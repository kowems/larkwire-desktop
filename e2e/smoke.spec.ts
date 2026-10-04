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
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { deviceIdFromKey, generateKeyPair, u8ToB64 } from "@larkwire/protocol";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url))); // e2e/ → packages/desktop
const req = createRequire(join(pkgDir, "package.json"));
/** electron 的 CJS index.js 导出二进制路径字符串（读 path.txt） */
const electronBin = req("electron") as string;

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
  const app = await launchApp(makeSyntheticHome());
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
    // 桥真停、配对连接真到生产中继：QR 图出来（=PairOfferAck 已回），非仅 waiting 文案
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
  const home = makeSyntheticHome();
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
});

test("S13 行内「重新配对」：确认后先解绑落盘→自动亮二维码（区别于「解除绑定」不亮码）", async () => {
  const home = makeSyntheticHome();
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

    // 链路二：解绑后续接 pairStart，配对视图 + 真实生产 QR（PairOfferAck 已回）
    await expect(page.locator("#view-pair")).toBeVisible();
    await expect(page.locator("#qr:not(.hidden)")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#view-main")).toBeHidden();
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
