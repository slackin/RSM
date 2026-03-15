import { createWriteStream } from "node:fs";
import archiver from "archiver";

export async function createArchive(sourceDir: string, outputArchive: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outputArchive);
    const archive = archiver("zip", { zlib: { level: 9 } });

    out.on("close", () => resolve());
    archive.on("error", reject);

    archive.pipe(out);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}
