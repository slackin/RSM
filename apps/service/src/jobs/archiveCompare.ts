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

interface ArchiveEntriesForCompare {
  entries: string[];
  excludedDirectoryPaths: string[];
  cleanup?: () => Promise<void>;
}

export function detectArchiveFormat(archivePath: string): ArchiveFormat | null {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.7z")) return "tar.7z";
  if (lower.endsWith(".zip")) return "zip";
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

async function extractTarFromTar7z(archivePath: string): Promise<{ tempDir: string; tarPath: string }> {
  const archiveStat = await fs.stat(archivePath);
  const requiredBytes = estimateRequiredExtractionBytes(archiveStat.size);
  const tempDir = await createExtractionTempDirectory(archivePath, requiredBytes);

  try {
    const sevenZipBinary = (sevenBin as { path7za: string }).path7za;
    await execFile(sevenZipBinary, ["e", "-y", `-o${tempDir}`, archivePath]);

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

async function listArchiveEntriesForCompare(archivePath: string): Promise<ArchiveEntriesForCompare> {
  const format = detectArchiveFormat(archivePath);

  if (format === "tar.7z") {
    const { tempDir, tarPath } = await extractTarFromTar7z(archivePath);
    const entries = await listTarEntries(tarPath);
    return {
      entries,
      excludedDirectoryPaths: [tempDir],
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    };
  }

  return {
    entries: await listArchiveEntries(archivePath),
    excludedDirectoryPaths: []
  };
}

export async function compareArchiveToDirectory(
  archivePath: string,
  directoryPath: string
): Promise<ArchiveCompareResponse> {
  await fs.access(archivePath);
  await fs.access(directoryPath);

  const normalizedDirectoryPath = path.resolve(directoryPath);
  const archiveInfo = await listArchiveEntriesForCompare(archivePath);

  try {
    const dirFiles = await collectFiles([normalizedDirectoryPath], {
      excludePaths: archiveInfo.excludedDirectoryPaths
    });
    const relDirFiles = dirFiles.map((f) => path.relative(normalizedDirectoryPath, f).replaceAll("\\", "/"));

    const archiveSet = new Set(archiveInfo.entries);
    const dirSet = new Set(relDirFiles);

    return {
      duplicateEntries: archiveInfo.entries.filter((entry) => dirSet.has(entry)),
      onlyInArchive: archiveInfo.entries.filter((entry) => !dirSet.has(entry)),
      onlyInDirectory: relDirFiles.filter((entry) => !archiveSet.has(entry))
    };
  } finally {
    await archiveInfo.cleanup?.();
  }
}

/**
 * Remove specific entries from a ZIP archive in-place.
 * Only ZIP format is supported; other formats throw with a clear message.
 */
export async function deleteArchiveEntries(
  archivePath: string,
  entries: string[]
): Promise<{ removed: number; failed: number }> {
  const format = detectArchiveFormat(archivePath);
  if (format !== "zip") {
    throw new Error(
      "In-archive deletion is only supported for ZIP files. For other formats, delete from the directory instead."
    );
  }

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
