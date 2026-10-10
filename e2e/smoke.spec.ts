/**
 * 桌面壳冒烟（项目首个自动化测试桩，WP2 计划钉死 2-3 条）：
 *   S1 隔离空 HOME → 首窗配对视图渲染（默认本地中继在，qr 真出；waiting 选择器兜底）
 *   S2 合成 config HOME（新设备身份+假配对手机）→ 主窗渲染：状态条+空会话态，无 fatal
 *   S3 S2 形态 close-to-tray：关窗不退 app、窗口不销毁，activate 重显
 *   S4 launchd 接管（WP3）：合成 plist 存在 → bootout（未加载报错忽略）→ plist 退役删除
 *      → 无活 pid 秒过轮询 → 主窗照常无 fatal + 日志留接管完成行
 *
 * 纪律：HOME=mkdtemp 假家（绝不拿真 HOME 跑测试桥）；全文件默认中继 = beforeAll 拉起的
 * 测试内本地真实中继 sharedRelayUrl，空 HOME 用例经 LARKWIRE_RELAY_URL 环境变量指过去。
 * 2026-10-07 前默认直指生产，每跑一条就用临时身份往生产库注册，累计积了 366 台噪声设备。
 * LARKWIRE_AWAY_IDLE_SEC=99999 自噬隔离。
 */
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { execSync, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { deviceIdFromKey, generateKeyPair, u8ToB64, b64ToU8, makeEnvelope, type Envelope } from "@larkwire/protocol";
import { WebSocket } from "ws";
import nacl from "tweetnacl";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // e2e/ → packages/desktop
const req = createRequire(join(pkgDir, "package.json"));
/** electron 的 CJS index.js 导出二进制路径字符串（读 path.txt） */
const electronBin = req("electron") as string;

/**
 * 按唯一 bundle id 经「全量 repeat + 属性内联判断」定位进程：读屏幕菜单栏真实加粗首项
 * （Apple 为 item 1，App 菜单为 item 2）。不用 `first process whose ...`：实测本机同时有旧
 * Electron 壳存活时，whose/first 选择器（含 unix id、bundle identifier is、甚至 whose ... contains）
 * 一律被路由到旧壳——其 bid 甚至不含目标串；而 repeat 内逐个读 bundle identifier 走另一条解析路径，
 * 实测能正确识别唯一新壳。进程未在 AX 注册/无辅助功能权限时返回 null，交外层重试。
 */
function axBoldMenuTitle(bundleId: string): string | null {
  const script = `
tell application "System Events"
  set found to missing value
  repeat with p in every application process
    try
      if bundle identifier of p contains "${bundleId}" then
        set found to p
        exit repeat
      end if
    end try
  end repeat
  if found is missing value then return "NO_PROC"
  return name of menu bar item 2 of menu bar 1 of found
end tell`;
  try {
    const out = execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: 20000,
    }).trim();
    return out === "NO_PROC" ? null : out;
  } catch {
    return null;
  }
}

/**
 * window server 层（CGWindowList）读回指定进程的在屏窗口，不经 System Events/AX。
 * 2026-10-08 实测本机 AX 平面全局退化：System Events 对所有进程（含 Cursor/Finder）
 * windows 计数恒为 0，且 UI elements 出现自指「application」镜像，原生关于面板的
 * 版本文本无法再走 AX 读回；CGW 仍如实见到面板（无标题、约 278×168 的新窗口）。
 */
type CgwWin = { pid: number; layer: number; width: number; height: number; name: string };

function cgwWindows(pids: number[]): CgwWin[] {
  const out = execFileSync("swift", [join(pkgDir, "e2e", "cgw-windows.swift"), ...pids.map(String)], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const wins: CgwWin[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("CGW|")) continue;
    const [, pid, layer, width, height, ...rest] = line.split("|");
    wins.push({
      pid: Number(pid),
      layer: Number(layer),
      width: Number(width),
      height: Number(height),
      name: rest.join("|"),
    });
  }
  return wins;
}

/**
 * S17/S18 专用：准备一个「每次唯一」的克隆壳。本机同时有 Eric 正在运行的 dev 实例时，测试壳
 * 与它共用 bundle id + 同一路径，System Events/LaunchServices 会串进程（AX 菜单点到旧壳、
 * 读到 Electron 壳版本 44.4.5——S18 首跑实测）。克隆根目录放在包内（与 electron 同卷，APFS
 * clone 才成立），bundle id 取自目录名保证唯一。
 */
function prepareE2eShell(): {
  shellExe: string;
  plist: string;
  shellRoot: string;
  bundleId: string;
} {
  const shellRoot = mkdtempSync(join(pkgDir, ".dev-shell-e2e-"));
  const slug = basename(shellRoot).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const bundleId = `site.kowims.larkwire.desktop.${slug}`;
  const shellExe = execSync(`node ${join(pkgDir, "scripts", "dev-shell.mjs")} --prepare`, {
    encoding: "utf8",
    env: { ...process.env, LARKWIRE_DEV_SHELL_DIR: shellRoot, LARKWIRE_DEV_BUNDLE_ID: bundleId },
  }).trim();
  const plist = join(dirname(dirname(shellExe)), "Info.plist");
  return { shellExe, plist, shellRoot, bundleId };
}

/** 删除测试专用克隆壳（须在 app.close() 后调）；失败不影响判定，残留由 .gitignore 忽略 */
function removeE2eShell(shellRoot: string): void {
  try {
    rmSync(shellRoot, { recursive: true, force: true });
  } catch {
    // 环境不允许删除时留给人工清理
  }
}

async function launchApp(home: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  // Cursor/VSCode 宿主给 Claude/终端 shell 注入 ELECTRON_RUN_AS_NODE=1——原样透传会让
  // electron 被当纯 node 跑（Process failed to launch，2026-09-24 冒烟 4/4 全挂钓出），必须剔除
  const { ELECTRON_RUN_AS_NODE: _dropped, ...hostEnv } = process.env;
  return electron.launch({
    executablePath: electronBin,
    // --user-data-dir 必须（2026-09-24 钓出）：macOS 的 userData 走 NS* API 读 passwd 真实家目录，
    // 不吃 HOME env——不覆盖时测试实例与真 App 共享 userData，单实例锁冲突秒退 exit 0（真 App 在跑则 4/4 全挂）
    args: [".", "--larkwire-desktop", `--user-data-dir=${join(home, "userData")}`],
    cwd: pkgDir,
    env: {
      ...hostEnv,
      HOME: home,
      LARKWIRE_AWAY_IDLE_SEC: "99999",
      // bootout 打在真 gui 域上（HOME 隔离无效）——测试用不存在的 Label 变体防误杀真常驻桥
      LARKWIRE_LAUNCHD_LABEL: "site.kowems.larkwire.bridge-e2e",
      ...extraEnv,
    },
  });
}

/** S5/S6 共用：在假 HOME 的 projects 下写一条合成转录（自造内容，非真实会话） */
const WP5_SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function writeSyntheticTranscript(home: string): void {
  const projDir = "-Users-test-wp5";
  const dir = join(home, ".claude", "projects", projDir);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "user",
    timestamp: new Date().toISOString(),
    cwd: "/Users/test/wp5",
    message: { role: "user", content: "合成测试行（WP5 冒烟，非真实会话）" },
  });
  writeFileSync(join(dir, `${WP5_SID}.jsonl`), line + "\n");
}

const WD_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Date → "Sun Sep 13 07:50:10 2026"（UTC 墙钟，与注册表 procStart 口径一致） */
function utcWallClock(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${WD_NAMES[d.getUTCDay()]} ${MO_NAMES[d.getUTCMonth()]} ${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** 造一个从未见过的新桥身份 + 一台假手机配对条目（返回身份，供本地中继落 active 配对）。
 *  relayUrl 缺省走全文件共享本地中继 sharedRelayUrl（beforeAll 已拉起）；需要中继承认
 *  假手机的行级测试必须经 seedActivePairing 把配对落进【对应】中继库，否则鉴权后
 *  pair.status（#83）会把中继不认识的假手机秒清，行级测试无从下手 */
function makeSyntheticHomeEx(relayUrl?: string): {
  home: string;
  bridgeDeviceId: string;
  phoneDeviceId: string;
} {
  const home = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const kp = generateKeyPair();
  const pub = u8ToB64(kp.publicKey);
  const phoneKp = generateKeyPair();
  const phonePub = u8ToB64(phoneKp.publicKey);
  const phoneDeviceId = deviceIdFromKey(phonePub);
  mkdirSync(join(home, ".larkwire"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(
    join(home, ".larkwire", "config.json"),
    JSON.stringify({
      deviceId: deviceIdFromKey(pub),
      publicKey: pub,
      secretKey: u8ToB64(kp.secretKey),
      name: "desktop-smoke",
      relay: relayUrl ?? sharedRelayUrl,
      pairPageBase: "https://larkwire.kowems.site/pair",
      paired: [
        { deviceId: phoneDeviceId, publicKey: phonePub, name: "冒烟假手机", pairedAt: Date.now() },
      ],
    }),
    { mode: 0o600 },
  );
  return { home, bridgeDeviceId: deviceIdFromKey(pub), phoneDeviceId };
}

/** 历史调用口径：只要家目录路径（生产中继场景不需要身份） */
function makeSyntheticHome(relayUrl?: string): string {
  return makeSyntheticHomeEx(relayUrl).home;
}

/** 往测试内中继库直接落一条 active 配对（桥配置里的假手机由此成为中继事实，不被 pair.status 清） */
function seedActivePairing(dbPath: string, bridgeId: string, phoneId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO pairings (bridge_id, phone_id, status, created_at) VALUES (?, ?, 'active', ?)`,
    ).run(bridgeId, phoneId, Date.now());
  } finally {
    db.close();
  }
}

/** S14：起一个测试内本地真实中继（随机端口 + HOME 内 db），等 listening 后返回进程与 ws 地址。
 *  extraEnv 供 S20 注入 dummy GETUI_* 与 GETUI_BASE_URL（默认值不变，绝不透到生产形态） */
function spawnLocalRelay(
  home: string,
  extraEnv: Record<string, string> = {},
): { relayProc: ChildProcess; relayUrl: string } {
  const port = 10_000 + Math.floor(Math.random() * 50_000);
  const tsxBin = join(pkgDir, "..", "..", "node_modules", ".bin", "tsx");
  const relayEntry = join(pkgDir, "..", "relay", "src", "index.ts");
  const relayProc = spawn(tsxBin, [relayEntry], {
    env: {
      ...process.env,
      LARKWIRE_RELAY_HOST: "127.0.0.1",
      LARKWIRE_RELAY_PORT: String(port),
      LARKWIRE_RELAY_DB: join(home, "relay.db"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { relayProc, relayUrl: `ws://127.0.0.1:${port}/ws` };
}

/** S16：模拟真手机——自持密钥对，走 hello→challenge→auth 完整握手（与中继集成测试 SimDevice 同口径） */
class SimPhone {
  readonly kp = nacl.box.keyPair();
  readonly deviceId: string;
  readonly name: string;
  private ws!: WebSocket;

  constructor(name: string) {
    this.name = name;
    this.deviceId = deviceIdFromKey(u8ToB64(this.kp.publicKey));
  }

  /** 连接并完成认证挑战，auth.ok 后返回 */
  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("模拟手机 connect/auth 超时")), 10_000);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          kind: "hello",
          v: 1,
          deviceId: this.deviceId,
          publicKey: u8ToB64(this.kp.publicKey),
          name: this.name,
        }));
      });
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as {
          kind?: string;
          cipher?: string;
          ephemeralPublicKey?: string;
        };
        if (msg.kind === "auth.challenge") {
          const packed = b64ToU8(msg.cipher as string);
          const boxNonce = packed.slice(0, nacl.box.nonceLength);
          const ct = packed.slice(nacl.box.nonceLength);
          const nonce = nacl.box.open(
            ct, boxNonce, b64ToU8(msg.ephemeralPublicKey as string), this.kp.secretKey,
          );
          if (!nonce) {
            clearTimeout(timer);
            reject(new Error("模拟手机 challenge 解不开"));
            return;
          }
          ws.send(JSON.stringify({ kind: "auth.response", nonce: u8ToB64(nonce) }));
        } else if (msg.kind === "auth.ok") {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /** 手机扫码后发 pair.accept（to=relay，明文 body） */
  sendPairAccept(token: string): void {
    const body = { token, publicKey: u8ToB64(this.kp.publicKey), name: this.name };
    this.ws.send(JSON.stringify(makeEnvelope("pair.accept", this.deviceId, "relay", 0, JSON.stringify(body))));
  }

  /** 等桥发来的指定类型信封（S16 用来确认 pair.confirm 已到） */
  waitForEnvelope(type: string, timeoutMs = 10_000): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`模拟手机等 ${type} 超时`)), timeoutMs);
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Partial<Envelope> & { kind?: string };
        if (msg.v === 1 && msg.type === type) {
          clearTimeout(timer);
          resolve(msg as Envelope);
        }
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 已关则忽略 */
    }
  }
}

/** 轮询子进程 stdout，等到中继 listening（10s 超时） */
async function waitRelayReady(relayProc: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("本地中继 listening 超时")), 10_000);
    relayProc.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    relayProc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`本地中继提前退出 code=${code}`));
    });
  });
}

/**
 * 全文件共享本地中继（beforeAll 拉起 / afterAll 拆除）：对中继行为「无所谓」的用例一律连它，
 * 绝不以临时身份注册生产——2026-10-07 前默认直指生产，生产库积了 366 台从未配对的噪声设备。
 * 需要行级控制配对的用例（S9/S12/S13/S14/S15/S16）仍各自 spawn 独立中继，互不干扰。
 */
let sharedRelayHome = "";
let sharedRelayProc: ChildProcess | null = null;
let sharedRelayUrl = "";

test.beforeAll(async () => {
  test.setTimeout(30_000);
  sharedRelayHome = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-sharedrelay-"));
  const r = spawnLocalRelay(sharedRelayHome);
  sharedRelayProc = r.relayProc;
  sharedRelayUrl = r.relayUrl;
  await waitRelayReady(sharedRelayProc);
});

test.afterAll(() => {
  if (sharedRelayProc?.pid) {
    sharedRelayProc.kill("SIGTERM");
    setTimeout(() => {
      if (sharedRelayProc?.pid && !sharedRelayProc.killed) sharedRelayProc.kill("SIGKILL");
    }, 5_000).unref();
  }
  try {
    rmSync(sharedRelayHome, { recursive: true, force: true });
  } catch {
    /* /tmp 系统自清 */
  }
});

test("S1 空 HOME → 首窗配对视图渲染", async () => {
  const app = await launchApp(mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-")), {
    LARKWIRE_RELAY_URL: sharedRelayUrl, // 空 HOME 配对流程走共享本地中继，不注册生产
  });
  try {
    // 应用名必须是「灵鹊」：dev 直接跑 Electron 壳时默认菜单首项显示 Electron（#86）
    expect(await app.evaluate(({ app: electronApp }) => electronApp.name)).toBe("灵鹊");
    const page = await app.firstWindow();
    await expect(page.locator("#preload-fail")).toBeHidden();
    await expect(page.locator("#view-pair")).toBeVisible();
    // 中继通→qr 图；不通→waiting 文案；两者其一必须可见（不断言网络）
    // waitForSelector 非严格模式：联合选择器任一可见即过（locator 严格模式遇双匹配会炸）
    await page.waitForSelector("#qr:not(.hidden), #qr-waiting:not(.hidden)", { state: "visible" });
  } finally {
    await app.close();
  }
});

test("S2 合成配对 config → 主窗渲染：状态条+空会话态、无 fatal", async () => {
  const app = await launchApp(makeSyntheticHome());
  try {
    const page = await app.firstWindow();
    await expect(page.locator("#preload-fail")).toBeHidden();
    await expect(page.locator("#view-main")).toBeVisible();
    await expect(page.locator("#statusbar")).toBeVisible();
    // pidfile 独立 + config 合法 → startBridge 不该抛 → 无 fatal 横幅
    await expect(page.locator("#fatal-banner")).toBeHidden();
    // 假 projects 目录为空 → 空会话态文案
    await expect(page.locator("#sessions-empty")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("S4 launchd 接管：合成 plist 退役 + 主窗照常 + 日志明示", async () => {
  const home = makeSyntheticHome();
  const plistDir = join(home, "Library", "LaunchAgents");
  mkdirSync(plistDir, { recursive: true });
  // 内容不重要（接管逻辑只看存在性不解析）；文件名用 e2e Label 变体——见 launchApp 的
  // LARKWIRE_LAUNCHD_LABEL 注释：真 Label 的 bootout 会误杀真常驻桥（HOME 隔离对 launchctl 无效）
  const plistPath = join(plistDir, "site.kowems.larkwire.bridge-e2e.plist");
  writeFileSync(plistPath, "<!-- 假 plist -->");
  const app = await launchApp(home);
  try {
    const page = await app.firstWindow();
    // bootout 对未加载服务报错=忽略；合成家无活 pid → 轮询秒过 → 桥正常起
    await expect(page.locator("#view-main")).toBeVisible();
    await expect(page.locator("#fatal-banner")).toBeHidden();
    // 接管证据：日志留完成行（:has-text=Playwright 引擎选择器；details 折叠故只查 attached）+ plist 已删
    await page.waitForSelector("#main-log:has-text('launchd 接管完成')", { state: "attached" });
    expect(existsSync(plistPath)).toBe(false);
  } finally {
    await app.close();
  }
});

test("S5 注册表活条目（pid=测试进程自身）→ 💻 徽章含 PID 渲染", async () => {
  const home = makeSyntheticHome();
  writeSyntheticTranscript(home);
  // procStart 取本测试进程真实启动时刻（ps lstart 本地墙钟→转 UTC），否则 PID 复用防护
  // （|lstart - procStart| > 5s 判尸体）会把条目滤掉
  const lstart = execSync(`ps -p ${process.pid} -o lstart=`, { encoding: "utf8" }).trim();
  const procStart = utcWallClock(new Date(lstart));
  const sessDir = join(home, ".claude", "sessions");
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: WP5_SID, procStart, kind: "interactive" }),
  );
  const app = await launchApp(home);
  try {
    const page = await app.firstWindow();
    // #77：组默认收起，先展开 wp5 项目组；行定位精确到 .group-items 内（避免连同组容器一起匹配）
    await page.locator(".group-head:has-text('wp5')").click();
    const row = page.locator(`.group-items li:has(.s-occ.occ-desktop:has-text("PID ${process.pid}"))`);
    await expect(row).toBeVisible();
    // 别窗占用→「关掉该窗口并接管」钮同在（真链路=杀进程，绝不进自动化点击）
    await expect(row.locator("[data-testid=btn-killopen]")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("S6 合成转录、无持有者 → 空闲徽章 + ▶ 终端接管钮存在", async () => {
  const home = makeSyntheticHome();
  writeSyntheticTranscript(home);
  const app = await launchApp(home);
  try {
    const page = await app.firstWindow();
    // #77：先展开 wp5 组，再定位空闲行
    await page.locator(".group-head:has-text('wp5')").click();
    const row = page.locator(`.group-items li:has(.s-occ.occ-free)`);
    await expect(row).toBeVisible();
    await expect(row.locator(".s-occ")).toHaveText("空闲");
    // 按钮真链路=弹真 Terminal 跑 resume——只验存在与接线，点击列真机手动清单
    await expect(row.locator("[data-testid=btn-terminal]")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("S7 系统守护面板：默认启用、口径文案在", async () => {
  const app = await launchApp(makeSyntheticHome());
  try {
    const page = await app.firstWindow();
    // #76：守护收进左栏导航，先切 tab
    await page.locator("[data-testid=nav-guard]").click();
    await expect(page.locator("#guard-details")).toBeVisible();
    await expect(page.locator("#guard-enabled-cb")).toBeChecked();
    await expect(page.locator("#guard-state-badge")).toHaveText("看护中");
    // 生产口径只读展示：90% / 5 分钟
    await expect(page.locator("#guard-meta")).toHaveText(/阈值 90%/);
    await expect(page.locator("#guard-meta")).toHaveText(/持续 5 分钟/);
    await expect(page.locator("#guard-events-empty")).toBeVisible();
  } finally {
    await app.close();
  }
});

/**
 * S8 真实忙进程全链路：造一个唯一名的 yes 二进制（Mach-O 复制，ps comm 带该名），
 * 守护测试口短口径（1s 轮询 / 2s 触发）→ 面板先出现可疑进程行 → 真被 SIGTERM 消失 → 处置记录落面板。
 */
test("S8 忙进程被守护发现并结束：可疑行→进程消失→处置记录", async () => {
  const home = makeSyntheticHome();
  const busyDir = mkdtempSync(join(tmpdir(), "larkwire-guard-busy-"));
  // ps 的 comm 取 argv[0]——`exec -a` 伪造唯一名（shebang 脚本直跑只会显示 /bin/bash；
  // 复制签名二进制换路径会被 AMFI 判 Killed: 9）。busyName 用全路径，匹配子串 guard-busy-e2e
  const busyName = join(busyDir, "guard-busy-e2e");
  const busy: ChildProcess = spawn(
    "/bin/bash",
    ["-c", `exec -a '${busyName}' bash -c 'while true; do :; done'`],
    { stdio: "ignore" },
  );
  const busyPid = busy.pid;
  if (!busyPid) throw new Error("忙进程启动失败");

  const electronApp = await launchApp(home, {
    LARKWIRE_GUARD_MATCH: "guard-busy-e2e",
    LARKWIRE_GUARD_INTERVAL_SEC: "1",
    LARKWIRE_GUARD_SUSTAIN_SEC: "2",
  });
  try {
    const page = await electronApp.firstWindow();
    // #76：先切到守护 tab
    await page.locator("[data-testid=nav-guard]").click();
    // 第一轮采样后即可疑行出现（行内含该 PID）
    await expect(page.locator(`#guard-suspects li:has-text("PID ${busyPid}")`)).toBeVisible({ timeout: 15_000 });

    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // 2 轮即触发 TERM——真机进程必须真的消失（不 mock）
    await expect.poll(() => alive(busyPid), { timeout: 15_000 }).toBe(false);
    await expect(page.locator(`#guard-events li:has-text("PID ${busyPid}")`)).toBeVisible({ timeout: 5_000 });
    // 进程消失后可疑行随之清掉
    await expect(page.locator(`#guard-suspects li:has-text("PID ${busyPid}")`)).toHaveCount(0);
  } finally {
    await electronApp.close();
    if (!busy.killed) busy.kill("SIGKILL");
  }
});

test("S9 主窗重配全链路：手机面板→停桥亮码→取消回主窗重启桥", async () => {
  // #84 起改走测试内本地中继：生产中继 pair.status（#83）会秒清未登记的假手机，
  // 行级断言来不及；本地库 seed 一条 active 配对即保住行，ack 回环毫秒级顺带压竞态
  const relayHome = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const { relayProc, relayUrl } = spawnLocalRelay(relayHome);
  try {
    await waitRelayReady(relayProc);
    const { home, bridgeDeviceId, phoneDeviceId } = makeSyntheticHomeEx(relayUrl);
    seedActivePairing(join(relayHome, "relay.db"), bridgeDeviceId, phoneDeviceId);
    const app = await launchApp(home);
    try {
      const page = await app.firstWindow();
      // #76：手机页收进左栏导航，先切 tab
      await page.locator("[data-testid=nav-phones]").click();
      await expect(page.locator("#phones-details")).toBeVisible();
      await expect(page.locator("[data-testid=paired-phone]")).toContainText("冒烟假手机");
      // 已有手机时底部按钮是追加入口「＋ 添加手机」
      await expect(page.locator("[data-testid=pair-add]")).toHaveText("＋ 添加手机");

      // 点「添加手机」有 confirm 弹窗——先挂自动接受
      page.on("dialog", (d) => void d.accept());
      await page.locator("[data-testid=pair-add]").click();
      await expect(page.locator("#view-pair")).toBeVisible();
      // 桥真停、配对连接真到中继：QR 图出来（=PairOfferAck 已回），非仅 waiting 文案
      await expect(page.locator("#qr:not(.hidden)")).toBeVisible({ timeout: 20_000 });

      // 取消 → startMainFlow 新桥连接 4000 踢掉配对连接，主窗恢复且无 fatal
      await page.locator("[data-testid=pair-cancel]").click();
      await expect(page.locator("#view-main")).toBeVisible();
      await expect(page.locator("#fatal-banner")).toBeHidden();
      // 取消后回默认会话 tab——手机页切回去仍可见
      await page.locator("[data-testid=nav-phones]").click();
      await expect(page.locator("#phones-details")).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    if (relayProc.pid) {
      relayProc.kill("SIGTERM");
      setTimeout(() => {
        if (relayProc.pid && !relayProc.killed) relayProc.kill("SIGKILL");
      }, 5_000).unref();
    }
  }
});

test("S10 左栏导航：五项齐全、默认会话页、切守护/设置生效", async () => {
  const app = await launchApp(makeSyntheticHome());
  try {
    const page = await app.firstWindow();
    for (const key of ["sessions", "phones", "guard", "logs", "settings"]) {
      await expect(page.locator(`[data-testid=nav-${key}]`)).toBeVisible();
    }
    // 默认会话 tab
    await expect(page.locator("#tab-sessions")).toBeVisible();
    await expect(page.locator("#phones-details")).toBeHidden();

    // 切守护：会话页隐藏、守护页可见，默认启用角标
    await page.locator("[data-testid=nav-guard]").click();
    await expect(page.locator("#tab-sessions")).toBeHidden();
    await expect(page.locator("#guard-details")).toBeVisible();
    await expect(page.locator('[data-nav-badge=guard]')).toHaveText("看护中");

    // 切设置：开机自启 checkbox 可见
    await page.locator("[data-testid=nav-settings]").click();
    await expect(page.locator("#tab-settings")).toBeVisible();
    await expect(page.locator("#loginitem-cb")).toBeVisible();

    // 切日志：大日志窗可见
    await page.locator("[data-testid=nav-logs]").click();
    await expect(page.locator("#main-log")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("S11 会话按项目分组：默认收起、组头文案、点开再收起", async () => {
  const home = makeSyntheticHome();
  writeSyntheticTranscript(home);
  const app = await launchApp(home);
  try {
    const page = await app.firstWindow();
    const head = page.locator("[data-testid=group-head]");
    await expect(head).toBeVisible();
    await expect(head.locator(".group-name")).toHaveText("wp5");
    await expect(head.locator(".group-meta")).toHaveText(/1 个/);
    // 默认箭头 ▸、组内会话行隐藏
    await expect(head.locator(".group-arrow")).toHaveText("▸");
    const items = page.locator(".group-items");
    await expect(items).toBeHidden();

    // 点开：行出现、箭头翻 ▾
    await head.click();
    await expect(items).toBeVisible();
    await expect(head.locator(".group-arrow")).toHaveText("▾");
    await expect(items.locator("li[data-session]")).toBeVisible();

    // 再点收起
    await head.click();
    await expect(items).toBeHidden();
    await expect(head.locator(".group-arrow")).toHaveText("▸");
  } finally {
    await app.close();
  }
});

test("S12 窗口内解除绑定：确认后行消失+空态出现、config 落盘已删配对", async () => {
  const relayHome = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const { relayProc, relayUrl } = spawnLocalRelay(relayHome);
  try {
    await waitRelayReady(relayProc);
    const { home, bridgeDeviceId, phoneDeviceId } = makeSyntheticHomeEx(relayUrl);
    seedActivePairing(join(relayHome, "relay.db"), bridgeDeviceId, phoneDeviceId);
    const app = await launchApp(home);
    try {
      const page = await app.firstWindow();
      await page.locator("[data-testid=nav-phones]").click();
      await expect(page.locator("[data-testid=paired-phone]")).toContainText("冒烟假手机");
      await expect(page.locator("#phones-empty")).toBeHidden();

      // 解绑有 confirm 弹窗——自动接受（含可能的失败 alert）
      page.on("dialog", (d) => void d.accept());
      await page.locator("[data-testid=phone-unpair]").click();

      // 桥真删配对（revokePeer → 推送状态）：行消失、空态出现
      await expect(page.locator("[data-testid=paired-phone]")).toHaveCount(0);
      await expect(page.locator("#phones-empty")).toBeVisible();
      // 面板徽章「全部离线」；左栏角标总数归零（空串）
      await expect(page.locator("#phones-badge")).toHaveText("全部离线");
      await expect(page.locator('[data-nav-badge=phones]')).toHaveText("");

      // 落盘回读：解绑不只是 UI 行为，config.json paired 已清空
      const cfg = JSON.parse(readFileSync(join(home, ".larkwire", "config.json"), "utf8")) as { paired: unknown[] };
      expect(cfg.paired).toEqual([]);
    } finally {
      await app.close();
    }
  } finally {
    if (relayProc.pid) {
      relayProc.kill("SIGTERM");
      setTimeout(() => {
        if (relayProc.pid && !relayProc.killed) relayProc.kill("SIGKILL");
      }, 5_000).unref();
    }
  }
});

test("S13 行内「重新配对」：确认后先解绑落盘→自动亮二维码（区别于「解除绑定」不亮码）", async () => {
  const relayHome = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const { relayProc, relayUrl } = spawnLocalRelay(relayHome);
  try {
    await waitRelayReady(relayProc);
    const { home, bridgeDeviceId, phoneDeviceId } = makeSyntheticHomeEx(relayUrl);
    seedActivePairing(join(relayHome, "relay.db"), bridgeDeviceId, phoneDeviceId);
    const app = await launchApp(home);
    try {
      const page = await app.firstWindow();
      await page.locator("[data-testid=nav-phones]").click();
      await expect(page.locator("[data-testid=phone-repair]")).toBeVisible();

      // 重新配对有 confirm 弹窗——自动接受（含可能的失败 alert）
      page.on("dialog", (d) => void d.accept());
      await page.locator("[data-testid=phone-repair]").click();

      // 链路一：解绑真落盘（不等扫码，config paired 已清空）
      await expect
        .poll(() => {
          const cfg = JSON.parse(readFileSync(join(home, ".larkwire", "config.json"), "utf8")) as { paired: unknown[] };
          return cfg.paired.length;
        })
        .toBe(0);

      // 链路二：解绑后续接 pairStart，配对视图 + 真实 QR（PairOfferAck 已回）。
      // 回环 ack 毫秒级，正好复压 #84 的快速握手丢帧
      await expect(page.locator("#view-pair")).toBeVisible();
      await expect(page.locator("#qr:not(.hidden)")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("#view-main")).toBeHidden();
    } finally {
      await app.close();
    }
  } finally {
    if (relayProc.pid) {
      relayProc.kill("SIGTERM");
      setTimeout(() => {
        if (relayProc.pid && !relayProc.killed) relayProc.kill("SIGKILL");
      }, 5_000).unref();
    }
  }
});

test("S14 本地真实中继对账：config 带中继不认识的假手机→桥连接后 pair.status 清理落盘 paired=[]", async () => {
  const home = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const { relayProc, relayUrl } = spawnLocalRelay(home);
  let launched = false;
  try {
    await waitRelayReady(relayProc);
    // 合成 config 指向本地中继；本地中继里没有任何配对（假手机从未在此登记过）
    const appHome = makeSyntheticHome(relayUrl);
    const app = await launchApp(appHome);
    launched = true;
    try {
      const page = await app.firstWindow();
      await expect(page.locator("#view-main")).toBeVisible();
      // 桥鉴权后收到 pair.status（peers=[]）→ handlePairStatus 把假手机清掉并落盘。
      // 回读 config.json：不是 UI 隐藏，是配对记录真的没了
      await expect
        .poll(
          () => {
            const cfg = JSON.parse(readFileSync(join(appHome, ".larkwire", "config.json"), "utf8")) as { paired: unknown[] };
            return cfg.paired.length;
          },
          { timeout: 15_000 },
        )
        .toBe(0);
    } finally {
      await app.close();
    }
  } finally {
    if (relayProc.pid) {
      relayProc.kill("SIGTERM");
      // 不等退出（tsx 单进程，SIGTERM 即走）；5s 兜底强杀，防吊住 worker
      setTimeout(() => {
        if (relayProc.pid && !relayProc.killed) relayProc.kill("SIGKILL");
      }, 5_000).unref();
    }
  }
});

test("S15 本地快速握手：ack 毫秒级到达→二维码照常显示，pair:snapshot 与画面同帧", async () => {
  // 回归 Eric 2026-10-05 报障「一直显示连接中继，生成二维码，卡住」：本地中继同机回环，
  // pair.offer 的 ack 毫秒级返回，url 帧极易早于渲染端监听注册——旧代码丢帧即永久卡住。
  const home = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const { relayProc, relayUrl } = spawnLocalRelay(home);
  try {
    await waitRelayReady(relayProc);
    // 空身份（paired=[]）→ 启动即配对流；中继指向本地回环
    mkdirSync(join(home, ".larkwire"), { recursive: true });
    const kp = generateKeyPair();
    const pub = u8ToB64(kp.publicKey);
    writeFileSync(
      join(home, ".larkwire", "config.json"),
      JSON.stringify({
        deviceId: deviceIdFromKey(pub),
        publicKey: pub,
        secretKey: u8ToB64(kp.secretKey),
        name: "desktop-s15",
        relay: relayUrl,
        pairPageBase: "https://larkwire.kowems.site/pair",
        paired: [],
      }),
      { mode: 0o600 },
    );
    const app = await launchApp(home);
    try {
      const page = await app.firstWindow();
      await expect(page.locator("#view-pair")).toBeVisible();
      // 二维码 10s 内必须真正显示（旧代码遇竞态会永久停在 qr-waiting）
      await expect(page.locator("#qr:not(.hidden)")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("#qr-waiting")).toBeHidden();
      // 快照契约：主进程留底的最近帧必须是 url，且 pairUrl 与画面一致
      const frame = (await page.evaluate(() =>
        (globalThis as unknown as { larkwire: { getPairSnapshot: () => Promise<unknown> } }).larkwire.getPairSnapshot(),
      )) as { phase: string; data: { pairUrl: string } };
      expect(frame.phase).toBe("url");
      expect(frame.data.pairUrl).toBe(await page.locator("#pair-url").textContent());
    } finally {
      await app.close();
    }
  } finally {
    if (relayProc.pid) {
      relayProc.kill("SIGTERM");
      setTimeout(() => {
        if (relayProc.pid && !relayProc.killed) relayProc.kill("SIGKILL");
      }, 5_000).unref();
    }
  }
});

test("S16 手机扫码后窗口换舞台：二维码收起、副标题变、确认键无需滚动完整可见且获焦，点确认配对落盘", async () => {
  const relayHome = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const { relayProc, relayUrl } = spawnLocalRelay(relayHome);
  const phone = new SimPhone("扫码新手机");
  try {
    await waitRelayReady(relayProc);
    const { home, bridgeDeviceId, phoneDeviceId } = makeSyntheticHomeEx(relayUrl);
    seedActivePairing(join(relayHome, "relay.db"), bridgeDeviceId, phoneDeviceId);
    const app = await launchApp(home);
    try {
      const page = await app.firstWindow();
      await page.locator("[data-testid=nav-phones]").click();
      page.on("dialog", (d) => void d.accept());
      await page.locator("[data-testid=pair-add]").click();
      await expect(page.locator("#qr:not(.hidden)")).toBeVisible({ timeout: 20_000 });

      // 从画面上的配对 URL 取 token（与真手机扫码得到的是同一个），模拟手机走完真实握手
      const pairUrl = (await page.locator("#pair-url").textContent()) as string;
      const token = new URL(pairUrl).searchParams.get("t") as string;
      expect(token.length).toBeGreaterThan(0);
      await phone.connect(relayUrl);
      // 桥应收到 pair.confirm——在发送 accept 前挂起等待
      const confirmP = phone.waitForEnvelope("pair.confirm");
      phone.sendPairAccept(token);

      // 状态变化一：二维码舞台整组收起（不是在二维码下方追加内容）
      await expect(page.locator("#pair-stage")).toBeHidden({ timeout: 10_000 });
      // 状态变化二：副标题明示「手机已扫码」
      await expect(page.locator("#pair-sub")).toHaveText(/✅ 手机「扫码新手机」已扫码/);
      await expect(page.locator("#fp-panel.fp-focus")).toBeVisible();

      // 交互重心：「一致，完成配对」完整落在视口内，无需滚动
      const geom = await page.locator("#fp-yes").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          vh: (globalThis as unknown as { innerHeight: number }).innerHeight,
        };
      });
      expect(geom.top).toBeGreaterThanOrEqual(0);
      expect(geom.bottom).toBeLessThanOrEqual(geom.vh);
      // 焦点已在确认键上（回车即可完成）
      await expect(page.locator("#fp-yes")).toBeFocused();

      // 真点确认：桥发 pair.confirm（手机真实收到）+ paired 落盘新手机
      await page.locator("#fp-yes").click();
      await confirmP;
      await expect
        .poll(() => {
          const cfg = JSON.parse(readFileSync(join(home, ".larkwire", "config.json"), "utf8")) as {
            paired: Array<{ deviceId: string }>;
          };
          return cfg.paired.some((p) => p.deviceId === phone.deviceId);
        }, { timeout: 10_000 })
        .toBe(true);
    } finally {
      await app.close();
    }
  } finally {
    phone.close();
    if (relayProc.pid) {
      relayProc.kill("SIGTERM");
      setTimeout(() => {
        if (relayProc.pid && !relayProc.killed) relayProc.kill("SIGKILL");
      }, 5_000).unref();
    }
  }
});

test("S3 close-to-tray：关窗不退出、activate 重显", async () => {
  const app = await launchApp(makeSyntheticHome());
  try {
    const page = await app.firstWindow();
    await expect(page.locator("#view-main")).toBeVisible();
    // 走主进程关窗（page.close() 会被壳的 preventDefault  veto 吊住——那正是被测行为本身）
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    const st = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { count: BrowserWindow.getAllWindows().length, visible: w ? w.isVisible() : null };
    });
    expect(st.count).toBe(1); // 隐藏非销毁
    expect(st.visible).toBe(false);
    await app.evaluate(({ app: electronApp }) => electronApp.emit("activate")); // 模拟 dock 点击
    await expect(page.locator("#view-main")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("S17 dev 改名克隆壳：OS 菜单栏加粗首项为灵鹊（AX 实测，非仅 JS 侧 label）", async () => {
  // 每次唯一的克隆壳根目录+bundle id，避免与 Eric 正在运行的 dev 实例在 System Events 串进程
  const { shellExe, plist, shellRoot, bundleId } = prepareE2eShell();
  expect(
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleName", plist], {
      encoding: "utf8",
    }).trim(),
    "克隆壳 Info.plist CFBundleName",
  ).toBe("灵鹊");

  const home = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const { ELECTRON_RUN_AS_NODE: _dropped, ...hostEnv } = process.env;
  const app = await electron.launch({
    executablePath: shellExe,
    args: [".", "--larkwire-desktop", `--user-data-dir=${join(home, "userData")}`],
    cwd: pkgDir,
    env: {
      ...hostEnv,
      HOME: home,
      LARKWIRE_RELAY_URL: sharedRelayUrl, // 空 HOME 配对流程走共享本地中继，不注册生产
      LARKWIRE_AWAY_IDLE_SEC: "99999",
      LARKWIRE_LAUNCHD_LABEL: "site.kowems.larkwire.bridge-e2e",
    },
  });
  try {
    await app.firstWindow();
    // JS 内部名（About/Hide/Quit 等菜单子项据此生成）
    expect(await app.evaluate(({ app: electronApp }) => electronApp.name)).toBe("灵鹊");
    // #86 教训：JS Menu 模型的 label 与 OS 标题会脱节（setName 官方承诺不影响 OS 名）——
    // 加粗首项必须问 System Events；进程 AX 注册有延迟，轮询 10s
    let bold: string | null = null;
    for (let i = 0; i < 20; i++) {
      bold = axBoldMenuTitle(bundleId);
      if (bold === "灵鹊") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(bold, "OS 菜单栏加粗首项（AX 实测）").toBe("灵鹊");
  } finally {
    await app.close();
    removeE2eShell(shellRoot);
  }
});

test("S18 dev 克隆壳关于面板：版本行为桌面版本而非 Electron 壳版本（OS 面板实测）", async () => {
  const appVersion = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  // 每次唯一的克隆壳（同 id/同路径串进程是 S18 首跑读到 44.4.5 的根因）
  const { shellExe, plist, shellRoot, bundleId } = prepareE2eShell();
  // plist 回读：覆盖参数确实生效；两个版本字段都必须是桌面版本——「版本X (Y)」各管一段（B1/B2 对照实测）
  expect(
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], {
      encoding: "utf8",
    }).trim(),
    "克隆壳 Info.plist CFBundleIdentifier",
  ).toBe(bundleId);
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    expect(
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
        encoding: "utf8",
      }).trim(),
      `克隆壳 Info.plist ${key}`,
    ).toBe(appVersion);
  }

  const home = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const { ELECTRON_RUN_AS_NODE: _dropped, ...hostEnv } = process.env;
  const app = await electron.launch({
    executablePath: shellExe,
    args: [".", "--larkwire-desktop", `--user-data-dir=${join(home, "userData")}`],
    cwd: pkgDir,
    env: {
      ...hostEnv,
      HOME: home,
      LARKWIRE_RELAY_URL: sharedRelayUrl, // 空 HOME 配对流程走共享本地中继，不注册生产
      LARKWIRE_AWAY_IDLE_SEC: "99999",
      LARKWIRE_LAUNCHD_LABEL: "site.kowems.larkwire.bridge-e2e",
    },
  });
  try {
    await app.firstWindow();
    await new Promise((r) => setTimeout(r, 1500)); // 等主窗上屏，建立 CGW 基线
    const rootPid = app.process().pid;
    if (!rootPid) throw new Error("Electron 根进程无 pid，无法做 window server 层读回");
    const baseline = cgwWindows([rootPid]);
    // 原生入口 orderFrontStandardAboutPanel，从进程内触发：AX 菜单点击实测会被
    // System Events 路由到旧壳（first-process 选择器串台）。先抢前台，面板才落在屏幕菜单栏下
    const triggerAbout = () =>
      app.evaluate(({ app: electronApp }) => {
        electronApp.focus({ steal: true });
        electronApp.showAboutPanel();
      });
    await triggerAbout();
    // CGW 读回：面板在 window server 层表现为「本进程一个新的无标题小窗」
    // （2026-10-08 实测 278×168，给足版本差异容差）。按墙上时钟轮询 20s，
    // 记录最后一次窗口现场供失败归因
    let panel: CgwWin | null = null;
    let lastDiag = "(未执行任何探测)";
    const isPanel = (w: CgwWin) =>
      w.layer === 0 &&
      w.width >= 200 &&
      w.width <= 500 &&
      w.height >= 100 &&
      w.height <= 400 &&
      w.name === "" &&
      !baseline.some((b) => b.width === w.width && b.height === w.height && b.name === w.name);
    const deadline = Date.now() + 20_000;
    let retriggerAt = Date.now() + 8_000; // 8s 仍未见：再抢前台重发一次（防首次调用落在激活竞态）
    for (;;) {
      const wins = cgwWindows([rootPid]);
      const found = wins.find(isPanel);
      if (found) {
        panel = found;
        break;
      }
      lastDiag = wins.map((w) => `${w.width}x${w.height} layer=${w.layer} name=${JSON.stringify(w.name)}`).join("; ");
      if (Date.now() >= deadline) break;
      if (Date.now() >= retriggerAt) {
        void triggerAbout();
        retriggerAt = Infinity;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!panel) {
      throw new Error(`关于面板 20s 内未在 window server 层出现。最后窗口现场：${lastDiag}`);
    }
    // app.getVersion() 同口径：返回桌面 package.json 版本（打包版读 CFBundleShortVersionString）
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getVersion()), "app.getVersion()").toBe(
      appVersion,
    );
  } finally {
    await app.close();
    removeE2eShell(shellRoot);
  }
});

type ProbeReport = {
  passed: boolean;
  elapsedMs: number;
  sizes: Record<
    string,
    { passed: boolean; anchors: number; anchorHits: number; anchorHitRatio: number }
  >;
};

/** execFileSync 非零退出时实际抛出的形状（本仓 @types/node 的 ExecFileException 未声明 status/stdout） */
type ExecError = { status?: number; stdout?: unknown };

test("S19 dev 克隆壳 OS 级图标：NSWorkspace 读回为灵鹊品牌图，stock Electron 壳零品牌锚点", () => {
  // 纯 OS read-back（不启动 app、不读 JS 侧值）：icon-probe 经 NSWorkspace→LaunchServices
  // （与 Finder/Dock 同源）问系统认定的 .app 图标，再与期望品牌 icns 的高饱和彩色锚点比对。
  // 阴阳必须同时实测：只证明「修复壳是品牌图」不算数，还得证明同探针在 stock Electron 上必挂。
  // 颜色容差用 45（非缺省 35）：macOS 26 的 Liquid Glass 容器对内部内容做了轻微缩放/
  // 色彩漂移（已渲染对比，内容右移约 1px、颜色略偏），tol35 时 32px 18/61=0.295 差一锚点；
  // tol45 实测 32px 21/61=0.344、16px 12/14=0.857，而 stock Electron 阴阳壳仍为 0/0——
  // 区分度没被放松。2026-10-05 标定。
  const probe = join(pkgDir, "scripts", "icon-probe.swift");
  const expectedIcon = join(pkgDir, "assets", "icon.icns");
  const { shellRoot } = prepareE2eShell();
  try {
    const shellApp = join(shellRoot, "灵鹊.app");

    // 阳性：修复后的唯一克隆壳，exit 0 且两尺寸锚点命中达标
    const positive = JSON.parse(
      execFileSync("swift", [probe, shellApp, expectedIcon, "--tolerance", "45"], {
        cwd: pkgDir,
        encoding: "utf8",
        timeout: 30_000,
      }),
    ) as ProbeReport;
    expect(positive.passed, "阳性壳探针 passed").toBe(true);
    for (const size of ["32", "16"]) {
      const r = positive.sizes[size]!;
      expect(r.passed, `阳性壳 ${size}px passed`).toBe(true);
      expect(r.anchorHits, `阳性壳 ${size}px 锚点命中数`).toBeGreaterThanOrEqual(3);
      expect(r.anchorHitRatio, `阳性壳 ${size}px 锚点命中率`).toBeGreaterThanOrEqual(0.3);
    }

    // 阴性：stock Electron.app，必须 exit 1 且两尺寸零品牌锚点
    const stockElectron = join(pkgDir, "node_modules", "electron", "dist", "Electron.app");
    try {
      execFileSync("swift", [probe, stockElectron, expectedIcon, "--tolerance", "45"], {
        cwd: pkgDir,
        encoding: "utf8",
        timeout: 30_000,
      });
      throw new Error("stock Electron 图标探针本应 exit 1，却意外通过——品牌锚点判定已失效");
    } catch (error) {
      // execFileSync 非零退出抛带 status/stdout 的错误；上面主动抛的 Error 无 status，必须透传
      if ((error as ExecError).status !== 1) throw error;
      const negative = JSON.parse(String((error as ExecError).stdout)) as ProbeReport;
      expect(negative.passed, "阴性壳探针 passed").toBe(false);
      expect(negative.sizes["32"]!.anchorHits, "阴性壳 32px 锚点命中").toBe(0);
      expect(negative.sizes["16"]!.anchorHits, "阴性壳 16px 锚点命中").toBe(0);
    }
  } finally {
    removeE2eShell(shellRoot);
  }
});

test("S20 看模式回合完成推送：专用中继+dummy 个推指本地 sink，实收 ✅ wp5 · 会话回合完成", async () => {
  test.setTimeout(60_000);

  // ① 模拟个推网关（真实 http 收包，全程不连真实个推/生产）：/:appid/auth 与 /:appid/push/single/cid
  const pushes: Record<string, unknown>[] = [];
  const sink = await new Promise<Server>((resolve, reject) => {
    const srv = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const reqUrl = req.url ?? "";
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          payload = {};
        }
        if (reqUrl.endsWith("/auth")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            code: 0,
            data: { token: "fake-auth-token", expire_time: String(Date.now() + 3600_000) },
          }));
          return;
        }
        pushes.push(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0 }));
      });
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const sinkPort = (sink.address() as AddressInfo).port;

  // ② 专用本地中继：dummy 三键 + GETUI_BASE_URL 指本 sink（⚠️ GETUI_BASE_URL 生产勿设，仅测试注入）
  const relayHome = mkdtempSync(join(tmpdir(), "larkwire-s20-relay-"));
  const { relayProc, relayUrl } = spawnLocalRelay(relayHome, {
    GETUI_APP_ID: "dummy-app-id",
    GETUI_APP_KEY: "dummy-app-key",
    GETUI_MASTER_SECRET: "dummy-master-secret",
    GETUI_BASE_URL: `http://127.0.0.1:${sinkPort}`,
  });
  let app: ElectronApplication | undefined;
  try {
    await waitRelayReady(relayProc);

    // ③ 新桥身份+假手机（配置中继指专用中继），落 active 配对与假个推 token
    const { home, bridgeDeviceId, phoneDeviceId } = makeSyntheticHomeEx(relayUrl);
    const dbPath = join(relayHome, "relay.db");
    seedActivePairing(dbPath, bridgeDeviceId, phoneDeviceId);
    const relayDb = new DatabaseSync(dbPath);
    try {
      relayDb
        .prepare(
          `INSERT INTO push_tokens (device_id, token, platform, updated_at) VALUES (?, ?, 'ios', ?)`,
        )
        .run(phoneDeviceId, "cid-s20-fake", Date.now());
    } finally {
      relayDb.close();
    }

    // ④ 先写 user 行再启动 app——新文件无 saved state，watcher 首见 offset=当前 EOF
    writeSyntheticTranscript(home);
    app = await launchApp(home, {
      LARKWIRE_DONE_DEBOUNCE_SEC: "1",
      LARKWIRE_AWAY_IDLE_SEC: "0",
    });

    // ⑤ 等 watcher 发现文件（poll 500ms，留足两个轮询周期），再【追加】assistant end_turn 行：
    //    先于发现写入会被 offset 跳过，turnEnd 永远不触发
    await new Promise((r) => setTimeout(r, 1500));
    const transcriptPath = join(
      home, ".claude", "projects", "-Users-test-wp5", `${WP5_SID}.jsonl`,
    );
    const assistantLine = JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      cwd: "/Users/test/wp5",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "合成测试回合结束（S20 冒烟，非真实会话）" }],
      },
    });
    writeFileSync(transcriptPath, assistantLine + "\n", { flag: "a" });

    // ⑥ 轮询 sink ≤20s，断言全链路实收文案（android notification + ios aps 双口径）
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && pushes.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pushes.length, "sink 应实收 1 条个推 push").toBeGreaterThanOrEqual(1);
    const req0 = pushes[0]!;
    const androidBody = (
      req0.push_message as { notification?: { body?: string } }
    ).notification?.body;
    const iosBody = (
      req0.push_channel as { ios?: { aps?: { alert?: { body?: string } } } }
    ).ios?.aps?.alert?.body;
    expect(androidBody).toBe("✅ wp5 · 会话回合完成");
    expect(iosBody).toBe("✅ wp5 · 会话回合完成");

    // 点击直达：payload 仍为 JSON{sessionId}（WP5_SID，session id 由文件名归一）
    const notif = (req0.push_message as { notification: Record<string, unknown> }).notification;
    expect(notif.click_type).toBe("payload");
    expect(notif.payload).toBe(JSON.stringify({ sessionId: WP5_SID }));
  } finally {
    if (app) await app.close().catch(() => {});
    relayProc.kill("SIGTERM");
    setTimeout(() => {
      if (relayProc.pid && !relayProc.killed) relayProc.kill("SIGKILL");
    }, 5_000).unref();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    try {
      rmSync(relayHome, { recursive: true, force: true });
    } catch {
      /* /tmp 系统自清 */
    }
  }
});
