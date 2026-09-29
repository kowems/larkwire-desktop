/**
 * preload（sandbox + contextIsolation）：renderer 与主进程间的最小 IPC 面。
 * 打包成 CJS .cjs——sandbox 形态下 ESM preload 受限（WP2 计划钉死）。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// renderer 是无类型 vanilla JS——payload 在 IPC 边界本就无法静态约束，用 any 如实表达
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cb = (payload: any) => void;

function on(channel: string) {
  return (cb: Cb) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("larkwire", {
  // 主 → 渲染
  onState: on("state"),
  onLog: on("log"),
  onPairUrl: on("pair:url"),
  onPairFp: on("pair:fp"),
  onPairError: on("pair:error"),
  // 渲染 → 主
  getState: () => ipcRenderer.invoke("state:get"),
  pairConfirm: (ok: boolean) => ipcRenderer.send("pair:confirm", ok),
  pairRetry: () => ipcRenderer.send("pair:retry"),
  setLoginItem: (open: boolean) => ipcRenderer.send("loginitem:set", open),
  // WP5 #49 会话占用管理
  releaseSession: (sessionId: string) => ipcRenderer.invoke("session:release", sessionId),
  openTerminal: (sessionId: string) => ipcRenderer.invoke("session:open-terminal", sessionId),
  killOpen: (sessionId: string) => ipcRenderer.invoke("session:kill-open", sessionId),
  // 系统守护（#72）
  setGuardEnabled: (on: boolean) => ipcRenderer.invoke("guard:set-enabled", on),
});
