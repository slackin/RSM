import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import type {
  BulkMoveDuplicatesResponse,
  CreateDirectoryResponse,
  DeleteFileResponse,
  DuplicateScanResponse,
  OrganizePlanResponse
} from "@rsm/shared";
import { createServiceApi, SERVICE_API_VERSION } from "./api/serviceApi";
import { ArchiveCompare } from "./components/ArchiveCompare";
import { ArchiveQueue } from "./components/ArchiveQueue";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { DuplicateReview } from "./components/DuplicateReview";
import { OrganizePreview } from "./components/OrganizePreview";
import { ScanJobs } from "./components/ScanJobs";

interface DuplicateScanProgressState {
  stage: "indexing" | "hashing";
  currentFile: string;
  processedSteps: number;
  totalSteps: number;
  percentComplete: number;
}

interface ProgressEvent {
  phase: string;
  roots?: string[];
  stage?: "indexing" | "hashing" | "extracting" | "listing" | "scanning";
  currentFile?: string;
  processedSteps?: number;
  totalSteps?: number;
}

function toWebsocketUrl(input: string): string {
  const url = new URL(input);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/progress";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function summarizeFile(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const pieces = normalized.split("/").filter(Boolean);
  return pieces[pieces.length - 1] ?? path;
}

function getScanErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseError = error.response?.data as { error?: string; message?: string } | undefined;
    const serverMessage = responseError?.error ?? responseError?.message;

    if (serverMessage) {
      return serverMessage;
    }

    if (error.code === "ECONNABORTED") {
      return "Scan request timed out in the client, but the service may still be scanning. Keep this window open to receive progress updates.";
    }

    if (error.request && !error.response) {
      return "Cannot connect to service. Verify Service URL and ensure the service is running.";
    }
  }

  return "Scan failed. Check connection settings and selected path, then try again.";
}

function formatCacheSummary(result: DuplicateScanResponse): string {
  const { cachedHashes, computedHashes, staleCacheEntries, prunedCacheEntries } = result.cacheStats;
  const parts = [`${cachedHashes} cached`, `${computedHashes} computed`];

  if (staleCacheEntries > 0) {
    parts.push(`${staleCacheEntries} refreshed`);
  }

  if (prunedCacheEntries > 0) {
    parts.push(`${prunedCacheEntries} pruned`);
  }

  return parts.join(", ");
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState(import.meta.env.VITE_SERVICE_URL ?? "http://localhost:8787");
  const [versionWarning, setVersionWarning] = useState<string | null>(null);
  const [scanRoot, setScanRoot] = useState("/tmp");
  const [duplicateResult, setDuplicateResult] = useState<DuplicateScanResponse | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatusText, setScanStatusText] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<DuplicateScanProgressState | null>(null);
  const [archiveCompareProgress, setArchiveCompareProgress] = useState<string | null>(null);
  const [organizePlan, setOrganizePlan] = useState<OrganizePlanResponse | null>(null);
  const [lastArchiveJob, setLastArchiveJob] = useState<string | null>(null);

  const api = useMemo(() => createServiceApi(baseUrl), [baseUrl]);

  useEffect(() => {
    setVersionWarning(null);
    api.health().then((resp) => {
      if (resp.apiVersion !== SERVICE_API_VERSION) {
        setVersionWarning(
          `Version mismatch: client expects API v${SERVICE_API_VERSION}, service reported v${resp.apiVersion ?? "unknown"}. Deploy the latest service build.`
        );
      }
    }).catch(() => {
      // Connection failure is surfaced elsewhere; skip version warning.
    });
  }, [api]);

  useEffect(() => {
    let socket: WebSocket | null = null;

    try {
      socket = new WebSocket(toWebsocketUrl(baseUrl));
    } catch {
      return;
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const payload = JSON.parse(event.data) as ProgressEvent;

      if (payload.phase === "duplicate_scan_started") {
        const displayRoot = payload.roots?.[0] ?? "selected folder";
        setScanStatusText(`Scanning ${displayRoot}...`);
        setScanProgress(null);
        setScanError(null);
        return;
      }

      if (
        payload.phase === "duplicate_scan_progress" &&
        payload.stage &&
        payload.currentFile &&
        typeof payload.processedSteps === "number" &&
        typeof payload.totalSteps === "number" &&
        payload.totalSteps > 0
      ) {
        const percentComplete = Math.min(100, Math.round((payload.processedSteps / payload.totalSteps) * 100));
        const stageLabel = payload.stage === "indexing" ? "Indexing" : "Hashing";
        const fileName = summarizeFile(payload.currentFile);

        setScanProgress({
          stage: payload.stage,
          currentFile: payload.currentFile,
          processedSteps: payload.processedSteps,
          totalSteps: payload.totalSteps,
          percentComplete
        });
        setScanStatusText(`${stageLabel} ${payload.processedSteps}/${payload.totalSteps} - ${fileName}`);
        return;
      }

      if (payload.phase === "duplicate_scan_complete") {
        setScanProgress((previous) => {
          if (!previous) return null;
          return { ...previous, percentComplete: 100 };
        });
      }

      if (payload.phase === "archive_compare_started") {
        setArchiveCompareProgress("Starting comparison\u2026");
        return;
      }

      if (payload.phase === "archive_compare_progress") {
        const stageLabels: Record<string, string> = {
          extracting: "Extracting archive\u2026",
          listing: "Reading archive entries\u2026",
          scanning: "Scanning directory\u2026"
        };
        setArchiveCompareProgress(stageLabels[payload.stage ?? ""] ?? "Comparing\u2026");
        return;
      }

      if (payload.phase === "archive_compare_complete") {
        setArchiveCompareProgress(null);
        return;
      }
    };

    return () => {
      socket?.close();
    };
  }, [baseUrl]);

  const runScan = async (root: string) => {
    if (isScanning) return;

    const normalizedRoot = root.trim();
    if (!normalizedRoot) {
      setScanError("Select a folder path before running a scan.");
      setScanStatusText(null);
      setScanProgress(null);
      return;
    }

    setIsScanning(true);
    setScanError(null);
    setScanStatusText(`Scanning ${normalizedRoot}...`);
    setScanProgress(null);
    const startedAt = Date.now();

    try {
      const result = await api.scanDuplicates({ roots: [normalizedRoot] });
      setDuplicateResult(result);
      const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      setScanStatusText(
        `Scan complete in ${durationSeconds}s. ${result.groups.length} duplicate groups found. Hash cache: ${formatCacheSummary(result)}.`
      );
    } catch (error) {
      setScanError(getScanErrorMessage(error));
      setScanStatusText(null);
      setScanProgress(null);
    } finally {
      setIsScanning(false);
    }
  };

  const browseDirectories = async (targetPath?: string) => {
    return api.browseDirectories({ path: targetPath });
  };

  const browseEntries = async (targetPath?: string, fileExtensions?: string) => {
    return api.browseEntries(targetPath, fileExtensions);
  };

  const createDirectory = async (parentPath: string, name: string): Promise<CreateDirectoryResponse> => {
    return api.createDirectory({ parentPath, name });
  };

  const buildPlan = async () => {
    const plan = await api.organizePlan({ root: "/tmp", destination: "/tmp/rsm-organized" });
    setOrganizePlan(plan);
  };

  const queueArchive = async () => {
    const result = await api.createArchive({
      sourceDir: "/tmp/rsm-organized",
      outputArchive: "/tmp/rsm-organized.zip"
    });
    setLastArchiveJob(result.jobId);
  };

  const deleteDuplicateFile = async (targetPath: string): Promise<DeleteFileResponse> => {
    const response = await api.deleteFile({ path: targetPath });

    setDuplicateResult((previous) => {
      if (!previous) return previous;

      const updatedGroups = previous.groups
        .map((group) => ({
          ...group,
          files: group.files.filter((file) => file !== response.path)
        }))
        .filter((group) => group.files.length > 1);

      return {
        ...previous,
        groups: updatedGroups,
        scannedFiles: Math.max(0, previous.scannedFiles - 1)
      };
    });

    return response;
  };

  const bulkMoveDuplicateFiles = async (destinationRoot: string): Promise<BulkMoveDuplicatesResponse> => {
    if (!duplicateResult) {
      return {
        destinationRoot,
        keptFiles: 0,
        requestedMoves: 0,
        movedFiles: 0,
        failedFiles: 0,
        results: []
      };
    }

    const response = await api.bulkMoveDuplicates({
      destinationRoot,
      groups: duplicateResult.groups
    });

    const movedPaths = new Set(response.results.filter((item) => item.moved).map((item) => item.source));
    if (movedPaths.size === 0) {
      return response;
    }

    setDuplicateResult((previous) => {
      if (!previous) return previous;

      const updatedGroups = previous.groups
        .map((group) => ({
          ...group,
          files: group.files.filter((filePath) => !movedPaths.has(filePath))
        }))
        .filter((group) => group.files.length > 1);

      return {
        ...previous,
        groups: updatedGroups,
        scannedFiles: Math.max(0, previous.scannedFiles - movedPaths.size)
      };
    });

    return response;
  };

  return (
    <main style={{ padding: "1rem", fontFamily: "Avenir Next, Segoe UI, Nunito Sans, sans-serif" }}>
      <h1>Remote Storage Manager Client</h1>
      <ConnectionSettings value={baseUrl} onChange={setBaseUrl} versionWarning={versionWarning} />
      <ScanJobs
        result={duplicateResult}
        selectedRoot={scanRoot}
        isScanning={isScanning}
        scanStatusText={scanStatusText}
        scanError={scanError}
        scanProgress={scanProgress}
        onRootChange={setScanRoot}
        onBrowse={browseDirectories}
        onScan={runScan}
      />
      <DuplicateReview
        result={duplicateResult}
        onDeleteFile={deleteDuplicateFile}
        onBrowseDirectories={browseDirectories}
        onCreateDirectory={createDirectory}
        onBulkMoveDuplicates={bulkMoveDuplicateFiles}
      />
      <ArchiveCompare
        compareProgress={archiveCompareProgress}
        onCompare={(ap, dp) => api.compareArchive({ archivePath: ap, directoryPath: dp })}
        onBrowseEntries={browseEntries}
        onBrowseDirectories={browseDirectories}
        onCreateDirectory={createDirectory}
        onDeleteDirectoryFiles={(dirPath, relPaths) =>
          api.archiveDeleteDirectoryFiles({ directoryPath: dirPath, relativePaths: relPaths })
        }
        onMoveDirectoryFiles={(dirPath, relPaths, destRoot) =>
          api.archiveMoveDirectoryFiles({ directoryPath: dirPath, relativePaths: relPaths, destinationRoot: destRoot })
        }
        onDeleteArchiveEntries={(ap, entries) =>
          api.archiveDeleteEntries({ archivePath: ap, entries })
        }
      />
      <section>
        <h2>Organize</h2>
        <button onClick={buildPlan}>Build Organize Plan</button>
      </section>
      <OrganizePreview plan={organizePlan} />
      <section>
        <h2>Create Archive</h2>
        <button onClick={queueArchive}>Queue Archive Job</button>
      </section>
      <ArchiveQueue lastJobId={lastArchiveJob} />
    </main>
  );
}
