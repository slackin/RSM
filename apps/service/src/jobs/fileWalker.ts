import { promises as fs } from "node:fs";
import path from "node:path";

export interface CollectFilesOptions {
  excludePaths?: string[];
}

function isSameOrDescendantPath(candidatePath: string, basePath: string): boolean {
  if (candidatePath === basePath) {
    return true;
  }

  return candidatePath.startsWith(`${basePath}${path.sep}`);
}

export async function collectFiles(roots: string[], options?: CollectFilesOptions): Promise<string[]> {
  const files: string[] = [];
  const excludedRoots = (options?.excludePaths ?? []).map((excludedPath) => path.resolve(excludedPath));

  const isIgnorableFsError = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" || code === "ENOENT";
  };

  async function walk(current: string): Promise<void> {
    const resolvedCurrent = path.resolve(current);
    if (excludedRoots.some((excludedRoot) => isSameOrDescendantPath(resolvedCurrent, excludedRoot))) {
      return;
    }

    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (isIgnorableFsError(error)) {
        return [] as Awaited<ReturnType<typeof fs.readdir>>;
      }
      throw error;
    });

    for (const entry of entries) {
      const full = path.join(current, entry.name.toString());
      const resolvedFull = path.resolve(full);
      if (excludedRoots.some((excludedRoot) => isSameOrDescendantPath(resolvedFull, excludedRoot))) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const isReadable = await fs
          .access(full)
          .then(() => true)
          .catch(() => false);

        if (isReadable) {
          files.push(full);
        }
      }
    }
  }

  for (const root of roots) {
    await walk(root);
  }

  return files;
}
