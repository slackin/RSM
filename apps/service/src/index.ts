import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { SERVICE_API_VERSION } from "@rsm/shared";
import {
  compareArchiveToDirectory,
  deleteArchiveEntries
} from "./jobs/archiveCompare.js";
import { createArchive } from "./jobs/archiveCreate.js";
import { runDuplicateScan } from "./jobs/duplicateDetector.js";
import { buildOrganizePlan } from "./jobs/organizer.js";

const server = Fastify({
  logger: true,
  // Large duplicate scans can produce a substantial move payload.
  bodyLimit: 100 * 1024 * 1024
});
await server.register(websocket);

server.addHook("onRequest", async (req, reply) => {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  reply.header("access-control-allow-headers", "content-type,authorization");

  if (req.method === "OPTIONS") {
    return reply.code(204).send();
  }
});

server.setErrorHandler((error, _req, reply) => {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({ error: "Invalid request", details: error.errors });
  }
  server.log.error(error);
  const err = error as { statusCode?: number; message?: string };
  return reply.status(err.statusCode ?? 500).send({
    error: err.message ?? "Internal Server Error"
  });
});

const progressSubscribers = new Set<(payload: object) => void>();

function publishProgress(payload: object): void {
  for (const send of progressSubscribers) send(payload);
}

function getDefaultBrowseRoot(): string {
  return path.parse(process.cwd()).root || "/";
}

function toPathErrorMessage(code: string, targetPath: string): { status: number; error: string } {
  if (code === "EACCES" || code === "EPERM") {
    return { status: 403, error: `Permission denied for path: ${targetPath}` };
  }

  if (code === "ENOENT") {
    return { status: 404, error: `Path does not exist: ${targetPath}` };
  }

  return { status: 500, error: `Unable to access path: ${targetPath}` };
}

async function resolveBrowseDirectory(inputPath: string): Promise<string> {
  const resolvedPath = path.resolve(inputPath);
  const stat = await fs.stat(resolvedPath);

  if (stat.isDirectory()) {
    return resolvedPath;
  }

  // If the caller passes a file path (common when reopening a picker), browse its parent.
  if (stat.isFile()) {
    return path.dirname(resolvedPath);
  }

  throw new Error(`Not a directory: ${resolvedPath}`);
}

function toFsMoveErrorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "Source file no longer exists.";
  if (code === "EACCES" || code === "EPERM") return "Permission denied while moving file.";
  if (code === "EISDIR") return "Expected a file but found a directory.";
  if (code === "ENOTDIR") return "Invalid target directory path.";
  return (error as Error).message || "Unknown file move error.";
}

async function resolveUniqueDestinationPath(initialPath: string): Promise<string> {
  const parsed = path.parse(initialPath);
  let attempt = 0;

  while (true) {
    const candidate =
      attempt === 0
        ? initialPath
        : path.join(parsed.dir, `${parsed.name} (${attempt})${parsed.ext}`);

    try {
      await fs.access(candidate);
      attempt += 1;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return candidate;
      throw error;
    }
  }
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, destinationPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw error;
  }

  await fs.copyFile(sourcePath, destinationPath);
  await fs.unlink(sourcePath);
}

server.get("/health", async () => ({ status: "ok", apiVersion: SERVICE_API_VERSION }));

server.get("/api/fs/directories", async (req, reply) => {
  const schema = z.object({ path: z.string().optional() });
  const query = schema.parse(req.query);
  const requestedPath = (query.path ?? "").trim();
  let targetPath = requestedPath.length > 0 ? path.resolve(requestedPath) : getDefaultBrowseRoot();

  let stat;
  try {
    targetPath = await resolveBrowseDirectory(targetPath);
    stat = await fs.stat(targetPath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not a directory:")) {
      return reply.status(400).send({ error: error.message });
    }
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, targetPath);
    return reply.status(response.status).send({ error: response.error });
  }

  if (!stat.isDirectory()) {
    return reply.status(400).send({ error: `Not a directory: ${targetPath}` });
  }

  try {
    await fs.access(targetPath, constants.R_OK | constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, targetPath);
    return reply.status(response.status).send({ error: response.error });
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(targetPath, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parentCandidate = path.dirname(targetPath);
  const parentPath = parentCandidate === targetPath ? null : parentCandidate;

  return reply.send({
    path: targetPath,
    parentPath,
    directories
  });
});

server.post("/api/fs/directories/create", async (req, reply) => {
  const schema = z.object({
    parentPath: z.string().trim().min(1),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !/[\\/]/.test(value), "Folder name cannot include path separators")
      .refine((value) => value !== "." && value !== "..", "Invalid folder name")
  });
  const body = schema.parse(req.body);
  const parentPath = path.resolve(body.parentPath);

  let stat;
  try {
    stat = await fs.stat(parentPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, parentPath);
    return reply.status(response.status).send({ error: response.error });
  }

  if (!stat.isDirectory()) {
    return reply.status(400).send({ error: `Not a directory: ${parentPath}` });
  }

  try {
    await fs.access(parentPath, constants.W_OK | constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, parentPath);
    return reply.status(response.status).send({ error: response.error });
  }

  const newDirectoryPath = path.join(parentPath, body.name);
  try {
    await fs.mkdir(newDirectoryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "EEXIST") {
      return reply.status(400).send({ error: `Directory already exists: ${newDirectoryPath}` });
    }

    const response = toPathErrorMessage(code, newDirectoryPath);
    return reply.status(response.status).send({ error: response.error });
  }

  return reply.send({ path: newDirectoryPath, created: true });
});

server.get("/ws/progress", { websocket: true }, (socket) => {
  const send = (payload: object): void => {
    socket.send(JSON.stringify(payload));
  };

  progressSubscribers.add(send);
  socket.on("close", () => {
    progressSubscribers.delete(send);
  });
});

server.post("/api/scan/duplicates", async (req, reply) => {
  const schema = z.object({ roots: z.array(z.string().trim().min(1)).min(1) });
  const body = schema.parse(req.body);
  const roots = body.roots.map((root) => path.resolve(root));
  const invalidRoots: string[] = [];

  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) {
      invalidRoots.push(root);
      continue;
    }

    const hasAccess = await fs
      .access(root, constants.R_OK | constants.X_OK)
      .then(() => true)
      .catch(() => false);

    if (!hasAccess) {
      invalidRoots.push(root);
    }
  }

  if (invalidRoots.length > 0) {
    return reply.status(400).send({
      error:
        invalidRoots.length === 1
          ? `Selected path is not a readable directory: ${invalidRoots[0]}`
          : `Some selected paths are not readable directories: ${invalidRoots.join(", ")}`
    });
  }

  publishProgress({ phase: "duplicate_scan_started", roots });
  const result = await runDuplicateScan(roots, (progress) => {
    publishProgress({ phase: "duplicate_scan_progress", ...progress });
  });
  publishProgress({
    phase: "duplicate_scan_complete",
    groups: result.groups.length,
    scannedFiles: result.scannedFiles,
    cacheStats: result.cacheStats
  });
  return reply.send(result);
});

server.post("/api/duplicates/move", async (req, reply) => {
  const schema = z.object({
    destinationRoot: z.string().trim().min(1),
    groups: z.array(
      z.object({
        sizeBytes: z.number(),
        checksum: z.string(),
        files: z.array(z.string().trim().min(1)).min(1)
      })
    )
  });

  const body = schema.parse(req.body);
  const destinationRoot = path.resolve(body.destinationRoot);

  let destinationStat;
  try {
    destinationStat = await fs.stat(destinationRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, destinationRoot);
    return reply.status(response.status).send({ error: response.error });
  }

  if (!destinationStat.isDirectory()) {
    return reply.status(400).send({ error: `Not a directory: ${destinationRoot}` });
  }

  try {
    await fs.access(destinationRoot, constants.W_OK | constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, destinationRoot);
    return reply.status(response.status).send({ error: response.error });
  }

  const processedSourcePaths = new Set<string>();
  const results: Array<{ source: string; destination: string | null; moved: boolean; error?: string }> = [];

  let keptFiles = 0;
  let requestedMoves = 0;
  let movedFiles = 0;

  for (const group of body.groups) {
    const resolvedFiles = group.files.map((filePath) => path.resolve(filePath));
    if (resolvedFiles.length < 2) continue;

    keptFiles += 1;

    const keepPath = resolvedFiles[0];

    for (const sourcePath of resolvedFiles.slice(1)) {
      if (sourcePath === keepPath) continue;
      if (processedSourcePaths.has(sourcePath)) {
        results.push({
          source: sourcePath,
          destination: null,
          moved: false,
          error: "File appeared in multiple duplicate groups."
        });
        continue;
      }

      processedSourcePaths.add(sourcePath);
      requestedMoves += 1;

      try {
        const sourceStat = await fs.stat(sourcePath);
        if (!sourceStat.isFile()) {
          results.push({
            source: sourcePath,
            destination: null,
            moved: false,
            error: "Path is not a file."
          });
          continue;
        }

        const targetPath = await resolveUniqueDestinationPath(path.join(destinationRoot, path.basename(sourcePath)));
        await moveFile(sourcePath, targetPath);

        movedFiles += 1;
        results.push({ source: sourcePath, destination: targetPath, moved: true });
      } catch (error) {
        results.push({
          source: sourcePath,
          destination: null,
          moved: false,
          error: toFsMoveErrorMessage(error)
        });
      }
    }
  }

  return reply.send({
    destinationRoot,
    keptFiles,
    requestedMoves,
    movedFiles,
    failedFiles: Math.max(0, requestedMoves - movedFiles),
    results
  });
});

server.post("/api/organize/plan", async (req, reply) => {
  const schema = z.object({ root: z.string(), destination: z.string() });
  const body = schema.parse(req.body);
  const items = await buildOrganizePlan(body.root, body.destination);
  return reply.send({ items });
});

server.get("/api/fs/entries", async (req, reply) => {
  const schema = z.object({
    path: z.string().optional(),
    fileExtensions: z.string().optional()
  });
  const query = schema.parse(req.query);
  const requestedPath = (query.path ?? "").trim();
  let targetPath = requestedPath.length > 0 ? path.resolve(requestedPath) : getDefaultBrowseRoot();

  let stat;
  try {
    targetPath = await resolveBrowseDirectory(targetPath);
    stat = await fs.stat(targetPath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not a directory:")) {
      return reply.status(400).send({ error: error.message });
    }
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, targetPath);
    return reply.status(response.status).send({ error: response.error });
  }

  if (!stat.isDirectory()) {
    return reply.status(400).send({ error: `Not a directory: ${targetPath}` });
  }

  try {
    await fs.access(targetPath, constants.R_OK | constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, targetPath);
    return reply.status(response.status).send({ error: response.error });
  }

  const allowedExtensions = query.fileExtensions
    ? new Set(query.fileExtensions.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean))
    : null;

  const entries = await fs.readdir(targetPath, { withFileTypes: true });

  const directories = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(targetPath, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const matchingFileEntries = entries.filter((e) => {
    if (!e.isFile()) return false;
    if (!allowedExtensions) return true;
    const lower = e.name.toLowerCase();
    for (const ext of allowedExtensions) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  });

  const files = await Promise.all(
    matchingFileEntries.map(async (e) => {
      const filePath = path.join(targetPath, e.name);
      const fileStat = await fs.stat(filePath).catch(() => null);
      return { name: e.name, path: filePath, sizeBytes: fileStat?.size ?? 0 };
    })
  );
  files.sort((a, b) => a.name.localeCompare(b.name));

  const parentCandidate = path.dirname(targetPath);
  const parentPath = parentCandidate === targetPath ? null : parentCandidate;

  return reply.send({ path: targetPath, parentPath, directories, files });
});

server.post("/api/archive/delete-directory-files", async (req, reply) => {
  const schema = z.object({
    directoryPath: z.string().trim().min(1),
    relativePaths: z.array(z.string().trim().min(1)).min(1)
  });
  const body = schema.parse(req.body);
  const dirPath = path.resolve(body.directoryPath);

  const dirStat = await fs.stat(dirPath).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return reply.status(400).send({ error: `Not a directory: ${dirPath}` });
  }

  const results: Array<{ relativePath: string; success: boolean; error?: string }> = [];
  let deleted = 0;
  let failed = 0;

  for (const relPath of body.relativePaths) {
    const normalizedRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(dirPath, normalizedRel);

    if (!filePath.startsWith(dirPath + path.sep) && filePath !== dirPath) {
      results.push({ relativePath: relPath, success: false, error: "Path traversal detected." });
      failed += 1;
      continue;
    }

    try {
      const fileStat = await fs.stat(filePath);
      if (!fileStat.isFile()) {
        results.push({ relativePath: relPath, success: false, error: "Not a file." });
        failed += 1;
        continue;
      }
      await fs.unlink(filePath);
      results.push({ relativePath: relPath, success: true });
      deleted += 1;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const msg =
        code === "ENOENT" ? "File not found." :
        code === "EACCES" || code === "EPERM" ? "Permission denied." :
        (error as Error).message;
      results.push({ relativePath: relPath, success: false, error: msg });
      failed += 1;
    }
  }

  return reply.send({ deleted, failed, results });
});

server.post("/api/archive/move-directory-files", async (req, reply) => {
  const schema = z.object({
    directoryPath: z.string().trim().min(1),
    relativePaths: z.array(z.string().trim().min(1)).min(1),
    destinationRoot: z.string().trim().min(1)
  });
  const body = schema.parse(req.body);
  const dirPath = path.resolve(body.directoryPath);
  const destRoot = path.resolve(body.destinationRoot);

  const dirStat = await fs.stat(dirPath).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return reply.status(400).send({ error: `Not a directory: ${dirPath}` });
  }

  const destStat = await fs.stat(destRoot).catch(() => null);
  if (!destStat?.isDirectory()) {
    return reply.status(400).send({ error: `Destination is not a directory: ${destRoot}` });
  }

  const results: Array<{ relativePath: string; destination: string | null; success: boolean; error?: string }> = [];
  let moved = 0;
  let failed = 0;

  for (const relPath of body.relativePaths) {
    const normalizedRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    const sourcePath = path.join(dirPath, normalizedRel);

    if (!sourcePath.startsWith(dirPath + path.sep) && sourcePath !== dirPath) {
      results.push({ relativePath: relPath, destination: null, success: false, error: "Path traversal detected." });
      failed += 1;
      continue;
    }

    try {
      const destPath = await resolveUniqueDestinationPath(path.join(destRoot, path.basename(normalizedRel)));
      await moveFile(sourcePath, destPath);
      results.push({ relativePath: relPath, destination: destPath, success: true });
      moved += 1;
    } catch (error) {
      results.push({ relativePath: relPath, destination: null, success: false, error: toFsMoveErrorMessage(error) });
      failed += 1;
    }
  }

  return reply.send({ moved, failed, destinationRoot: destRoot, results });
});

server.post("/api/archive/delete-entries", async (req, reply) => {
  const schema = z.object({
    archivePath: z.string().trim().min(1),
    entries: z.array(z.string().trim().min(1)).min(1)
  });
  const body = schema.parse(req.body);
  const archivePath = path.resolve(body.archivePath);

  const archiveStat = await fs.stat(archivePath).catch(() => null);
  if (!archiveStat?.isFile()) {
    return reply.status(400).send({ error: `Not a file: ${archivePath}` });
  }

  try {
    const { removed, failed } = await deleteArchiveEntries(archivePath, body.entries);
    return reply.send({ removed, failed, archivePath, supported: true });
  } catch (error) {
    const message = (error as Error).message;
    const isUnsupported = message.includes("not supported");
    return reply
      .status(isUnsupported ? 400 : 500)
      .send({ removed: 0, failed: body.entries.length, archivePath, supported: !isUnsupported, error: message });
  }
});

// Active archive compare abort controller (only one compare at a time).
let activeCompareAbort: AbortController | null = null;

server.post("/api/archive/compare/cancel", async (_req, reply) => {
  if (activeCompareAbort) {
    activeCompareAbort.abort();
    activeCompareAbort = null;
    publishProgress({ phase: "archive_compare_cancelled" });
    return reply.send({ cancelled: true });
  }
  return reply.send({ cancelled: false });
});

server.post("/api/archive/compare", async (req, reply) => {
  const schema = z.object({
    archivePath: z.string().trim().min(1),
    directoryPath: z.string().trim().min(1)
  });
  const body = schema.parse(req.body);

  const archivePath = path.resolve(body.archivePath);
  const directoryPath = path.resolve(body.directoryPath);

  const archiveStat = await fs.stat(archivePath).catch(() => null);
  if (!archiveStat?.isFile()) {
    return reply.status(400).send({ error: `Not a file: ${archivePath}` });
  }

  const directoryStat = await fs.stat(directoryPath).catch(() => null);
  if (!directoryStat?.isDirectory()) {
    return reply.status(400).send({ error: `Not a directory: ${directoryPath}` });
  }

  const abortController = new AbortController();
  activeCompareAbort = abortController;

  try {
    publishProgress({ phase: "archive_compare_started", archivePath, directoryPath });
    const result = await compareArchiveToDirectory(archivePath, directoryPath, (event) => {
      publishProgress({ phase: "archive_compare_progress", ...event });
    }, abortController.signal);
    publishProgress({ phase: "archive_compare_complete" });
    return reply.send(result);
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      publishProgress({ phase: "archive_compare_cancelled" });
      return reply.status(499).send({ error: "Compare cancelled by user." });
    }

    const err = error as NodeJS.ErrnoException & { stderr?: string; level?: string };
    const code = err.code;
    const message = err.message ?? "Unknown archive compare error.";
    const stderr = err.stderr ?? "";
    const fullText = `${message}\n${stderr}`;

    const badRequestErrorMarkers = [
      "Unsupported archive format",
      "No .tar file found inside .tar.7z archive",
      "Unable to create extraction temp directory",
      "Can not open the file as archive",
      "Can not open the file as [7z] archive",
      "Cannot open file as archive",
      "Is not archive"
    ];

    if (badRequestErrorMarkers.some((marker) => fullText.includes(marker))) {
      return reply.status(400).send({ error: "Not a valid archive or unsupported format." });
    }

    if (code === "EACCES" || code === "EPERM") {
      return reply.status(403).send({ error: "Permission denied while comparing archive and directory." });
    }

    if (code === "ENOENT") {
      return reply.status(404).send({ error: "Archive or directory path no longer exists." });
    }

    return reply.status(500).send({ error: message });
  } finally {
    if (activeCompareAbort === abortController) {
      activeCompareAbort = null;
    }
  }
});

server.post("/api/archive/create", async (req, reply) => {
  const schema = z.object({ sourceDir: z.string(), outputArchive: z.string() });
  const body = schema.parse(req.body);
  const jobId = randomUUID();

  void createArchive(body.sourceDir, body.outputArchive).then(() => {
    publishProgress({ phase: "archive_created", jobId, outputArchive: body.outputArchive });
  });

  return reply.send({ jobId, status: "queued" });
});

server.post("/api/files/delete", async (req, reply) => {
  const schema = z.object({ path: z.string().trim().min(1) });
  const body = schema.parse(req.body);
  const targetPath = path.resolve(body.path);

  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, targetPath);
    return reply.status(response.status).send({ error: response.error });
  }

  if (!stat.isFile()) {
    return reply.status(400).send({ error: `Not a file: ${targetPath}` });
  }

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const response = toPathErrorMessage(code, targetPath);
    return reply.status(response.status).send({ error: response.error });
  }

  return reply.send({ path: targetPath, deleted: true });
});

const host = process.env.RSM_HOST ?? "0.0.0.0";
const port = Number(process.env.RSM_PORT ?? 8787);

await server.listen({ host, port });
