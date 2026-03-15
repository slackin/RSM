import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileCategory, OrganizePlanItem } from "@rsm/shared";
import { collectFiles } from "./fileWalker.js";

const typeMap: Array<[RegExp, FileCategory]> = [
  [/\.(jpg|jpeg|png|gif|webp|tiff|heic)$/i, "pictures"],
  [/\.(mp4|mkv|avi|mov|wmv|webm)$/i, "video"],
  [/\.(mp3|wav|flac|ogg|m4a|aac)$/i, "audio"],
  [/\.(pdf|doc|docx|txt|md|xls|xlsx|ppt|pptx)$/i, "documents"],
  [/\.(zip|tar|gz|bz2|7z|rar)$/i, "archives"]
];

function detectCategory(file: string): FileCategory {
  for (const [pattern, category] of typeMap) {
    if (pattern.test(file)) return category;
  }
  return "other";
}

function monthFolder(d: Date): string {
  return d.toLocaleString("en-US", { month: "short" });
}

export async function buildOrganizePlan(
  root: string,
  destination: string,
  categories?: FileCategory[],
  tinyFileThresholdBytes?: number
): Promise<OrganizePlanItem[]> {
  const allowedCategories = categories && categories.length > 0 ? new Set(categories) : null;
  const files = await collectFiles([root]);
  const plan: OrganizePlanItem[] = [];

  for (const file of files) {
    const category = detectCategory(file);
    if (allowedCategories && !allowedCategories.has(category)) continue;

    const stat = await fs.stat(file);
    const date = new Date(stat.mtime);
    const year = String(date.getFullYear());
    const month = monthFolder(date);

    const isTiny = tinyFileThresholdBytes != null && tinyFileThresholdBytes > 0 && stat.size < tinyFileThresholdBytes;
    const base = isTiny ? path.join(destination, "tiny-files") : destination;
    const destinationPath = path.join(base, category, year, month, path.basename(file));

    plan.push({
      source: file,
      destination: destinationPath,
      category
    });
  }

  return plan;
}
