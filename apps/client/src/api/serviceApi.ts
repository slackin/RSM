import axios from "axios";
import type {
  ArchiveCompareRequest,
  ArchiveCompareResponse,
  ArchiveCreateRequest,
  ArchiveDeleteDirectoryFilesRequest,
  ArchiveDeleteDirectoryFilesResponse,
  ArchiveDeleteEntriesRequest,
  ArchiveDeleteEntriesResponse,
  ArchiveMoveDirectoryFilesRequest,
  ArchiveMoveDirectoryFilesResponse,
  BulkMoveDuplicatesRequest,
  BulkMoveDuplicatesResponse,
  BrowseDirectoriesRequest,
  BrowseDirectoriesResponse,
  BrowseEntriesResponse,
  CreateDirectoryRequest,
  CreateDirectoryResponse,
  DeleteFileRequest,
  DeleteFileResponse,
  DuplicateScanRequest,
  DuplicateScanResponse,
  HealthResponse,
  OrganizePlanRequest,
  OrganizePlanResponse
} from "@rsm/shared";

export { SERVICE_API_VERSION } from "@rsm/shared";

export function createServiceApi(baseURL: string) {
  const http = axios.create({ baseURL, timeout: 120000 });

  http.interceptors.response.use(
    (response) => response,
    (error: unknown) => {
      if (axios.isAxiosError(error) && error.request && !error.response) {
        const requestUrl = error.config?.url ?? "";
        const normalizedBase = baseURL.replace(/\/$/, "");
        const normalizedPath = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
        const target = `${normalizedBase}${normalizedPath}`;

        return Promise.reject(
          new Error(
            `Cannot connect to service at ${target}. Verify the Service URL and ensure the service is running.`
          )
        );
      }

      return Promise.reject(error);
    }
  );

  return {
    health: async (): Promise<HealthResponse> => (await http.get("/health")).data,
    browseDirectories: async (payload: BrowseDirectoriesRequest = {}): Promise<BrowseDirectoriesResponse> =>
      (await http.get("/api/fs/directories", { params: payload })).data,
    browseEntries: async (targetPath?: string, fileExtensions?: string): Promise<BrowseEntriesResponse> =>
      (await http.get("/api/fs/entries", { params: { path: targetPath, fileExtensions } })).data,
    createDirectory: async (payload: CreateDirectoryRequest): Promise<CreateDirectoryResponse> =>
      (await http.post("/api/fs/directories/create", payload)).data,
    scanDuplicates: async (payload: DuplicateScanRequest): Promise<DuplicateScanResponse> =>
      (await http.post("/api/scan/duplicates", payload, { timeout: 0 })).data,
    bulkMoveDuplicates: async (payload: BulkMoveDuplicatesRequest): Promise<BulkMoveDuplicatesResponse> =>
      (await http.post("/api/duplicates/move", payload, { timeout: 0 })).data,
    organizePlan: async (payload: OrganizePlanRequest): Promise<OrganizePlanResponse> =>
      (await http.post("/api/organize/plan", payload)).data,
    compareArchive: async (payload: ArchiveCompareRequest): Promise<ArchiveCompareResponse> =>
      (await http.post("/api/archive/compare", payload, { timeout: 0 })).data,
    createArchive: async (payload: ArchiveCreateRequest): Promise<{ jobId: string; status: string }> =>
      (await http.post("/api/archive/create", payload)).data,
    archiveDeleteDirectoryFiles: async (payload: ArchiveDeleteDirectoryFilesRequest): Promise<ArchiveDeleteDirectoryFilesResponse> =>
      (await http.post("/api/archive/delete-directory-files", payload)).data,
    archiveMoveDirectoryFiles: async (payload: ArchiveMoveDirectoryFilesRequest): Promise<ArchiveMoveDirectoryFilesResponse> =>
      (await http.post("/api/archive/move-directory-files", payload)).data,
    archiveDeleteEntries: async (payload: ArchiveDeleteEntriesRequest): Promise<ArchiveDeleteEntriesResponse> =>
      (await http.post("/api/archive/delete-entries", payload)).data,
    deleteFile: async (payload: DeleteFileRequest): Promise<DeleteFileResponse> =>
      (await http.post("/api/files/delete", payload)).data
  };
}
