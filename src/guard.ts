/**
 * 系统守护（批次④ #72，2026-09-28 Eric 拍板「协议、桥、监控统一进桌面 App」）：
 * CPU 失控进程兜底——匹配进程连续满载约 5 分钟即 SIGTERM，弹通知、上面板。
 *
 * 判定口径与原外挂 ~/.local/bin/cursor-exthost-watchdog.sh 逐字一致（真机实测过）：
 *   - 每 20 秒一轮 ps 采样；瞬时 CPU% ≥ 90 计一轮
 *   - 单次采样跌破阈值只衰减 1 不清零（防调度抖动；真爆发结束后也会很快放完）
 *   - 连续约 300 秒（15 轮）才 TERM——绝不 SIGKILL
 *
 * 模块不碰 Electron：通知/状态推送走注入钩子（与桥核心 onLog 等钩子同风格），
 * 进程表是内存 Map（App 本身即常驻体，不需要外挂那套 state 文件）。
 * 当前唯一看护对象=Cursor 扩展宿主；以后加对象只需往匹配表加子串。
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { larkwireDir } from "@larkwire/core";

const execFileP = promisify(execFile);

/** 匹配子串表——对 ps 的 comm（含路径）做 includes；加新看护对象只动这里 */
const DEFAULT_MATCHES = ["Cursor Helper (Plugin)"];
const DEFAULT_THRESHOLD = 90;
const DEFAULT_INTERVAL_SEC = 20;
const DEFAULT_SUSTAIN_SEC = 300;
/** 事件环持久化上限（与外挂日志一样只留近期） */
const EVENT_KEEP = 50;
/** 面板「近期处置」展示条数 */
const EVENTS_IN_STATE = 10;

export interface GuardEvent {
  /** 秒级本地时间 YYYY-MM-DD HH:MM:SS */
  ts: string;
  text: string;
}

export interface GuardSuspect {
  pid: number;
  cpu: number;
  /** 按轮数折算的已持续高负载秒数 */
  sustainedSecs: number;
}

export interface GuardSnapshot {
  enabled: boolean;
  threshold: number;
  intervalSecs: number;
  sustainSecs: number;
  /** 本轮匹配到的进程总数 */
  watching: number;
  suspects: GuardSuspect[];
  /** 近期处置，最新在前 */
  events: GuardEvent[];
}

export interface GuardHooks {
  /** 状态有实质变化时回调（main 走 pushState） */
  onState?: () => void;
  notify?: (title: string, body: string) => void;
}

interface PersistShape {
  enabled: boolean;
  events: GuardEvent[];
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 秒级本地时间戳（不用 toLocale 系，避免区域设置漂移） */
function nowTs(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

export class ProcessGuard {
  private readonly matches: string[];
  private readonly threshold: number;
  private readonly intervalSecs: number;
  private readonly needRounds: number;
  private readonly persistPath: string;
  private readonly hooks: GuardHooks;

  private enabled: boolean;
  private events: GuardEvent[] = [];
  /** pid → 连续高负载轮数 + 最近一次 CPU% */
  private readonly counters = new Map<number, { count: number; cpu: number }>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private watching = 0;
  /** 上次推送的状态签名——无实质变化不打扰（避免每 20s 重建托盘菜单） */
  private lastSig = "";

  constructor(hooks: GuardHooks = {}) {
    this.hooks = hooks;
    const matchRaw = process.env.LARKWIRE_GUARD_MATCH;
    this.matches = matchRaw
      ? matchRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : DEFAULT_MATCHES;
    this.intervalSecs = numEnv("LARKWIRE_GUARD_INTERVAL_SEC", DEFAULT_INTERVAL_SEC);
    this.threshold = numEnv("LARKWIRE_GUARD_THRESHOLD", DEFAULT_THRESHOLD);
    const sustainSecs = numEnv("LARKWIRE_GUARD_SUSTAIN_SEC", DEFAULT_SUSTAIN_SEC);
    this.needRounds = Math.ceil(sustainSecs / this.intervalSecs);
    this.persistPath = join(larkwireDir(), "guard.json");

    const persisted = this.load();
    this.enabled = persisted?.enabled ?? true;
    this.events = persisted?.events ?? [];
  }

  // ---------- 持久化 ----------

  private load(): PersistShape | null {
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      const obj = JSON.parse(raw) as Partial<PersistShape>;
      if (!Array.isArray(obj.events)) return null;
      return {
        enabled: obj.enabled !== false,
        events: obj.events
          .filter((e): e is GuardEvent => !!e && typeof e.ts === "string" && typeof e.text === "string")
          .slice(-EVENT_KEEP),
      };
    } catch {
      return null; // 无文件/损坏=缺省（守护默认开）
    }
  }

  private persist(): void {
    const data: PersistShape = { enabled: this.enabled, events: this.events.slice(-EVENT_KEEP) };
    try {
      // 守护可能早于桥配置启动（配对视图）——确保 ~/.larkwire 在
      mkdirSync(larkwireDir(), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch {
      /* 落盘失败不挡判定——内存事件环与面板仍在 */
    }
  }

  private addEvent(text: string): void {
    this.events.push({ ts: nowTs(), text });
    if (this.events.length > EVENT_KEEP) this.events = this.events.slice(-EVENT_KEEP);
    this.persist();
  }

  // ---------- 生命周期 ----------

  /** 按当前设置决定跑不跑（app whenReady 调一次） */
  activate(): void {
    if (this.enabled) this.start();
  }

  start(): void {
    if (this.timer) return;
    void this.tick(); // 与外挂 launchd 一样：装完先跑一轮
    this.timer = setInterval(() => void this.tick(), this.intervalSecs * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.start();
    } else {
      this.stop();
      this.counters.clear(); // 关就是关——重开从 0 计，不展示陈旧可疑项
      this.watching = 0;
    }
    this.persist();
    this.pushState(true);
  }

  // ---------- 巡检 ----------

  /**
   * 枚举匹配进程：ps 行 `  pid  cpu  comm…`，comm 可含空格（Cursor Helper (Plugin)），
   * 故只切前两字段、其余整段做子串匹配。
   */
  private async enumerate(): Promise<Map<number, number>> {
    const { stdout } = await execFileP("ps", ["-axo", "pid=,pcpu=,comm="], { maxBuffer: 8 * 1024 * 1024 });
    const found = new Map<number, number>();
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const head = line.trim();
      const sp1 = head.indexOf(" ");
      if (sp1 === -1) continue;
      const pid = Number(head.slice(0, sp1));
      const rest = head.slice(sp1).trim();
      const sp2 = rest.indexOf(" ");
      if (sp2 === -1) continue;
      const cpu = Number(rest.slice(0, sp2));
      const comm = rest.slice(sp2).trim();
      if (!Number.isInteger(pid) || !Number.isFinite(cpu)) continue;
      if (this.matches.some((m) => comm.includes(m))) found.set(pid, cpu);
    }
    return found;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // ps 卡顿时不叠跑
    this.ticking = true;
    try {
      const found = await this.enumerate();
      this.watching = found.size;

      for (const [pid, cpu] of found) {
        const cur = this.counters.get(pid) ?? { count: 0, cpu: 0 };
        cur.cpu = cpu;
        if (cpu >= this.threshold) {
          cur.count += 1;
        } else if (cur.count > 0) {
          // 单次采样可能因调度抖动瞬时跌破，衰减 1 而非清零
          cur.count -= 1;
        }

        if (cur.count >= this.needRounds) {
          this.terminate(pid, cpu, cur.count);
          cur.count = 0;
        }
        this.counters.set(pid, cur);
      }

      // 消失的进程删条目
      for (const pid of this.counters.keys()) {
        if (!found.has(pid)) this.counters.delete(pid);
      }
    } catch {
      /* ps 本轮失败=跳过，下轮再来（不致命，不打扰） */
    } finally {
      this.ticking = false;
    }
    this.pushState(false);
  }

  private terminate(pid: number, cpu: number, rounds: number): void {
    const secs = rounds * this.intervalSecs;
    try {
      process.kill(pid, "SIGTERM");
      const text = `已结束失控进程 PID ${pid}（CPU ${cpu}%，连续约 ${secs}s ≥ ${this.threshold}%）——请回 Cursor Reload Window`;
      this.addEvent(text);
      this.hooks.notify?.("灵鹊系统守护", `已结束失控扩展宿主 PID ${pid}（CPU ${cpu}%），请回 Cursor Reload Window`);
    } catch (err) {
      const why = (err as NodeJS.ErrnoException).code === "ESRCH" ? "进程已退出" : "TERM 发送失败";
      this.addEvent(`PID ${pid}（CPU ${cpu}%）处置未完成：${why}`);
    }
  }

  // ---------- 状态外发 ----------

  snapshot(): GuardSnapshot {
    const suspects: GuardSuspect[] = [];
    for (const [pid, c] of this.counters) {
      if (c.count > 0) {
        suspects.push({ pid, cpu: c.cpu, sustainedSecs: c.count * this.intervalSecs });
      }
    }
    suspects.sort((a, b) => b.sustainedSecs - a.sustainedSecs);
    return {
      enabled: this.enabled,
      threshold: this.threshold,
      intervalSecs: this.intervalSecs,
      sustainSecs: this.needRounds * this.intervalSecs,
      watching: this.watching,
      suspects,
      events: this.events.slice(-EVENTS_IN_STATE).reverse(),
    };
  }

  private sig(s: GuardSnapshot): string {
    return JSON.stringify([
      s.enabled,
      s.watching,
      s.suspects.map((x) => `${x.pid}:${x.cpu}:${x.sustainedSecs}`).join(","),
      // 事件环满 10 条后长度恒定，须把最新一条纳入签名（否则新处置刷不出）
      s.events[0] ? `${s.events[0].ts}|${s.events[0].text}` : "",
    ]);
  }

  /** 状态签名变化才回调；force=扳开关等必须立刻同步的场景 */
  private pushState(force: boolean): void {
    const snap = this.snapshot();
    const sig = this.sig(snap);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.hooks.onState?.();
  }
}
