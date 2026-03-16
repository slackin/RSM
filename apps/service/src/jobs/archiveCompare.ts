import { constants, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";
import { list as tarList, type ReadEntry } from "tar";
import Seven from "node-7z";
import sevenBin from "7zip-bin";
import { createExtractorFromFile } from "node-unrar-js";
import type { ArchiveCompareResponse } from "@rsm/shared";
import { collectFiles } from "./fileWalker.js";

const execFile = promisify(execFileCallback);

export type ArchiveFormat = "zip" | "tar" | "7z" | "rar" | "tar.7z";
export type CompareProgressStage = "extracting" | "listing" | "scanning";

export interface CompareProgressEvent {
  stage: CompareProgressStage;
  /** Human-readable detail (e.g. current file name during extraction). */
  detail?: string;
  /** Number of items processed so far in this stage. */
  processed?: number;
  /** Total expected items for this stage (if known). */
  total?: number;
}

type OnCompareProgress = (event: CompareProgressEvent) => void;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Archive compare cancelled", "AbortError");
}

interface ArchiveEntriesForCompare {
  entries: string[];
  excludedDirectoryPaths: string[];
  cleanup?: () => Promise<void>;
}

export function detectArchiveFormat(archivePath: string): ArchiveFormat | null {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.7z")) return "tar.7z";
  if (lower.endsWith(".zip") || lower.endsWith(".pk3")) return "zip";
  if (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "tar";
  if (lower.endsWith(".7z")) return "7z";
  if (lower.endsWith(".rar")) return "rar";
  return null;
}

async function listZipEntries(archivePath: string): Promise<string[]> {
  const zip = new AdmZip(archivePath);
  return zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName.replaceAll("\\", "/"));
}

async function listTarEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tarList({
    file: archivePath,
    onentry: (entry: ReadEntry) => {
      if (entry.type !== "Directory") {
        entries.push(entry.path);
      }
    }
  });
  return entries;
}

async function list7zEntries(archivePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const files: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = Seven.list(archivePath, { $bin: (sevenBin as any).path7za });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.on("data", (chunk: any) => {
      if (chunk.file) files.push((chunk.file as string).replaceAll("\\", "/"));
    });
    stream.on("end", () => resolve(files));
    stream.on("error", (err: unknown) => reject(err));
  });
}

function toNumber(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getAvailableBytes(targetPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFile("df", ["-Pk", targetPath]);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const dataLine = lines[lines.length - 1] ?? "";
    const columns = dataLine.trim().split(/\s+/);
    const availableKb = toNumber(columns[3] ?? "");
    return availableKb === null ? null : availableKb * 1024;
  } catch {
    return null;
  }
}

function estimateRequiredExtractionBytes(archiveSizeBytes: number): number {
  const sixtyFourMb = 64 * 1024 * 1024;
  // .tar.7z may expand significantly; use a conservative floor + multiplier.
  return Math.max(archiveSizeBytes * 3, archiveSizeBytes + sixtyFourMb);
}

async function createExtractionTempDirectory(archivePath: string, requiredBytes: number): Promise<string> {
  const archiveDirectory = path.dirname(path.resolve(archivePath));
  const candidateParents = [archiveDirectory, path.resolve(os.tmpdir())];
  const failedReasons: string[] = [];

  for (const parentDir of candidateParents) {
    try {
      await fs.access(parentDir, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      failedReasons.push(`${parentDir} (not writable)`);
      continue;
    }

    const availableBytes = await getAvailableBytes(parentDir);
    if (availableBytes !== null && availableBytes < requiredBytes) {
      failedReasons.push(`${parentDir} (insufficient free space)`);
      continue;
    }

    try {
      const tempPrefix = path.join(parentDir, ".rsm-archive-compare-");
      return await fs.mkdtemp(tempPrefix);
    } catch (error) {
      failedReasons.push(`${parentDir} (${(error as Error).message})`);
    }
  }

  throw new Error(
    `Unable to create extraction temp directory. Required approx ${requiredBytes} bytes. Tried: ${failedReasons.join("; ")}`
  );
}

async function extractTarFromTar7z(
  archivePath: string,
  onProgress?: OnCompareProgress,
  signal?: AbortSignal
): Promise<{ tempDir: string; tarPath: string }> {
  const archiveStat = await fs.stat(archivePath);
  const requiredBytes = estimateRequiredExtractionBytes(archiveStat.size);
  const tempDir = await createExtractionTempDirectory(archivePath, requiredBytes);

  try {
    throwIfAborted(signal);
    const sevenZipBinary = (sevenBin as { path7za: string }).path7za;

    // Use spawn to get per-file extraction progress
    await new Promise<void>((resolve, reject) => {
      const child = execFileCallback(
        sevenZipBinary,
        ["e", "-y", `-o${tempDir}`, "-bsp1", archivePath],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );

      // Listen for abort to kill the child process
      const onAbort = () => {
        child.kill("SIGTERM");
        reject(new DOMException("Archive compare cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      // Stream extraction progress from stdout
      let lineBuffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        // 7zip progress lines may use \r without \n
        const parts = lineBuffer.split(/[\r\n]/);
        lineBuffer = parts.pop() ?? "";
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          // Lines like "- filename" or percentage lines
          const percentMatch = trimmed.match(/^\s*(\d+)%/);
          if (percentMatch) {
            onProgress?.({
              stage: "extracting",
              detail: `Extracting: ${percentMatch[1]}%`,
              processed: Number(percentMatch[1]),
              total: 100
            });
          } else if (trimmed.startsWith("- ")) {
            onProgress?.({
              stage: "extracting",
              detail: `Extracting: ${trimmed.slice(2)}`
            });
          }
        }
      });

      child.on("close", () => {
        signal?.removeEventListener("abort", onAbort);
      });
    });

    const extractedEntries = await fs.readdir(tempDir, { withFileTypes: true });
    const tarCandidates = extractedEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".tar"))
      .map((entry) => entry.name);

    if (tarCandidates.length === 0) {
      throw new Error("No .tar file found inside .tar.7z archive.");
    }

    const expectedTarName = path.basename(archivePath).slice(0, -3).toLowerCase();
    const tarFileName = tarCandidates.find((name) => name.toLowerCase() === expectedTarName) ?? tarCandidates[0];
    return { tempDir, tarPath: path.join(tempDir, tarFileName) };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function listRarEntries(archivePath: string): Promise<string[]> {
  const extractor = await createExtractorFromFile({ filepath: archivePath });
  const { fileHeaders } = extractor.getFileList();
  return [...fileHeaders]
    .filter((h) => !h.flags.directory)
    .map((h) => h.name.replaceAll("\\", "/"));
}

export async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const format = detectArchiveFormat(archivePath);
  switch (format) {
    case "zip": return listZipEntries(archivePath);
    case "tar": return listTarEntries(archivePath);
    case "7z": return list7zEntries(archivePath);
    case "tar.7z": {
      const { tempDir, tarPath } = await extractTarFromTar7z(archivePath);
      try {
        return await listTarEntries(tarPath);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
    case "rar": return listRarEntries(archivePath);
    default: throw new Error(`Unsupported archive format. Supported: .zip, .tar, .tar.gz, .tar.bz2, .tar.7z, .7z, .rar`);
  }
}

async function listArchiveEntriesForCompare(
  archivePath: string,
  onProgress?: OnCompareProgress,
  signal?: AbortSignal
): Promise<ArchiveEntriesForCompare> {
  const format = detectArchiveFormat(archivePath);

  if (format === "tar.7z") {
    onProgress?.({ stage: "extracting", detail: "Starting extraction\u2026" });
    const { tempDir, tarPath } = await extractTarFromTar7z(archivePath, onProgress, signal);
    throwIfAborted(signal);
    onProgress?.({ stage: "listing", detail: "Reading tar entries\u2026" });
    const entries = await listTarEntries(tarPath);
    onProgress?.({ stage: "listing", detail: `Found ${entries.length} entries in archive` });
    return {
      entries,
      excludedDirectoryPaths: [tempDir],
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    };
  }

  throwIfAborted(signal);
  onProgress?.({ stage: "listing", detail: "Reading archive entries\u2026" });
  const entries = await listArchiveEntries(archivePath);
  onProgress?.({ stage: "listing", detail: `Found ${entries.length} entries in archive` });
  return {
    entries,
    excludedDirectoryPaths: []
  };
}

interface ArchiveDirectoryMatch {
  archiveEntry: string; // original path in the archive
  dirEntry: string;     // path relative to the comparison directory
}

/**
 * Match archive entries to directory-relative file paths using path-suffix semantics.
 *
 * Two paths are considered a match when one is a path-component-level suffix of the other:
 *   - "backup/photos/img.jpg"  matches  "photos/img.jpg"  (archive has extra prefix)
 *   - "img.jpg"               matches  "photos/img.jpg"  (dir has extra prefix)
 *   - "photos/img.jpg"        matches  "photos/img.jpg"  (exact)
 *
 * This handles real-world archive layouts where the internal directory structure does
 * not perfectly mirror the depth of the selected comparison directory.
 *
 * Matching is unambiguous: each archive entry and each directory entry is used at most
 * once. When multiple archive entries share the same basename, only the one whose path
 * is a component-suffix of the directory entry is accepted.
 */
function matchArchiveEntriesToDirectory(
  archiveEntries: string[],
  dirFiles: string[]
): ArchiveDirectoryMatch[] {
  const results: ArchiveDirectoryMatch[] = [];
  const usedArchive = new Set<string>();
  const usedDir = new Set<string>();

  // Index archive entries by basename for O(1) candidate lookup.
  const archiveByBasename = new Map<string, string[]>();
  for (const ae of archiveEntries) {
    const slash = ae.lastIndexOf("/");
    const base = slash === -1 ? ae : ae.slice(slash + 1);
    let list = archiveByBasename.get(base);
    if (!list) { list = []; archiveByBasename.set(base, list); }
    list.push(ae);
  }

  for (const de of dirFiles) {
    if (usedDir.has(de)) continue;
    const slash = de.lastIndexOf("/");
    const base = slash === -1 ? de : de.slice(slash + 1);
    const candidates = archiveByBasename.get(base);
    if (!candidates) continue;

    for (const ae of candidates) {
      if (usedArchive.has(ae)) continue;
      // Accept if one path is a component-level suffix of the other.
      if (ae === de || ae.endsWith(`/${de}`) || de.endsWith(`/${ae}`)) {
        results.push({ archiveEntry: ae, dirEntry: de });
        usedArchive.add(ae);
        usedDir.add(de);
        break;
      }
    }
  }

  return results;
}

/**
 * Recursively expand nested archive entries.
 * For each entry that looks like a supported archive, extract it to a temp dir,
 * list its contents, and prefix them with the archive entry name.
 */
async function expandNestedArchiveEntries(
  archivePath: string,
  entries: string[],
  onProgress?: OnCompareProgress,
  signal?: AbortSignal
): Promise<{ expanded: string[]; tempDirs: string[] }> {
  const NESTED_ARCHIVE_EXTENSIONS = [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.7z", ".zip", ".pk3", ".7z", ".rar", ".tar"];

  function isNestedArchive(entryName: string): boolean {
    const lower = entryName.toLowerCase();
    return NESTED_ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  /**
   * Return the parent directory portion of an entry path.
   * "baseq3/pak0.pk3" → "baseq3", "pak0.pk3" → "".
   * The nested archive filename is NOT used as a virtual directory because it
   * doesn't correspond to any real directory on disk — the contents of a pk3/zip
   * are logically merged into the parent directory.
   */
  function parentPrefix(entryPath: string): string {
    const slash = entryPath.lastIndexOf("/");
    return slash === -1 ? "" : entryPath.substring(0, slash);
  }

  function prefixed(prefix: string, inner: string): string {
    return prefix ? `${prefix}/${inner}` : inner;
  }

  const format = detectArchiveFormat(archivePath);
  if (!format) return { expanded: entries, tempDirs: [] };

  const nestedEntries = entries.filter(isNestedArchive);
  if (nestedEntries.length === 0) return { expanded: entries, tempDirs: [] };

  // We need to extract the outer archive to access nested archives
  onProgress?.({ stage: "extracting", detail: "Extracting outer archive for recursive scan\u2026" });
  throwIfAborted(signal);

  let outerDir: string;
  outerDir = await extractFullArchive(archivePath, format);

  const tempDirs = [outerDir];
  const result: string[] = [];

  for (const entry of entries) {
    if (!isNestedArchive(entry)) {
      result.push(entry);
      continue;
    }

    throwIfAborted(signal);
    const nestedPath = path.join(outerDir, ...entry.split("/"));
    try {
      await fs.access(nestedPath);
    } catch {
      // Nested archive file not found after extraction — keep as regular entry
      result.push(entry);
      continue;
    }

    onProgress?.({ stage: "listing", detail: `Reading nested archive: ${entry}\u2026` });
    const entryDir = parentPrefix(entry);
    try {
      const innerEntries = await listArchiveEntries(nestedPath);
      // Prefix inner entries with the nested archive's parent directory
      for (const inner of innerEntries) {
        result.push(prefixed(entryDir, inner));
      }
      // Recursively expand further nesting
      const deeper = innerEntries.filter(isNestedArchive);
      if (deeper.length > 0) {
        const nestedFormat = detectArchiveFormat(nestedPath);
        if (nestedFormat) {
          // For deeper nesting, extract the inner archive and recurse
          const deepExpanded = await expandNestedArchiveEntries(
            nestedPath,
            innerEntries,
            onProgress,
            signal
          );
          tempDirs.push(...deepExpanded.tempDirs);
          // Replace the prefixed entries we just added with the deeper-expanded versions
          // Remove the shallow inner entries and add the deep ones
          const shallowCount = innerEntries.length;
          result.splice(result.length - shallowCount, shallowCount);
          for (const de of deepExpanded.expanded) {
            result.push(prefixed(entryDir, de));
          }
        }
      }
    } catch (err) {
      // If we can't read the nested archive, keep it as a regular entry
      result.push(entry);
    }
  }

  // Deduplicate: multiple nested archives in the same directory may contribute
  // identical inner paths (e.g. two pk3 files both containing maps/q3dm1.bsp).
  const seen = new Set<string>();
  const unique = result.filter((e) => {
    if (seen.has(e)) return false;
    seen.add(e);
    return true;
  });

  return { expanded: unique, tempDirs };
}

export async function compareArchiveToDirectory(
  archivePath: string,
  directoryPath: string,
  onProgress?: OnCompareProgress,
  signal?: AbortSignal,
  options?: { recursive?: boolean }
): Promise<ArchiveCompareResponse> {
  await fs.access(archivePath);
  await fs.access(directoryPath);
  throwIfAborted(signal);

  const normalizedDirectoryPath = path.resolve(directoryPath);
  const archiveInfo = await listArchiveEntriesForCompare(archivePath, onProgress, signal);
  const recursiveTempDirs: string[] = [];

  try {
    let finalEntries = archiveInfo.entries;

    if (options?.recursive) {
      onProgress?.({ stage: "listing", detail: "Checking for nested archives\u2026" });
      const expanded = await expandNestedArchiveEntries(
        archivePath,
        archiveInfo.entries,
        onProgress,
        signal
      );
      finalEntries = expanded.expanded;
      recursiveTempDirs.push(...expanded.tempDirs);
      if (finalEntries.length !== archiveInfo.entries.length) {
        onProgress?.({ stage: "listing", detail: `Expanded to ${finalEntries.length} entries (from ${archiveInfo.entries.length})` });
      }
    }

    throwIfAborted(signal);
    onProgress?.({ stage: "scanning", detail: "Scanning directory\u2026" });
    const dirFiles = await collectFiles([normalizedDirectoryPath], {
      excludePaths: [...archiveInfo.excludedDirectoryPaths, ...recursiveTempDirs],
      signal
    });
    onProgress?.({ stage: "scanning", detail: `Found ${dirFiles.length} files in directory. Matching\u2026` });
    const relDirFiles = dirFiles.map((f) => path.relative(normalizedDirectoryPath, f).replaceAll("\\", "/"));

    throwIfAborted(signal);
    const matches = matchArchiveEntriesToDirectory(finalEntries, relDirFiles);
    const matchedArchive = new Set(matches.map((m) => m.archiveEntry));
    const matchedDir = new Set(matches.map((m) => m.dirEntry));

    return {
      duplicateEntries: matches.map((m) => m.dirEntry),
      archiveDuplicateEntries: matches.map((m) => m.archiveEntry),
      archiveEntryPrefix: "",
      onlyInArchive: finalEntries.filter((ae) => !matchedArchive.has(ae)),
      onlyInDirectory: relDirFiles.filter((de) => !matchedDir.has(de))
    };
  } finally {
    await archiveInfo.cleanup?.();
    for (const td of recursiveTempDirs) {
      await fs.rm(td, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Determine the tar compression flag for creation based on archive extension.
 */
function tarCompressionFlag(archivePath: string): string {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "z";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "j";
  return "";
}

/**
 * Extract an archive's full contents to a temporary directory.
 * The caller is responsible for cleaning up the returned directory.
 */
async function extractFullArchive(
  archivePath: string,
  format: ArchiveFormat
): Promise<string> {
  const archiveStat = await fs.stat(archivePath);
  const requiredBytes = estimateRequiredExtractionBytes(archiveStat.size);
  const tempDir = await createExtractionTempDirectory(archivePath, requiredBytes);

  try {
    const sevenZipBin = (sevenBin as { path7za: string }).path7za;

    switch (format) {
      case "zip": {
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(tempDir, true);
        break;
      }
      case "tar": {
        await execFile("tar", ["xf", archivePath, "-C", tempDir]);
        break;
      }
      case "7z":
      case "rar": {
        await execFile(sevenZipBin, ["x", "-y", `-o${tempDir}`, archivePath]);
        break;
      }
      case "tar.7z": {
        // Extract 7z to get inner tar file
        await execFile(sevenZipBin, ["x", "-y", `-o${tempDir}`, archivePath]);

        const extracted = await fs.readdir(tempDir, { withFileTypes: true });
        const tarFiles = extracted
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".tar"))
          .map((e) => e.name);
        if (tarFiles.length === 0) throw new Error("No .tar file found inside .tar.7z archive.");

        const expectedTarName = path.basename(archivePath).slice(0, -3).toLowerCase();
        const tarFileName = tarFiles.find((n) => n.toLowerCase() === expectedTarName) ?? tarFiles[0];
        const tarPath = path.join(tempDir, tarFileName);

        // Extract tar contents to a separate directory, then swap
        const contentDir = await fs.mkdtemp(path.join(path.dirname(tempDir), ".rsm-tar-contents-"));
        try {
          await execFile("tar", ["xf", tarPath, "-C", contentDir]);
          await fs.rm(tempDir, { recursive: true, force: true });
          await fs.rename(contentDir, tempDir);
        } catch (error) {
          await fs.rm(contentDir, { recursive: true, force: true });
          throw error;
        }
        break;
      }
      default:
        throw new Error(`Extraction not implemented for format: ${format}`);
    }
    return tempDir;
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Recursively remove empty directories under (but not including) the root.
 */
async function removeEmptyDirectories(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullPath = path.join(dir, entry.name);
      await removeEmptyDirectories(fullPath);
      try { await fs.rmdir(fullPath); } catch { /* not empty, ignore */ }
    }
  }
}

/**
 * Repackage a directory into an archive, atomically replacing the original.
 */
async function repackageArchive(
  sourceDir: string,
  archivePath: string,
  format: ArchiveFormat
): Promise<void> {
  const tempOutput = archivePath + ".rsm-repack-tmp";

  try {
    const sevenZipBin = (sevenBin as { path7za: string }).path7za;

    switch (format) {
      case "tar": {
        const flag = tarCompressionFlag(archivePath);
        await execFile("tar", [`c${flag}f`, tempOutput, "-C", sourceDir, "."]);
        break;
      }
      case "7z": {
        await execFile(sevenZipBin, ["a", "-y", path.resolve(tempOutput), "."], { cwd: sourceDir });
        break;
      }
      case "tar.7z": {
        const tempTar = tempOutput + ".tar";
        try {
          await execFile("tar", ["cf", tempTar, "-C", sourceDir, "."]);
          await execFile(sevenZipBin, ["a", "-y", path.resolve(tempOutput), tempTar]);
        } finally {
          await fs.unlink(tempTar).catch(() => {});
        }
        break;
      }
      default:
        throw new Error(`Repackaging not supported for format: ${format}`);
    }

    // Atomically replace the original archive
    await fs.rename(tempOutput, archivePath);
  } catch (error) {
    await fs.unlink(tempOutput).catch(() => {});
    throw error;
  }
}

/**
 * Delete specific entries from an archive via extract → delete → repackage.
 */
async function deleteViaRepackage(
  archivePath: string,
  entries: string[],
  format: ArchiveFormat
): Promise<{ removed: number; failed: number }> {
  const resolvedArchive = path.resolve(archivePath);
  const tempDir = await extractFullArchive(resolvedArchive, format);

  try {
    let removed = 0;
    let failed = 0;

    for (const entry of entries) {
      const normalizedEntry = path.normalize(entry).replace(/^(\.\.[\/\\])+/, "");
      const filePath = path.join(tempDir, normalizedEntry);

      // Path traversal check
      if (!filePath.startsWith(tempDir + path.sep) && filePath !== tempDir) {
        failed += 1;
        continue;
      }

      try {
        await fs.unlink(filePath);
        removed += 1;
      } catch {
        failed += 1;
      }
    }

    if (removed > 0) {
      await removeEmptyDirectories(tempDir);
      await repackageArchive(tempDir, resolvedArchive, format);
    }

    return { removed, failed };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Remove specific entries from an archive.
 * Supports ZIP (in-place via AdmZip), tar, 7z, and tar.7z (via extract-delete-repackage).
 * RAR is not supported (requires proprietary tools to create).
 */
export async function deleteArchiveEntries(
  archivePath: string,
  entries: string[]
): Promise<{ removed: number; failed: number }> {
  const format = detectArchiveFormat(archivePath);

  if (!format) {
    throw new Error("Unrecognized archive format.");
  }

  // ZIP: efficient in-place deletion via AdmZip
  if (format === "zip") {
    const zip = new AdmZip(archivePath);
    let removed = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        zip.deleteFile(entry);
        removed += 1;
      } catch {
        failed += 1;
      }
    }

    zip.writeZip(archivePath);
    return { removed, failed };
  }

  if (format === "rar") {
    throw new Error("In-archive deletion is not supported for RAR files. RAR creation requires proprietary tools.");
  }

  // tar, 7z, tar.7z: extract → delete → repackage
  return deleteViaRepackage(archivePath, entries, format);
}
