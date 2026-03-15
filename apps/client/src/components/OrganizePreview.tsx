import { useEffect, useMemo, useState } from "react";
import type {
  BrowseDirectoriesResponse,
  CreateDirectoryResponse,
  FileCategory,
  OrganizeExecuteResponse,
  OrganizePlanItem,
  OrganizePlanResponse
} from "@rsm/shared";
import "./OrganizePreview.css";

const ALL_CATEGORIES: { key: FileCategory; label: string }[] = [
  { key: "pictures", label: "Images" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Music" },
  { key: "documents", label: "Documents" },
  { key: "archives", label: "Archives" },
  { key: "other", label: "Other" }
];

interface Props {
  onBuildPlan: (root: string, destination: string, categories: FileCategory[], tinyFileThresholdBytes?: number) => Promise<OrganizePlanResponse>;
  onExecutePlan: (items: OrganizePlanItem[]) => Promise<OrganizeExecuteResponse>;
  onBrowse: (path?: string) => Promise<BrowseDirectoriesResponse>;
  onCreateDirectory: (parentPath: string, name: string) => Promise<CreateDirectoryResponse>;
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

interface DirectoryPickerProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBrowse: (path?: string) => Promise<BrowseDirectoriesResponse>;
  onCreateDirectory: (parentPath: string, name: string) => Promise<CreateDirectoryResponse>;
  disabled?: boolean;
}

function DirectoryPicker({ label, value, onChange, onBrowse, onCreateDirectory, disabled }: DirectoryPickerProps) {
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [currentPath, setCurrentPath] = useState(value || "/");
  const [highlightedPath, setHighlightedPath] = useState(value || "/");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<BrowseDirectoriesResponse["directories"]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const loadDirectories = async (path?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      let response: BrowseDirectoriesResponse | null = null;
      try {
        response = await onBrowse(path?.trim());
      } catch (initialError) {
        const retries = [parentDirectoryPath(path ?? ""), "/"].filter(
          (c): c is string => Boolean(c)
        );
        const attempted = new Set<string>([path ?? ""]);
        for (const candidate of retries) {
          if (attempted.has(candidate)) continue;
          attempted.add(candidate);
          try {
            response = await onBrowse(candidate);
            break;
          } catch { /* continue */ }
        }
        if (!response) throw initialError;
      }
      setCurrentPath(response.path);
      setHighlightedPath(response.path);
      setParentPath(response.parentPath);
      setDirectories(response.directories);
    } catch {
      setError("Failed to load directory.");
    } finally {
      setIsLoading(false);
    }
  };

  const openBrowser = () => {
    setIsBrowsing(true);
    setFilterText("");
    setNewFolderName("");
    void loadDirectories(value || "/");
  };

  const chooseFolder = () => {
    onChange(highlightedPath);
    setIsBrowsing(false);
  };

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    setIsCreating(true);
    try {
      const result = await onCreateDirectory(currentPath, trimmed);
      setNewFolderName("");
      void loadDirectories(currentPath);
      setHighlightedPath(result.path);
    } catch {
      setError("Failed to create folder.");
    } finally {
      setIsCreating(false);
    }
  };

  const filteredDirectories = useMemo(() => {
    const f = filterText.trim().toLowerCase();
    if (!f) return directories;
    return directories.filter((d) => d.name.toLowerCase().includes(f));
  }, [directories, filterText]);

  const breadcrumbs = useMemo(() => {
    const segments = pathSegments(currentPath);
    const items = [{ label: "/", path: "/" }];
    for (let i = 0; i < segments.length; i++) {
      items.push({ label: segments[i], path: buildPathFromSegments(segments.slice(0, i + 1)) });
    }
    return items;
  }, [currentPath]);

  return (
    <div className="orgPickerGroup">
      <label className="orgLabel">{label}</label>
      <div className="orgInputRow">
        <input
          className="orgInput"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/path/on/remote/host"
        />
        <button className="orgBtn orgBtnSecondary" disabled={disabled} onClick={openBrowser}>
          Browse
        </button>
      </div>
      {isBrowsing && (
        <div className="orgBrowserPanel">
          <div className="orgBrowserToolbar">
            <button className="orgBtn orgBtnSecondary" disabled={isLoading || !parentPath} onClick={() => void loadDirectories(parentPath ?? undefined)}>Up</button>
            <button className="orgBtn orgBtnSecondary" disabled={isLoading} onClick={() => void loadDirectories(currentPath)}>Refresh</button>
            <button className="orgBtn orgBtnPrimary" disabled={isLoading} onClick={chooseFolder}>Choose Folder</button>
            <button className="orgBtn orgBtnGhost" onClick={() => setIsBrowsing(false)}>Close</button>
          </div>
          <div className="orgBreadcrumbs">
            {breadcrumbs.map((c, i) => (
              <button key={c.path} className="orgBreadcrumb" disabled={isLoading} onClick={() => void loadDirectories(c.path)}>
                {i === 0 ? "Root" : c.label}
              </button>
            ))}
          </div>
          <div className="orgBrowserMeta">
            <span className="orgBrowserPath">{currentPath}</span>
            <input className="orgBrowserFilter" value={filterText} disabled={isLoading} onChange={(e) => setFilterText(e.target.value)} placeholder="Filter folders" />
          </div>
          <div className="orgNewFolderRow">
            <input className="orgInput orgNewFolderInput" value={newFolderName} disabled={isCreating || isLoading} onChange={(e) => setNewFolderName(e.target.value)} placeholder="New folder name" />
            <button className="orgBtn orgBtnSecondary" disabled={isCreating || isLoading || !newFolderName.trim()} onClick={() => void handleCreateFolder()}>Create</button>
          </div>
          {isLoading && <p className="orgBrowserStatus">Loading folders...</p>}
          {error && <p className="orgBrowserStatus orgBrowserStatusError">{error}</p>}
          <ul className="orgBrowserList">
            {filteredDirectories.map((d) => (
              <li key={d.path} className="orgBrowserListItem">
                <button
                  className={`orgBrowserRow ${highlightedPath === d.path ? "orgBrowserRowSelected" : ""}`}
                  disabled={isLoading}
                  onClick={() => setHighlightedPath(d.path)}
                  onDoubleClick={() => void loadDirectories(d.path)}
                >
                  <span className="orgFolderIcon" aria-hidden="true">DIR</span>
                  <span className="orgFolderName">{d.name}</span>
                  <span className="orgFolderPath">{d.path}</span>
                </button>
              </li>
            ))}
          </ul>
          {!isLoading && filteredDirectories.length === 0 && <p className="orgBrowserStatus">No matching folders.</p>}
        </div>
      )}
    </div>
  );
}

interface CategoryGroup {
  category: FileCategory;
  years: Map<string, Map<string, OrganizePlanItem[]>>;
  totalFiles: number;
}

function buildCategoryTree(items: OrganizePlanItem[]): CategoryGroup[] {
  const categoryMap = new Map<FileCategory, Map<string, Map<string, OrganizePlanItem[]>>>();

  for (const item of items) {
    if (!categoryMap.has(item.category)) {
      categoryMap.set(item.category, new Map());
    }
    const years = categoryMap.get(item.category)!;

    // Extract year/month from destination path: .../category/year/month/file
    const parts = item.destination.replace(/\\/g, "/").split("/");
    const fileName = parts[parts.length - 1];
    const month = parts[parts.length - 2] ?? "Unknown";
    const year = parts[parts.length - 3] ?? "Unknown";

    if (!years.has(year)) years.set(year, new Map());
    const months = years.get(year)!;
    if (!months.has(month)) months.set(month, []);
    months.get(month)!.push(item);
  }

  const groups: CategoryGroup[] = [];
  for (const [category, years] of categoryMap) {
    let totalFiles = 0;
    for (const months of years.values()) {
      for (const files of months.values()) totalFiles += files.length;
    }
    groups.push({ category, years, totalFiles });
  }

  groups.sort((a, b) => {
    const order: FileCategory[] = ["pictures", "video", "audio", "documents", "archives", "other"];
    return order.indexOf(a.category) - order.indexOf(b.category);
  });

  return groups;
}

const CATEGORY_LABELS: Record<FileCategory, string> = {
  pictures: "Images",
  video: "Video",
  audio: "Music",
  documents: "Documents",
  archives: "Archives",
  other: "Other"
};

export function OrganizePreview({ onBuildPlan, onExecutePlan, onBrowse, onCreateDirectory }: Props) {
  const [sourceDir, setSourceDir] = useState("/tmp");
  const [destDir, setDestDir] = useState("/tmp/rsm-organized");
  const [selectedCategories, setSelectedCategories] = useState<Set<FileCategory>>(
    new Set(ALL_CATEGORIES.map((c) => c.key))
  );
  const [plan, setPlan] = useState<OrganizePlanResponse | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [executeResult, setExecuteResult] = useState<OrganizeExecuteResponse | null>(null);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [tinyFilesEnabled, setTinyFilesEnabled] = useState(false);
  const [tinyFileSizeKB, setTinyFileSizeKB] = useState(100);

  const toggleCategory = (key: FileCategory) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllCategories = () => setSelectedCategories(new Set(ALL_CATEGORIES.map((c) => c.key)));
  const selectNoneCategories = () => setSelectedCategories(new Set());

  const handleBuildPlan = async () => {
    if (!sourceDir.trim() || !destDir.trim()) {
      setPlanError("Both source and destination directories are required.");
      return;
    }
    if (selectedCategories.size === 0) {
      setPlanError("Select at least one file type.");
      return;
    }
    setIsPlanning(true);
    setPlanError(null);
    setPlan(null);
    setExecuteResult(null);
    setExecuteError(null);
    setExpandedCategories(new Set());
    setExpandedYears(new Set());
    try {
      const categories = Array.from(selectedCategories);
      const threshold = tinyFilesEnabled && tinyFileSizeKB > 0 ? tinyFileSizeKB * 1024 : undefined;
      const result = await onBuildPlan(sourceDir.trim(), destDir.trim(), categories, threshold);
      setPlan(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to build organize plan.";
      setPlanError(message);
    } finally {
      setIsPlanning(false);
    }
  };

  const handleExecute = async () => {
    if (!plan || plan.items.length === 0) return;
    setIsExecuting(true);
    setExecuteError(null);
    setExecuteResult(null);
    try {
      const result = await onExecutePlan(plan.items);
      setExecuteResult(result);
      setPlan(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to execute organize plan.";
      setExecuteError(message);
    } finally {
      setIsExecuting(false);
    }
  };

  const toggleExpandCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleExpandYear = (key: string) => {
    setExpandedYears((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const { regularTree, tinyTree } = useMemo(() => {
    if (!plan) return { regularTree: [], tinyTree: [] };
    const regular: OrganizePlanItem[] = [];
    const tiny: OrganizePlanItem[] = [];
    for (const item of plan.items) {
      if (item.destination.replace(/\\/g, "/").includes("/tiny-files/")) {
        tiny.push(item);
      } else {
        regular.push(item);
      }
    }
    return { regularTree: buildCategoryTree(regular), tinyTree: buildCategoryTree(tiny) };
  }, [plan]);
  const busy = isPlanning || isExecuting;

  return (
    <section className="organizeSection">
      <h2>Organize Files</h2>

      <DirectoryPicker
        label="Source directory"
        value={sourceDir}
        onChange={setSourceDir}
        onBrowse={onBrowse}
        onCreateDirectory={onCreateDirectory}
        disabled={busy}
      />

      <DirectoryPicker
        label="Destination directory"
        value={destDir}
        onChange={setDestDir}
        onBrowse={onBrowse}
        onCreateDirectory={onCreateDirectory}
        disabled={busy}
      />

      <div className="orgCategorySection">
        <label className="orgLabel">File types to organize</label>
        <div className="orgCategoryActions">
          <button className="orgBtn orgBtnGhost orgBtnSmall" disabled={busy} onClick={selectAllCategories}>All</button>
          <button className="orgBtn orgBtnGhost orgBtnSmall" disabled={busy} onClick={selectNoneCategories}>None</button>
        </div>
        <div className="orgCategoryGrid">
          {ALL_CATEGORIES.map((cat) => (
            <label key={cat.key} className={`orgCategoryCheckbox ${selectedCategories.has(cat.key) ? "orgCategoryChecked" : ""}`}>
              <input
                type="checkbox"
                checked={selectedCategories.has(cat.key)}
                disabled={busy}
                onChange={() => toggleCategory(cat.key)}
              />
              <span>{cat.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="orgTinyFilesSection">
        <label className="orgCategoryCheckbox" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={tinyFilesEnabled} disabled={busy} onChange={(e) => setTinyFilesEnabled(e.target.checked)} />
          <span>Separate tiny files</span>
        </label>
        {tinyFilesEnabled && (
          <div className="orgTinyFilesRow">
            <label className="orgLabel">Threshold (KB)</label>
            <input
              className="orgInput"
              type="number"
              min={1}
              value={tinyFileSizeKB}
              disabled={busy}
              onChange={(e) => setTinyFileSizeKB(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 100 }}
            />
            <span className="orgTinyFilesHint">Files smaller than {tinyFileSizeKB} KB go into a "tiny-files" subfolder</span>
          </div>
        )}
      </div>

      <div className="orgActionRow">
        <button className="orgBtn orgBtnPrimary" disabled={busy || selectedCategories.size === 0} onClick={() => void handleBuildPlan()}>
          {isPlanning ? "Building Plan..." : "Build Plan"}
        </button>
        {plan && plan.items.length > 0 && (
          <button className="orgBtn orgBtnExecute" disabled={busy} onClick={() => void handleExecute()}>
            {isExecuting ? "Organizing..." : `Organize ${plan.items.length} Files`}
          </button>
        )}
      </div>

      {planError && <p className="orgError">{planError}</p>}
      {executeError && <p className="orgError">{executeError}</p>}

      {executeResult && (
        <div className="orgResultBanner">
          <strong>
            Organized {executeResult.movedFiles} of {executeResult.totalItems} files.
          </strong>
          {executeResult.failedFiles > 0 && (
            <span className="orgResultFailed"> {executeResult.failedFiles} failed.</span>
          )}
        </div>
      )}

      {plan && plan.items.length === 0 && !isPlanning && (
        <p className="orgEmpty">No files found matching the selected types in the source directory.</p>
      )}

      {plan && plan.items.length > 0 && (
        <div className="orgPlanPreview">
          <div className="orgPlanHeader">
            <span className="orgPlanCount">{plan.items.length} files to organize</span>
            <span className="orgPlanStructure">destination/{"{type}"}/{"{year}"}/{"{month}"}/file</span>
          </div>
          <div className="orgTree">
            {regularTree.map((group) => {
              const catExpanded = expandedCategories.has(group.category);
              const sortedYears = Array.from(group.years.entries()).sort(([a], [b]) => b.localeCompare(a));

              return (
                <div key={group.category} className="orgTreeCategory">
                  <button
                    className="orgTreeToggle orgTreeCategoryHeader"
                    onClick={() => toggleExpandCategory(group.category)}
                  >
                    <span className="orgTreeArrow">{catExpanded ? "\u25BC" : "\u25B6"}</span>
                    <span className="orgTreeCategoryLabel">{CATEGORY_LABELS[group.category]}</span>
                    <span className="orgTreeCount">{group.totalFiles} files</span>
                  </button>
                  {catExpanded && sortedYears.map(([year, months]) => {
                    const yearKey = `${group.category}/${year}`;
                    const yearExpanded = expandedYears.has(yearKey);
                    const sortedMonths = Array.from(months.entries());
                    const yearTotal = sortedMonths.reduce((sum, [, items]) => sum + items.length, 0);

                    return (
                      <div key={yearKey} className="orgTreeYear">
                        <button
                          className="orgTreeToggle orgTreeYearHeader"
                          onClick={() => toggleExpandYear(yearKey)}
                        >
                          <span className="orgTreeArrow">{yearExpanded ? "\u25BC" : "\u25B6"}</span>
                          <span className="orgTreeYearLabel">{year}</span>
                          <span className="orgTreeCount">{yearTotal} files</span>
                        </button>
                        {yearExpanded && sortedMonths.map(([month, items]) => {
                          const monthKey = `${yearKey}/${month}`;
                          return (
                            <div key={monthKey} className="orgTreeMonth">
                              <div className="orgTreeMonthHeader">
                                <span className="orgTreeMonthLabel">{month}</span>
                                <span className="orgTreeCount">{items.length} files</span>
                              </div>
                              <ul className="orgTreeFileList">
                                {items.map((item) => {
                                  const name = item.source.replace(/\\/g, "/").split("/").pop() ?? item.source;
                                  return (
                                    <li key={item.source} className="orgTreeFile" title={item.source}>
                                      {name}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {tinyTree.length > 0 && (
            <div className="orgTinyFilesPreview">
              <div className="orgTinyFilesPreviewHeader">
                <span className="orgTinyFilesPreviewLabel">Tiny Files</span>
                <span className="orgTreeCount">
                  {tinyTree.reduce((sum, g) => sum + g.totalFiles, 0)} files &rarr; tiny-files/
                </span>
              </div>
              <div className="orgTree">
                {tinyTree.map((group) => {
                  const tinyKey = `tiny/${group.category}`;
                  const catExpanded = expandedCategories.has(tinyKey);
                  const sortedYears = Array.from(group.years.entries()).sort(([a], [b]) => b.localeCompare(a));

                  return (
                    <div key={tinyKey} className="orgTreeCategory">
                      <button
                        className="orgTreeToggle orgTreeCategoryHeader"
                        onClick={() => toggleExpandCategory(tinyKey)}
                      >
                        <span className="orgTreeArrow">{catExpanded ? "\u25BC" : "\u25B6"}</span>
                        <span className="orgTreeCategoryLabel">{CATEGORY_LABELS[group.category]}</span>
                        <span className="orgTreeCount">{group.totalFiles} files</span>
                      </button>
                      {catExpanded && sortedYears.map(([year, months]) => {
                        const yearKey = `tiny/${group.category}/${year}`;
                        const yearExpanded = expandedYears.has(yearKey);
                        const sortedMonths = Array.from(months.entries());
                        const yearTotal = sortedMonths.reduce((sum, [, items]) => sum + items.length, 0);

                        return (
                          <div key={yearKey} className="orgTreeYear">
                            <button
                              className="orgTreeToggle orgTreeYearHeader"
                              onClick={() => toggleExpandYear(yearKey)}
                            >
                              <span className="orgTreeArrow">{yearExpanded ? "\u25BC" : "\u25B6"}</span>
                              <span className="orgTreeYearLabel">{year}</span>
                              <span className="orgTreeCount">{yearTotal} files</span>
                            </button>
                            {yearExpanded && sortedMonths.map(([month, items]) => {
                              const monthKey = `${yearKey}/${month}`;
                              return (
                                <div key={monthKey} className="orgTreeMonth">
                                  <div className="orgTreeMonthHeader">
                                    <span className="orgTreeMonthLabel">{month}</span>
                                    <span className="orgTreeCount">{items.length} files</span>
                                  </div>
                                  <ul className="orgTreeFileList">
                                    {items.map((item) => {
                                      const name = item.source.replace(/\\/g, "/").split("/").pop() ?? item.source;
                                      return (
                                        <li key={item.source} className="orgTreeFile" title={item.source}>
                                          {name}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
