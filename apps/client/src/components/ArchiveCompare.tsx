import { useMemo, useState } from "react";
import axios from "axios";
import type {
  ArchiveCompareResponse,
  ArchiveDeleteDirectoryFilesResponse,
  ArchiveMoveDirectoryFilesResponse,
  ArchiveDeleteEntriesResponse,
  BrowseDirectoryEntry,
  BrowseEntriesFile,
  BrowseEntriesResponse,
  BrowseDirectoriesResponse,
  CreateDirectoryResponse
} from "@rsm/shared";
import "./ArchiveCompare.css";

const ARCHIVE_EXTENSIONS = ".zip,.7z,.rar,.tar,.tar.gz,.tgz,.tar.bz2,.tbz2,.tar.7z";
const ENTRIES_PREVIEW_LIMIT = 200;

interface Props {
  onCompare: (archivePath: string, directoryPath: string) => Promise<ArchiveCompareResponse>;
  onBrowseEntries: (path?: string, fileExtensions?: string) => Promise<BrowseEntriesResponse>;
  onBrowseDirectories: (path?: string) => Promise<BrowseDirectoriesResponse>;
  onCreateDirectory: (parentPath: string, name: string) => Promise<CreateDirectoryResponse>;
  onDeleteDirectoryFiles: (
    directoryPath: string,
    relativePaths: string[]
  ) => Promise<ArchiveDeleteDirectoryFilesResponse>;
  onMoveDirectoryFiles: (
    directoryPath: string,
    relativePaths: string[],
    destinationRoot: string
  ) => Promise<ArchiveMoveDirectoryFilesResponse>;
  onDeleteArchiveEntries: (
    archivePath: string,
    entries: string[]
  ) => Promise<ArchiveDeleteEntriesResponse>;
  onCancelCompare: () => Promise<unknown>;
  compareProgress?: string | null;
}

type ActiveBrowser = "archive" | "directory" | "move-dest" | null;
type PendingConfirm = "delete-dir" | "delete-archive" | null;

function toApiErrorMessage(error: unknown, fallback: string, contextPath?: string): string {
  const context = contextPath ? ` (${contextPath})` : "";

  if (axios.isAxiosError(error)) {
    const payload = error.response?.data;
    const apiMessage =
      typeof payload === "string"
        ? payload
        : (payload as { error?: string; message?: string } | undefined)?.error ??
          (payload as { error?: string; message?: string } | undefined)?.message;

    if (apiMessage) {
      const status = error.response?.status ? ` (HTTP ${error.response.status})` : "";
      return `${apiMessage}${status}`;
    }

    if (error.message) {
      return `${fallback}${context}: ${error.message}`;
    }

    return `${fallback}${context}`;
  }

  if (error instanceof Error && error.message) {
    return `${fallback}${context}: ${error.message}`;
  }

  return `${fallback}${context}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pathSegments(input: string): string[] {
  return input.replace(/\\/g, "/").split("/").filter(Boolean);
}

function buildPathFromSegments(segments: string[]): string {
  return `/${segments.join("/")}`;
}

function parentDirectoryPath(input: string): string | null {
  const normalized = input.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  if (normalized === "/") return null;

  const pieces = normalized.split("/").filter(Boolean);
  if (pieces.length === 0) return "/";

  pieces.pop();
  return pieces.length === 0 ? "/" : `/${pieces.join("/")}`;
}

function FileBrowser({
  title,
  currentPath,
  parentPath,
  directories,
  files,
  highlightedPath,
  highlightedFile,
  isLoading,
  error,
  newFolderName,
  showCreateFolder,
  onNavigate,
  onSelectDir,
  onSelectFile,
  onNewFolderNameChange,
  onCreateFolder,
  onConfirm,
  onCancel,
  confirmLabel
}: {
  title: string;
  currentPath: string;
  parentPath: string | null;
  directories: BrowseDirectoryEntry[];
  files: BrowseEntriesFile[];
  highlightedPath: string;
  highlightedFile: string | null;
  isLoading: boolean;
  error: string | null;
  newFolderName: string;
  showCreateFolder: boolean;
  onNavigate: (path: string) => void;
  onSelectDir: (path: string) => void;
  onSelectFile?: (file: BrowseEntriesFile) => void;
  onNewFolderNameChange: (value: string) => void;
  onCreateFolder: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
}) {
  const breadcrumbs = useMemo(() => {
    const segments = pathSegments(currentPath);
    const items = [{ label: "/", path: "/" }];
    for (let i = 0; i < segments.length; i += 1) {
      items.push({ label: segments[i], path: buildPathFromSegments(segments.slice(0, i + 1)) });
    }
    return items;
  }, [currentPath]);

  return (
    <div className="archiveCompareBrowserPanel">
      <div className="archiveCompareBrowserToolbar">
        {parentPath && (
          <button className="archiveCompareButton" onClick={() => onNavigate(parentPath)} disabled={isLoading}>
            ↑ Up
          </button>
        )}
        <button
          className="archiveCompareButton archiveCompareButtonPrimary"
          onClick={onConfirm}
          disabled={isLoading}
        >
          {confirmLabel}
        </button>
        <button className="archiveCompareButton" onClick={onCancel} disabled={isLoading}>
          Cancel
        </button>
        <strong style={{ alignSelf: "center", fontSize: "0.86rem", color: "#2a4864" }}>{title}</strong>
      </div>

      <div className="archiveCompareBreadcrumbs">
        {breadcrumbs.map((crumb) => (
          <button
            key={crumb.path}
            className={`archiveCompareBreadcrumbBtn${crumb.path === currentPath ? " archiveCompareBreadcrumbBtnActive" : ""}`}
            onClick={() => onNavigate(crumb.path)}
          >
            {crumb.label}
          </button>
        ))}
      </div>

      <div className="archiveCompareCurrentPath" title={currentPath}>
        {currentPath}
      </div>

      {error && <div className="archiveCompareError">{error}</div>}
      {isLoading && <div className="archiveCompareBrowserStatus">Loading…</div>}

      {!isLoading && (
        <ul className="archiveCompareBrowserList">
          {directories.map((dir) => (
            <li key={dir.path}>
              <button
                className={`archiveCompareBrowserRow${highlightedPath === dir.path ? " archiveCompareBrowserRowSelected" : ""}`}
                onClick={() => {
                  onSelectDir(dir.path);
                  onNavigate(dir.path);
                }}
              >
                <span className="archiveCompareBrowserIcon">📁</span>
                <span className="archiveCompareBrowserName">{dir.name}</span>
              </button>
            </li>
          ))}
          {files.map((file) => (
            <li key={file.path}>
              <button
                className={`archiveCompareBrowserRow archiveCompareBrowserRowFile${highlightedFile === file.path ? " archiveCompareBrowserRowSelected" : ""}`}
                onClick={() => onSelectFile?.(file)}
              >
                <span className="archiveCompareBrowserIcon">🗜️</span>
                <span className="archiveCompareBrowserName archiveCompareBrowserNameFile">
                  {file.name}
                  <span style={{ color: "#7a9a7a", marginLeft: "0.5em", fontWeight: 400 }}>
                    ({formatBytes(file.sizeBytes)})
                  </span>
                </span>
              </button>
            </li>
          ))}
          {directories.length === 0 && files.length === 0 && (
            <li style={{ padding: "0.3rem 0.42rem", color: "#7a8fa5", fontSize: "0.82rem" }}>
              No items found.
            </li>
          )}
        </ul>
      )}

      {showCreateFolder && (
        <div className="archiveCompareCreateFolderRow">
          <input
            className="archiveCompareCreateFolderInput"
            placeholder="New folder name…"
            value={newFolderName}
            onChange={(e) => onNewFolderNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCreateFolder();
            }}
          />
          <button
            className="archiveCompareButton archiveCompareButtonPrimary"
            onClick={onCreateFolder}
            disabled={!newFolderName.trim() || isLoading}
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({
  title,
  count,
  badgeClass,
  expanded,
  onToggle,
  children
}: {
  title: string;
  count: number;
  badgeClass: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="archiveCompareSection">
      <div className="archiveCompareSectionHeader" onClick={onToggle}>
        <span className="archiveCompareSectionTitle">{title}</span>
        <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span className={`archiveCompareSummaryBadge ${badgeClass}`}>{count}</span>
          <span className="archiveCompareSectionToggle">{expanded ? "▲" : "▼"}</span>
        </span>
      </div>
      {expanded && children}
    </div>
  );
}

export function ArchiveCompare({
  onCompare,
  onBrowseEntries,
  onBrowseDirectories,
  onCreateDirectory,
  onDeleteDirectoryFiles,
  onMoveDirectoryFiles,
  onDeleteArchiveEntries,
  onCancelCompare,
  compareProgress
}: Props) {
  const [archivePath, setArchivePath] = useState("");
  const [directoryPath, setDirectoryPath] = useState("");

  const [isComparing, setIsComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<ArchiveCompareResponse | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  const [isActing, setIsActing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);

  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);
  const [activeBrowser, setActiveBrowser] = useState<ActiveBrowser>(null);

  // Browser state (shared for archive picker, dir picker, move destination)
  const [browserPath, setBrowserPath] = useState("/");
  const [browserParent, setBrowserParent] = useState<string | null>(null);
  const [browserDirs, setBrowserDirs] = useState<BrowseDirectoryEntry[]>([]);
  const [browserFiles, setBrowserFiles] = useState<BrowseEntriesFile[]>([]);
  const [isBrowserLoading, setIsBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [browserHighlightedDir, setBrowserHighlightedDir] = useState("/");
  const [browserHighlightedFile, setBrowserHighlightedFile] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  const [duplicatesExpanded, setDuplicatesExpanded] = useState(true);
  const [archiveOnlyExpanded, setArchiveOnlyExpanded] = useState(false);
  const [dirOnlyExpanded, setDirOnlyExpanded] = useState(false);

  const loadBrowserEntries = async (targetPath: string, forBrowser: ActiveBrowser) => {
    setIsBrowserLoading(true);
    setBrowserError(null);
    try {
      const runBrowse = async (pathValue: string) => {
        if (forBrowser === "archive") {
          return onBrowseEntries(pathValue, ARCHIVE_EXTENSIONS);
        }
        const dirRes = await onBrowseDirectories(pathValue);
        return { ...dirRes, files: [] };
      };

      let res: Awaited<ReturnType<typeof runBrowse>>;
      try {
        res = await runBrowse(targetPath);
      } catch (error) {
        const message = toApiErrorMessage(error, "Failed to load directory.", targetPath);
        const retryPaths: string[] = [];

        if (/not a directory/i.test(message)) {
          const parent = parentDirectoryPath(targetPath);
          if (parent && parent !== targetPath) {
            retryPaths.push(parent);
          }
        }

        // If the current start path is invalid for this service host, fall back to root.
        if (targetPath !== "/") {
          retryPaths.push("/");
        }

        let recovered: Awaited<ReturnType<typeof runBrowse>> | null = null;
        for (const retryPath of retryPaths) {
          try {
            recovered = await runBrowse(retryPath);
            break;
          } catch {
            // Continue through fallback candidates and surface original error if none succeed.
          }
        }

        if (!recovered) {
          throw error;
        }

        res = recovered;
      }

      setBrowserPath(res.path);
      setBrowserParent(res.parentPath);
      setBrowserDirs(res.directories);
      setBrowserFiles(res.files);
      setBrowserHighlightedDir(res.path);
      setBrowserHighlightedFile(null);
    } catch (error) {
      setBrowserError(toApiErrorMessage(error, "Failed to load directory.", targetPath));
    } finally {
      setIsBrowserLoading(false);
    }
  };

  const openBrowser = (mode: ActiveBrowser, startPath?: string) => {
    setActiveBrowser(mode);
    setBrowserError(null);
    setNewFolderName("");
    const initial = startPath ?? "/";
    void loadBrowserEntries(initial, mode);
  };

  const closeBrowser = () => {
    setActiveBrowser(null);
    setBrowserFiles([]);
    setBrowserDirs([]);
  };

  const handleCompare = async () => {
    if (isComparing) return;
    const ap = archivePath.trim();
    const dp = directoryPath.trim();
    if (!ap || !dp) {
      setCompareError("Enter both an archive path and a directory path before comparing.");
      return;
    }
    setIsComparing(true);
    setCompareResult(null);
    setCompareError(null);
    setActionMessage(null);
    setActionError(null);
    setActionWarning(null);
    try {
      const result = await onCompare(ap, dp);
      setCompareResult(result);
      setDuplicatesExpanded(result.duplicateEntries.length > 0);
      setArchiveOnlyExpanded(false);
      setDirOnlyExpanded(false);
    } catch (error) {
      // Don't show error when cancelled by user
      if (axios.isAxiosError(error) && error.response?.status === 499) {
        setCompareError(null);
      } else {
        setCompareError(toApiErrorMessage(error, "Comparison failed. Check the paths and try again."));
      }
    } finally {
      setIsComparing(false);
    }
  };

  const handleCancelCompare = async () => {
    try {
      await onCancelCompare();
    } catch {
      // Best-effort cancel
    }
  };

  const handleDeleteFromDirectory = async () => {
    if (!compareResult || isActing) return;
    setIsActing(true);
    setPendingConfirm(null);
    setActionMessage(null);
    setActionError(null);
    setActionWarning(null);
    try {
      const res = await onDeleteDirectoryFiles(directoryPath.trim(), compareResult.duplicateEntries);
      setActionMessage(
        `Deleted ${res.deleted} of ${compareResult.duplicateEntries.length} duplicate files from the directory.` +
        (res.failed > 0 ? ` ${res.failed} failed.` : "")
      );
      if (res.failed > 0) {
        setActionError(`${res.failed} file(s) could not be deleted. Check permissions.`);
      }
      setCompareResult((prev) =>
        prev
          ? {
              ...prev,
              duplicateEntries: prev.duplicateEntries.filter((e) =>
                res.results.some((r: ArchiveDeleteDirectoryFilesResponse["results"][number]) => r.relativePath === e && !r.success)
              ),
              onlyInDirectory: prev.onlyInDirectory
            }
          : prev
      );
    } catch (error) {
      setActionError(toApiErrorMessage(error, "Delete from directory failed."));
    } finally {
      setIsActing(false);
    }
  };

  const handleMoveFromDirectory = async (destinationRoot: string) => {
    if (!compareResult || isActing) return;
    setActiveBrowser(null);
    setIsActing(true);
    setActionMessage(null);
    setActionError(null);
    setActionWarning(null);
    try {
      const res = await onMoveDirectoryFiles(
        directoryPath.trim(),
        compareResult.duplicateEntries,
        destinationRoot
      );
      setActionMessage(
        `Moved ${res.moved} of ${compareResult.duplicateEntries.length} duplicate files to ${res.destinationRoot}.` +
        (res.failed > 0 ? ` ${res.failed} failed.` : "")
      );
      if (res.failed > 0) {
        setActionError(`${res.failed} file(s) could not be moved. Check permissions.`);
      }
      const movedPaths = new Set(
        res.results.filter((r: ArchiveMoveDirectoryFilesResponse["results"][number]) => r.success).map((r: ArchiveMoveDirectoryFilesResponse["results"][number]) => r.relativePath)
      );
      setCompareResult((prev) =>
        prev
          ? {
              ...prev,
              duplicateEntries: prev.duplicateEntries.filter((e) => !movedPaths.has(e))
            }
          : prev
      );
    } catch (error) {
      setActionError(toApiErrorMessage(error, "Move from directory failed."));
    } finally {
      setIsActing(false);
    }
  };

  const handleDeleteFromArchive = async () => {
    if (!compareResult || isActing) return;
    setIsActing(true);
    setPendingConfirm(null);
    setActionMessage("Removing entries from archive… This may take a while for tar/7z formats.");
    setActionError(null);
    setActionWarning(null);
    try {
      // archiveDuplicateEntries holds the original archive paths (may differ from the
      // directory-relative paths in duplicateEntries when the archive has extra prefixes).
      const archiveEntries = compareResult.archiveDuplicateEntries?.length
        ? compareResult.archiveDuplicateEntries
        : compareResult.duplicateEntries;
      const res = await onDeleteArchiveEntries(archivePath.trim(), archiveEntries);
      if (!res.supported) {
        setActionWarning(res.error ?? "In-archive deletion is not supported for this archive format.");
      } else {
        setActionMessage(
          `Removed ${res.removed} of ${compareResult.duplicateEntries.length} entries from the archive.` +
          (res.failed > 0 ? ` ${res.failed} failed.` : "")
        );
        if (res.failed > 0) {
          setActionError(`${res.failed} entries could not be removed.`);
        }
        setCompareResult((prev) =>
          prev
            ? {
                ...prev,
                duplicateEntries: res.failed === 0 ? [] : prev.duplicateEntries,
                onlyInArchive: prev.onlyInArchive
              }
            : prev
        );
      }
    } catch (error) {
      const msg = toApiErrorMessage(error, "Delete from archive failed.");
      if (msg.toLowerCase().includes("not supported")) {
        setActionWarning(msg);
      } else {
        setActionError(msg);
      }
    } finally {
      setIsActing(false);
    }
  };

  const createFolderInBrowser = async () => {
    const name = newFolderName.trim();
    if (!name || isBrowserLoading) return;
    try {
      const res = await onCreateDirectory(browserPath, name);
      setNewFolderName("");
      await loadBrowserEntries(browserPath, activeBrowser);
      setBrowserHighlightedDir(res.path);
    } catch (error) {
      setBrowserError(toApiErrorMessage(error, "Unable to create folder."));
    }
  };

  const isBusy = isComparing || isActing;

  return (
    <section className="archiveCompare">
      <h2>Archive Compare</h2>

      <div className="archiveCompareFormGrid">
        <div>
          <label className="archiveCompareFieldLabel" htmlFor="ac-archive-path">
            Archive file (.zip, .7z, .rar, .tar, .tar.gz, .tar.bz2, .tar.7z)
          </label>
          <div className="archiveCompareInputRow">
            <input
              id="ac-archive-path"
              className="archiveCompareInput"
              value={archivePath}
              disabled={isBusy}
              onChange={(e) => setArchivePath(e.target.value)}
              placeholder="/path/to/archive.zip"
            />
            <button
              className="archiveCompareButton"
              disabled={isBusy}
              onClick={() => openBrowser("archive", archivePath || undefined)}
            >
              Browse
            </button>
          </div>
          {activeBrowser === "archive" && (
            <FileBrowser
              title="Select archive file"
              currentPath={browserPath}
              parentPath={browserParent}
              directories={browserDirs}
              files={browserFiles}
              highlightedPath={browserHighlightedDir}
              highlightedFile={browserHighlightedFile}
              isLoading={isBrowserLoading}
              error={browserError}
              newFolderName={newFolderName}
              showCreateFolder={false}
              onNavigate={(p) => void loadBrowserEntries(p, "archive")}
              onSelectDir={(p) => setBrowserHighlightedDir(p)}
              onSelectFile={(file) => {
                setArchivePath(file.path);
                setBrowserHighlightedFile(file.path);
                closeBrowser();
              }}
              onNewFolderNameChange={setNewFolderName}
              onCreateFolder={() => void createFolderInBrowser()}
              onConfirm={() => {
                if (browserHighlightedFile) {
                  setArchivePath(browserHighlightedFile);
                }
                closeBrowser();
              }}
              onCancel={closeBrowser}
              confirmLabel={browserHighlightedFile ? "Use selected file" : "Cancel"}
            />
          )}
        </div>

        <div>
          <label className="archiveCompareFieldLabel" htmlFor="ac-dir-path">
            Directory to compare against
          </label>
          <div className="archiveCompareInputRow">
            <input
              id="ac-dir-path"
              className="archiveCompareInput"
              value={directoryPath}
              disabled={isBusy}
              onChange={(e) => setDirectoryPath(e.target.value)}
              placeholder="/path/to/directory"
            />
            <button
              className="archiveCompareButton"
              disabled={isBusy}
              onClick={() => openBrowser("directory", directoryPath || undefined)}
            >
              Browse
            </button>
          </div>
          {activeBrowser === "directory" && (
            <FileBrowser
              title="Select directory"
              currentPath={browserPath}
              parentPath={browserParent}
              directories={browserDirs}
              files={browserFiles}
              highlightedPath={browserHighlightedDir}
              highlightedFile={null}
              isLoading={isBrowserLoading}
              error={browserError}
              newFolderName={newFolderName}
              showCreateFolder={false}
              onNavigate={(p) => void loadBrowserEntries(p, "directory")}
              onSelectDir={(p) => setBrowserHighlightedDir(p)}
              onNewFolderNameChange={setNewFolderName}
              onCreateFolder={() => void createFolderInBrowser()}
              onConfirm={() => {
                setDirectoryPath(browserHighlightedDir);
                closeBrowser();
              }}
              onCancel={closeBrowser}
              confirmLabel="Use this folder"
            />
          )}
        </div>
      </div>

      <div className="archiveCompareActions">
        <button
          className="archiveCompareButton archiveCompareButtonPrimary"
          disabled={isBusy}
          onClick={() => void handleCompare()}
        >
          {isComparing ? "Comparing…" : "Compare"}
        </button>        {isComparing && (
          <button
            className="archiveCompareButton archiveCompareButtonDanger"
            onClick={() => void handleCancelCompare()}
          >
            Stop
          </button>
        )}        {compareResult && !isBusy && (
          <button
            className="archiveCompareButton"
            onClick={() => {
              setCompareResult(null);
              setActionMessage(null);
              setActionError(null);
              setActionWarning(null);
              setPendingConfirm(null);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {isComparing && compareProgress && (
        <div className="archiveCompareProgressStatus">{compareProgress}</div>
      )}

      {compareError && <div className="archiveCompareError">{compareError}</div>}
      {actionMessage && <div className="archiveCompareMessage">{actionMessage}</div>}
      {actionWarning && <div className="archiveCompareWarning">{actionWarning}</div>}
      {actionError && <div className="archiveCompareError">{actionError}</div>}

      {compareResult && (
        <>
          <div className="archiveCompareSummary">
            <span className="archiveCompareSummaryBadge archiveCompareSummaryBadgeDuplicate">
              {compareResult.duplicateEntries.length} duplicate{compareResult.duplicateEntries.length !== 1 ? "s" : ""}
            </span>
            <span className="archiveCompareSummaryBadge archiveCompareSummaryBadgeArchiveOnly">
              {compareResult.onlyInArchive.length} only in archive
            </span>
            <span className="archiveCompareSummaryBadge archiveCompareSummaryBadgeDirOnly">
              {compareResult.onlyInDirectory.length} only in directory
            </span>
          </div>

          {/* Duplicates section */}
          <CollapsibleSection
            title="Duplicates"
            count={compareResult.duplicateEntries.length}
            badgeClass="archiveCompareSummaryBadgeDuplicate"
            expanded={duplicatesExpanded}
            onToggle={() => setDuplicatesExpanded((v) => !v)}
          >
            {compareResult.duplicateEntries.length === 0 ? (
              <div style={{ padding: "0.55rem 0.75rem", color: "#56677a", fontSize: "0.86rem" }}>
                No duplicates found.
              </div>
            ) : (
              <>
                <ul className="archiveCompareEntryList">
                  {compareResult.duplicateEntries.slice(0, ENTRIES_PREVIEW_LIMIT).map((entry) => (
                    <li key={entry} className="archiveCompareEntry" title={entry}>
                      {entry}
                    </li>
                  ))}
                  {compareResult.duplicateEntries.length > ENTRIES_PREVIEW_LIMIT && (
                    <li className="archiveCompareEntryMore">
                      … and {compareResult.duplicateEntries.length - ENTRIES_PREVIEW_LIMIT} more
                    </li>
                  )}
                </ul>

                <div className="archiveCompareDuplicateActions">
                  {pendingConfirm === "delete-dir" ? (
                    <div className="archiveCompareConfirmRow">
                      <span>
                        Delete {compareResult.duplicateEntries.length} file
                        {compareResult.duplicateEntries.length !== 1 ? "s" : ""} from the directory? This cannot be undone.
                      </span>
                      <button
                        className="archiveCompareButton archiveCompareButtonDanger"
                        disabled={isActing}
                        onClick={() => void handleDeleteFromDirectory()}
                      >
                        {isActing ? "Deleting…" : "Confirm Delete"}
                      </button>
                      <button
                        className="archiveCompareButton"
                        disabled={isActing}
                        onClick={() => setPendingConfirm(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : pendingConfirm === "delete-archive" ? (
                    <div className="archiveCompareConfirmRow">
                      <span>
                        Remove {compareResult.duplicateEntries.length} entr
                        {compareResult.duplicateEntries.length !== 1 ? "ies" : "y"} from the archive? ZIP only. This cannot be undone.
                      </span>
                      <button
                        className="archiveCompareButton archiveCompareButtonDanger"
                        disabled={isActing}
                        onClick={() => void handleDeleteFromArchive()}
                      >
                        {isActing ? "Removing…" : "Confirm Remove"}
                      </button>
                      <button
                        className="archiveCompareButton"
                        disabled={isActing}
                        onClick={() => setPendingConfirm(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : activeBrowser === "move-dest" ? (
                    <div style={{ width: "100%" }}>
                      <FileBrowser
                        title="Move duplicates to…"
                        currentPath={browserPath}
                        parentPath={browserParent}
                        directories={browserDirs}
                        files={[]}
                        highlightedPath={browserHighlightedDir}
                        highlightedFile={null}
                        isLoading={isBrowserLoading}
                        error={browserError}
                        newFolderName={newFolderName}
                        showCreateFolder={true}
                        onNavigate={(p) => void loadBrowserEntries(p, "move-dest")}
                        onSelectDir={(p) => setBrowserHighlightedDir(p)}
                        onNewFolderNameChange={setNewFolderName}
                        onCreateFolder={() => void createFolderInBrowser()}
                        onConfirm={() => void handleMoveFromDirectory(browserHighlightedDir)}
                        onCancel={closeBrowser}
                        confirmLabel={
                          isActing
                            ? "Moving…"
                            : `Move ${compareResult.duplicateEntries.length} file${compareResult.duplicateEntries.length !== 1 ? "s" : ""} here`
                        }
                      />
                    </div>
                  ) : (
                    <>
                      <button
                        className="archiveCompareButton archiveCompareButtonDanger"
                        disabled={isBusy || compareResult.duplicateEntries.length === 0}
                        onClick={() => setPendingConfirm("delete-dir")}
                      >
                        Delete from Directory
                      </button>
                      <button
                        className="archiveCompareButton archiveCompareButtonWarning"
                        disabled={isBusy || compareResult.duplicateEntries.length === 0}
                        onClick={() => openBrowser("move-dest", directoryPath || undefined)}
                      >
                        Move to Review Folder
                      </button>
                      <button
                        className="archiveCompareButton archiveCompareButtonDanger"
                        disabled={isBusy || compareResult.duplicateEntries.length === 0}
                        onClick={() => setPendingConfirm("delete-archive")}
                        title="Only supported for ZIP archives"
                      >
                        Delete from Archive
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </CollapsibleSection>

          {/* Only in archive */}
          <CollapsibleSection
            title="Only in Archive"
            count={compareResult.onlyInArchive.length}
            badgeClass="archiveCompareSummaryBadgeArchiveOnly"
            expanded={archiveOnlyExpanded}
            onToggle={() => setArchiveOnlyExpanded((v) => !v)}
          >
            <ul className="archiveCompareEntryList">
              {compareResult.onlyInArchive.slice(0, ENTRIES_PREVIEW_LIMIT).map((entry) => (
                <li key={entry} className="archiveCompareEntry" title={entry}>
                  {entry}
                </li>
              ))}
              {compareResult.onlyInArchive.length > ENTRIES_PREVIEW_LIMIT && (
                <li className="archiveCompareEntryMore">
                  … and {compareResult.onlyInArchive.length - ENTRIES_PREVIEW_LIMIT} more
                </li>
              )}
              {compareResult.onlyInArchive.length === 0 && (
                <li style={{ padding: "0.3rem 0.42rem", color: "#7a8fa5", fontSize: "0.82rem" }}>
                  None.
                </li>
              )}
            </ul>
          </CollapsibleSection>

          {/* Only in directory */}
          <CollapsibleSection
            title="Only in Directory"
            count={compareResult.onlyInDirectory.length}
            badgeClass="archiveCompareSummaryBadgeDirOnly"
            expanded={dirOnlyExpanded}
            onToggle={() => setDirOnlyExpanded((v) => !v)}
          >
            <ul className="archiveCompareEntryList">
              {compareResult.onlyInDirectory.slice(0, ENTRIES_PREVIEW_LIMIT).map((entry) => (
                <li key={entry} className="archiveCompareEntry" title={entry}>
                  {entry}
                </li>
              ))}
              {compareResult.onlyInDirectory.length > ENTRIES_PREVIEW_LIMIT && (
                <li className="archiveCompareEntryMore">
                  … and {compareResult.onlyInDirectory.length - ENTRIES_PREVIEW_LIMIT} more
                </li>
              )}
              {compareResult.onlyInDirectory.length === 0 && (
                <li style={{ padding: "0.3rem 0.42rem", color: "#7a8fa5", fontSize: "0.82rem" }}>
                  None.
                </li>
              )}
            </ul>
          </CollapsibleSection>
        </>
      )}
    </section>
  );
}
