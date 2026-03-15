// Increment this when a breaking API change is made so client and service can
// detect mismatches at connection time.
export const SERVICE_API_VERSION = "1";

export interface HealthResponse {
  status: string;
  apiVersion: string;
}

export type FileCategory =
  | "pictures"
  | "video"
  | "audio"
  | "documents"
  | "archives"
  | "other";

export interface DuplicateScanRequest {
  roots: string[];
}

export interface BrowseDirectoriesRequest {
  path?: string;
}

export interface BrowseDirectoryEntry {
  name: string;
  path: string;
}

export interface BrowseDirectoriesResponse {
  path: string;
  parentPath: string | null;
  directories: BrowseDirectoryEntry[];
}

export interface CreateDirectoryRequest {
  parentPath: string;
  name: string;
}

export interface CreateDirectoryResponse {
  path: string;
  created: boolean;
}

export interface DuplicateGroup {
  sizeBytes: number;
  checksum: string;
  files: string[];
}

export interface DuplicateScanCacheStats {
  cachedHashes: number;
  computedHashes: number;
  staleCacheEntries: number;
  prunedCacheEntries: number;
}

export interface DuplicateScanResponse {
  groups: DuplicateGroup[];
  scannedFiles: number;
  cacheStats: DuplicateScanCacheStats;
}

export interface BulkMoveDuplicatesRequest {
  destinationRoot: string;
  groups: DuplicateGroup[];
}

export interface BulkMoveResultItem {
  source: string;
  destination: string | null;
  moved: boolean;
  error?: string;
}

export interface BulkMoveDuplicatesResponse {
  destinationRoot: string;
  keptFiles: number;
  requestedMoves: number;
  movedFiles: number;
  failedFiles: number;
  results: BulkMoveResultItem[];
}

export interface OrganizePlanItem {
  source: string;
  destination: string;
  category: FileCategory;
}

export interface OrganizePlanRequest {
  root: string;
  destination: string;
}

export interface OrganizePlanResponse {
  items: OrganizePlanItem[];
}

export interface ArchiveCompareRequest {
  archivePath: string;
  directoryPath: string;
}

export interface ArchiveCompareResponse {
  /**
   * Paths relative to the comparison directory that exist in both the archive and the
   * directory. Use these for directory operations (delete/move) and for display.
   * Indexed in parallel with `archiveDuplicateEntries`.
   */
  duplicateEntries: string[];
  /**
   * Original archive paths corresponding to `duplicateEntries` (same length, same order).
   * These may differ from `duplicateEntries` when the archive stores files under extra
   * path prefixes (e.g. archive has "backup/photos/img.jpg" while the directory has
   * "photos/img.jpg"). Pass these — not `duplicateEntries` — to in-archive deletion.
   */
  archiveDuplicateEntries: string[];
  /** @deprecated — always empty string; kept for backward compatibility. */
  archiveEntryPrefix: string;
  onlyInArchive: string[];
  onlyInDirectory: string[];
}

export interface ArchiveCreateRequest {
  sourceDir: string;
  outputArchive: string;
}

export interface BrowseEntriesFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface BrowseEntriesResponse {
  path: string;
  parentPath: string | null;
  directories: BrowseDirectoryEntry[];
  files: BrowseEntriesFile[];
}

export interface ArchiveDeleteDirectoryFilesRequest {
  directoryPath: string;
  relativePaths: string[];
}

export interface ArchiveDeleteDirectoryFilesResult {
  relativePath: string;
  success: boolean;
  error?: string;
}

export interface ArchiveDeleteDirectoryFilesResponse {
  deleted: number;
  failed: number;
  results: ArchiveDeleteDirectoryFilesResult[];
}

export interface ArchiveMoveDirectoryFilesRequest {
  directoryPath: string;
  relativePaths: string[];
  destinationRoot: string;
}

export interface ArchiveMoveDirectoryFilesResult {
  relativePath: string;
  destination: string | null;
  success: boolean;
  error?: string;
}

export interface ArchiveMoveDirectoryFilesResponse {
  moved: number;
  failed: number;
  destinationRoot: string;
  results: ArchiveMoveDirectoryFilesResult[];
}

export interface ArchiveDeleteEntriesRequest {
  archivePath: string;
  entries: string[];
}

export interface ArchiveDeleteEntriesResponse {
  removed: number;
  failed: number;
  archivePath: string;
  supported: boolean;
  error?: string;
}

export interface JobAcceptedResponse {
  jobId: string;
  status: "queued";
}

export interface DeleteFileRequest {
  path: string;
}

export interface DeleteFileResponse {
  path: string;
  deleted: boolean;
}
