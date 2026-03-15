import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface FileFingerprint {
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface FileMetadataCacheStats {
  cachedHashes: number;
  computedHashes: number;
  staleCacheEntries: number;
  prunedCacheEntries: number;
}

interface FileMetadataRecord extends FileFingerprint {
  checksum: string;
  updatedAt: string;
}

interface FileMetadataDatabaseShape {
  version: 1;
  entries: Record<string, FileMetadataRecord>;
}

const DATABASE_VERSION = 1;
const DEFAULT_DATABASE_PATH = path.join(process.cwd(), ".rsm", "file-metadata.db");
const LEGACY_DATABASE_PATH = path.join(process.cwd(), ".rsm", "file-metadata-db.json");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFileMetadataRecord(value: unknown): value is FileMetadataRecord {
  if (!isObject(value)) return false;

  return (
    isFiniteNumber(value.sizeBytes) &&
    isFiniteNumber(value.mtimeMs) &&
    isFiniteNumber(value.ctimeMs) &&
    typeof value.checksum === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isWithinRoot(filePath: string, root: string): boolean {
  const relativePath = path.relative(root, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function matchesFingerprint(record: FileFingerprint, fingerprint: FileFingerprint): boolean {
  return (
    record.sizeBytes === fingerprint.sizeBytes &&
    record.mtimeMs === fingerprint.mtimeMs &&
    record.ctimeMs === fingerprint.ctimeMs
  );
}

export class FileMetadataDatabase {
  private readonly db: Database.Database;
  private readonly selectChecksumStatement;
  private readonly upsertStatement;
  private readonly deleteStatement;
  private readonly listPathsStatement;

  constructor(private readonly databasePath = DEFAULT_DATABASE_PATH) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_metadata (
        path TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        ctime_ms REAL NOT NULL,
        checksum TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.selectChecksumStatement = this.db.prepare(
      `
        SELECT checksum, size_bytes AS sizeBytes, mtime_ms AS mtimeMs, ctime_ms AS ctimeMs
        FROM file_metadata
        WHERE path = ?
      `
    );
    this.upsertStatement = this.db.prepare(
      `
        INSERT INTO file_metadata (path, size_bytes, mtime_ms, ctime_ms, checksum, updated_at)
        VALUES (@path, @sizeBytes, @mtimeMs, @ctimeMs, @checksum, @updatedAt)
        ON CONFLICT(path) DO UPDATE SET
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          ctime_ms = excluded.ctime_ms,
          checksum = excluded.checksum,
          updated_at = excluded.updated_at
      `
    );
    this.deleteStatement = this.db.prepare("DELETE FROM file_metadata WHERE path = ?");
    this.listPathsStatement = this.db.prepare("SELECT path FROM file_metadata");
  }

  static async open(databasePath = DEFAULT_DATABASE_PATH): Promise<FileMetadataDatabase> {
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const database = new FileMetadataDatabase(databasePath);
    await database.importLegacyJsonCache();
    return database;
  }

  get path(): string {
    return this.databasePath;
  }

  private async importLegacyJsonCache(): Promise<void> {
    const hasRows = this.db.prepare("SELECT 1 FROM file_metadata LIMIT 1").get() as { 1: number } | undefined;
    if (hasRows) return;

    const content = await fs.readFile(LEGACY_DATABASE_PATH, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    });
    if (!content) return;

    try {
      const parsed = JSON.parse(content) as FileMetadataDatabaseShape;
      if (parsed.version !== DATABASE_VERSION || !isObject(parsed.entries)) {
        return;
      }

      const records = Object.entries(parsed.entries).filter((entry): entry is [string, FileMetadataRecord] =>
        isFileMetadataRecord(entry[1])
      );

      const transaction = this.db.transaction((items: Array<[string, FileMetadataRecord]>) => {
        for (const [filePath, record] of items) {
          this.upsertStatement.run({ path: filePath, ...record });
        }
      });

      transaction(records);
    } catch {
      return;
    }
  }

  lookupChecksum(
    filePath: string,
    fingerprint: FileFingerprint
  ): { checksum: string | null; stale: boolean } {
    const record = this.selectChecksumStatement.get(filePath) as
      | (FileFingerprint & { checksum: string })
      | undefined;
    if (!record) {
      return { checksum: null, stale: false };
    }

    if (!matchesFingerprint(record, fingerprint)) {
      return { checksum: null, stale: true };
    }

    return { checksum: record.checksum, stale: false };
  }

  setChecksum(filePath: string, fingerprint: FileFingerprint, checksum: string): void {
    this.upsertStatement.run({
      path: filePath,
      ...fingerprint,
      checksum,
      updatedAt: new Date().toISOString()
    });
  }

  delete(filePath: string): void {
    this.deleteStatement.run(filePath);
  }

  pruneRoots(roots: string[], seenPaths: Iterable<string>): number {
    const seen = new Set(seenPaths);
    let removed = 0;

    const rows = this.listPathsStatement.all() as Array<{ path: string }>;
    for (const { path: filePath } of rows) {
      const belongsToScannedRoot = roots.some((root) => isWithinRoot(filePath, root));
      if (!belongsToScannedRoot || seen.has(filePath)) continue;

      this.deleteStatement.run(filePath);
      removed += 1;
    }

    return removed;
  }

  async save(): Promise<void> {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.db.close();
  }
}