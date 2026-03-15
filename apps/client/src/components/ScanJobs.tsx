import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import type { BrowseDirectoriesResponse, DuplicateScanResponse } from "@rsm/shared";
import "./ScanJobs.css";

interface Props {
  result: DuplicateScanResponse | null;
  selectedRoot: string;
  isScanning: boolean;
  scanStatusText: string | null;
  scanError: string | null;
  scanProgress: {
    stage: "indexing" | "hashing";
    currentFile: string;
    processedSteps: number;
    totalSteps: number;
    percentComplete: number;
  } | null;
  onRootChange: (next: string) => void;
  onBrowse: (path?: string) => Promise<BrowseDirectoriesResponse>;
  onScan: (root: string) => Promise<void>;
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function pathSegments(input: string): string[] {
  const normalized = input.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean);
}

function buildPathFromSegments(segments: string[]): string {
  return `/${segments.join("/")}`;
}

function directoryFromPath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return normalized.slice(0, lastSlash);
}

function parentDirectoryPath(input: string): string | null {
  const normalized = input.trim().replace(/\\/g, "/");
  if (!normalized || normalized === "/") return null;

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function toBrowseErrorMessage(error: unknown, targetPath?: string): string {
  const context = targetPath?.trim() ? ` for ${targetPath}` : "";

  if (axios.isAxiosError(error)) {
    const payload = error.response?.data;
    const apiMessage =
      typeof payload === "string"
        ? payload
        : (payload as { error?: string; message?: string } | undefined)?.error ??
          (payload as { error?: string; message?: string } | undefined)?.message;

    const detail = apiMessage ?? error.message;
    const status = error.response?.status ? ` (HTTP ${error.response.status})` : "";
    return `Failed to load directory${context}${status}: ${detail}`;
  }

  if (error instanceof Error && error.message) {
    return `Failed to load directory${context}: ${error.message}`;
  }

  return `Failed to load directory${context}.`;
}

export function ScanJobs({
  result,
  selectedRoot,
  isScanning,
  scanStatusText,
  scanError,
  scanProgress,
  onRootChange,
  onBrowse,
  onScan
}: Props) {
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [currentPath, setCurrentPath] = useState<string>(selectedRoot);
  const [highlightedPath, setHighlightedPath] = useState<string>(selectedRoot);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<BrowseDirectoriesResponse["directories"]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!isScanning) {
      setElapsedSeconds(0);
      return;
    }

    const interval = setInterval(() => {
      setElapsedSeconds((seconds) => seconds + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isScanning]);

  const loadDirectories = async (path?: string) => {
    setIsLoading(true);
    setError(null);

    const requestedPath = path?.trim();

    try {
      let response: BrowseDirectoriesResponse | null = null;

      try {
        response = await onBrowse(requestedPath);
      } catch (initialError) {
        const retryCandidates = [parentDirectoryPath(requestedPath ?? ""), "/"].filter(
          (candidate): candidate is string => Boolean(candidate)
        );

        const attempted = new Set<string>([requestedPath ?? ""]);
        for (const candidate of retryCandidates) {
          if (attempted.has(candidate)) continue;
          attempted.add(candidate);

          try {
            response = await onBrowse(candidate);
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
      setError(toBrowseErrorMessage(browseError, requestedPath));
    } finally {
      setIsLoading(false);
    }
  };

  const openBrowser = () => {
    if (isScanning) return;
    setIsBrowsing(true);
    setFilterText("");
    void loadDirectories(selectedRoot);
  };

  const filteredDirectories = useMemo(() => {
    const normalizedFilter = filterText.trim().toLowerCase();
    if (!normalizedFilter) return directories;
    return directories.filter((directory) => directory.name.toLowerCase().includes(normalizedFilter));
  }, [directories, filterText]);

  const breadcrumbs = useMemo(() => {
    const segments = pathSegments(currentPath);
    const items = [{ label: "/", path: "/" }];
    for (let i = 0; i < segments.length; i += 1) {
      items.push({
        label: segments[i],
        path: buildPathFromSegments(segments.slice(0, i + 1))
      });
    }
    return items;
  }, [currentPath]);

  const handleScan = () => {
    void onScan(selectedRoot);
  };

  const chooseFolder = () => {
    onRootChange(highlightedPath);
    setIsBrowsing(false);
  };

  return (
    <section className="scanJobs">
      <h2>Duplicate Scan</h2>
      <label className="scanJobsLabel" htmlFor="scan-root-input">
        Remote folder
      </label>
      <div className="scanJobsInputRow">
        <input
          id="scan-root-input"
          className="scanJobsInput"
          value={selectedRoot}
          disabled={isScanning}
          onChange={(e) => onRootChange(e.target.value)}
          placeholder="/path/on/remote/host"
        />
        <button className="scanJobsButton scanJobsButtonSecondary" disabled={isScanning} onClick={openBrowser}>
          Browse
        </button>
        <button className="scanJobsButton scanJobsButtonPrimary" disabled={isScanning} onClick={handleScan}>
          {isScanning ? "Scanning..." : "Run Scan"}
        </button>
      </div>
      {isScanning ? (
        <div className="scanProgress" role="status" aria-live="polite">
          <span className="scanProgressDot" aria-hidden="true" />
          <span>{scanStatusText ?? "Scanning selected folder..."}</span>
          <span className="scanProgressTime">{elapsedSeconds}s elapsed</span>
          {scanProgress ? (
            <>
              <div className="scanProgressBar" aria-hidden="true">
                <span className="scanProgressFill" style={{ width: `${scanProgress.percentComplete}%` }} />
              </div>
              <div className="scanProgressDetails">
                <span>
                  Stage: {scanProgress.stage === "indexing" ? "Indexing Files" : "Hashing Candidates"}
                </span>
                <span>
                  Progress: {scanProgress.processedSteps}/{scanProgress.totalSteps} ({scanProgress.percentComplete}%)
                </span>
                <span className="scanCurrentFile" title={scanProgress.currentFile}>
                  Last file: {scanProgress.currentFile}
                </span>
                <span className="scanCurrentDirectory" title={directoryFromPath(scanProgress.currentFile)}>
                  Last directory: {directoryFromPath(scanProgress.currentFile)}
                </span>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {!isScanning && scanStatusText ? <p className="scanCompleteMessage">{scanStatusText}</p> : null}
      {scanError ? <p className="scanErrorMessage">{scanError}</p> : null}
      {isBrowsing ? (
        <div className="browserPanel">
          <div className="browserToolbar">
            <button
              className="scanJobsButton scanJobsButtonSecondary"
              disabled={isScanning || isLoading || !parentPath}
              onClick={() => void loadDirectories(parentPath ?? undefined)}
            >
              Up
            </button>
            <button className="scanJobsButton scanJobsButtonSecondary" disabled={isScanning || isLoading} onClick={() => void loadDirectories(currentPath)}>
              Refresh
            </button>
            <button
              className="scanJobsButton scanJobsButtonPrimary"
              disabled={isScanning || isLoading}
              onClick={chooseFolder}
            >
              Choose Folder
            </button>
            <button className="scanJobsButton scanJobsButtonGhost" disabled={isScanning || isLoading} onClick={() => setIsBrowsing(false)}>
              Close
            </button>
          </div>

          <div className="browserBreadcrumbs" aria-label="Current folder">
            {breadcrumbs.map((crumb, index) => (
              <button
                key={crumb.path}
                className="breadcrumbButton"
                disabled={isScanning || isLoading}
                onClick={() => void loadDirectories(crumb.path)}
              >
                {index === 0 ? "Root" : crumb.label}
              </button>
            ))}
          </div>

          <div className="browserMetaRow">
            <span className="browserPath">{currentPath}</span>
            <input
              className="browserFilter"
              value={filterText}
              disabled={isScanning || isLoading}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter folders"
            />
          </div>

          {isLoading ? <p className="browserStatus">Loading folders...</p> : null}
          {error ? <p className="browserStatus browserStatusError">{error}</p> : null}

          <ul className="browserList">
            {filteredDirectories.map((directory) => {
              const isSelected = highlightedPath === directory.path;
              return (
                <li key={directory.path} className="browserListItem">
                  <button
                    className={`browserRow ${isSelected ? "browserRowSelected" : ""}`}
                    disabled={isScanning || isLoading}
                    onClick={() => setHighlightedPath(directory.path)}
                    onDoubleClick={() => void loadDirectories(directory.path)}
                  >
                    <span className="folderIcon" aria-hidden="true">
                      DIR
                    </span>
                    <span className="folderName">{directory.name}</span>
                    <span className="folderPath">{directory.path}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {!isLoading && filteredDirectories.length === 0 ? (
            <p className="browserStatus">No matching folders in this location.</p>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <div className="scanSummaryPanel">
          <p className="scanSummary">
            Scanned {result.scannedFiles} files, found {result.groups.length} duplicate groups.
          </p>
          <div className="scanCacheStats" aria-label="Hash cache statistics">
            <div className="scanCacheStatCard">
              <span className="scanCacheStatLabel">Cache hits</span>
              <strong className="scanCacheStatValue">{result.cacheStats.cachedHashes}</strong>
            </div>
            <div className="scanCacheStatCard">
              <span className="scanCacheStatLabel">Recomputed</span>
              <strong className="scanCacheStatValue">{result.cacheStats.computedHashes}</strong>
            </div>
            <div className="scanCacheStatCard">
              <span className="scanCacheStatLabel">Hit rate</span>
              <strong className="scanCacheStatValue">
                {formatPercent(result.cacheStats.cachedHashes, result.cacheStats.cachedHashes + result.cacheStats.computedHashes)}
              </strong>
            </div>
            <div className="scanCacheStatCard">
              <span className="scanCacheStatLabel">Invalidated</span>
              <strong className="scanCacheStatValue">{result.cacheStats.staleCacheEntries}</strong>
            </div>
            <div className="scanCacheStatCard">
              <span className="scanCacheStatLabel">Pruned</span>
              <strong className="scanCacheStatValue">{result.cacheStats.prunedCacheEntries}</strong>
            </div>
          </div>
        </div>
      ) : (
        <p className="scanSummary">No scan run yet.</p>
      )}
    </section>
  );
}
