import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("rsm", {
  platform: process.platform
});
