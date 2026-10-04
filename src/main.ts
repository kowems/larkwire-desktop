/**
 * 灵鹊桌面壳主进程（批次② WP2，2026-09-22 晚 Eric 拍板口径）：
 * 双皮一份逻辑——桥核心 import 自 larkwire 包（CLI 的 watch/pair 与桌面共用 watch.ts/pair.ts）；
 * 首窗大二维码配对 / 主窗会话列表+状态条 / 托盘 / close-to-tray / 自启默认开 / 单实例。
 *
 * 与 CLI 的差异面（全部经 WP1 开的口注入，桥核心零改造）：
 *   - startBridge({ exitOnFatal:false, handleSignals:false, onLog })——被踢/信号由 app 生命周期接管
 *   - runPair(opts, PairHooks)——亮码/指纹人对照/日志三钩子换成窗口交互
 *   - pidfile 互斥认两种形态：打包=灵鹊.app/Contents/MacOS/…，开发=electron 二进制 + --larkwire-desktop 标记参数
 *
 * WP3：首启接管旧 launchd 形态（larkwire install 装的常驻桥）——bootout 注销 → 退役 plist →
 * 等 pidfile 释放 → 起桥；回退路径保留（larkwire install 随时可重装，pidfile 互斥防双跑）。
 */
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BridgeStartError,
  loadConfig,
  readAlivePid,
  runPair,
  startBridge,
  type BridgeHandle,
  type Occupancy,
} from "@larkwire/core";
import QRCode from "qrcode";
import { ProcessGuard, type GuardSnapshot } from "./guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(here, "renderer", "index.html");
const TRAY_ICON = join(here, "assets", "trayTemplate.png");
/** 与 CLI 同一缺省（cli.ts watch case）：--dir 未给时 ~/.claude/projects */
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
/** 旧 launchd 形态的 Label——必须与 bridge install.ts 的 LABEL 逐字同步（那边改名这边跟着改）。
 *  env 覆盖=测试专用（install.ts PlistSpec 测试 Label 变体同款先例）：bootout 打在**真 gui 域**上，
 *  HOME 隔离对它无效——e2e 必须用不存在的 Label 变体，否则合成 plist 会误杀 Eric 的真常驻桥 */
const LAUNCHD_LABEL = process.env.LARKWIRE_LAUNCHD_LABEL ?? "site.kowems.larkwire.bridge";
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
/** 主进程落盘日志（#78 三方对账）：所有 sendLog 行同时写这里，App 重启/关窗都不丢 */
const LOG_DIR = join(homedir(), ".larkwire");
const LOG_FILE = join(LOG_DIR, "desktop.log");
const LOG_OLD_FILE = join(LOG_DIR, "desktop.log.old");
const LOG_MAX_BYTES = 1_000_000;
const execFileP = promisify(execFile);

type View = "pair" | "main";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: BridgeHandle | null = null;
/** 系统守护（#72）：独立于桥和配对流，app ready 即看护 */
let guard: ProcessGuard | null = null;
let view: View = "main";
let quitting = false;
let lastFatal: string | null = null;
/** 一次性提示横幅（当前唯一来源=launchd 接管）；非致命、纯告知，做完即清 */
let notice: string | null = null;
/** 指纹人对照的挂起 Promise——同一时刻至多一个（pair 流程串行） */
let fpResolve: ((ok: boolean) => void) | null = null;
/** 配对流在途标志（首启自动配对/托盘入口/主窗按钮/重试四源汇入，防并发重入） */
let pairRunning = false;

// ---------- 工具 ----------

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * 日志缓冲：页面加载完成前 send("log") 会丢（webContents.send 不等渲染进程就绪）——
 * 接管/桥启动的早期日志行正是用户最该看到的，缓冲到 did-finish-load 一次性补发。
 */
let rendererReady = false;
const logBuffer: string[] = [];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地时区秒级时间戳（YYYY-MM-DD HH:MM:SS）——落盘对账口径，与全局规则一致 */
function tsNow(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * 追加写盘：单行失败（磁盘满/权限）只吞不挡 UI 日志。
 * 超 1MB 轮转一次（desktop.log → desktop.log.old），只留一代——够对一次解绑账。
 */
function writeDiskLog(line: string): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = statSync(LOG_FILE).size;
    } catch {
      /* 文件还没有 */
    }
    if (size > LOG_MAX_BYTES) {
      try {
        renameSync(LOG_FILE, LOG_OLD_FILE);
      } catch {
        /* 轮转失败就覆盖续写，不挡日志 */
      }
    }
    appendFileSync(LOG_FILE, `${tsNow()} ${line}\n`, { mode: 0o600 });
  } catch {
    /* 落盘失败不拖垮主流程 */
  }
}

function sendLog(line: string): void {
  writeDiskLog(line);
  if (rendererReady) {
    send("log", line);
  } else {
    logBuffer.push(line);
    if (logBuffer.length > 500) logBuffer.shift(); // 与 renderer LOG_CAP 同口径
  }
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s : s.slice(0, i);
}

interface StatePayload {
  view: View;
  fatal: string | null;
  notice: string | null;
  loginItem: boolean;
  snap: {
    deviceId: string;
    name: string;
    relay: string;
    connected: boolean;
    onlinePhones: number;
    pairedPhones: number;
    pendingPermissions: number;
    sessions: {
      sessionId: string;
      project: string;
      title: string;
      lastActiveAt: number;
      occupancy: Occupancy;
    }[];
  } | null;
  /** 配对手机名单（名字直接读 config——桥 snapshot 只给计数不给名） */
  paired: { deviceId: string; name: string }[];
  /** 系统守护状态（任何视图都在——守护独立于桥） */
  guard: GuardSnapshot | null;
}

function statePayload(): StatePayload {
  const snap = bridge?.snapshot() ?? null;
  return {
    view,
    fatal: lastFatal,
    notice,
    loginItem: app.getLoginItemSettings().openAtLogin,
    snap: snap && {
      deviceId: snap.deviceId,
      name: snap.name,
      relay: snap.relay,
      connected: snap.connected,
      onlinePhones: snap.onlinePhones,
      pairedPhones: snap.pairedPhones,
      pendingPermissions: snap.pendingPermissions,
      sessions: snap.sessions.map((s) => ({
        sessionId: s.sessionId,
        project: s.project,
        title: s.title ?? "",
        lastActiveAt: s.lastActiveAt,
        occupancy: s.occupancy,
      })),
    },
    paired: (loadConfig()?.paired ?? []).map((p) => ({ deviceId: p.deviceId, name: p.name })),
    guard: guard ? guard.snapshot() : null,
  };
}

function pushState(): void {
  const st = statePayload();
  send("state", st);
  refreshTray(st);
}

// ---------- 托盘 ----------

function trayStatus(st: StatePayload): string {
  if (st.view === "pair") return "等待手机扫码配对…";
  if (st.fatal) return `⚠ ${firstLine(st.fatal)}`;
  if (!st.snap) return "桥未启动";
  const conn = st.snap.connected ? "已连中继" : "中继连接中…";
  const perm = st.snap.pendingPermissions > 0 ? ` · ${st.snap.pendingPermissions} 张权限卡待答` : "";
  return `${conn} · ${st.snap.onlinePhones}/${st.snap.pairedPhones} 台手机 · ${st.snap.sessions.length} 个会话${perm}`;
}

function refreshTray(st: StatePayload): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗", click: () => showWindow() },
      {
        label: "配对新手机…",
        click: () => {
          showWindow();
          void startPairFlow("tray");
        },
      },
      { label: trayStatus(st), enabled: false },
      { type: "separator" },
      {
        label: "开机自启",
        type: "checkbox",
        checked: st.loginItem,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          pushState();
        },
      },
      { type: "separator" },
      { label: "退出灵鹊", click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  const img = nativeImage.createFromPath(TRAY_ICON);
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip("灵鹊 Larkwire");
  tray.on("click", () => showWindow());
}

// ---------- 窗口 ----------

function showWindow(): void {
  if (!win) createWindow();
  win?.show();
  win?.focus();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    title: "灵鹊 Larkwire",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  rendererReady = false; // 重建窗口（activate 重显）时缓冲重新兜底，直到新页面就绪
  void win.loadFile(RENDERER);
  win.webContents.on("did-finish-load", () => {
    rendererReady = true;
    for (const line of logBuffer.splice(0)) send("log", line);
  });
  win.on("close", (e) => {
    // close-to-tray：主窗关掉只是藏起来，桥照跑（手机无感）。
    // 配对视图：首启无配对关窗=放弃→退出；重配关窗=取消重配、回主窗后收进托盘
    if (quitting) return;
    e.preventDefault();
    if (view === "pair") {
      const cfg = loadConfig();
      if (!cfg || cfg.paired.length === 0) {
        app.quit();
        return;
      }
      void cancelPairFlow().finally(() => win?.hide());
      return;
    }
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
    fpResolve?.(false); // 关窗视作指纹不确认，解开 runPair 挂起
    fpResolve = null;
  });
}

// ---------- 配对流（PairHooks 注入窗口交互） ----------

/** 短调用栈：只留本进程 6 帧内的工程路径，定位「谁触发了配对视图」（#78 对账插桩） */
function shortStack(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(2, 8);
  return frames
    .map((f) => f.replace(/^\s*at /, "").replace(/file:\/\/\/.*\/src\//g, ""))
    .join(" < ");
}

/**
 * 进入配对视图（首启自动配对 / 托盘「配对新手机」/ 主窗按钮 / 失败重试 四源汇入）：
 * 主窗重配时桥占着同一桥身份的中继连接——先停桥腾出身份，否则与 runPair 互踢（4000）。
 * pairRunning 防并发重入；runPair 无外部中止口，取消=另走 cancelPairFlow（新桥连接踢掉旧的）。
 * source 标签 + 调用栈仅为日志对账：查清「没点配对却跳二维码」的真实触发源。
 */
async function startPairFlow(source: string): Promise<void> {
  sendLog(`▶ 配对流启动（来源=${source}）栈：${shortStack()}`);
  if (pairRunning) {
    sendLog(`↩ 配对流已在途，忽略来源=${source} 的重复触发`);
    return;
  }
  pairRunning = true;
  view = "pair";
  lastFatal = null;
  if (bridge) {
    sendLog("正在暂停桥以进行配对…");
    const b = bridge;
    bridge = null; // 状态条立刻反映「桥未启动」，stop 期间不再推桥事件
    pushState();
    await b.stop().catch(() => {});
  }
  send("pair:reset", null);
  pushState();
  void runPair(
    {},
    {
      onLog: (line) => sendLog(line),
      showPairUrl: (pairUrl, bridgeFp) => {
        void QRCode.toDataURL(pairUrl, { width: 480, margin: 1 })
          .then((dataUrl) => send("pair:url", { dataUrl, pairUrl, bridgeFp }))
          .catch((err: unknown) => send("pair:error", { message: `二维码生成失败：${String(err)}` }));
      },
      confirmFingerprint: (ctx) =>
        new Promise<boolean>((resolve) => {
          fpResolve = resolve;
          send("pair:fp", ctx);
        }),
    },
  )
    .then((result) => {
      sendLog(`✅ 配对完成：${result.name}（${result.deviceId.slice(0, 12)}…）`);
      fpResolve = null;
      void startMainFlow();
    })
    .catch((err: unknown) => {
      fpResolve = null;
      send("pair:error", { message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      pairRunning = false;
    });
}

/** 配对视图「取消」：无配对=首启放弃→退出；有配对→回主视图——新桥连接会 4000 踢掉
 *  仍在等扫码的配对连接（runPair 无中止口），其 reject 落 pair:error，主视图不显示，无害 */
async function cancelPairFlow(): Promise<void> {
  sendLog("配对流取消（cancelPairFlow）");
  if (view !== "pair") return;
  fpResolve?.(false);
  fpResolve = null;
  const cfg = loadConfig();
  if (!cfg || cfg.paired.length === 0) {
    app.quit();
    return;
  }
  await startMainFlow();
}

// ---------- launchd 接管（WP3） ----------

/**
 * 桌面 App 是新的常驻形态——检测旧 launchd 桥（larkwire install 装的）还在就接管：
 * bootout 注销服务（旧桥进程随之死，KeepAlive 不再复活）→ 退役 plist → 等 pidfile 释放。
 * 回退路径保留：larkwire install 随时可重装（pidfile 互斥防双跑，谁后起谁吃 fatal）。
 */
async function takeoverLegacyLaunchd(): Promise<void> {
  if (!existsSync(LAUNCHD_PLIST)) return;
  notice = "正在接管开机自启：旧 launchd 形态退役，桌面 App 接手…";
  sendLog("检测到旧版 launchd 自启桥——正在接管（bootout 注销 + 退役 plist）…");
  pushState();
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  // bootout 把旧桥进程带走；未加载/已注销报错=无害（plist 照样退役）
  await execFileP("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]).catch(() => {});
  try {
    unlinkSync(LAUNCHD_PLIST);
  } catch {
    /* 删不掉不挡路——下次启动再试 */
  }
  // 等旧桥死透（pidfile 释放）再 startBridge——否则「活 pid」守卫拒启。
  // 10s 还不放就照常往下走：让守卫抛 BridgeStartError 走 fatal 横幅（诚实失败，不硬杀）
  const t0 = Date.now();
  while (readAlivePid() !== null && Date.now() - t0 < 10_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  sendLog("✅ launchd 接管完成，旧形态已退役（想回退：终端跑 larkwire install 可重装）。");
  notice = null;
  pushState();
}

// ---------- 主流（startBridge + 事件 → 状态推送） ----------

async function startMainFlow(): Promise<void> {
  sendLog("▶ 主流启动（起桥）");
  view = "main";
  lastFatal = null;
  pushState(); // 先亮主窗骨架（接管横幅可见），再接管+起桥
  await takeoverLegacyLaunchd();
  try {
    bridge = startBridge({
      projectsDir: PROJECTS_DIR,
      exitOnFatal: false,
      handleSignals: false,
      onLog: (line) => sendLog(line),
    });
  } catch (err) {
    // 守卫三连拒启（未初始化/零配对/活 pid）——主窗状态条明示，不崩 app
    lastFatal = err instanceof BridgeStartError ? err.message : String(err);
    pushState();
    return;
  }
  // onLog 钩子已覆盖全部日志行（sink 先调、emitter 后调）——这里只订状态类事件，防双发
  bridge.on("conn", () => pushState());
  bridge.on("phones", () => pushState());
  bridge.on("sessions", () => pushState());
  bridge.on("revoked", () => pushState());
  bridge.on("fatal", (info) => {
    lastFatal = info.message;
    pushState();
  });
  pushState();
}

// ---------- 终端接管（WP5 #49：桌面「接管」=在终端打开该会话） ----------

/** shell 单引号转义——cwd 可能含任意字符（空格/引号/中文），sessionId 虽固定 UUID 也同口径走一遍 */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * 弹 Terminal 跑 claude --resume。cwd 只从**桥 snapshot** 取（不接受渲染进程传的路径）；
 * 转录探测不到 cwd 或目录已没了 → 退回 HOME（cd 失败不阻断 resume 命令）。
 * osascript 经 execFile 参数数组传入（无 shell 解释面），全程 async——禁 execSync。
 */
async function openInTerminal(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
  const snap = bridge?.snapshot();
  if (!snap) return { ok: false, reason: "桥未启动" };
  const s = snap.sessions.find((x) => x.sessionId === sessionId);
  if (!s) return { ok: false, reason: "会话不在列表中（可能已被清理）" };
  const cwd = s.cwd && existsSync(s.cwd) ? s.cwd : homedir();
  const cmd = `cd ${shQuote(cwd)} 2>/dev/null; claude --resume ${shQuote(sessionId)}`;
  const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(cmd)}\nend tell`;
  try {
    await execFileP("osascript", ["-e", script]);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Terminal 启动失败：${firstLine(String(err))}` };
  }
}

// ---------- IPC ----------

ipcMain.handle("state:get", () => {
  sendLog("IPC state:get");
  return statePayload();
});

// WP5 #49 三动作：还回 / 终端打开 / 关掉别窗并接管
ipcMain.handle("session:release", (_e, sessionId: unknown) => {
  sendLog(`IPC session:release ${String(sessionId)}`);
  if (typeof sessionId !== "string" || !bridge) return false;
  return bridge.releaseSession(sessionId);
});
ipcMain.handle("session:open-terminal", (_e, sessionId: unknown) => {
  sendLog(`IPC session:open-terminal ${String(sessionId)}`);
  if (typeof sessionId !== "string") return { ok: false, reason: "会话 ID 无效" };
  return openInTerminal(sessionId);
});
ipcMain.handle("session:kill-open", async (_e, sessionId: unknown) => {
  sendLog(`IPC session:kill-open ${String(sessionId)}`);
  if (typeof sessionId !== "string" || !bridge) {
    return { ok: false, reason: "桥未启动或会话 ID 无效" };
  }
  // killHolder 四重验证 + 轮询等死（3s）内置——绝不 SIGKILL；死透后才弹终端
  const killed = bridge.killHolder(sessionId);
  if (!killed.ok) return { ok: false, reason: killed.reason ?? "无法关闭该窗口" };
  const opened = await openInTerminal(sessionId);
  return opened.ok ? { ok: true, pid: killed.pid } : { ok: false, reason: opened.reason };
});
// 「我的手机」页解除绑定：撤销走桥（在线时通知手机+中继），不再需要终端 larkwire unpair
ipcMain.handle("pair:revoke", (_e, deviceId: unknown) => {
  sendLog(`IPC pair:revoke 目标=${String(deviceId)}`);
  if (typeof deviceId !== "string" || !bridge) return false;
  const ok = bridge.revokePeer(deviceId);
  sendLog(ok ? `解绑结果：已撤销 ${String(deviceId)}` : `解绑结果：失败（该手机不在配对列表）`);
  if (ok) pushState();
  return ok;
});
ipcMain.on("pair:confirm", (_e, ok: unknown) => {
  sendLog(`IPC pair:confirm 结果=${ok === true}`);
  fpResolve?.(ok === true);
  fpResolve = null;
});
ipcMain.on("pair:retry", () => {
  sendLog("IPC pair:retry（渲染端「重试」）");
  if (view === "pair") void startPairFlow("ipc:pair-retry");
});
ipcMain.on("pair:cancel", () => {
  sendLog("IPC pair:cancel（渲染端「取消」）");
  void cancelPairFlow();
});
ipcMain.on("pair:start", () => {
  sendLog("IPC pair:start（渲染端「配对/添加手机」按钮，或行内「重新配对」解绑后续接）");
  void startPairFlow("ipc:pair-start");
});
ipcMain.on("loginitem:set", (_e, open: unknown) => {
  sendLog(`IPC loginitem:set ${open === true}`);
  app.setLoginItemSettings({ openAtLogin: open === true });
  pushState();
});
ipcMain.handle("guard:set-enabled", (_e, on: unknown) => {
  sendLog(`IPC guard:set-enabled ${on === true}`);
  guard?.setEnabled(on === true);
  return guard?.snapshot().enabled ?? false;
});

// ---------- app 生命周期 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow()); // macOS dock 点击
  app.on("window-all-closed", () => {
    // 主窗 close-to-tray 不会触发这里；首启配对视图关窗=放弃 → 退出
    if (view === "pair") app.quit();
  });
  app.on("before-quit", (e) => {
    if (quitting) return;
    quitting = true;
    guard?.stop(); // 同步清 interval，不挡退出
    if (!bridge) return; // 无桥可停，放行退出
    e.preventDefault();
    setTimeout(() => app.exit(0), 5000).unref(); // stop 卡死兜底
    void bridge
      .stop()
      .catch(() => {})
      .finally(() => app.exit(0)); // app.exit 不再触发 before-quit
  });

  void app.whenReady().then(() => {
    // 自启默认开仅限打包形态：dev 的 electron 二进制指向 repo（~/Documents TCC 禁区），
    // 注册登录项会在登录时拉一个必死进程——开发态不动登录项（托盘勾选仍可手动开）
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
    // 系统守护先于窗口和桥就位——配对视图/桥没起时系统照护，状态段立即可用
    guard = new ProcessGuard({
      onState: () => pushState(),
      notify: (title, body) => {
        try {
          if (Notification.isSupported()) new Notification({ title, body }).show();
        } catch {
          /* 通知不可用=面板事件环兜底 */
        }
      },
    });
    guard.activate();
    createTray();
    createWindow();
    const cfg = loadConfig();
    sendLog(
      `—— App 启动（packaged=${app.isPackaged}）配置：${cfg ? `已配对 ${cfg.paired.length} 台` : "无配置"}——`,
    );
    if (!cfg || cfg.paired.length === 0) void startPairFlow("startup");
    else void startMainFlow();
  });
}
