/**
 * 桌面壳冒烟（项目首个自动化测试桩，WP2 计划钉死 2-3 条）：
 *   S1 隔离空 HOME → 首窗配对视图渲染（qr-waiting 或 qr 至少其一——不断言中继可达性）
 *   S2 合成 config HOME（新设备身份+假配对手机）→ 主窗渲染：状态条+空会话态，无 fatal
 *   S3 S2 形态 close-to-tray：关窗不退 app、窗口不销毁，activate 重显
 *   S4 launchd 接管（WP3）：合成 plist 存在 → bootout（未加载报错忽略）→ plist 退役删除
 *      → 无活 pid 秒过轮询 → 主窗照常无 fatal + 日志留接管完成行
 *
 * 纪律：HOME=mkdtemp 假家（绝不拿真 HOME 跑测试桥——S2 桥以全新 deviceId 连生产中继，
 * 无配对手机、零持久状态，等同任意新设备首连，无害）；LARKWIRE_AWAY_IDLE_SEC=99999 自噬隔离。
 */
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { deviceIdFromKey, generateKeyPair, u8ToB64 } from "@larkwire/protocol";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // e2e/ → packages/desktop
const req = createRequire(join(pkgDir, "package.json"));
/** electron 的 CJS index.js 导出二进制路径字符串（读 path.txt） */
const electronBin = req("electron") as string;

async function launchApp(home: string): Promise<ElectronApplication> {
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

/** 造一个从未见过的新桥身份 + 一台永不存在的假手机配对条目 */
function makeSyntheticHome(): string {
  const home = mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-"));
  const kp = generateKeyPair();
  const pub = u8ToB64(kp.publicKey);
  const phoneKp = generateKeyPair();
  const phonePub = u8ToB64(phoneKp.publicKey);
  mkdirSync(join(home, ".larkwire"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(
    join(home, ".larkwire", "config.json"),
    JSON.stringify({
      deviceId: deviceIdFromKey(pub),
      publicKey: pub,
      secretKey: u8ToB64(kp.secretKey),
      name: "desktop-smoke",
      relay: "wss://larkwire.kowems.site/ws",
      pairPageBase: "https://larkwire.kowems.site/pair",
      paired: [
        { deviceId: deviceIdFromKey(phonePub), publicKey: phonePub, name: "冒烟假手机", pairedAt: Date.now() },
      ],
    }),
    { mode: 0o600 },
  );
  return home;
}

test("S1 空 HOME → 首窗配对视图渲染", async () => {
  const app = await launchApp(mkdtempSync(join(tmpdir(), "larkwire-desktop-e2e-")));
  try {
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
    const row = page.locator(`#sessions-list li:has(.s-occ.occ-desktop:has-text("PID ${process.pid}"))`);
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
    const row = page.locator(`#sessions-list li:has(.s-occ.occ-free)`);
    await expect(row).toBeVisible();
    await expect(row.locator(".s-occ")).toHaveText("空闲");
    // 按钮真链路=弹真 Terminal 跑 resume——只验存在与接线，点击列真机手动清单
    await expect(row.locator("[data-testid=btn-terminal]")).toBeVisible();
  } finally {
    await app.close();
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
