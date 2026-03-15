/**
 * Dev-mode orchestrator: starts Vite internally, then launches Electron.
 * No concurrently, no wait-on, no standalone webpage.
 *
 * Run via: tsx electron/dev.ts
 */
import { createServer, type ViteDevServer } from "vite";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

// In Node context the "electron" package exports the path to the binary.
const require = createRequire(import.meta.url);
const electronBin: string = require("electron");

let vite: ViteDevServer | null = null;
let electron: ChildProcess | null = null;

async function cleanup(): Promise<void> {
  electron?.kill();
  await vite?.close();
}

async function main(): Promise<void> {
  vite = await createServer();
  await vite.listen();

  const address = vite.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : 5173;
  const devUrl = `http://localhost:${port}`;

  console.log(`\n  Vite dev server ready → ${devUrl}\n`);

  electron = spawn(electronBin, ["dist/electron/main.js"], {
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
    stdio: "inherit",
  });

  electron.on("exit", async (code) => {
    await vite?.close();
    process.exit(code ?? 0);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await cleanup();
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error("Failed to start dev environment:", err);
  await cleanup();
  process.exit(1);
});
