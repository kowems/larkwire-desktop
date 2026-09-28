import { defineConfig } from "@playwright/test";

/** Electron 冒烟：窗口在物理屏弹出，单 worker 串行、速开速关。浏览器无需下载（吃 Electron 自带 Chromium）。 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
});
