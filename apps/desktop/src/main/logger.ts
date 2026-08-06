/**
 * Unified main-process logger.
 *
 * Outputs (dev: 仓库内 `apps/desktop/logs/`; packaged: `<userData>/logs/`)。所有最终
 * 日志按天 rotate (跨天开新文件) + 只保留最近 30 天:
 *   · sessions/<sessionId>/YYYY-MM-DD.ndjson — 某 session 的 agent 结构化流:
 *       maker   : scope `maker/s:<id>/*` / `r:maker*` (该 session 的 agent 运行时)
 *       cc-debug: 该 session 的 cc 子进程 debug (经 writeCcDebugLine 汇入, 见下)
 *     目录名 = 完整 sessionId; 每条 NDJSON 带 source / sessionId / 归一化 epoch ms。
 *     30 天没活动的整个 session 目录由 cleanupOldSessions 删除。
 *   · agent-YYYY-MM-DD.ndjson — 无 session 关联的 agent 日志: proxy (cc-proxy/* /
 *     codex-proxy/*, 全局单例, 请求不带 business session) + 启动期 / 全局基础设施 maker 日志。
 *   · main-YYYY-MM-DD.log — everything else (electron lifecycle, IPC, vendor, console)。
 *   dev 额外镜像到 terminal stdout/stderr; packaged 无 console。
 *
 * 注意: cc 子进程的内部 debug 由 cc 二进制通过 SDK debugFile 选项直接 fopen 写入一个
 * raw 中转文件 (sessions/<id>/cc-debug.raw.log, 路径由 resolveSessionCcDebugFile 给出;
 * 无 session 时回退全局 cc-debug.raw.log), **不经过本 logger 的 emit**。bootstrap 的
 * tailer 扫描这些 raw 文件, 逐行调 writeCcDebugLine() 归一化汇入对应 session 的 agent 流。
 *
 * 旧的 maker.log / cc-proxy.log / cc-debug.log 已并入, 启动期由 purgeLegacyAgentLogs()
 * 清掉, 不再生成 (旧 main.log 保留作历史归档, 不删)。
 *
 * Filtering:
 *   - Default level: dev=trace (everything), packaged=info
 *   - Override priority (highest first):
 *       1. process.env.LOG_LEVEL
 *       2. `<userData>/log-config.json` → { "level": "debug" }   ← persistent
 *          across restarts without touching OS env
 *       3. Default for current mode
 *
 * Renderer logs come in via IPC `renderer:log` and route through this same
 * writer (with scope prefixed `r:`) so the right stream holds the full picture
 * (`r:maker*` 也归入 agent 流)。
 *
 * ⚠️ 安全不变量: main-*.log 的**记录边界**(行首 `[ts] [LEVEL] [scope] `)是日志上报判断
 * 「这条记录来自哪个来源、要不要放行」的依据。写侧因此必须保证除记录首行外没有行以该特征
 * 开头 —— emit() 对 msg 走 escapeMainLogContinuationLines(), 且每次打开 main 当天文件写一行
 * 格式哨兵。正文与理由见 shared/mainLogRecordFormat.ts; 放宽任一侧都是隐私变更。
 *
 * Rotation: main-*.log / agent-*.ndjson / sessions/<id>/*.ndjson 统一按天切 + 保留 30 天
 * (30 天没活动的 session 目录整个删)。例外: cc-debug.raw.log (cc 外部进程写的中转文件,
 * 没法按天) 启动期砍头保尾 (keepRecentSync)。
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import util from 'node:util';

import { LOG_RETENTION_DAYS } from '../shared/logRetention';
import {
  escapeMainLogContinuationLines,
  RECORD_FORMAT_SENTINEL_MSG,
  RECORD_FORMAT_SENTINEL_SCOPE,
} from '../shared/mainLogRecordFormat';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5,
};

const LEVEL_TAG: Record<LogLevel, string> = {
  trace: 'TRACE', debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR', fatal: 'FATAL',
};

function parseLevel(s: string | undefined, fallback: LogLevel): LogLevel {
  if (!s) return fallback;
  const l = s.toLowerCase();
  if (l in LEVEL_PRIORITY) return l as LogLevel;
  return fallback;
}

let currentLevel: LogLevel = 'info';
let isDevMode = false;
let initialized = false;

// ── 落盘 slot + 按天 rotate ───────────────────────────────────────────────────
// 所有最终日志统一按天: main 与 agent 各一个 DailySlot, 跨天开新文件 + 只保留最近
// LOG_RETENTION_DAYS 天 (cleanupOldDailyLogs)。main 写纯文本行, agent 写结构化 NDJSON。
const AGENT_LOG_EXT = '.ndjson';

// cc-debug.raw.log 例外: cc 子进程自己 fopen 写的中转文件, 没法按天切, 仍用启动期
// 砍头保尾 (keepRecentSync, 见下)。它内容最终汇入 agent 流, 不是给用户直接看的最终日志。
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const KEEP_RECENT_BYTES = 2 * 1024 * 1024;

type AgentSource = 'maker' | 'proxy' | 'cc-debug';
interface AgentLogRecord {
  ts: number;        // epoch ms (UTC 绝对时刻) — 唯一排序基准
  tz: number;        // 本地时区 offset (分钟; 东八区 = 480), UI 显示用
  seq: number;       // 进程内单调递增, 同 ms 内定序
  level: LogLevel;
  source: AgentSource;
  scope: string;
  sessionId: string; // 从 scope 提取的 business session id 前 8 位, 无则 ''
  msg: string;
}

// 按天 rotate slot: main 与 agent 共用。文件名 = <prefix><YYYY-MM-DD><ext>。
// dateKey 变了就切文件; 不砍头 (按天 rotate + 保留期清理)。
interface DailySlot {
  stream: fs.WriteStream | null;
  dir: string;
  dateKey: string; // 'YYYY-MM-DD' (本地)
  prefix: string;  // 'main-' | 'agent-'
  ext: string;     // '.log' | '.ndjson'
}
const mainSlot: DailySlot = { stream: null, dir: '', dateKey: '', prefix: 'main-', ext: '.log' };
// 无 session 关联的 agent 日志 (启动期 / 全局基础设施) → logs 根的 agent-<date>.ndjson。
const agentSlot: DailySlot = { stream: null, dir: '', dateKey: '', prefix: 'agent-', ext: AGENT_LOG_EXT };
let agentSeq = 0;

// 有 session 关联的 agent 日志 → sessions/<full-id>/<date>.ndjson (per-session 目录, 目录内按天)。
// sessionSlots LRU 缓存打开的 slot 控制并发 fd 数; 超过 MAX_OPEN_SESSION_SLOTS 关掉最久未用的。
const SESSIONS_DIR = 'sessions';
const MAX_OPEN_SESSION_SLOTS = 32;
const sessionSlots = new Map<string, DailySlot>();
let logRootDir = '';

// scope 路由: maker-host adapter 用 'maker' / 'maker/xxx' 作为根 scope,
// renderer 转发会被加 'r:' 前缀, 所以 'r:maker' / 'r:maker/xxx' 也算。
function isMakerScope(scope: string): boolean {
  return /^(r:)?maker(\/|$)/.test(scope);
}

// proxy 单独路由: anthropic-compat-proxy-host 用 'cc-proxy' 作为根 scope,
// codex-proxy-host 用 'codex-proxy' 作为根 scope。内部 child logger 会继续带
// '/xxx' 后缀,renderer 不会转发这条 scope (proxy 完全在 main 进程内,renderer
// 不感知),所以这里不需要 'r:' 兼容。
function isCcProxyScope(scope: string): boolean {
  return /^cc-proxy(\/|$)/.test(scope);
}

function isCodexProxyScope(scope: string): boolean {
  return /^codex-proxy(\/|$)/.test(scope);
}

// agent 统一流: maker 系 + cc-proxy 系都并入 (cc-debug 由 writeCcDebugLine 单独汇入)。
function isAgentScope(scope: string): boolean {
  return isMakerScope(scope) || isCcProxyScope(scope) || isCodexProxyScope(scope);
}

function sourceForScope(scope: string): AgentSource {
  return isCcProxyScope(scope) || isCodexProxyScope(scope) ? 'proxy' : 'maker';
}

// 从 scope 抽 business session id。maker-core 用 's:<id>/' 编码 (agent 层), session.ts
// 用 'session/<id>' (Session 层); 两种前缀都认。完整 UUID (36 字符, 带连字符) 或旧式
// 8 位都匹配; 捕获到的整串就是 session 目录名。无匹配返回 ''。
const AGENT_SESSION_ID_RE = /(?:^|\/)(?:s:|session\/)([0-9a-fA-F-]{8,36})(?:\/|$)/;
function extractSessionId(scope: string): string {
  const m = AGENT_SESSION_ID_RE.exec(scope);
  return m ? m[1] : '';
}

/**
 * 砍头保尾的核心实现。逻辑参数化, 拆出 read/write 两个钩子让 sync/async 两个壳子复用。
 *
 * 从尾部往前读 KEEP_RECENT_BYTES, 找第一个 \n, 从下一字节起算 (避免半行), 然后整块覆写。
 * 读失败 → 全文丢弃 (truncate to 0); 写失败 → 摆烂下次再说。
 */
function trimPlan(size: number): { keep: number; start: number } {
  const keep = Math.min(size, KEEP_RECENT_BYTES);
  return { keep, start: size - keep };
}

function trimBuffer(recent: Buffer): Buffer {
  // 找第一个 \n, 从下一字节起算, 避免把半行当完整行
  const nl = recent.indexOf(0x0a);
  return nl >= 0 && nl < recent.length - 1 ? recent.subarray(nl + 1) : recent;
}

/**
 * 同步版 — 仅用于 app 启动期一次性裁剪 (logger init / cc-debug 启动 trim)。
 * 启动期 IO 全是同步, 多这一下不影响。运行时一律走 async 版本。
 *
 * 调用前提: 对该文件的 fd 都已关掉 (否则 writeFileSync 在 Windows 上可能失败)。
 */
export function keepRecentSync(filePath: string): void {
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { return; }
  if (size <= MAX_FILE_SIZE_BYTES) return;

  const { keep, start } = trimPlan(size);
  let recent: Buffer | null = null;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      recent = Buffer.alloc(keep);
      fs.readSync(fd, recent, 0, keep, start);
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  } catch { /* read failed — fall through to truncate */ }

  try {
    fs.writeFileSync(filePath, recent ? trimBuffer(recent) : '');
  } catch { /* 维护失败就让它去, 下次再说 */ }
}

/**
 * 启动期把所有 sessions/<id>/cc-debug.raw.log 也砍头保尾 (跟全局 cc-debug.raw.log 同策略)。
 *
 * per-session raw 由 cc 子进程 fopen 写、不经 emit, 平时只靠 cleanupOldSessions 30 天整目录删;
 * 期间一个开着 NODE_DEBUG 的活跃 session 能把单个 raw 写到几百 MB ~ 数 GB。它内容已被 bootstrap
 * 的 tailer 汇入 <date>.ndjson, raw 只是中转, 砍头保尾 (留最近 KEEP_RECENT_BYTES) 不丢有效信息。
 * 启动期没有 session 在跑 (用户起 session 才 fopen), 此时 sync trim 安全 (同 keepRecentSync 的
 * fd 前提)。运行中超大的 raw 等下次启动收口。
 */
export function keepRecentSessionCcDebugSync(): void {
  if (!logRootDir) return;
  const base = path.join(logRootDir, SESSIONS_DIR);
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    keepRecentSync(path.join(base, d.name, 'cc-debug.raw.log'));
  }
}

// Original stdout/stderr handles, captured before init so dev terminal
// mirroring keeps working even if some other code rebinds console.*.
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);
let devTerminalMirrorEnabled = true;

export function disableDevTerminalMirror(): void {
  devTerminalMirrorEnabled = false;
}

/**
 * dev 终端被关掉 / pipe 断开后,后续 stdio 写入会抛 EIO/EPIPE。这两种码不应
 * 视为致命错,文件日志仍然有效,只需把终端镜像静默降级即可。
 * 导出给 lifecycle.ts 的 uncaughtException 兜底处理器共用,避免多处复制。
 */
export function isBrokenStdioError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EIO' || code === 'EPIPE';
}

/**
 * 识别"瞬时网络错误" —— 主要场景: main 进程里某个 fetch / TCP socket 没有 catch,
 * VPN 断开或目标域名国内不可达时抛出的 ETIMEDOUT / ECONNRESET / ENOTFOUND 等。
 *
 * 历史案例: 用户 VPN 断开后, main 进程后台请求外网 (e.g. Cloudflare/Dropbox/
 * Twitter CDN 网段) 触发 connect ETIMEDOUT, 没人 catch 直接冒泡成 uncaughtException
 * → lifecycle 杀进程 → App 反复闪退。
 *
 * 命中后 lifecycle 的 uncaughtException handler 会跳过 shutdown 只 log.error 留
 * 全栈; logger 自己的镜像仍然按 [FATAL] 打 —— 故意保留这个显眼关键词方便后续
 * `grep FATAL main.log` 反查崩点。这只是兜底降级, 真正的 fix 是给漏 catch 的
 * 调用点补 try/catch。
 *
 * AggregateError 的 .code 会直接挂在父对象上 (e.g. multi-DNS 同时 ETIMEDOUT),
 * 简单读 err.code 就能命中, 不需要递归 .errors。
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ETIMEDOUT':
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ECONNABORTED':
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'EHOSTUNREACH':
    case 'EHOSTDOWN':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'UND_ERR_SOCKET':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return true;
    default:
      return false;
  }
}

// dev 终端镜像的单行上限。终端只是人眼实时观察通道,超长行(典型:透传大 payload
// 的 debug dump)全量镜像毫无阅读价值,却要在 main event loop 上做整行拷贝、且
// Windows console 消费极慢会持续堆积内核缓冲;截断到 8KiB,完整内容永远在日志文件里。
const DEV_TERMINAL_LINE_MAX_CHARS = 8 * 1024;

// 背压:write() 返回 false = 内核 stdio 缓冲已满(典型:Windows console 慢消费 +
// 日志风暴)。此时暂停镜像、只计数丢弃,等 'drain' 恢复时补一条汇总提示。
// 只影响终端镜像,文件日志一行不丢。stdout/stderr 共用一个暂停位(同一个终端)。
let devTerminalPaused = false;
let devTerminalDroppedLines = 0;

/** 导出仅供单测:镜像行截断规则(超限截断 + 提示后缀,保住行尾换行)。 */
export function truncateDevTerminalLine(line: string): string {
  if (line.length <= DEV_TERMINAL_LINE_MAX_CHARS) return line;
  return (
    line.slice(0, DEV_TERMINAL_LINE_MAX_CHARS) +
    `... (terminal mirror truncated, ${line.length} chars; full line in log file)\n`
  );
}

function writeDevTerminal(write: (chunk: string) => boolean, line: string): void {
  if (!devTerminalMirrorEnabled) return;
  if (devTerminalPaused) {
    devTerminalDroppedLines++;
    return;
  }
  try {
    const flushed = write(truncateDevTerminalLine(line));
    if (!flushed) {
      // 缓冲满:数据已排队不丢,但继续写只会无限堆积内存。暂停镜像等 drain。
      // write 是启动期捕获的 bound 方法,stream 对象仍是 process.stdout/stderr
      // 本体(console 劫持只换 write 方法),once('drain') 挂在流上是安全的。
      const stream = write === origStderr ? process.stderr : process.stdout;
      devTerminalPaused = true;
      stream.once('drain', () => {
        devTerminalPaused = false;
        if (devTerminalDroppedLines > 0) {
          const dropped = devTerminalDroppedLines;
          devTerminalDroppedLines = 0;
          try {
            write(`[logger] terminal mirror dropped ${dropped} line(s) under backpressure (files kept full content)\n`);
          } catch { /* 终端断开走下方同款降级,这里静默即可 */ }
        }
      });
    }
  } catch (err) {
    if (isBrokenStdioError(err)) {
      // Dev terminals can disappear before Electron exits. File logging remains
      // valid, so stdout/stderr mirroring must degrade instead of killing main.
      devTerminalMirrorEnabled = false;
      return;
    }
    throw err;
  }
}

export interface InitOptions {
  isDev?: boolean;
  level?: LogLevel;
  logDir?: string;
}

function readLevelFromConfigFile(userDataDir: string): LogLevel | undefined {
  // Persistent override that survives restarts without OS env. Edit
  // `<userData>/log-config.json` → { "level": "debug" }, restart the app.
  try {
    const cfgPath = path.join(userDataDir, 'log-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { level?: string };
    if (parsed.level && parsed.level.toLowerCase() in LEVEL_PRIORITY) {
      return parsed.level.toLowerCase() as LogLevel;
    }
  } catch { /* missing / unreadable / malformed → fall through */ }
  return undefined;
}

export function initLogger(opts?: InitOptions): void {
  if (initialized) return;
  initialized = true;

  isDevMode = opts?.isDev ?? !app.isPackaged;
  // dev: 仓库内 apps/desktop/logs/ —— vite 把 main 编译到 apps/desktop/.vite/build/,
  // 所以 __dirname 上跳两级正好是 apps/desktop/。
  // packaged: <userData>/logs/ (asar 内不可写,且用户不该去仓库找日志)。
  const logDir = opts?.logDir ?? (isDevMode
    ? path.resolve(__dirname, '../../logs')
    : path.join(app.getPath('userData'), 'logs'));

  // Level resolution: env > config file > opts.level > built-in default.
  // log-config.json: dev 放 apps/desktop/logs/, packaged 放 <userData>/。
  const cfgDir = isDevMode ? logDir : path.dirname(logDir);
  const fileLevel = readLevelFromConfigFile(cfgDir);
  currentLevel = parseLevel(
    process.env.LOG_LEVEL,
    fileLevel ?? opts?.level ?? (isDevMode ? 'trace' : 'info'),
  );

  // File output: 两种模式都开文件; dev 额外保留终端输出 (见 emit())。按天 rotate:
  //   main-<date>.log              — electron / IPC / vendor / console (纯文本)
  //   agent-<date>.ndjson          — 无 session 关联的 agent 日志 (proxy + 全局基础设施)
  //   sessions/<id>/<date>.ndjson  — 各 session 的 maker + cc-debug 日志
  // 共用 ensureDailySlot + cleanupOldDailyLogs (按天切 + 保留 30 天); 整个 session 目录
  // 30 天没活动由 cleanupOldSessions 删。旧的无日期 maker.log / cc-proxy.log / cc-debug.log
  // 已并入, 启动期清掉不再生成 (purgeLegacyAgentLogs; 旧 main.log 保留作历史归档, 不删)。
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logRootDir = logDir;
    mainSlot.dir = logDir;
    agentSlot.dir = logDir;
    const bootNow = new Date();
    ensureDailySlot(mainSlot, bootNow);
    ensureDailySlot(agentSlot, bootNow);
    purgeLegacyAgentLogs(logDir);
    void cleanupOldSessions(logDir);
  } catch (err) {
    origStderr(`[logger init] failed to setup log dir: ${(err as Error).message}\n`);
  }
  if (isDevMode) {
    // 把实际路径打到终端,方便用户/AI 直接 tail。
    writeDevTerminal(origStdout, `[logger] dev log dir: ${logDir}\n`);
  }

  // Safety net: any code that still calls console.* (third-party libs we
  // can't migrate, or pre-init dependencies) gets captured here. After the
  // full in-house migration this is mostly insurance against regressions
  // and noisy upstream packages.
  const fallback = createLogger('console');
  // Node 的 ExperimentalWarning / DeprecationWarning 通过 process.emit('warning')
  // 触发, 默认 handler 走 console.error 打出 "(node:<pid>) <Kind>: <msg>"。
  // 这些是上游依赖(undici 顶层 require('node:sqlite') / 某个包用 url.parse 等)
  // 的提醒, 不是我们代码的错误, 不应当污染 ERROR 等级。识别 "(node:<pid>) " 前缀
  // 降级到 WARN: 仍然可见 (DeprecationWarning 提示的旧 API 将来要追到具体调用点),
  // 但不再被当成"应用出错"。
  const NODE_PROC_WARNING_PREFIX = /^\(node:\d+\)\s/;
  console.log = (...args: unknown[]) => fallback.info(...args);
  console.info = (...args: unknown[]) => fallback.info(...args);
  console.warn = (...args: unknown[]) => fallback.warn(...args);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && NODE_PROC_WARNING_PREFIX.test(args[0])) {
      fallback.warn(...args);
      return;
    }
    fallback.error(...args);
  };
  console.debug = (...args: unknown[]) => fallback.debug(...args);
  console.trace = (...args: unknown[]) => fallback.trace(...args);

  process.on('uncaughtException', (err) => {
    // EIO/EPIPE 是 dev 终端断开导致的无害 stdio 错误,lifecycle 那条会负责忽略
    // 它不触发 shutdown;此处也跟着静默,避免在 main.log 里产生 FATAL 噪音误导排查。
    if (isBrokenStdioError(err)) return;
    // 瞬时网络错误 (ETIMEDOUT/ECONNRESET/ENOTFOUND 等) lifecycle 已经降级为不杀
    // 进程, 但这里仍然按 [FATAL] 打 —— 故意保留这个显眼的关键词, 方便后续从日志
    // grep 反查"哪次 VPN 抖动崩在哪个调用点"。日志层只负责"留全栈据可查", 是否
    // 致命由 lifecycle 决定。
    emit('fatal', 'process', ['uncaughtException:', err?.stack || err?.message || err]);
  });
  process.on('unhandledRejection', (reason) => {
    emit('fatal', 'process', ['unhandledRejection:', reason]);
  });

  emit('info', 'logger', [
    `=== App started === v${app.getVersion()} level=${currentLevel} isDev=${isDevMode}`,
  ]);
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

// agent 日志根目录 (= 各 logger 文件所在目录)。host 用它拼 per-session cc-debug 路径。
export function getLogDir(): string {
  return logRootDir;
}

// host 用: 拼某 session 的 cc-debug raw 落盘路径 + mkdir, 给 ClaudeCodeAgent 的
// resolveCcDebugFile 注入用。无 sessionId / 未 init → undefined (agent 回退全局 raw)。
export function resolveSessionCcDebugFile(sessionId?: string): string | undefined {
  if (!logRootDir || !sessionId) return undefined;
  const dir = path.join(logRootDir, SESSIONS_DIR, sessionId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return path.join(dir, 'cc-debug.raw.log');
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

/**
 * Local-time ISO-like timestamp with timezone offset, e.g.
 *   2026-05-07T20:34:12.345+08:00
 * 比 toISOString() 的 UTC 时间更易读,offset 也保留下来防止跨时区误读。
 */
function localTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const tzMin = -d.getTimezoneOffset(); // 例如东八区 → 480
  const sign = tzMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzMin);
  const tzH = pad(Math.floor(abs / 60));
  const tzM = pad(abs % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${tzH}:${tzM}`
  );
}

// ── 按天 rotate: main + agent 共用 ────────────────────────────────────────────

function dateKeyLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dailyLogPath(slot: DailySlot, dateKey: string): string {
  return path.join(slot.dir, `${slot.prefix}${dateKey}${slot.ext}`);
}

// 删除文件名日期早于保留窗口的 <prefix>*<ext> (main-*.log / agent-*.ndjson)。
// 启动 + 每次跨天切文件时调一次。
async function cleanupOldDailyLogs(dir: string, prefix: string, ext: string): Promise<void> {
  let files: string[];
  try { files = await fs.promises.readdir(dir); } catch { return; }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const f of files) {
    if (!f.startsWith(prefix) || !f.endsWith(ext)) continue;
    const dateStr = f.slice(prefix.length, f.length - ext.length);
    const t = Date.parse(`${dateStr}T00:00:00`);
    if (!Number.isFinite(t) || t >= cutoff) continue;
    try { await fs.promises.unlink(path.join(dir, f)); } catch { /* ignore */ }
  }
}

// 一次性清掉旧的无日期日志 (maker.log / cc-proxy.log / cc-debug.log + .1 备份)。它们的
// 内容现在并入 agent 流, 不再生成。**不删**旧的无日期 main.log (留作历史归档, 新内容写
// main-<date>.log)。同步删 (启动期, 量小)。
const LEGACY_AGENT_LOG_FILES = ['maker.log', 'cc-proxy.log', 'cc-debug.log'];
function purgeLegacyAgentLogs(dir: string): void {
  for (const name of LEGACY_AGENT_LOG_FILES) {
    for (const f of [name, `${name}.1`]) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* not exist */ }
    }
  }
}

/**
 * 往 main 当天文件写一行「记录格式哨兵」。
 *
 * 上报侧只采**第 0 字节就是哨兵**的文件(整份可信), 否则整份不采: 本模块引入续行转义之前
 * 写下的日志没有转义, 其中可能含伪造的记录头 (见 shared/mainLogRecordFormat.ts)。
 * 注意判据是「第 0 字节」而不是「出现过」—— 哨兵行的形状正文可以逐字构造, 见
 * log-upload/mainLogReader.startsWithFormatSentinel。所以这里对**追加**到存量文件的那一次
 * 写入只是留个人工可读的标记, 不会让那份文件变成可采的。
 *
 * 故意**绕过 emit 的等级过滤**直接写流: 走 emit 的话, `LOG_LEVEL=warn` 这类配置会让
 * 哨兵不落地, 上报侧于是跳过整个文件、一条也采不到 —— 一个日志等级配置不该把上报能力
 * 静默关掉。
 */
function writeRecordFormatSentinel(slot: DailySlot): void {
  if (!slot.stream) return;
  const line =
    `[${localTimestamp(new Date())}] [${LEVEL_TAG.info}] ` +
    `[${RECORD_FORMAT_SENTINEL_SCOPE}] ${RECORD_FORMAT_SENTINEL_MSG}\n`;
  try { slot.stream.write(line); } catch { /* stream broken — silent */ }
}

// 按天切换: dateKey 变了就关旧 stream、开当天文件, 并触发保留清理。main / agent 共用。
function ensureDailySlot(slot: DailySlot, now: Date): void {
  if (!slot.dir) return; // 未 init
  const key = dateKeyLocal(now);
  if (key === slot.dateKey && slot.stream) return;
  if (slot.stream) {
    try { slot.stream.end(); } catch { /* ignore */ }
    slot.stream = null;
  }
  slot.dateKey = key;
  try {
    slot.stream = fs.createWriteStream(dailyLogPath(slot, key), { flags: 'a' });
  } catch (err) {
    origStderr(`[logger] failed to open ${slot.prefix}${key}${slot.ext}: ${(err as Error).message}\n`);
    slot.stream = null;
  }
  // 只有 main 流是纯文本按行解析的, 需要哨兵; agent / session 流是 NDJSON, 记录边界由
  // JSON 行本身保证, 不存在伪造记录头的问题。
  if (slot === mainSlot) writeRecordFormatSentinel(slot);
  void cleanupOldDailyLogs(slot.dir, slot.prefix, slot.ext);
}

// 取/建某 session 的 per-session agent slot (LRU)。目录 sessions/<full-id>/, 文件 <date>.ndjson。
function sessionAgentSlot(sessionId: string): DailySlot | null {
  if (!logRootDir) return null;
  const existing = sessionSlots.get(sessionId);
  if (existing) {
    // LRU touch: 删了重插到尾部 (Map 迭代顺序 = 插入顺序, 头部最旧)
    sessionSlots.delete(sessionId);
    sessionSlots.set(sessionId, existing);
    return existing;
  }
  // 超过上限先关掉最久未用的
  if (sessionSlots.size >= MAX_OPEN_SESSION_SLOTS) {
    const oldest = sessionSlots.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      const ev = sessionSlots.get(oldest);
      if (ev?.stream) { try { ev.stream.end(); } catch { /* ignore */ } }
      sessionSlots.delete(oldest);
    }
  }
  const dir = path.join(logRootDir, SESSIONS_DIR, sessionId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  const slot: DailySlot = { stream: null, dir, dateKey: '', prefix: '', ext: AGENT_LOG_EXT };
  sessionSlots.set(sessionId, slot);
  return slot;
}

// 删除 30 天没活动的整个 session 目录 (含 <date>.ndjson + cc-debug.raw.log)。启动期调一次。
// 活跃 session 目录最新文件 mtime > cutoff, 不会被删。
async function cleanupOldSessions(rootDir: string): Promise<void> {
  const base = path.join(rootDir, SESSIONS_DIR);
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(base, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sdir = path.join(base, d.name);
    let newest = 0;
    try {
      const files = await fs.promises.readdir(sdir);
      for (const f of files) {
        try { newest = Math.max(newest, (await fs.promises.stat(path.join(sdir, f))).mtimeMs); } catch { /* ignore */ }
      }
    } catch { continue; }
    if (newest > 0 && newest < cutoff) {
      try { await fs.promises.rm(sdir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// main 纯文本行写入: 按天切 + append。
function writeMainLine(line: string): void {
  ensureDailySlot(mainSlot, new Date());
  if (!mainSlot.stream) return;
  try { mainSlot.stream.write(line); } catch { /* stream broken — silent */ }
}

// agent NDJSON 写入点: maker/proxy (经 emit) 与 cc-debug (经 writeCcDebugLine) 都汇到这里。
// 有 sessionId → 写 sessions/<id>/<date>.ndjson; 无 → 写 logs 根 agent-<date>.ndjson。
function writeAgentRecord(rec: Omit<AgentLogRecord, 'seq'>): void {
  const slot = rec.sessionId ? sessionAgentSlot(rec.sessionId) : agentSlot;
  if (!slot) return;
  ensureDailySlot(slot, new Date(rec.ts));
  if (!slot.stream) return;
  const full: AgentLogRecord = { ...rec, seq: agentSeq++ };
  try { slot.stream.write(`${JSON.stringify(full)}\n`); } catch { /* stream broken — silent */ }
}

// cc 子进程 debug 行 (格式 "<UTC-ISO> [LEVEL] [scope?] msg") 解析归一化后汇入 agent 流。
// 由 bootstrap-electron 的 cc-debug tailer 逐行调用, sessionId 来自 raw 文件所在的
// sessions/<id>/ 目录 (per-session debugFile)。无 sessionId 时归根 agent 流。
const CC_DEBUG_LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[(\w+)\]\s*(?:\[([^\]]+)\])?\s*([\s\S]*)$/;
export function writeCcDebugLine(rawLine: string, sessionId = ''): void {
  const m = CC_DEBUG_LINE_RE.exec(rawLine);
  let ts: number;
  let level: LogLevel;
  let scope: string;
  let msg: string;
  if (m) {
    ts = Date.parse(m[1]);
    if (!Number.isFinite(ts)) ts = Date.now();
    level = parseLevel(m[2], 'debug');
    scope = m[3] ? `cc/${m[3]}` : 'cc';
    msg = m[4];
  } else {
    ts = Date.now();
    level = 'debug';
    scope = 'cc';
    msg = rawLine;
  }
  writeAgentRecord({ ts, tz: -new Date(ts).getTimezoneOffset(), level, source: 'cc-debug', scope, sessionId, msg });
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (!shouldLog(level)) return;
  const now = new Date();
  const ts = localTimestamp(now);
  let msg: string;
  try {
    msg = args.length === 0 ? '' : util.format(...(args as [unknown, ...unknown[]]));
  } catch {
    msg = args.map((a) => String(a)).join(' ');
  }

  // 路由:
  //   agent scope (maker/* + cc-proxy/* + codex-proxy/* + renderer r:maker*) → agent-YYYY-MM-DD.ndjson
  //       统一结构化流, 三源 (maker / proxy / cc-debug) 合并, 按天 rotate + 保留 30 天,
  //       每条带 source / sessionId / 归一化 epoch ms, 供 UI 按 session 过滤显示。
  //       cc-debug 不走这里 (cc 子进程自己 fopen 写 raw), 由 writeCcDebugLine 汇入同一流。
  //   其余 → main.log (electron 生命周期 / IPC / vendor / console 兜底), 砍头保尾不变。
  if (isAgentScope(scope)) {
    writeAgentRecord({
      ts: now.getTime(),
      tz: -now.getTimezoneOffset(),
      level,
      source: sourceForScope(scope),
      scope,
      sessionId: extractSessionId(scope),
      msg,
    });
    if (isDevMode) {
      const line = `[${ts}] [${LEVEL_TAG[level]}] [${scope}] ${msg}\n`;
      if (level === 'error' || level === 'fatal') writeDevTerminal(origStderr, line);
      else writeDevTerminal(origStdout, line);
    }
    return;
  }

  // 续行转义是**安全不变量**, 不是排版: 上报侧按行首特征切记录并据此放行来源,
  // 续行若能伪装成放行来源的记录头, 被封禁来源的多行内容就能把用户内容送出去。
  // 详见 shared/mainLogRecordFormat.ts。
  const line = `[${ts}] [${LEVEL_TAG[level]}] [${scope}] ${escapeMainLogContinuationLines(msg)}\n`;
  writeMainLine(line);
  if (isDevMode) {
    // dev 额外双写终端,实时观察用
    if (level === 'error' || level === 'fatal') writeDevTerminal(origStderr, line);
    else writeDevTerminal(origStdout, line);
  }
}

export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    trace: (...args) => emit('trace', scope, args),
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
    fatal: (...args) => emit('fatal', scope, args),
  };
}

/**
 * Entry point for the IPC handler that ferries renderer log lines into this
 * writer. Renderer scopes get an `r:` prefix so origin is obvious in main.log.
 * Not for general use — callers should construct their own logger via
 * createLogger().
 */
export function writeFromRenderer(level: LogLevel, scope: string, msg: string): void {
  emit(level, `r:${scope}`, [msg]);
}

// ── PII helpers ──────────────────────────────────────────────────────────────
// Centralized so every "I want to log a path / email" decision goes through
// the same mask. Tightening the mask here tightens it everywhere.

/**
 * Reduce an absolute path to its trailing 2 segments preceded by `.../`,
 * stripping the user's home prefix entirely.
 *
 * Examples:
 *   C:\Users\admin\AppData\Roaming\xdt-maker → ...\Roaming\xdt-maker
 *   /Users/sam/projects/xdt-maker            → .../projects/xdt-maker
 *   /tmp                                      → /tmp (already short)
 *
 * Use for: workingDir, execPath, resourcesPath, userData, file paths in logs.
 */
export function maskPath(p: string | null | undefined): string {
  if (!p) return '<null>';
  // Detect separator from the path itself; mixing seps would be weird but
  // we honor whatever's in the input.
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter((s) => s.length > 0);
  if (parts.length <= 2) return p; // already short — show as-is
  const tail = parts.slice(-2).join(sep);
  // Preserve a leading separator so absolute paths still look absolute-ish.
  return `...${sep}${tail}`;
}

/**
 * Reduce an email to first letter + `***@<domain>` so log readers can
 * correlate "same user across log lines" without learning who.
 *
 * Examples:
 *   carol@example.com → c***@example.com
 *   l@x.com            → ***@x.com   (too short for a 1-char prefix)
 *   null / undefined   → '<none>'
 */
export function maskEmail(e: string | null | undefined): string {
  if (!e) return '<none>';
  const at = e.indexOf('@');
  if (at <= 0) return '***'; // no domain — bail out
  const domain = e.slice(at);
  const local = e.slice(0, at);
  if (local.length < 2) return `***${domain}`;
  return `${local[0]}***${domain}`;
}
