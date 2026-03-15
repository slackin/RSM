import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import type {
  BrowseDirectoriesResponse,
  BulkMoveDuplicatesResponse,
  CreateDirectoryResponse,
  DuplicateScanResponse
} from "@rsm/shared";
import "./DuplicateReview.css";

interface Props {
  result: DuplicateScanResponse | null;
  onDeleteFile: (path: string) => Promise<{ deleted: boolean }>;
  onBrowseDirectories: (path?: string) => Promise<BrowseDirectoriesResponse>;
  onCreateDirectory: (parentPath: string, name: string) => Promise<CreateDirectoryResponse>;
  onBulkMoveDuplicates: (destinationRoot: string) => Promise<BulkMoveDuplicatesResponse>;
}

const GROUPS_PER_PAGE = 40;
const FILES_PREVIEW_LIMIT = 20;

function toDeleteErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const payload = error.response?.data as { error?: string; message?: string } | undefined;
    return payload?.error ?? payload?.message ?? "Delete failed due to a server error.";
  }

  return "Delete failed. Try again.";
}

function toActionErrorMessage(error: unknown, fallback: string): string {
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
      return `${fallback}: ${error.message}`;
    }

    return fallback;
  }

  if (error instanceof Error && error.message) {
    return `${fallback}: ${error.message}`;
  }

  return fallback;
}

function directoryFromPath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return normalized.slice(0, lastSlash);
}

function pathSegments(input: string): string[] {
  return input.replace(/\\/g, "/").split("/").filter(Boolean);
}

function buildPathFromSegments(segments: string[]): string {
  return `/${segments.join("/")}`;
}

function parentDirectoryPath(input: string): string | null {
  const normalized = input.trim().replace(/\\/g, "/");
  if (!normalized || normalized === "/") return null;

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function DuplicateReview({
  result,
  onDeleteFile,
  onBrowseDirectories,
  onCreateDirectory,
  onBulkMoveDuplicates
}: Props) {
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [isMovingDuplicates, setIsMovingDuplicates] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const [isLoadingBrowser, setIsLoadingBrowser] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("/");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [highlightedPath, setHighlightedPath] = useState("/");
  const [directories, setDirectories] = useState<BrowseDirectoriesResponse["directories"]>([]);
  const [newFolderName, setNewFolderName] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => result?.groups ?? [], [result]);
  const duplicateMoveCount = useMemo(
    () => groups.reduce((total, group) => total + Math.max(0, group.files.length - 1), 0),
    [groups]
  );

  useEffect(() => {
    setCurrentPage(1);
    setExpandedGroups({});
  }, [groups.length]);

  const totalPages = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  const pagedGroups = useMemo(() => {
    const startIndex = (currentPage - 1) * GROUPS_PER_PAGE;
    return groups.slice(startIndex, startIndex + GROUPS_PER_PAGE);
  }, [currentPage, groups]);

  const pageStartIndex = (currentPage - 1) * GROUPS_PER_PAGE;

  const toggleGroupExpansion = (groupKey: string) => {
    setExpandedGroups((previous) => ({
      ...previous,
      [groupKey]: !previous[groupKey]
    }));
  };

  const handleDelete = async (targetPath: string) => {
    if (deletingPath) return;

    setDeletingPath(targetPath);
    setMessage(null);
    setError(null);

    try {
      await onDeleteFile(targetPath);
      setMessage(`Deleted ${targetPath}`);
    } catch (deleteError) {
      setError(toDeleteErrorMessage(deleteError));
    } finally {
      setDeletingPath(null);
    }
  };

  const loadDirectories = async (targetPath?: string) => {
    setIsLoadingBrowser(true);
    setBrowserError(null);

    const requestedPath = targetPath?.trim();

    try {
      let response: BrowseDirectoriesResponse | null = null;

      try {
        response = await onBrowseDirectories(requestedPath);
      } catch (initialError) {
        const retryCandidates = [parentDirectoryPath(requestedPath ?? ""), "/"].filter(
          (candidate): candidate is string => Boolean(candidate)
        );

        const attempted = new Set<string>([requestedPath ?? ""]);
        for (const candidate of retryCandidates) {
          if (attempted.has(candidate)) continue;
          attempted.add(candidate);

          try {
            response = await onBrowseDirectories(candidate);
            break;
          } catch {
            // Continue through fallback candidates and surface the original error if all retries fail.
          }
        }

        if (!response) {
          throw initialError;
        }
      }

      setCurrentPath(response.path);
      setHighlightedPath(response.path);
      setParentPath(response.parentPath);
      setDirectories(response.directories);
    } catch (browseError) {
      setBrowserError(
        toActionErrorMessage(browseError, `Failed to load directory${requestedPath ? `: ${requestedPath}` : ""}.`)
      );
    } finally {
      setIsLoadingBrowser(false);
    }
  };

  const openBulkMoveBrowser = () => {
    if (duplicateMoveCount === 0 || deletingPath || isMovingDuplicates) return;

    setIsBrowserOpen(true);
    setBrowserError(null);
    setNewFolderName("");

    const firstDuplicateFile = groups[0]?.files[0];
    const preferredPath = firstDuplicateFile ? directoryFromPath(firstDuplicateFile) : highlightedPath;
    void loadDirectories(preferredPath);
  };

  const createFolder = async () => {
    const folderName = newFolderName.trim();
    if (!folderName || isLoadingBrowser || isMovingDuplicates) return;

    setBrowserError(null);
    try {
      const response = await onCreateDirectory(currentPath, folderName);
      setNewFolderName("");
      await loadDirectories(currentPath);
      setHighlightedPath(response.path);
      setMessage(`Created folder: ${response.path}`);
      setError(null);
    } catch (createError) {
      setBrowserError(toActionErrorMessage(createError, "Unable to create folder."));
    }
  };

  const moveDuplicates = async () => {
    if (duplicateMoveCount === 0 || isMovingDuplicates || isLoadingBrowser) return;

    setIsMovingDuplicates(true);
    setMessage(null);
    setError(null);
    setBrowserError(null);

    try {
      const response = await onBulkMoveDuplicates(highlightedPath);
      setMessage(
        `Moved ${response.movedFiles}/${response.requestedMoves} duplicate files to ${response.destinationRoot}. Kept ${response.keptFiles} originals in place.`
      );

      if (response.failedFiles > 0) {
        setError(`Failed to move ${response.failedFiles} file(s). Review file permissions and try again.`);
      }

      setIsBrowserOpen(false);
    } catch (moveError) {
      setError(toActionErrorMessage(moveError, "Bulk move failed. Try again."));
    } finally {
      setIsMovingDuplicates(false);
    }
  };

  const breadcrumbs = useMemo(() => {
    const segments = pathSegments(currentPath);
    const items = [{ label: "Root", path: "/" }];

    for (let index = 0; index < segments.length; index += 1) {
      items.push({
        label: segments[index],
        path: buildPathFromSegments(segments.slice(0, index + 1))
      });
    }

    return items;
  }, [currentPath]);

  return (
    <section className="duplicateReview">
      <h2>Duplicate Review</h2>
      <div className="duplicateActionsRow">
        <span className="duplicateActionHint">
          {duplicateMoveCount > 0
            ? `${duplicateMoveCount} duplicate files can be moved for evaluation.`
            : "Run a scan to identify duplicates first."}
        </span>
        <button
          className="duplicateBulkMoveButton"
          disabled={duplicateMoveCount === 0 || Boolean(deletingPath) || isMovingDuplicates}
          onClick={openBulkMoveBrowser}
        >
          {isMovingDuplicates ? "Moving..." : "Bulk Move Duplicates"}
        </button>
      </div>

      {message ? <p className="duplicateReviewMessage">{message}</p> : null}
      {error ? <p className="duplicateReviewError">{error}</p> : null}

      {isBrowserOpen ? (
        <div className="duplicateBrowserPanel">
          <div className="duplicateBrowserToolbar">
            <button
              className="duplicateBrowserButton"
              disabled={isLoadingBrowser || isMovingDuplicates || !parentPath}
              onClick={() => void loadDirectories(parentPath ?? undefined)}
            >
              Up
            </button>
            <button
              className="duplicateBrowserButton"
              disabled={isLoadingBrowser || isMovingDuplicates}
              onClick={() => void loadDirectories(currentPath)}
            >
              Refresh
            </button>
            <button
              className="duplicateBrowserButton duplicateBrowserButtonPrimary"
              disabled={isLoadingBrowser || isMovingDuplicates || duplicateMoveCount === 0}
              onClick={moveDuplicates}
            >
              Move Duplicates Here
            </button>
            <button
              className="duplicateBrowserButton"
              disabled={isLoadingBrowser || isMovingDuplicates}
              onClick={() => setIsBrowserOpen(false)}
            >
              Close
            </button>
          </div>

          <div className="duplicateBreadcrumbs" aria-label="Destination folder breadcrumbs">
            {breadcrumbs.map((crumb) => (
              <button
                key={crumb.path}
                className={`duplicateBreadcrumbButton ${crumb.path === currentPath ? "duplicateBreadcrumbButtonActive" : ""}`}
                disabled={isLoadingBrowser || isMovingDuplicates}
                onClick={() => void loadDirectories(crumb.path)}
              >
                {crumb.label}
              </button>
            ))}
          </div>

          <p className="duplicateCurrentPath" title={highlightedPath}>
            Selected destination: {highlightedPath}
          </p>

          <div className="duplicateCreateFolderRow">
            <input
              className="duplicateCreateFolderInput"
              value={newFolderName}
              disabled={isLoadingBrowser || isMovingDuplicates}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder="New folder name"
            />
            <button
              className="duplicateBrowserButton"
              disabled={isLoadingBrowser || isMovingDuplicates || !newFolderName.trim()}
              onClick={() => void createFolder()}
            >
              Create Folder
            </button>
          </div>

          {browserError ? <p className="duplicateReviewError">{browserError}</p> : null}
          {isLoadingBrowser ? <p className="duplicateBrowserStatus">Loading folders...</p> : null}

          <ul className="duplicateBrowserList">
            {directories.map((directory) => {
              const isSelected = highlightedPath === directory.path;
              return (
                <li key={directory.path} className="duplicateBrowserListItem">
                  <button
                    className={`duplicateBrowserRow ${isSelected ? "duplicateBrowserRowSelected" : ""}`}
                    disabled={isLoadingBrowser || isMovingDuplicates}
                    onClick={() => setHighlightedPath(directory.path)}
                    onDoubleClick={() => void loadDirectories(directory.path)}
                  >
                    <span className="duplicateBrowserFolderName">{directory.name}</span>
                    <span className="duplicateBrowserFolderPath">{directory.path}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {!isLoadingBrowser && directories.length === 0 ? (
            <p className="duplicateBrowserStatus">No subfolders in this location.</p>
          ) : null}
        </div>
      ) : null}

      {groups.length === 0 ? <p className="duplicateReviewEmpty">No duplicate groups to review yet.</p> : null}

      {groups.length > 0 ? (
        <div className="duplicatePagingBar">
          <span className="duplicatePagingSummary">
            Showing groups {pageStartIndex + 1}-{Math.min(groups.length, pageStartIndex + pagedGroups.length)} of {groups.length}
          </span>
          <div className="duplicatePagingControls">
            <button
              className="duplicateBrowserButton"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
            >
              Previous
            </button>
            <span className="duplicatePagingPage">Page {currentPage} / {totalPages}</span>
            <button
              className="duplicateBrowserButton"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      <ul className="duplicateGroupList">
        {pagedGroups.map((group, index) => {
          const absoluteIndex = pageStartIndex + index;
          const groupKey = `${group.sizeBytes}-${group.checksum}`;
          const isExpanded = expandedGroups[groupKey] ?? false;
          const visibleFiles = isExpanded ? group.files : group.files.slice(0, FILES_PREVIEW_LIMIT);

          return (
          <li key={groupKey} className="duplicateGroupCard">
            <header className="duplicateGroupHeader">
              <h3>Group {absoluteIndex + 1}: Same file content</h3>
              <p>
                {group.files.length} matches, {group.sizeBytes} bytes each, checksum {group.checksum.slice(0, 16)}...
              </p>
              {group.files.length > FILES_PREVIEW_LIMIT ? (
                <button className="duplicateToggleFilesButton" onClick={() => toggleGroupExpansion(groupKey)}>
                  {isExpanded
                    ? `Show fewer files`
                    : `Show all ${group.files.length} files (showing ${FILES_PREVIEW_LIMIT})`}
                </button>
              ) : null}
            </header>

            <ul className="duplicateFileList">
              {visibleFiles.map((filePath) => {
                const isDeleting = deletingPath === filePath;
                return (
                  <li key={filePath} className="duplicateFileRow">
                    <code className="duplicateFilePath" title={filePath}>
                      {filePath}
                    </code>
                    <button
                      className="duplicateDeleteButton"
                      disabled={Boolean(deletingPath)}
                      onClick={() => void handleDelete(filePath)}
                    >
                      {isDeleting ? "Deleting..." : "Delete"}
                    </button>
                  </li>
                );
              })}
            </ul>

            {!isExpanded && group.files.length > FILES_PREVIEW_LIMIT ? (
              <p className="duplicateFilesTruncatedHint">
                {group.files.length - FILES_PREVIEW_LIMIT} more files hidden for performance.
              </p>
            ) : null}
          </li>
          );
        })}
      </ul>
    </section>
  );
}
