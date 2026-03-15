import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import XXHash from "xxhash-wasm";
import type { DuplicateGroup, DuplicateScanResponse } from "@rsm/shared";
import { collectFiles } from "./fileWalker.js";
import { FileMetadataDatabase, type FileFingerprint } from "./fileMetadataDatabase.js";

interface DuplicateScanProgress {
  stage: "indexing" | "hashing";
  currentFile: string;
  processedSteps: number;
  totalSteps: number;
  processedFiles: number;
  totalFiles: number;
}

type ProgressCallback = (payload: DuplicateScanProgress) => void;

interface IndexedFile extends FileFingerprint {
  path: string;
}

function isIgnorableFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

async function checksum(path: string): Promise<string> {
  const { create64 } = await XXHash();
  const hasher = create64();

  return await new Promise<string>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hasher.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hasher.digest().toString(16)));
  });
}

function toFingerprint(stat: Awaited<ReturnType<typeof fs.stat>>): FileFingerprint {
  return {
    sizeBytes: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs)
  };
}

export async function runDuplicateScan(
  roots: string[],
  onProgress?: ProgressCallback
): Promise<DuplicateScanResponse> {
  const metadataDatabase = await FileMetadataDatabase.open();
  try {
    const files = await collectFiles(roots);
    const bySize = new Map<number, IndexedFile[]>();
    const seenPaths = new Set<string>();
    const totalFiles = files.length;
    let processedSteps = 0;
    let lastEmittedStep = -1;
    let lastEmittedAt = 0;
    let cachedHashes = 0;
    let computedHashes = 0;
    let staleCacheEntries = 0;

    const emitProgress = (
      payload: Omit<DuplicateScanProgress, "processedSteps" | "totalSteps" | "totalFiles">,
      totalSteps: number,
      force = false
    ) => {
      if (!onProgress) return;
      const now = Date.now();
      const shouldThrottleByStep = processedSteps - lastEmittedStep < 40;
      const shouldThrottleByTime = now - lastEmittedAt < 1000;
      if (!force && shouldThrottleByStep && shouldThrottleByTime) return;

      lastEmittedStep = processedSteps;
      lastEmittedAt = now;
      onProgress({
        ...payload,
        processedSteps,
        totalSteps,
        totalFiles
      });
    };

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const stat = await fs.stat(file).catch((error) => {
        if (isIgnorableFsError(error)) return null;
        throw error;
      });
      processedSteps += 1;

      const shouldEmitIndexProgress = i % 25 === 0 || i === files.length - 1;
      if (shouldEmitIndexProgress) {
        emitProgress(
          {
            stage: "indexing",
            currentFile: file,
            processedFiles: i + 1
          },
          totalFiles,
          i === files.length - 1
        );
      }

      if (!stat?.isFile()) continue;
      const fingerprint = toFingerprint(stat);
      const group = bySize.get(fingerprint.sizeBytes) ?? [];
      group.push({ path: file, ...fingerprint });
      bySize.set(fingerprint.sizeBytes, group);
      seenPaths.add(file);
    }

    const duplicateGroups: DuplicateGroup[] = [];
    const checksumCandidates = Array.from(bySize.values()).reduce((sum, sizeGroup) => {
      if (sizeGroup.length < 2) return sum;
      return sum + sizeGroup.length;
    }, 0);
    const totalSteps = totalFiles + checksumCandidates;

    for (const [size, sizeGroup] of bySize.entries()) {
      if (sizeGroup.length < 2) continue;

      const byChecksum = new Map<string, string[]>();
      for (let i = 0; i < sizeGroup.length; i += 1) {
        const file = sizeGroup[i];

        const shouldEmitHashStart = i % 5 === 0;
        if (shouldEmitHashStart) {
          emitProgress(
            {
              stage: "hashing",
              currentFile: file.path,
              processedFiles: totalFiles
            },
            totalSteps
          );
        }

        const lookup = metadataDatabase.lookupChecksum(file.path, file);
        if (lookup.stale) {
          staleCacheEntries += 1;
        }

        const sum =
          lookup.checksum ??
          (await checksum(file.path)
            .then((value) => value)
            .catch((error) => {
              if (isIgnorableFsError(error)) return null;
              throw error;
            }));
        processedSteps += 1;

        if (lookup.checksum) {
          cachedHashes += 1;
        } else {
          computedHashes += 1;
        }

        const shouldEmitHashProgress = i % 10 === 0 || i === sizeGroup.length - 1;
        if (shouldEmitHashProgress) {
          emitProgress(
            {
              stage: "hashing",
              currentFile: file.path,
              processedFiles: totalFiles
            },
            totalSteps,
            processedSteps === totalSteps
          );
        }

        if (!sum) {
          metadataDatabase.delete(file.path);
          continue;
        }

        if (!lookup.checksum) {
          metadataDatabase.setChecksum(file.path, file, sum);
        }

        const checksumGroup = byChecksum.get(sum) ?? [];
        checksumGroup.push(file.path);
        byChecksum.set(sum, checksumGroup);
      }

      for (const [sum, sumGroup] of byChecksum.entries()) {
        if (sumGroup.length > 1) {
          duplicateGroups.push({ sizeBytes: size, checksum: sum, files: sumGroup });
        }
      }
    }

    const prunedCacheEntries = metadataDatabase.pruneRoots(roots, seenPaths);
    await metadataDatabase.save().catch(() => undefined);

    return {
      groups: duplicateGroups,
      scannedFiles: files.length,
      cacheStats: {
        cachedHashes,
        computedHashes,
        staleCacheEntries,
        prunedCacheEntries
      }
    };
  } finally {
    metadataDatabase.close();
  }
}
