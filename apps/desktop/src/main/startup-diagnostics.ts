/**
 * 启动诊断 —— 回答「上一次进程为什么没了」(issue #758)。
 *
 * 背景:用户多次遇到 app 无提示消失后重启,主日志里只有新的 `=== App started ===`,
 * 没有任何退出链路记录(无 forceQuit / before-quit / runQuitDisposers),WER 里也
 * 找不到 dump——完全无法区分 native crash / 外部 kill / 主进程 hang 后被杀。
 *
 * 三件事:
 *
 * 1. **run marker(退出尸检)**:每个进程实例在
 *    `<userData>/diagnostics/run-markers/run-<pid>.json` 维护一份状态标记:
 *      - 启动时写 `running`,之后每 HEARTBEAT_INTERVAL_MS 刷新 heartbeatAt
 *        (心跳跑在 main event loop 上——事后 heartbeatAt 冻结在死亡时刻之前
 *        很久,即为「主进程 event loop 被卡死(hang)」的直接证据);
 *      - lifecycle.beginShutdown → `shutdown-begin`(带 reason);
 *      - runQuitDisposers 跑完 → disposedAt;
 *      - process 'exit' 事件(任何 JS 层退出必经,含 process.exit 强退)→ `exited`。
 *    下次启动扫描所有 pid 已死的残留标记并分类:
 *      - `exited`          → 正常退出(info)
 *      - `shutdown-begin`  → 开始了 shutdown 但没跑完就死了(warn)
 *      - `running`         → 无任何退出记录 = native crash / 外部 kill / hang(error)
 *    per-pid 文件天然容忍 dev 多实例共库与 packaged 单例锁 loser 实例——pid 还活着
 *    的标记跳过不动,不会把并存实例误判成崩溃,也不会互相踩写。
 *
 * 2. **crashReporter**:启动 Electron 内置 Crashpad(uploadToServer:false,只落
 *    本地),让 main / renderer / GPU / utility 的 native crash 从此有 minidump 可查
 *    (此前完全没开,native crash 一个 dump 都不留,这正是 issue 里"找不到 dump"
 *    的原因之一)。
 *
 * 3. **crash dump 扫描**:启动时扫 crashDumps 目录近 14 天的 .dmp,有异常退出记录
 *    时把 dump 清单一并打进日志,反馈排查不用再人肉翻 WER。
 *
 * 平台注记:process.kill(pid, 0) 探活在 macOS / Windows 均可用(Windows 上由
 * libuv 转 OpenProcess 探测);标记文件极小(<400B)、30s 一次写 userData,两端
 * I/O 开销可忽略。pid 复用理论上可能让死进程被误判"还活着"而漏报一次,概率极低
 * 且只影响诊断不影响功能,接受。
 */

import { app, crashReporter } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger';

const log = createLogger('startup-diagnostics');

/** 心跳刷新间隔。30s:足够定位 hang 的时间窗,又不构成可感知的 I/O 负担。 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** crash dump 扫描回看窗口。 */
const DUMP_SCAN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** dump 清单最多列几个(按 mtime 降序),防日志刷屏。 */
const DUMP_LIST_CAP = 10;

export type RunMarkerState = 'running' | 'shutdown-begin' | 'exited';

/** 单个进程实例的运行标记(落盘 JSON 的完整 schema)。 */
export interface RunMarker {
  pid: number;
  version: string;
  startedAt: string; // ISO
  heartbeatAt: string; // ISO
  heartbeatIntervalMs: number;
  state: RunMarkerState;
  /** beginShutdown 的触发入口,e.g. 'before-quit' / 'uncaughtException' / 'update-relaunch' */
  shutdownReason?: string;
  shutdownAt?: string;
  /** runQuitDisposers 全链跑完的时刻;缺失 = disposer chain 没跑完 */
  disposedAt?: string;
  exitCode?: number;
  exitedAt?: string;
}

export type PreviousRunReportKind =
  | 'clean' // exited + exitCode 0 — 正常退出
  | 'crash-exit' // exited + exitCode !== 0 — 经过 lifecycle 的崩溃退出
  | 'shutdown-incomplete' // shutdown-begin — 开始 shutdown 但没跑完
  | 'abnormal' // running — 无任何退出记录(crash / kill / hang)
  | 'still-running' // pid 还活着 — 并存实例,跳过
  | 'corrupt'; // 标记文件解析失败(多半是崩溃瞬间写了一半)

export interface PreviousRunReport {
  kind: PreviousRunReportKind;
  file: string;
  marker?: RunMarker;
}

export interface RunMarkerStoreDeps {
  /** 标记文件目录(调用方保证是 userData 下的路径,勿落仓库工作区) */
  dir: string;
  pid: number;
  version: string;
  now?: () => Date;
  /** 探活钩子,默认 process.kill(pid, 0);测试注入 */
  isPidAlive?: (pid: number) => boolean;
  warn?: (msg: string, err?: unknown) => void;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限(POSIX);其余(ESRCH 等)视为已死。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * run marker 的读写与尸检核心。不 import electron —— 依赖全部注入,单测可在
 * os.tmpdir 下直接驱动(规则 14 / 23)。
 */
export class RunMarkerStore {
  private readonly dir: string;
  private readonly pid: number;
  private readonly version: string;
  private readonly now: () => Date;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly warn: (msg: string, err?: unknown) => void;
  private current: RunMarker | null = null;
  private writeFailureLogged = false;

  constructor(deps: RunMarkerStoreDeps) {
    this.dir = deps.dir;
    this.pid = deps.pid;
    this.version = deps.version;
    this.now = deps.now ?? (() => new Date());
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    this.warn = deps.warn ?? ((msg, err) => log.warn(msg, err));
  }

  private get markerPath(): string {
    return path.join(this.dir, `run-${this.pid}.json`);
  }

  /**
   * 落盘当前标记。同步写:调用点要么是低频状态转换,要么是 process 'exit'
   * 钩子(只能同步)。使用 write-tmp + rename 保证原子性——同目录 rename
   * 在 macOS/Windows 均为原子替换,消除并存实例读到半写内容的窗口。
   */
  private persist(): void {
    if (!this.current) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.markerPath}.${this.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.current));
      fs.renameSync(tmp, this.markerPath);
      this.writeFailureLogged = false;
    } catch (err) {
      if (!this.writeFailureLogged) {
        this.writeFailureLogged = true;
        this.warn('failed to persist run marker (will not repeat)', err);
      }
    }
  }

  /** 本实例启动:写 running 标记。 */
  begin(): void {
    const nowIso = this.now().toISOString();
    this.current = {
      pid: this.pid,
      version: this.version,
      startedAt: nowIso,
      heartbeatAt: nowIso,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      state: 'running',
    };
    this.persist();
  }

  heartbeat(): void {
    if (!this.current) return;
    this.current.heartbeatAt = this.now().toISOString();
    this.persist();
  }

  /** shutdown 入口(lifecycle.beginShutdown / updateService.forceQuit)。首个 reason 保留。 */
  markShutdownBegin(reason: string): void {
    if (!this.current) return;
    if (this.current.state === 'running') {
      this.current.state = 'shutdown-begin';
      this.current.shutdownReason = reason;
      this.current.shutdownAt = this.now().toISOString();
      this.persist();
    }
  }

  /** runQuitDisposers 全链完成。 */
  markDisposed(): void {
    if (!this.current) return;
    this.current.disposedAt = this.now().toISOString();
    this.persist();
  }

  /** process 'exit' 钩子 —— JS 层任何退出路径的最后一站。 */
  markExited(exitCode: number): void {
    if (!this.current) return;
    this.current.state = 'exited';
    this.current.exitCode = exitCode;
    this.current.exitedAt = this.now().toISOString();
    this.persist();
  }

  /**
   * 尸检:扫描目录里其它实例遗留的标记,分类并清理(还活着的留着)。
   * 在 begin() 之前调用,自己的标记尚未写入。
   */
  analyzePreviousRuns(): PreviousRunReport[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return []; // 目录不存在 = 首次启动
    }
    const reports: PreviousRunReport[] = [];
    for (const name of entries) {
      if (!/^run-\d+\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      let marker: RunMarker | null = null;
      try {
        marker = JSON.parse(fs.readFileSync(file, 'utf8')) as RunMarker;
      } catch {
        marker = null;
      }
      if (marker && marker.pid === this.pid) continue; // 理论不可达,防御
      if (!marker || typeof marker.pid !== 'number' || !marker.state) {
        reports.push({ kind: 'corrupt', file });
        this.remove(file);
        continue;
      }
      if (this.isPidAlive(marker.pid)) {
        reports.push({ kind: 'still-running', file, marker });
        continue;
      }
      const kind: PreviousRunReportKind =
        marker.state === 'exited'
          ? (marker.exitCode != null && marker.exitCode !== 0 ? 'crash-exit' : 'clean')
          : marker.state === 'shutdown-begin'
            ? 'shutdown-incomplete'
            : 'abnormal';
      reports.push({ kind, file, marker });
      this.remove(file);
    }
    return reports;
  }

  private remove(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      this.warn(`failed to remove processed run marker ${file}`, err);
    }
  }
}

interface CrashDumpEntry {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * 递归扫描 crashDumps 目录下 sinceMs 之后的 .dmp(Crashpad 在 mac/win 的完成、
 * pending 子目录布局不同,直接递归覆盖)。深度限 4,防御性避免异常目录结构。
 */
export function scanCrashDumps(rootDir: string, sinceMs: number): CrashDumpEntry[] {
  const out: CrashDumpEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.dmp')) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= sinceMs) {
            out.push({ path: p, mtimeMs: st.mtimeMs, sizeBytes: st.size });
          }
        } catch {
          /* 文件竞态消失 — 忽略 */
        }
      }
    }
  };
  walk(rootDir, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// ── module-level 单例接线(electron 侧) ──────────────────────────────────────

let _store: RunMarkerStore | null = null;
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
/**
 * 本次启动的尸检结论,供日志上报的「原生崩溃兜底」路径消费(它要知道上次运行有没有
 * 「异常退出且无任何退出记录」)。只读快照,消费方不得改动。
 */
let _previousRunReports: PreviousRunReport[] = [];

function logPreviousRunReports(reports: PreviousRunReport[]): boolean {
  let hadAbnormal = false;
  for (const r of reports) {
    const m = r.marker;
    switch (r.kind) {
      case 'clean':
        log.info(
          `[exit-diagnosis] previous run exited cleanly: pid=${m!.pid} v=${m!.version} ` +
            `exitCode=${m!.exitCode ?? '?'} reason=${m!.shutdownReason ?? 'n/a'} ` +
            `disposersCompleted=${m!.disposedAt ? 'yes' : 'no'} exitedAt=${m!.exitedAt ?? '?'}`,
        );
        break;
      case 'crash-exit':
        hadAbnormal = true;
        log.error(
          `[exit-diagnosis] previous run exited with non-zero code: pid=${m!.pid} v=${m!.version} ` +
            `exitCode=${m!.exitCode} reason=${m!.shutdownReason ?? '?'} ` +
            `disposersCompleted=${m!.disposedAt ? 'yes' : 'no'} exitedAt=${m!.exitedAt ?? '?'} — ` +
            `process went through lifecycle shutdown but exited abnormally (renderer crash / uncaughtException / fatal signal)`,
        );
        break;
      case 'shutdown-incomplete': {
        hadAbnormal = true;
        const disposersCompleted = m!.disposedAt ? 'yes' : 'no';
        const detail = m!.disposedAt
          ? 'disposers completed but process died before exit (post-cleanup crash)'
          : 'process died mid-shutdown (disposer hang or crash during cleanup)';
        log.warn(
          `[exit-diagnosis] previous run began shutdown but never completed: pid=${m!.pid} ` +
            `v=${m!.version} reason=${m!.shutdownReason ?? '?'} shutdownAt=${m!.shutdownAt ?? '?'} ` +
            `disposersCompleted=${disposersCompleted} lastHeartbeatAt=${m!.heartbeatAt} — ${detail}`,
        );
        break;
      }
      case 'abnormal': {
        hadAbnormal = true;
        // 心跳跑在 main event loop:若进程死前 event loop 已被卡死(hang),
        // heartbeatAt 会冻结在卡死时刻 —— 与「用户看到 app 消失」的时间差即 hang 时长。
        const started = Date.parse(m!.startedAt);
        const lastBeat = Date.parse(m!.heartbeatAt);
        const aliveSec =
          Number.isFinite(started) && Number.isFinite(lastBeat)
            ? Math.round((lastBeat - started) / 1000)
            : null;
        log.error(
          `[exit-diagnosis] previous run exited abnormally with NO exit record: pid=${m!.pid} ` +
            `v=${m!.version} startedAt=${m!.startedAt} lastHeartbeatAt=${m!.heartbeatAt}` +
            `${aliveSec !== null ? ` (~${aliveSec}s alive)` : ''} — no graceful shutdown was recorded; ` +
            `likely native crash, external kill, or main-process hang. ` +
            `If lastHeartbeatAt is much earlier than the disappearance time, the main event loop was hung. ` +
            `Check the crash dumps listed below and Windows WER (AppHang) records.`,
        );
        break;
      }
      case 'still-running':
        log.info(
          `[exit-diagnosis] another instance appears to be running: pid=${m!.pid} v=${m!.version} ` +
            `startedAt=${m!.startedAt} (marker kept)`,
        );
        break;
      case 'corrupt':
        hadAbnormal = true;
        log.warn(
          `[exit-diagnosis] found corrupt run marker ${r.file} — previous process likely died while writing it`,
        );
        break;
    }
  }
  return hadAbnormal;
}

function logCrashDumpScan(hadAbnormal: boolean): void {
  if (!hadAbnormal) return;
  let dumpDir: string;
  try {
    dumpDir = app.getPath('crashDumps');
  } catch (err) {
    log.warn('cannot resolve crashDumps path', err);
    return;
  }
  const dumps = scanCrashDumps(dumpDir, Date.now() - DUMP_SCAN_WINDOW_MS);
  if (dumps.length > 0) {
    const listed = dumps
      .slice(0, DUMP_LIST_CAP)
      .map((d) => `${d.path} (${new Date(d.mtimeMs).toISOString()}, ${Math.round(d.sizeBytes / 1024)}KB)`)
      .join('; ');
    const line =
      `[exit-diagnosis] ${dumps.length} crash dump(s) in the last 14 days under ${dumpDir}: ${listed}` +
      (dumps.length > DUMP_LIST_CAP ? ` … +${dumps.length - DUMP_LIST_CAP} more` : '');
    log.warn(line);
  } else {
    log.warn(
      `[exit-diagnosis] no crash dumps found under ${dumpDir} in the last 14 days — the abnormal ` +
        `exit above was likely an external kill or a hard hang (see Windows WER AppHang) rather than a native crash`,
    );
  }
}

/**
 * 启动诊断入口。必须在 app ready 之前、userData 定型之后调用(bootstrap-electron
 * 顶层满足两者)。幂等;整体 try/catch —— 诊断永不阻断启动。
 */
export function initStartupDiagnostics(): void {
  if (_store) return;
  // 1) Crashpad:main/renderer/GPU/utility 的 native crash 从此有本地 minidump。
  //    不上传(uploadToServer:false),dump 只落 app.getPath('crashDumps')。
  try {
    crashReporter.start({ uploadToServer: false });
    log.info(`crashReporter started (local-only), dumps dir: ${app.getPath('crashDumps')}`);
  } catch (err) {
    log.warn('crashReporter.start failed (non-fatal)', err);
  }
  // 2) run marker 尸检 + 本实例标记 + 心跳。
  try {
    const store = new RunMarkerStore({
      dir: path.join(app.getPath('userData'), 'diagnostics', 'run-markers'),
      pid: process.pid,
      version: app.getVersion(),
    });
    const reports = store.analyzePreviousRuns();
    _previousRunReports = reports;
    const hadAbnormal = logPreviousRunReports(reports);
    logCrashDumpScan(hadAbnormal);
    store.begin();
    _store = store;
    _heartbeatTimer = setInterval(() => _store?.heartbeat(), HEARTBEAT_INTERVAL_MS);
    // 心跳定时器不该阻止进程退出(Electron main 实际由 app 生命周期决定,unref 纯防御)。
    _heartbeatTimer.unref?.();
    // process 'exit' 是 JS 层一切退出路径(含 process.exit 强退)的最后同步时机。
    process.on('exit', (code) => {
      _store?.markExited(code);
    });
  } catch (err) {
    log.warn('startup diagnostics init failed (non-fatal)', err);
  }
}

/**
 * 本次启动的退出尸检结论。
 *
 * 此前这些结论只写进日志、没有任何程序化出口,「上次是原生崩溃」这个事实无法被别的模块
 * 消费。日志上报的原生崩溃兜底路径需要它(需求 §4.1 的第四条触发路径)。
 * `initStartupDiagnostics()` 之前调用返回空数组。
 */
export function getPreviousRunReports(): readonly PreviousRunReport[] {
  return _previousRunReports;
}

/** lifecycle.beginShutdown → 记录 shutdown 入口。init 前调用是 no-op。 */
export function noteShutdownBegin(reason: string): void {
  _store?.markShutdownBegin(reason);
}

/** runQuitDisposers 全链完成 → 记录 disposedAt。 */
export function noteQuitDisposersCompleted(): void {
  _store?.markDisposed();
}

/**
 * 绕过 lifecycle 的预期强退(updateService.forceQuit 的 process.exit 路径)——
 * 先把 reason 写进标记,随后 process 'exit' 钩子补 exited 终态,下次启动不会
 * 被误判成异常退出。
 */
export function noteExpectedExit(reason: string): void {
  _store?.markShutdownBegin(reason);
}
