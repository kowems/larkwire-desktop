/**
 * macOS dev 启动器：让开发态菜单栏首项显示「灵鹊」。
 *
 * 背景：屏幕菜单栏那个加粗首项由 AppKit 拥有，只从运行 bundle 的 Info.plist CFBundleName 读取；
 * app.setName 仅改 Electron 内部名（官方 docs 原话：does not affect the name that the OS uses；
 * issue #19892，2019 至今），dev 直接跑 node_modules 里的 Electron.app → 加粗首项恒为 Electron，
 * 自定义 Menu.setApplicationMenu 同样改不动它（已 AX 实测）。
 * 做法：把 Electron.app APFS 克隆（cp -c 写时复制，几乎不占空间）到 .dev-shell/灵鹊.app，
 * 改 CFBundleName/CFBundleDisplayName/CFBundleIdentifier 后从克隆体启动；配 main.ts 在 ready 前的
 * app.setName，加粗首项与 About/Hide/Quit 子项全部显示灵鹊。
 * 「关于灵鹊」原生面板同样只认 Info.plist：版本行「版本X (Y)」X=CFBundleShortVersionString、
 * Y=CFBundleVersion（均已实测），不读 app.getVersion()，故两个版本字段一并写成桌面 package.json
 * 版本，否则面板露出 Electron 壳版本（44.4.5）。打包版由 electron-builder 从 package.json 生成 plist，
 * 无需处理。electron 版本、应用版本或本配方变化（.dev-shell/.marker）时自动重建克隆。
 *
 * 用法：
 *   node scripts/dev-shell.mjs [透传给应用的参数…]  准备克隆壳（如需）并启动应用
 *   node scripts/dev-shell.mjs --prepare            只准备克隆壳，stdout 打印可执行路径（e2e 用）
 * 环境变量（e2e 隔离用，日常开发不用设）：
 *   LARKWIRE_DEV_SHELL_DIR  覆盖克隆壳根目录（缺省 .dev-shell）
 *   LARKWIRE_DEV_BUNDLE_ID  覆盖 bundle id（缺省 site.kowims.larkwire.desktop.dev）
 * 非 macOS：bundle 名机制无对应物，直接透传跑原 electron。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ → packages/desktop
const require = createRequire(join(pkgDir, "package.json"));
/** electron 的 CJS 入口导出可执行文件路径：…/electron/dist/Electron.app/Contents/MacOS/Electron */
const electronExe = require("electron");

const APP_NAME = "灵鹊";
/** 与打包版 appId（site.kowims.larkwire.desktop）区分，单实例锁/AX 定位互不串台 */
const DEV_BUNDLE_ID = "site.kowims.larkwire.desktop.dev";
/** e2e 隔离用：克隆壳根目录可覆盖（每次测试独立壳，不碰 Eric 正在运行的 .dev-shell） */
const SHELL_ROOT = process.env.LARKWIRE_DEV_SHELL_DIR || join(pkgDir, ".dev-shell");
/** e2e 隔离用：bundle id 可覆盖——同 id 多个 adhoc 壳时 System Events/LaunchServices 会串进程 */
const BUNDLE_ID = process.env.LARKWIRE_DEV_BUNDLE_ID || DEV_BUNDLE_ID;
/** 克隆配方版本：改了改名/版本/图标注入规则就抬版本，强制所有人重建 */
const MARKER_VERSION = 3;
/** 桌面应用自身版本：关于面板的两个 plist 版本字段都写它，与打包版口径一致 */
const APP_VERSION = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
/**
 * 品牌图标资产：assets/icon.icns 是按 macOS Big Sur+ 形状（Apple 连续圆角、824 网格）
 * 预生成的合规 icns；OS 层图标（Dock/Finder/Force-Touch）由 Info.plist CFBundleIconFile 指向它。
 * 直接覆盖 electron.icns 也能换图，但保留独立 larkwire.icns 语义更清晰、升级 electron 不踩歧义。
 */
const BRAND_ICNS = join(pkgDir, "assets", "icon.icns");
/** 图标资产哈希进 marker：换图标文件自动触发重建 */
const ICON_SHA = createHash("sha256").update(readFileSync(BRAND_ICNS)).digest("hex");

const prepareOnly = process.argv.includes("--prepare");

if (process.platform !== "darwin") {
  if (prepareOnly) {
    process.stdout.write(electronExe + "\n");
    process.exit(0);
  }
  launch(electronExe);
} else {
  const shellExe = prepareShell(electronExe);
  if (prepareOnly) {
    process.stdout.write(shellExe + "\n");
    process.exit(0);
  }
  launch(shellExe);
}

function launch(exe) {
  const passthrough = process.argv.slice(2).filter((a) => a !== "--prepare");
  // Cursor/VSCode 宿主给 shell 注入 ELECTRON_RUN_AS_NODE=1——透传会让壳被当纯 Node 跑
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [pkgDir, "--larkwire-desktop", ...passthrough], {
    stdio: "inherit",
    env,
  });
  const forward = (sig) => () => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function prepareShell(exe) {
  // exe: …/electron/dist/Electron.app/Contents/MacOS/Electron
  const sourceBundle = dirname(dirname(dirname(exe)));
  if (!sourceBundle.endsWith(".app")) throw new Error(`意外的 electron 可执行路径：${exe}`);
  const electronPkgRoot = dirname(dirname(sourceBundle)); // …/electron（dist 的上一级）
  const electronVersion = JSON.parse(
    readFileSync(join(electronPkgRoot, "package.json"), "utf8"),
  ).version;

  const shellRoot = SHELL_ROOT;
  const shellBundle = join(shellRoot, `${APP_NAME}.app`);
  const shellExe = join(shellBundle, "Contents", "MacOS", basename(exe)); // CFBundleExecutable 保持 Electron
  const markerPath = join(shellRoot, ".marker");
  const marker = JSON.stringify({
    v: MARKER_VERSION,
    electronVersion,
    appName: APP_NAME,
    bundleId: BUNDLE_ID,
    appVersion: APP_VERSION,
    iconSha256: ICON_SHA,
  });

  let rebuild = !existsSync(shellExe);
  if (!rebuild) {
    try {
      rebuild = readFileSync(markerPath, "utf8") !== marker;
    } catch {
      rebuild = true;
    }
  }

  if (rebuild) {
    rmSync(shellRoot, { recursive: true, force: true });
    mkdirSync(shellRoot, { recursive: true });
    // 优先 APFS 写时复制克隆（同卷近乎零占用、秒成）；环境不支持时退回实体拷贝
    const clone = spawnSync("cp", ["-cR", sourceBundle, shellBundle], { stdio: "ignore" });
    if (clone.error || clone.status !== 0) {
      const copy = spawnSync("cp", ["-R", sourceBundle, shellBundle], { stdio: "inherit" });
      if (copy.error || copy.status !== 0) throw new Error("克隆 electron 壳失败");
    }
    const plist = join(shellBundle, "Contents", "Info.plist");
    // CFBundleName 是关键（只改 DisplayName 无效，已实测）；bundleId 改掉防与原 Electron.app 注册冲突
    plistSet(plist, "CFBundleName", APP_NAME);
    plistSet(plist, "CFBundleDisplayName", APP_NAME);
    plistSet(plist, "CFBundleIdentifier", BUNDLE_ID);
    // 原生关于面板「版本X (Y)」两字段各管一段（B1/B2 对照实测），缺一会露出半个壳版本
    plistSet(plist, "CFBundleShortVersionString", APP_VERSION);
    plistSet(plist, "CFBundleVersion", APP_VERSION);
    // OS 层图标换品牌图：装入 Resources/icon.icns 并让 CFBundleIconFile 指向它，
    // 与打包版 Resources/icon.icns 同名同物；否则克隆壳保留 electron.icns，
    // Dock/Finder/Force-Touch 全是 Electron 默认图标（issue #89）。
    copyFileSync(BRAND_ICNS, join(shellBundle, "Contents", "Resources", "icon.icns"));
    plistSet(plist, "CFBundleIconFile", "icon.icns");
    writeFileSync(markerPath, marker, { mode: 0o600 });
  }

  return shellExe;
}

function plistSet(plist, key, value) {
  const set = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], {
    stdio: "ignore",
  });
  if (set.status === 0) return;
  const add = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Add :${key} string ${value}`, plist],
    { stdio: "inherit" },
  );
  if (add.error || add.status !== 0) throw new Error(`Info.plist 写入 ${key} 失败`);
}
