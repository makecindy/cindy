/**
 * nodeRuntimeBroker — 随意识安装的本地 Node 工作进程守门与 stdio 中继。
 *
 * 安全边界：
 * - 只执行已安装目录内、ghost.json 明确声明的单个 JS 入口；无 command / args / shell；
 * - 子进程拥有当前系统用户级本机权限，绝不把它描述成系统沙箱；
 * - 子进程只有 JSON-RPC stdio，不能直接拿到 Cindy IPC。所有 Cindy 能力仍须
 *   Node → main.js → contextBridge → 主机，并再次经过对应 slot 守门；
 * - 一段启用的意识最多一个 Node 进程，多会话复用；按需启动、闲置关闭，
 *   停用/更新/卸载/主机退出时由上层 stop；原位更新另用 stopAndWait，等旧进程
 *   真正退出后才可替换其安装目录；
 * - MCP 只开放 client→server 调用。server 反向请求 Cindy 能力恒回 -32601。
 * - 代启子进程(childSpawn)不是上述铁律的例外:控制帧走引导层私藏的
 *   parentPort(插件代码摸不到),能要到的唯一东西是"再跑一个包内申报过的
 *   JS"——没有任何 Cindy 能力面;子进程原样 stdio 由主机纯字节中继,不参与
 *   协议;worker 死/停即级联收全家。
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { utilityProcess } from 'electron';

import type {
  GhostNodeChildToHostMessage,
  GhostNodeChildToWorkerMessage,
  GhostPipeEventPush,
  GhostPipeNodeResult,
  InstalledGhost,
} from '../../shared/ghost.js';
import {
  GHOST_NODE_CHILD_MODE_FLAG,
  GHOST_NODE_MAX_CHILDREN_PER_GHOST,
  GHOST_NODE_REQUEST_MAX_TOTAL_MS,
  isGhostNodeMcpReservedMethod,
  parseGhostNodeChildToHostMessage,
} from '../../shared/ghost.js';
import { isGhostOwnerScopeUsable, type GhostOwnerScope } from './ghostOwnerScope.js';

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
/** 停止后先给进程自行收尾的窗口；到点再 SIGKILL。 */
const PROCESS_STOP_GRACE_MS = 2_000;
/** 原位更新绝不能无限等退出；给 SIGKILL 的 exit 事件留一个小缓冲。 */
const PROCESS_STOP_WAIT_TIMEOUT_MS = PROCESS_STOP_GRACE_MS + 500;
/**
 * 启动失败重试(2026-07-24):Windows 上杀软实时扫描刚写入的 .vite 产物 /
 * 刚更新的 app.asar 时,子进程读引导入口会瞬时 ACCESS_DENIED(表现为
 * "EPERM: operation not permitted, open …nodeRuntimeWorkerProcess.js" 后
 * 立即退出)。这类失败几百毫秒内自愈,给"fork 抛错 / 就绪前退出"留有界
 * 重试;启动超时不重试——进程活着只是没就绪,重跑只会成倍拉长等待。
 */
const WORKER_START_ATTEMPTS = 3;
const WORKER_START_RETRY_DELAYS_MS = [250, 750] as const;
/** 启动期 stderr 只留头部这么多字符,够提取一行诊断,不给日志灌洪。 */
const STARTUP_STDERR_CAP = 4_096;
/**
 * 意外死亡诊断(2026-07-26):引导层先发 ready、后 require 插件入口,所以"插件
 * 模块加载期抛错"这类崩溃落在启动期之后——startupStderr 那条路截不到,在途
 * 请求只会收到干巴巴的"已退出(code=1)"。真实案例:某插件在 Windows 上
 * defineProperty(process, 'stdin') 抛 TypeError,主进程日志里有完整栈,插件与
 * Agent 侧却一无所知,只能翻日志才知道为什么。这里另留 stderr **尾部**——崩溃
 * 摘要出现在最后,与启动期的头部截存互补。
 */
const EXIT_STDERR_CAP = 4_096;
/** 尾部 stderr 只在紧邻退出时可信;更早的日志与本次死亡无关,拼进错误只会误导。 */
const EXIT_STDERR_LOOKBACK_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_PENDING_REQUESTS = 32;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_STDIO_LINE_BYTES = 1024 * 1024;
const MCP_PROTOCOL_VERSION = '2025-06-18';

interface NodeWorkerReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  once?(event: 'end', listener: () => void): this;
}

interface NodeWorkerWritable {
  destroyed?: boolean;
  write(chunk: string): boolean;
}

/** 生产使用 utilityProcess 适配器；最小接口便于纯单测注入假进程。 */
export interface NodeWorkerProcess {
  stdin: NodeWorkerWritable;
  stdout: NodeWorkerReadable;
  stderr: NodeWorkerReadable;
  pid?: number;
  killed?: boolean;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  /**
   * 诊断-only 的 main 侧观测；不得用于放行业务请求。晚订阅只安全回放已
   * 观测的 utility-process-spawned。
   */
  onStartupObservation?(listener: (observation: NodeWorkerStartupObservation) => void): void;
  /** 订阅 worker 引导层就绪后经 parentPort 上行的控制帧(代启子进程用;可选)。 */
  onControl?(listener: (message: unknown) => void): void;
  /** 给 worker 引导层下行一条控制帧(代启结果/子进程输出等;可选)。 */
  sendControl?(message: unknown): boolean;
}

export type NodeWorkerStartupStage = 'utility-process-spawned' | 'parent-port-ready';

export interface NodeWorkerStartupObservation {
  stage: NodeWorkerStartupStage;
  pid?: number;
}

type NodeWorkerObservedTimeoutClass = 'native-not-observed' | 'native-observed-ready-not-observed';

export type NodeRuntimeObservedMainWindowState =
  'absent' | 'hidden' | 'minimized' | 'visible-unfocused' | 'focused' | 'unknown';

export type NodeRuntimeObservedScreenState = 'active' | 'idle' | 'locked' | 'unknown';

export interface NodeRuntimeStartAttemptContext {
  observedMainWindowState: NodeRuntimeObservedMainWindowState;
  observedScreenState: NodeRuntimeObservedScreenState;
}

export interface GhostNodeRuntimeBrokerDeps {
  getGhost(id: string): InstalledGhost | null;
  ownerScope?: GhostOwnerScope;
  /**
   * 读取当前插件自己声明的 Node 凭证。生产接 safeStorage；返回 null =
   * 未保存或保险库不可用。调用方不得记录返回值。
   */
  readSecret?: (ghostId: string, secretKey: string) => string | null;
  spawnProcess?: (entryPath: string, cwd: string, ghostId: string) => NodeWorkerProcess;
  /** 代启原样 stdio 子进程(childSpawn;缺省用 utilityProcess 适配器)。 */
  spawnChildProcess?: (
    entryPath: string,
    cwd: string,
    ghostId: string,
    args: string[],
  ) => NodeWorkerProcess;
  sendToGhost?: (ghostId: string, payload: GhostPipeEventPush) => void;
  now?: () => number;
  /** 测试注入；生产诊断时钟与业务计时分离。 */
  diagnosticNow?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** 每次启动尝试恰好读取一次的粗粒度宿主快照；异常不得影响 fork。 */
  getStartAttemptContext?: () => NodeRuntimeStartAttemptContext;
  /** 生产由 main 单例注入；测试可显式注入。 */
  appRunId?: string;
  /** 测试注入；生产每次 startWorkerOnce 生成随机 128-bit 标识。 */
  createAttemptId?: () => string;
  log?: {
    debug?(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

function debugDiagnostic(
  log: GhostNodeRuntimeBrokerDeps['log'],
  message: string,
  meta: Record<string, unknown>,
): void {
  try {
    log?.debug?.(message, meta);
  } catch {
    // 诊断输出永不影响进程生命周期。
  }
}

function warnDiagnostic(
  log: GhostNodeRuntimeBrokerDeps['log'],
  message: string,
  meta: Record<string, unknown>,
): void {
  try {
    log?.warn(message, meta);
  } catch {
    // 诊断输出永不影响进程生命周期。
  }
}

function readDiagnosticPid(child: NodeWorkerProcess): number | undefined {
  try {
    const pid = child.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  /** 沉默窗口(毫秒;续命重臂时用)。 */
  timeoutMs: number;
  /** 绝对截止时刻(this.now() 口径);null = 不续命(旧语义,总时长即 timeoutMs)。 */
  deadlineAt: number | null;
  /** 超时收尾(初臂/续命共用同一段收尾逻辑)。 */
  expire(): void;
  ownerScopeSnapshot: unknown;
}

/** 宿主代启的原样 stdio 子进程(childSpawn;挂在某个 worker 名下)。 */
interface ChildProcEntry {
  childId: string;
  entryRel: string;
  proc: NodeWorkerProcess;
  hardKillTimer: NodeJS.Timeout | null;
  stopping: boolean;
}

/** 已 fork 但尚未完成 spawn 握手的代启子进程。 */
interface StartingChildProcEntry {
  ghostId: string;
  proc: NodeWorkerProcess;
  hardKillTimer: NodeJS.Timeout | null;
  stopping: boolean;
}

interface WorkerEntry {
  ghost: InstalledGhost;
  ownerScopeSnapshot: unknown;
  /** 本进程对应的入口(相对路径;主入口 = manifest.node.entry)。 */
  entryRel: string;
  child: NodeWorkerProcess;
  /** 就绪握手完成前为 true:此阶段的退出由 ensureWorker 统一报告(可能重试),handleExit 不发 crashed。 */
  startupPhase: boolean;
  /** 诊断-only 启动阶段；不参与 ready 放行。 */
  startupStages: Set<NodeWorkerStartupStage>;
  /** 诊断相关性；不参与任何生命周期判定。 */
  appRunId: string;
  attemptId: string;
  diagnosticPid?: number;
  /** 主动停止开始时间，仅供既有 exit 回调计算观测延迟。 */
  stoppingStartedAt?: number;
  /** 启动期 stderr 头部截存,失败时提取一行诊断拼进错误消息(如杀软拦截的 EPERM)。 */
  startupStderr: string;
  /** stderr 尾部按段带时间戳截存,退出时只取回看窗口内的段拼接诊断。 */
  stderrSegments: Array<{ text: string; at: number }>;
  /** segments 总字符数(增量维护,避免每次 reduce)。 */
  stderrTotalChars: number;
  /** stderr 也可能把多字节字符切在两个 Buffer 之间,与 stdout 同理需流式解码。 */
  stderrDecoder: StringDecoder;
  /** stdout 的 UTF-8 字节可能把一个汉字切在两个 chunk 之间，必须流式解码。 */
  stdoutDecoder: StringDecoder;
  stdoutBuffer: string;
  nextId: number;
  pending: Map<string, PendingRpc>;
  /** 本 worker 名下代启的子进程(childId → 记账;级联生死)。 */
  children: Map<string, ChildProcEntry>;
  idleTimer: NodeJS.Timeout | null;
  hardKillTimer: NodeJS.Timeout | null;
  mcpInitPromise: Promise<void> | null;
  stopping: boolean;
  /** 曾发给本 worker 的凭证明文(退出诊断脱敏用;settleExit 后立即清空)。 */
  exposedSecretValues: Set<string>;
  /** exit 后 stderr drain 用:非 null 表示进程已退出、正在等待管道排空。 */
  exitDrain: {
    code: number | null;
    signal: string | null;
    error: Error | null;
    timer: NodeJS.Timeout;
    exitedAt: number;
    exitObservedAt: number;
    gen: number;
  } | null;
}

class NodeRpcError extends Error {
  constructor(
    readonly kind: 'exit' | 'protocol' | 'timeout' | 'remote',
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/**
 * 工作进程启动失败:retryable 决定 ensureWorker 是否值得再试一次;
 * silent = 状态已由别处如实播报(如 stop 时的 'stopped'),不再补发 'crashed'。
 */
class WorkerStartError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly silent = false,
    readonly ownerBoundary = false,
    readonly diagnostic?: {
      error: string;
    },
  ) {
    super(message);
  }
}

interface StartAttemptDiagnostic {
  appRunId: string;
  attemptId: string;
  observedMainWindowState: NodeRuntimeObservedMainWindowState;
  observedScreenState: NodeRuntimeObservedScreenState;
  observedStages: Set<NodeWorkerStartupStage>;
  pid?: number;
  observedTimeoutClass?: NodeWorkerObservedTimeoutClass;
  observedStagesAtDeadline?: NodeWorkerStartupStage[];
}

function randomDiagnosticId(): string | null {
  try {
    return randomUUID().replaceAll('-', '');
  } catch {
    return null;
  }
}

const STARTUP_STAGE_ORDER: readonly NodeWorkerStartupStage[] = [
  'utility-process-spawned',
  'parent-port-ready',
];

/**
 * 从 stderr 里挑最有诊断价值的一行(优先含 error 的行),截短拼进失败消息。
 * preferLast: true 时从末尾向前搜索(退出诊断,最后的 error 行更可能是死因);
 *             false 时从头向后搜索(启动诊断,首条 error 最相关)。
 */
function stderrHint(text: string, preferLast = false): string | null {
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const fallback = preferLast ? lines[lines.length - 1] : lines[0];
  const isDiagnostic = (s: string) => /error|fatal|exception|panic|abort/i.test(s);
  const errorLine = preferLast
    ? lines.findLast(isDiagnostic)
    : lines.find(isDiagnostic);
  const line = errorLine ?? fallback;
  return sanitizePathsInHint(line).slice(0, 240);
}

function sanitizePathsInHint(hint: string): string {
  const basename = (p: string) => p.split(/[/\\]/).pop() ?? p;
  return hint
    // 双引号包裹(内部允许 ')
    .replace(/"((?:[A-Za-z]:[/\\]|\\\\[^"]+|\/)[^"]+)"/g, (_, p) => `"${basename(p)}"`)
    // 单引号包裹(内部允许 ")
    .replace(/'((?:[A-Za-z]:[/\\]|\\\\[^']+|\/)[^']+)'/g, (_, p) => `'${basename(p)}'`)
    .replace(/[A-Za-z]:[/\\][^")\]\n]*/g, basename)
    .replace(/\\\\[^")\]\n]*/g, basename)
    // 多段 POSIX 路径;(?<![:/]) 排除 URL scheme 和连续斜杠
    .replace(/(?<![:/])\/(?:[^/")\]\n]+\/)+[^")\]\n]*/g, basename)
    // 单段 POSIX 绝对路径(/.ssh、/_private、/123mount 等)
    .replace(/(?<![:/])\/[^\s/")\]\n:,][^\s")\]\n:,]*(?=[\s")\]\n:,]|$)/g, basename);
}

type UtilityFork = typeof utilityProcess.fork;

/**
 * 用 Electron 官方 utilityProcess 承载第三方 Node 代码。
 *
 * 正式包关闭 RunAsNode fuse，因此不能把 process.execPath 当 node 二进制 spawn。
 * utilityProcess 是 Electron 保留的 Node service process 通道，不要求放宽 fuse。
 */
export function createUtilityNodeWorkerProcess(
  entryPath: string,
  cwd: string,
  ghostId: string,
  fork: UtilityFork = utilityProcess.fork,
  /** 提供即为"原样 stdio 子进程"模式(childSpawn 代启):透传启动参数,不参与协议。 */
  childArgs?: string[],
): NodeWorkerProcess {
  const isChild = childArgs !== undefined;
  // 不继承 API key / token 等宿主环境变量。Node 本身仍有用户级本机权限，
  // 这里只是在“无意泄露宿主秘密”和“系统运行必需变量”之间取最小集合。
  const inheritedKeys = [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    // 用户身份路径变量（是路径不是秘密）：gh / git 等 CLI 依赖它们定位用户级
    // 配置。gh 会按 GH_CONFIG_DIR → XDG_CONFIG_HOME → 平台默认目录查找；
    // Windows 上默认目录依赖 APPDATA / 用户目录，缺少这些变量会让 keyring 里明明
    // 有登录的 gh 仍误报“未登录”。HOME 是 Unix 侧同义变量，一并透传。
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    // gh 允许用 GH_CONFIG_DIR 指定自定义配置目录；同属路径类变量，不含秘密。
    'GH_CONFIG_DIR',
    // XDG_CONFIG_HOME 也可指定 gh 配置目录，且在 Windows 上同样可能优先于 APPDATA。
    'XDG_CONFIG_HOME',
  ] as const;
  const env: NodeJS.ProcessEnv = {
    CINDY_GHOST_ID: ghostId,
    // 不暴露安装目录路径——插件通过 __dirname 定位自身资源即可。
    // 显式传路径会降低篡改 ghost.json/trust 的门槛(相对路径写入已
    // 靠 cwd=tmpdir 阻断,但绝对路径仍可达;减少攻击面)。
  };
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const workerEntry = path.join(__dirname, 'nodeRuntimeWorkerProcess.js');
  const forkArgs = isChild
    ? [entryPath, GHOST_NODE_CHILD_MODE_FLAG, ...childArgs]
    : [entryPath];
  const child = fork(workerEntry, forkArgs, {
    cwd: os.tmpdir(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: `cindy-ghost-node:${ghostId}${isChild ? ':child' : ''}`,
    ...(process.platform === 'darwin' ? { disclaim: true } : {}),
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    child.kill();
    throw new Error('Node utilityProcess 没有可用的 stdout/stderr');
  }

  const events = new EventEmitter();
  const controlListeners = new Set<(message: unknown) => void>();
  const startupObservationListeners = new Set<
    (observation: NodeWorkerStartupObservation) => void
  >();
  let nativeSpawnObservation: NodeWorkerStartupObservation | null = null;
  let destroyed = false;
  let killed = false;
  let ready = false;
  const readNativePid = (): number | undefined => {
    try {
      const value = child.pid;
      return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const publishNativeSpawnObservation = (pid = readNativePid()): void => {
    try {
      if (nativeSpawnObservation) return;
      const observation: NodeWorkerStartupObservation = {
        stage: 'utility-process-spawned',
        ...(pid !== undefined ? { pid } : {}),
      };
      nativeSpawnObservation = observation;
      for (const listener of startupObservationListeners) {
        try {
          listener(observation);
        } catch {
          // 诊断 observer 不能中断原有 ready/spawn 传播。
        }
      }
    } catch {
      // 整条 native-spawn diagnostic 发布链 fail-open。
    }
  };
  const onMessage = (message: unknown) => {
    if (
      !ready &&
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).type === 'ready'
    ) {
      ready = true;
      events.emit('spawn');
      // 子进程原样模式:就绪后一律不再收消息——它没有任何上行控制资格。
      if (isChild) child.removeListener('message', onMessage);
      return;
    }
    // 普通模式就绪后,parentPort 只承载引导层的子进程控制帧;帧形状由
    // broker 侧 parseGhostNodeChildToHostMessage 严格把关,不合形静默丢。
    if (ready && !isChild) {
      controlListeners.forEach((listener) => listener(message));
    }
  };
  try {
    child.on('spawn', () => publishNativeSpawnObservation());
  } catch {
    // native spawn observer 安装失败不得影响 adapter 构造。
  }
  try {
    const initialPid = readNativePid();
    if (initialPid !== undefined) publishNativeSpawnObservation(initialPid);
  } catch {
    // PID 只用于诊断；getter 异常不得影响 adapter 构造。
  }
  child.on('message', onMessage);
  child.on('exit', (code) => {
    destroyed = true;
    killed = true;
    events.emit('exit', code, null);
  });
  child.on('error', (type, location) => {
    events.emit('error', new Error(`Node utilityProcess ${type} at ${location}`));
  });

  const adapter = {
    stdin: {
      get destroyed() {
        return destroyed;
      },
      write(chunk: string): boolean {
        if (destroyed) return false;
        // 原样子进程走 base64 字节口(chunk 可能切坏多字节字符);
        // 普通 worker 保持 utf8 文本口(逐行 JSON,旧行为零变化)。
        child.postMessage(isChild ? { type: 'stdin-b64', chunk } : { type: 'stdin', chunk });
        return true;
      },
    },
    stdout,
    stderr,
    onStartupObservation(listener: (observation: NodeWorkerStartupObservation) => void): void {
      if (nativeSpawnObservation) {
        try {
          listener(nativeSpawnObservation);
        } catch {
          // native spawn 可能早于 broker 订阅；安全回放仍须 fail-open。
        }
      }
      startupObservationListeners.add(listener);
    },
    onControl(listener: (message: unknown) => void): void {
      controlListeners.add(listener);
    },
    sendControl(message: unknown): boolean {
      if (destroyed) return false;
      child.postMessage(message);
      return true;
    },
    get pid() {
      return child.pid;
    },
    get killed() {
      return killed;
    },
    on(event: 'exit' | 'error', listener: (...args: unknown[]) => void) {
      events.on(event, listener);
      return adapter;
    },
    once(event: 'spawn' | 'exit' | 'error', listener: (...args: unknown[]) => void) {
      events.once(event, listener);
      return adapter;
    },
    kill(signal?: NodeJS.Signals): boolean {
      destroyed = true;
      killed = true;
      if (signal === 'SIGKILL' && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL');
          return true;
        } catch {
          // 已退出或平台不支持时落回 utilityProcess 自带的终止。
        }
      }
      return child.kill();
    },
  };
  return adapter as NodeWorkerProcess;
}

const defaultSpawnProcess = createUtilityNodeWorkerProcess;

/** 代启子进程缺省实现:同一 utilityProcess 通道,原样 stdio 模式。 */
const defaultSpawnChildProcess = (
  entryPath: string,
  cwd: string,
  ghostId: string,
  args: string[],
): NodeWorkerProcess =>
  createUtilityNodeWorkerProcess(entryPath, cwd, ghostId, utilityProcess.fork, args);

function errorResult(
  errorCode: Extract<GhostPipeNodeResult, { ok: false }>['errorCode'],
  message: string,
  data?: unknown,
): GhostPipeNodeResult {
  return { ok: false, errorCode, message, ...(data !== undefined ? { data } : {}) };
}

function clearHostSecrets(secrets: Record<string, string> | undefined): void {
  if (!secrets) return;
  for (const key of Object.keys(secrets)) secrets[key] = '';
}

/**
 * 每意识的本地 Node 工作进程生命周期与 JSON-RPC stdio 中继。
 * 多进程窄版(2026-07-23):主入口之外,manifest.node.entries 申报的每个额外
 * 入口各占一个进程(按 ghostId+entry 记账);仍只能跑包内申报过的 JS,不是
 * 任意命令执行。stop(ghostId) 收掉该意识全部进程。
 */
export class GhostNodeRuntimeBroker {
  /**
   * key = `ghostId::entryRel`(entryRel = 主入口或申报的额外入口;ghostId 与
   * 安全相对路径的字符集都不含 ":",拼接无歧义)。
   */
  private readonly workers = new Map<string, WorkerEntry>();
  private readonly appRunId: string;

  constructor(private readonly deps: GhostNodeRuntimeBrokerDeps) {
    this.appRunId = /^[0-9a-f]{16,64}$/.test(deps.appRunId ?? '') ? deps.appRunId! : 'unknown';
  }

  private createStartAttemptDiagnostic(): StartAttemptDiagnostic {
    const mainWindowStates: readonly NodeRuntimeObservedMainWindowState[] = [
      'absent',
      'hidden',
      'minimized',
      'visible-unfocused',
      'focused',
      'unknown',
    ];
    const screenStates: readonly NodeRuntimeObservedScreenState[] = [
      'active',
      'idle',
      'locked',
      'unknown',
    ];
    let observedMainWindowState: NodeRuntimeObservedMainWindowState = 'unknown';
    let observedScreenState: NodeRuntimeObservedScreenState = 'unknown';
    try {
      const observed = this.deps.getStartAttemptContext?.();
      if (observed && mainWindowStates.includes(observed.observedMainWindowState)) {
        observedMainWindowState = observed.observedMainWindowState;
      }
      if (observed && screenStates.includes(observed.observedScreenState)) {
        observedScreenState = observed.observedScreenState;
      }
    } catch {
      // 诊断快照或其只读字段失败不能影响 fork。
    }
    let attemptId: string | undefined;
    try {
      const candidate = this.deps.createAttemptId?.();
      if (candidate && /^[0-9a-f]{16,64}$/.test(candidate)) attemptId = candidate;
    } catch {
      // 测试注入异常同样不得影响启动。
    }
    return {
      appRunId: this.appRunId,
      attemptId: attemptId ?? randomDiagnosticId() ?? 'unknown',
      observedMainWindowState,
      observedScreenState,
      observedStages: new Set(),
    };
  }

  private startupSettlementMeta(
    attempt: StartAttemptDiagnostic,
    outcome: 'ready' | 'failed' | 'cancelled',
  ): Record<string, unknown> {
    return {
      appRunId: attempt.appRunId,
      attemptId: attempt.attemptId,
      outcome,
      ...(attempt.observedStagesAtDeadline
        ? { observedStagesAtDeadline: attempt.observedStagesAtDeadline }
        : {
            observedStagesAtSettle: STARTUP_STAGE_ORDER.filter((stage) =>
              attempt.observedStages.has(stage),
            ),
          }),
      ...(attempt.pid !== undefined ? { pid: attempt.pid } : {}),
    };
  }

  private static keyOf(ghostId: string, entryRel: string): string {
    return `${ghostId}::${entryRel}`;
  }

  stateOf(ghostId: string): 'off' | 'running' {
    for (const entry of this.workers.values()) {
      if (entry.ghost.manifest.id === ghostId) return 'running';
    }
    return 'off';
  }

  /** resident 档在插件启用/启动时调用；按需档保持零进程。常驻只覆盖主入口。
   *  同时也是 stop() 的对称点:上层完成更新/重启后调用此方法,清除停止标记。 */
  async startResident(ghost: InstalledGhost): Promise<void> {
    this.stoppedGhosts.delete(ghost.manifest.id);
    if (!ghost.enabled || ghost.manifest.node?.lifecycle !== 'resident') return;
    const ownerScopeSnapshot = this.captureOwnerScope();
    const entry = await this.ensureWorker(ghost, ghost.manifest.node.entry, ownerScopeSnapshot);
    this.assertOwnerScopeUsable(ghost.manifest.id, ownerScopeSnapshot);
    if (ghost.manifest.node.protocol === 'mcp-stdio') await this.ensureMcpInitialized(entry);
  }

  /** Recovery-only restart for a runtime that was already running on demand. */
  async startForRecovery(ghost: InstalledGhost): Promise<void> {
    this.stoppedGhosts.delete(ghost.manifest.id);
    if (!ghost.enabled || !ghost.manifest.node) return;
    const ownerScopeSnapshot = this.captureOwnerScope();
    const entry = await this.ensureWorker(ghost, ghost.manifest.node.entry, ownerScopeSnapshot);
    this.assertOwnerScopeUsable(ghost.manifest.id, ownerScopeSnapshot);
    if (ghost.manifest.node.protocol === 'mcp-stdio') await this.ensureMcpInitialized(entry);
  }

  /** main.js 的 node-request 入口。 */
  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeNodeResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.node) {
      return errorResult('PERMISSION_DENIED', '插件未申请本地 Node 权限，或当前未启用');
    }
    // getGhost 确认插件当前已启用——这是按需插件的"后更新/重启边界",
    // 清除 stop() 留下的停止标记,使按需进程可以恢复启动。
    this.stoppedGhosts.delete(ghostId);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return errorResult('INVALID_REQUEST', 'node-request 载荷必须是对象');
    }
    const request = payload as Record<string, unknown>;
    if (request.type !== 'node-request') {
      return errorResult('INVALID_REQUEST', '请求类型必须是 node-request');
    }
    if (
      typeof request.method !== 'string' ||
      !/^[A-Za-z0-9_./:-]{1,128}$/.test(request.method)
    ) {
      return errorResult('INVALID_REQUEST', 'method 必须是 1–128 位安全方法名');
    }
    if (
      request.timeoutMs !== undefined &&
      (typeof request.timeoutMs !== 'number' ||
        !Number.isInteger(request.timeoutMs) ||
        request.timeoutMs < 1_000 ||
        request.timeoutMs > MAX_REQUEST_TIMEOUT_MS)
    ) {
      return errorResult('INVALID_REQUEST', 'timeoutMs 必须是 1000–120000 的整数');
    }
    // 长任务续命(构建等):声明 maxTotalMs 后 timeoutMs 变为"沉默窗口",
    // worker 有动静就续期,绝对上限 15 分钟。不声明 = 旧语义零变化。
    const effectiveTimeoutMs = (request.timeoutMs as number | undefined) ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      request.maxTotalMs !== undefined &&
      (typeof request.maxTotalMs !== 'number' ||
        !Number.isInteger(request.maxTotalMs) ||
        request.maxTotalMs < effectiveTimeoutMs ||
        request.maxTotalMs > GHOST_NODE_REQUEST_MAX_TOTAL_MS)
    ) {
      return errorResult(
        'INVALID_REQUEST',
        `maxTotalMs 必须是 ≥ 生效 timeoutMs 且 ≤ ${GHOST_NODE_REQUEST_MAX_TOTAL_MS} 的整数`,
      );
    }
    let paramsJson: string;
    try {
      paramsJson = JSON.stringify(request.params ?? null);
    } catch {
      return errorResult('INVALID_REQUEST', 'params 必须可以转换成 JSON');
    }
    if (Buffer.byteLength(paramsJson, 'utf8') > MAX_REQUEST_BYTES) {
      return errorResult('INVALID_REQUEST', `params 不能超过 ${MAX_REQUEST_BYTES} 字节`);
    }
    // 目标入口(多进程窄版):缺省主入口;指定时必须逐字命中申报清单——
    // 这是"只能跑包内申报过的 JS"的代码边界,不靠作者自觉。
    let entryRel = ghost.manifest.node.entry;
    if (request.entry !== undefined) {
      if (
        typeof request.entry !== 'string' ||
        !(ghost.manifest.node.entries ?? []).includes(request.entry)
      ) {
        return errorResult(
          'INVALID_REQUEST',
          'entry 必须逐字命中 ghost.json 的 node.entries 申报清单(缺省 = 主入口)',
        );
      }
      entryRel = request.entry;
    }
    const secretBindings = (ghost.manifest.node.secretBindings ?? []).filter(
      (binding) =>
        binding.methods.includes(request.method as string) &&
        (binding.entry ?? ghost.manifest.node!.entry) === entryRel,
    );

    if (
      ghost.manifest.node.protocol === 'mcp-stdio' &&
      isGhostNodeMcpReservedMethod(request.method as string)
    ) {
      return errorResult('INVALID_REQUEST', 'MCP 初始化由 Cindy 主机统一管理');
    }

    let ownerScopeSnapshot: unknown;
    try {
      ownerScopeSnapshot = this.captureOwnerScope();
    } catch {
      return errorResult('PERMISSION_DENIED', 'Plugin owner boundary is not stable');
    }

    let hostSecrets: Record<string, string> | undefined;
    if (secretBindings.length > 0) {
      hostSecrets = Object.create(null) as Record<string, string>;
      try {
        for (const binding of secretBindings) {
          if (!this.ownerScopeUsable(ghostId, ownerScopeSnapshot)) {
            clearHostSecrets(hostSecrets);
            return errorResult('PERMISSION_DENIED', 'Plugin owner boundary is not stable');
          }
          const value = this.deps.readSecret?.(ghostId, binding.key) ?? null;
          if (value === null) {
            clearHostSecrets(hostSecrets);
            return errorResult(
              'PERMISSION_DENIED',
              `Node 请求需要先配置凭证「${binding.label}」`,
            );
          }
          hostSecrets[binding.key] = value;
        }
        if (!this.ownerScopeUsable(ghostId, ownerScopeSnapshot)) {
          clearHostSecrets(hostSecrets);
          return errorResult('PERMISSION_DENIED', 'Plugin owner boundary is not stable');
        }
      } catch {
        clearHostSecrets(hostSecrets);
        return errorResult('INTERNAL', '读取 Node 请求所需凭证失败');
      }
    }

    let entry: WorkerEntry;
    try {
      entry = await this.ensureWorker(ghost, entryRel, ownerScopeSnapshot);
      this.assertOwnerScopeUsable(ghostId, ownerScopeSnapshot);
    } catch (error) {
      clearHostSecrets(hostSecrets);
      if (error instanceof WorkerStartError && error.ownerBoundary) {
        return errorResult('PERMISSION_DENIED', error.message);
      }
      return errorResult(
        'PROCESS_START_FAILED',
        error instanceof Error ? error.message : 'Node 工作进程启动失败',
      );
    }
    if (entry.pending.size >= MAX_PENDING_REQUESTS) {
      clearHostSecrets(hostSecrets);
      return errorResult('RATE_LIMITED', '这个插件同时等待的 Node 请求太多');
    }

    try {
      if (ghost.manifest.node.protocol === 'mcp-stdio') {
        await this.ensureMcpInitialized(entry);
        this.assertOwnerScopeUsable(ghostId, ownerScopeSnapshot);
        if (entry.pending.size >= MAX_PENDING_REQUESTS) {
          return errorResult('RATE_LIMITED', '这个插件同时等待的 Node 请求太多');
        }
      }
      if (hostSecrets) {
        for (const v of Object.values(hostSecrets)) {
          if (v) entry.exposedSecretValues.add(v);
        }
      }
      const pendingResult = this.sendRpc(
        entry,
        request.method,
        request.params ?? null,
        effectiveTimeoutMs,
        request.maxTotalMs as number | undefined,
        hostSecrets,
        ownerScopeSnapshot,
      );
      // writeLine/JSON.stringify 在 sendRpc 内同步完成；随即抹掉本次临时对象，
      // 不让凭证明文跟随 Promise 生命周期常驻在 broker 闭包里。
      if (hostSecrets) {
        clearHostSecrets(hostSecrets);
        hostSecrets = undefined;
      }
      const result = await pendingResult;
      return { ok: true, result };
    } catch (error) {
      if (error instanceof NodeRpcError) {
        if (error.kind === 'timeout') return errorResult('TIMEOUT', error.message);
        if (error.kind === 'exit') return errorResult('PROCESS_EXITED', error.message);
        return errorResult('PROTOCOL_ERROR', error.message, error.data);
      }
      return errorResult('INTERNAL', error instanceof Error ? error.message : String(error));
    } finally {
      clearHostSecrets(hostSecrets);
      this.scheduleIdleStop(entry);
    }
  }

  /* ── 宿主代启子进程(childSpawn,2026-07-23)──────────────────────── */

  /** worker 引导层上行控制帧的总入口:形状不合静默丢,资格逐项查。 */
  private handleWorkerControl(entry: WorkerEntry, raw: unknown): void {
    if (!this.ownerScopeUsable(entry.ghost.manifest.id, entry.ownerScopeSnapshot)) return;
    const message = parseGhostNodeChildToHostMessage(raw);
    if (!message) return;
    if (message.type === 'spawn-child') {
      void this.spawnChildForWorker(entry, message);
      return;
    }
    const child = entry.children.get(message.childId);
    if (!child || child.stopping) return;
    if (message.type === 'child-stdin') {
      child.proc.stdin.write(message.b64);
    } else if (message.type === 'child-stdin-end') {
      child.proc.sendControl?.({ type: 'stdin-end' });
    } else if (message.type === 'child-kill') {
      this.stopChild(entry, child, false);
    }
  }

  /** 某插件当前在世的代启子进程总数(跨该插件全部 worker)。 */
  private childCountOf(ghostId: string): number {
    let count = 0;
    for (const entry of this.workers.values()) {
      if (entry.ghost.manifest.id === ghostId) count += entry.children.size;
    }
    return count;
  }

  /**
   * 代生在途预约(ghostId → 数量):spawn 要等子进程就绪才记账,并发申请会在
   * 记账前一起挤过数量顶——预约位在检查的同一同步段占坑,堵死这条竞态。
   */
  private readonly childReservations = new Map<string, number>();

  private replyToWorker(entry: WorkerEntry, message: GhostNodeChildToWorkerMessage): void {
    if (!this.ownerScopeUsable(entry.ghost.manifest.id, entry.ownerScopeSnapshot)) return;
    entry.child.sendControl?.(message);
  }

  /**
   * 代生一个原样 stdio 子进程。守门四连:childSpawn 开关(现查清单,停用即失效)
   * → 入口必须已申报(entry / entries 逐字命中)→ 数量顶 → 路径不越安装目录。
   * 全过才 fork;就绪后先记账、再挂字节中继、最后回执——worker 拿到 ok 时
   * 输出零丢失(Readable 在挂上 data 前自缓冲)。
   */
  private async spawnChildForWorker(
    entry: WorkerEntry,
    message: Extract<GhostNodeChildToHostMessage, { type: 'spawn-child' }>,
  ): Promise<void> {
    const ghostId = entry.ghost.manifest.id;
    const fail = (reason: string): void => {
      this.deps.log?.warn('ghost node child spawn rejected', { ghostId, reason });
      this.replyToWorker(entry, {
        type: 'spawn-child-result',
        reqId: message.reqId,
        ok: false,
        message: reason,
      });
    };
    // stopAndWait 已开始后不得再 fork 新 child；否则它会落在本轮快照之外，
    // 又把目录替换竞态带回来。仍在世的 worker 必须收到拒绝回执，避免它白等
    // 到自己的请求超时；已被移除的 worker 则不再可安全回信。
    if (this.workers.get(GhostNodeRuntimeBroker.keyOf(ghostId, entry.entryRel)) !== entry) {
      return;
    }
    if (this.stoppedGhosts.has(ghostId)) {
      fail('插件正在停止，不能再启动子进程');
      return;
    }
    if (!this.ownerScopeUsable(ghostId, entry.ownerScopeSnapshot)) {
      fail('Plugin owner boundary changed before child process dispatch');
      return;
    }
    const ghost = this.deps.getGhost(ghostId);
    const node = ghost?.enabled ? ghost.manifest.node : undefined;
    if (!node || node.childSpawn !== true) {
      fail('插件未声明 node.childSpawn,或当前未启用');
      return;
    }
    const declared = [node.entry, ...(node.entries ?? [])];
    if (!declared.includes(message.entry)) {
      fail('子进程入口必须逐字命中 ghost.json 申报清单(node.entry / node.entries)');
      return;
    }
    const reserved = this.childReservations.get(ghostId) ?? 0;
    if (this.childCountOf(ghostId) + reserved >= GHOST_NODE_MAX_CHILDREN_PER_GHOST) {
      fail(`同时在世的子进程最多 ${GHOST_NODE_MAX_CHILDREN_PER_GHOST} 个`);
      return;
    }
    this.childReservations.set(ghostId, reserved + 1);
    try {
      await this.spawnChildReserved(entry, message, ghostId);
    } finally {
      const left = (this.childReservations.get(ghostId) ?? 1) - 1;
      if (left <= 0) this.childReservations.delete(ghostId);
      else this.childReservations.set(ghostId, left);
    }
  }

  /** 预约位已占的代生主体(spawnChildForWorker 的续段;失败路径自行回执)。 */
  private async spawnChildReserved(
    entry: WorkerEntry,
    message: Extract<GhostNodeChildToHostMessage, { type: 'spawn-child' }>,
    ghostId: string,
  ): Promise<void> {
    const fail = (reason: string): void => {
      this.deps.log?.warn('ghost node child spawn rejected', { ghostId, reason });
      this.replyToWorker(entry, {
        type: 'spawn-child-result',
        reqId: message.reqId,
        ok: false,
        message: reason,
      });
    };
    const entryPath = path.resolve(entry.ghost.dir, ...message.entry.split('/'));
    const root = path.resolve(entry.ghost.dir);
    if (entryPath === root || !entryPath.startsWith(`${root}${path.sep}`)) {
      fail('子进程入口越出插件安装目录');
      return;
    }

    let proc: NodeWorkerProcess;
    try {
      proc = (this.deps.spawnChildProcess ?? defaultSpawnChildProcess)(
        entryPath,
        root,
        ghostId,
        message.args ?? [],
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : '子进程启动失败');
      return;
    }
    // fork 已经产生真实 OS 进程，但它要等 child-mode ready 才会写进
    // entry.children。原位更新不能漏掉这段空窗，否则 Windows rename 仍可能
    // 撞上子进程持有的插件文件句柄。
    const startingChild = this.trackStartingChild(ghostId, proc);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let startTimer: NodeJS.Timeout | null = null;
        const settle = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          if (startTimer) this.clearTimer(startTimer);
          outcome();
        };
        startTimer = this.setTimer(
          () => settle(() => reject(new Error('子进程启动超时'))),
          DEFAULT_START_TIMEOUT_MS,
        );
        startTimer.unref?.();
        proc.once('spawn', () => settle(resolve));
        proc.once('error', (error) => settle(() => reject(error)));
        proc.once('exit', (code) => settle(() => reject(new Error(`子进程启动前退出(code=${code})`))));
      });
    } catch (error) {
      // error 只表示进程通道失败，不保证 OS 进程已经退出。保留 starting
      // 记账直到真实 exit，并立即强杀；否则后续更新会漏掉仍持有文件句柄的进程。
      this.stopStartingChild(startingChild, true);
      fail(error instanceof Error ? error.message : '子进程启动失败');
      return;
    }

    // worker 在等待答复期间死了/被停:孩子不能变孤儿,就地收掉。
    if (
      this.workers.get(GhostNodeRuntimeBroker.keyOf(ghostId, entry.entryRel)) !== entry
      || !this.ownerScopeUsable(ghostId, entry.ownerScopeSnapshot)
    ) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // no-op
      }
      return;
    }

    // 之后没有 await，先从启动中集合移到正式 children 不会留下可观察空窗。
    this.forgetStartingChild(startingChild);
    const child: ChildProcEntry = {
      childId: randomUUID(),
      entryRel: message.entry,
      proc,
      hardKillTimer: null,
      stopping: false,
    };
    entry.children.set(child.childId, child);
    // 子进程在世期间 worker 不许被空闲回收(代理常驻正是这个形态)。
    this.clearIdleTimer(entry);
    proc.stdout.on('data', (chunk) => {
      this.replyToWorker(entry, {
        type: 'child-stdout',
        childId: child.childId,
        b64: Buffer.from(chunk).toString('base64'),
      });
    });
    proc.stderr.on('data', (chunk) => {
      this.replyToWorker(entry, {
        type: 'child-stderr',
        childId: child.childId,
        b64: Buffer.from(chunk).toString('base64'),
      });
    });
    proc.on('exit', (code) => this.handleChildExit(entry, child, code));
    // error 只说明进程通道失败，不证明 OS 进程已经退出。开始有界停止，
    // 但继续保留 children 记账直到真实 exit，供 stopAndWait 快照覆盖。
    proc.on('error', () => this.stopChild(entry, child, false));
    this.deps.log?.info('ghost node child spawned', {
      ghostId,
      entry: message.entry,
      childId: child.childId,
      pid: proc.pid,
    });
    this.replyToWorker(entry, {
      type: 'spawn-child-result',
      reqId: message.reqId,
      ok: true,
      childId: child.childId,
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
    });
  }

  private handleChildExit(entry: WorkerEntry, child: ChildProcEntry, code: number | null): void {
    if (entry.children.get(child.childId) !== child) return;
    entry.children.delete(child.childId);
    if (child.hardKillTimer) {
      this.clearTimer(child.hardKillTimer);
      child.hardKillTimer = null;
    }
    if (!entry.stopping) {
      this.replyToWorker(entry, { type: 'child-exit', childId: child.childId, code });
      // 最后一个孩子走了,worker 恢复正常的空闲回收节奏。
      this.scheduleIdleStop(entry);
    }
  }

  /** silent = 级联收尾(worker 已死,孩子不必也无法再收到 child-exit)。 */
  private stopChild(entry: WorkerEntry, child: ChildProcEntry, silent: boolean): void {
    if (child.stopping) return;
    child.stopping = true;
    if (silent) {
      entry.children.delete(child.childId);
    }
    try {
      child.proc.kill('SIGTERM');
      child.hardKillTimer = this.setTimer(() => {
        child.hardKillTimer = null;
        try {
          child.proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, PROCESS_STOP_GRACE_MS);
      child.hardKillTimer.unref?.();
    } catch {
      // 已退出即视为停止成功。
    }
  }

  /** 停用、更新或卸载一个插件时立即停止其名下**全部** Node 进程。 */
  stop(ghostId: string): void {
    this.stoppedGhosts.add(ghostId);
    for (const starting of [...(this.startingChildren.get(ghostId) ?? [])]) {
      this.stopStartingChild(starting);
    }
    for (const [key, entry] of [...this.workers]) {
      if (entry.ghost.manifest.id === ghostId) this.stopWorker(key, entry);
    }
  }

  /**
   * 停止并等待当前已运行的 Node 进程退出。
   *
   * 原位更新会把整个插件目录 rename 到备份位。在 Windows 上，即使已经向
   * utilityProcess 发出 SIGTERM，只要旧进程尚未触发 exit，目录中的入口文件
   * 仍可能被占用而让 rename 报 EPERM。已 fork 但尚未 ready 的 child 也在
   * 等待集合内；先订阅 exit、再 stop，避免在两步之间漏掉极快退出的事件。
   */
  async stopAndWait(ghostId: string): Promise<void> {
    // 先封住新的 child spawn；这段没有 await，随后快照可覆盖所有已 fork 的进程。
    this.stoppedGhosts.add(ghostId);
    // 以真实进程账本为准，而不是 workers/children 的业务状态。错误事件、父进程
    // 退出或上一次停止超时都可能先移除业务记账；只要没有真实 exit，重试更新
    // 仍必须等待同一 OS 进程，不能绕过 Windows 文件锁保护。
    const processes = new Set(this.liveProcesses.get(ghostId) ?? []);
    const exited = [...processes].map((process) => this.waitForProcessExit(process, ghostId));
    this.stop(ghostId);
    await Promise.all(exited);
  }

  /** 原位更新时，进程异常或强杀后仍不退出都必须阻止目录替换。 */
  private waitForProcessExit(process: NodeWorkerProcess, ghostId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let processError: Error | null = null;
      let timer: NodeJS.Timeout | null = null;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) this.clearTimer(timer);
        outcome();
      };
      timer = this.setTimer(
        () =>
          settle(() =>
            reject(
              processError
                ? new Error(`插件 Node 进程停止失败(${ghostId}): ${processError.message}`)
                : new Error(`插件 Node 进程停止超时(${ghostId})`),
            ),
          ),
        PROCESS_STOP_WAIT_TIMEOUT_MS,
      );
      timer.unref?.();
      process.once('exit', () => settle(resolve));
      // error 不是进程退出证明。记住诊断，但继续等 exit 或有界超时，让
      // stopWorker / stopStartingChild 的 SIGKILL 兜底保持生效。
      process.once('error', (error) => {
        processError = error;
      });
    });
  }

  /** 所有已创建的 OS 进程：只认真实 exit 移除，error 不算退出证明。 */
  private readonly liveProcesses = new Map<string, Set<NodeWorkerProcess>>();

  private trackLiveProcess(ghostId: string, process: NodeWorkerProcess): void {
    const processes = this.liveProcesses.get(ghostId) ?? new Set<NodeWorkerProcess>();
    if (processes.has(process)) return;
    processes.add(process);
    this.liveProcesses.set(ghostId, processes);
    process.once('exit', () => {
      const current = this.liveProcesses.get(ghostId);
      if (!current) return;
      current.delete(process);
      if (current.size === 0) this.liveProcesses.delete(ghostId);
    });
  }

  private readonly startingChildren = new Map<string, Set<StartingChildProcEntry>>();

  private trackStartingChild(ghostId: string, proc: NodeWorkerProcess): StartingChildProcEntry {
    this.trackLiveProcess(ghostId, proc);
    const entry: StartingChildProcEntry = { ghostId, proc, hardKillTimer: null, stopping: false };
    const children = this.startingChildren.get(ghostId) ?? new Set<StartingChildProcEntry>();
    children.add(entry);
    this.startingChildren.set(ghostId, children);
    // error 不是进程已退出的证明，任何路径都保留记账直到真实 exit。
    proc.once('exit', () => this.forgetStartingChild(entry));
    return entry;
  }

  private forgetStartingChild(entry: StartingChildProcEntry): void {
    if (entry.hardKillTimer) {
      this.clearTimer(entry.hardKillTimer);
      entry.hardKillTimer = null;
    }
    const children = this.startingChildren.get(entry.ghostId);
    if (!children) return;
    children.delete(entry);
    if (children.size === 0) this.startingChildren.delete(entry.ghostId);
  }

  private stopStartingChild(entry: StartingChildProcEntry, force = false): void {
    if (entry.stopping) return;
    entry.stopping = true;
    try {
      entry.proc.kill(force ? 'SIGKILL' : 'SIGTERM');
      entry.hardKillTimer = this.setTimer(() => {
        entry.hardKillTimer = null;
        try {
          entry.proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, PROCESS_STOP_GRACE_MS);
      entry.hardKillTimer.unref?.();
    } catch {
      // 已退出即视为停止成功；stopAndWait 会以 exit/error 或有界超时收口。
    }
  }

  private stopWorker(key: string, entry: WorkerEntry): void {
    entry.stopping = true;
    this.workers.delete(key);
    this.exitGen.set(key, (this.exitGen.get(key) ?? 0) + 1);
    this.clearIdleTimer(entry);
    // 级联:先收孩子再收本体,不留孤儿进程。
    for (const child of [...entry.children.values()]) this.stopChild(entry, child, true);
    for (const pending of entry.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new NodeRpcError('exit', 'Node 工作进程已停止'));
    }
    entry.pending.clear();
    entry.exposedSecretValues.clear();
    // PID 是启动期已经捕获的只读 fact；停止关键路径前不再调用诊断 getter/logger。
    const stopPid = entry.diagnosticPid;
    let sigtermKillReturned = false;
    try {
      sigtermKillReturned = entry.child.kill('SIGTERM');
      entry.hardKillTimer = this.setTimer(() => {
        entry.hardKillTimer = null;
        try {
          const killReturned = entry.child.kill('SIGKILL');
          debugDiagnostic(this.deps.log, 'ghost node process lifecycle', {
            ghostId: entry.ghost.manifest.id,
            entry: entry.entryRel,
            appRunId: entry.appRunId,
            attemptId: entry.attemptId,
            ...(entry.diagnosticPid !== undefined ? { pid: entry.diagnosticPid } : {}),
            stage: 'sigkill-requested',
            killReturned,
          });
        } catch {
          // already gone
          debugDiagnostic(this.deps.log, 'ghost node process lifecycle', {
            ghostId: entry.ghost.manifest.id,
            entry: entry.entryRel,
            appRunId: entry.appRunId,
            attemptId: entry.attemptId,
            ...(entry.diagnosticPid !== undefined ? { pid: entry.diagnosticPid } : {}),
            stage: 'sigkill-requested',
            killReturned: false,
          });
        }
      }, PROCESS_STOP_GRACE_MS);
      entry.hardKillTimer.unref?.();
    } catch {
      // 已退出即视为停止成功。
    }
    this.sendStatus(entry.ghost, 'stopped', undefined, entry.entryRel);
    // 诊断计时从 HEAD 停止动作全部完成后开始；不得推迟 signal/grace timer/status。
    if (entry.stoppingStartedAt === undefined) entry.stoppingStartedAt = Date.now();
    debugDiagnostic(this.deps.log, 'ghost node process lifecycle', {
      ghostId: entry.ghost.manifest.id,
      entry: entry.entryRel,
      appRunId: entry.appRunId,
      attemptId: entry.attemptId,
      ...(stopPid !== undefined ? { pid: stopPid } : {}),
      stage: 'sigterm-requested',
      killReturned: sigtermKillReturned,
    });
  }

  /** Cindy 退出时收掉全部随包 Node 进程。 */
  destroyAll(): void {
    this.destroyed = true;
    for (const [key, entry] of [...this.workers]) this.stopWorker(key, entry);
  }

  /** 同 key 在途启动去重:重试退避窗口内的并发请求共享同一次启动,不双开进程。 */
  private readonly startingWorkers = new Map<string, Promise<WorkerEntry>>();
  private readonly startingWorkerScopes = new Map<string, unknown>();

  /** stop(ghostId) 置入:在途重试检测到后立即中止,不继续拉新进程。 */
  private readonly stoppedGhosts = new Set<string>();

  /** 每次 handleExit 递增,settleExit 仅在世代未推进时发布 crashed。 */
  private readonly exitGen = new Map<string, number>();

  /** destroyAll(主机退出)后置真:退避中的重试不得再拉新进程。 */
  private destroyed = false;

  private async ensureWorker(
    ghost: InstalledGhost,
    entryRel: string,
    ownerScopeSnapshot: unknown,
  ): Promise<WorkerEntry> {
    const key = GhostNodeRuntimeBroker.keyOf(ghost.manifest.id, entryRel);
    const inflight = this.startingWorkers.get(key);
    if (inflight) {
      const entry = await inflight;
      this.assertOwnerScopeUsable(ghost.manifest.id, ownerScopeSnapshot);
      this.assertOwnerScopeUsable(ghost.manifest.id, entry.ownerScopeSnapshot);
      return entry;
    }
    const existing = this.workers.get(key);
    if (existing) {
      this.assertOwnerScopeUsable(ghost.manifest.id, ownerScopeSnapshot);
      this.assertOwnerScopeUsable(ghost.manifest.id, existing.ownerScopeSnapshot);
      return existing;
    }
    this.startingWorkerScopes.set(key, ownerScopeSnapshot);
    const starting = this.startWorkerWithRetry(ghost, entryRel, key, ownerScopeSnapshot);
    this.startingWorkers.set(key, starting);
    try {
      return await starting;
    } finally {
      this.startingWorkers.delete(key);
      this.startingWorkerScopes.delete(key);
    }
  }

  private async startWorkerWithRetry(
    ghost: InstalledGhost,
    entryRel: string,
    key: string,
    ownerScopeSnapshot: unknown,
  ): Promise<WorkerEntry> {
    this.assertOwnerScopeUsable(ghost.manifest.id, ownerScopeSnapshot);
    if (this.destroyed || this.stoppedGhosts.has(ghost.manifest.id)) {
      throw new WorkerStartError('Node 工作进程启动已取消', false, true);
    }
    this.sendStatus(ghost, 'starting', undefined, entryRel);
    let current = ghost;
    let lastError = new Error('Node 工作进程启动失败');
    for (let attempt = 1; attempt <= WORKER_START_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await this.delay(WORKER_START_RETRY_DELAYS_MS[attempt - 2] ?? 750);
        this.assertOwnerScopeUsable(ghost.manifest.id, ownerScopeSnapshot);
        // 退避期间插件可能被停用/卸载/更新/停止,主机也可能正在退出:
        // 现查现用;已停用/已收摊/已停止就不再拉进程,也不补发状态事件。
        if (this.destroyed || this.stoppedGhosts.has(ghost.manifest.id)) throw lastError;
        const fresh = this.deps.getGhost(ghost.manifest.id);
        if (!fresh?.enabled) throw lastError;
        // 跨更新边界时重验入口:新 manifest 可能已不再申报该 entry。
        if (!fresh.manifest.node) throw lastError;
        const declaredEntries = [fresh.manifest.node.entry, ...(fresh.manifest.node.entries ?? [])];
        if (!declaredEntries.includes(entryRel)) throw lastError;
        current = fresh;
      }
      const attemptDiagnostic = this.createStartAttemptDiagnostic();
      debugDiagnostic(this.deps.log, 'ghost node startup attempt', {
        ghostId: ghost.manifest.id,
        entry: entryRel,
        attempt,
        appRunId: attemptDiagnostic.appRunId,
        attemptId: attemptDiagnostic.attemptId,
        stage: 'begin',
        observedMainWindowState: attemptDiagnostic.observedMainWindowState,
        observedScreenState: attemptDiagnostic.observedScreenState,
      });
      try {
        const entry = await this.startWorkerOnce(
          current,
          entryRel,
          key,
          ownerScopeSnapshot,
          attemptDiagnostic,
        );
        debugDiagnostic(this.deps.log, 'ghost node startup settlement', {
          ghostId: ghost.manifest.id,
          entry: entryRel,
          attempt,
          ...this.startupSettlementMeta(attemptDiagnostic, 'ready'),
        });
        return entry;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof WorkerStartError ? error.retryable : true;
        const diagnostic = error instanceof WorkerStartError ? error.diagnostic : undefined;
        const cancelled = error instanceof WorkerStartError && error.silent;
        const settlement = {
          ghostId: ghost.manifest.id,
          entry: entryRel,
          attempt,
          ...this.startupSettlementMeta(attemptDiagnostic, cancelled ? 'cancelled' : 'failed'),
          error:
            diagnostic?.error ??
            (attemptDiagnostic.observedTimeoutClass ? 'startup-timeout' : 'worker-start-failed'),
          ...(attemptDiagnostic.observedTimeoutClass
            ? { observedTimeoutClass: attemptDiagnostic.observedTimeoutClass }
            : {}),
        };
        if (cancelled) {
          debugDiagnostic(this.deps.log, 'ghost node startup settlement', settlement);
        } else {
          warnDiagnostic(this.deps.log, 'ghost node start attempt failed', settlement);
        }
        if (!retryable) break;
      }
    }
    if (!(lastError instanceof WorkerStartError) || !lastError.silent) {
      this.sendStatus(current, 'crashed', lastError.message, entryRel);
    }
    throw lastError;
  }

  private async startWorkerOnce(
    ghost: InstalledGhost,
    entryRel: string,
    key: string,
    ownerScopeSnapshot: unknown,
    attemptDiagnostic: StartAttemptDiagnostic,
  ): Promise<WorkerEntry> {
    this.assertOwnerScopeUsable(ghost.manifest.id, ownerScopeSnapshot);
    const node = ghost.manifest.node;
    if (!node) throw new WorkerStartError('ghost.json 缺少 node 工作进程详单', false);
    const entryPath = path.resolve(ghost.dir, ...entryRel.split('/'));
    const root = path.resolve(ghost.dir);
    if (entryPath === root || !entryPath.startsWith(`${root}${path.sep}`)) {
      throw new WorkerStartError('node 入口越出插件安装目录', false);
    }
    const forkStartedAt = this.diagnosticNow();
    let child: NodeWorkerProcess;
    try {
      child = (this.deps.spawnProcess ?? defaultSpawnProcess)(entryPath, root, ghost.manifest.id);
    } catch (error) {
      throw new WorkerStartError(
        error instanceof Error ? error.message : String(error),
        true,
        false,
        false,
        { error: 'utility-process-fork-threw' },
      );
    }
    this.trackLiveProcess(ghost.manifest.id, child);
    const readChildDiagnosticPid = (): number | undefined => readDiagnosticPid(child);
    attemptDiagnostic.pid = readChildDiagnosticPid();
    const entry: WorkerEntry = {
      ghost,
      ownerScopeSnapshot,
      entryRel,
      child,
      startupPhase: true,
      startupStages: attemptDiagnostic.observedStages,
      appRunId: attemptDiagnostic.appRunId,
      attemptId: attemptDiagnostic.attemptId,
      diagnosticPid: attemptDiagnostic.pid,
      startupStderr: '',
      stderrSegments: [],
      stderrTotalChars: 0,
      stderrDecoder: new StringDecoder('utf8'),
      stdoutDecoder: new StringDecoder('utf8'),
      stdoutBuffer: '',
      nextId: 1,
      pending: new Map(),
      children: new Map(),
      idleTimer: null,
      hardKillTimer: null,
      mcpInitPromise: null,
      stopping: false,
      exposedSecretValues: new Set(),
      exitDrain: null,
    };
    const recordStartupObservation = (observation: NodeWorkerStartupObservation): void => {
      if (
        observation.stage !== 'utility-process-spawned' &&
        observation.stage !== 'parent-port-ready'
      ) {
        return;
      }
      if (entry.startupStages.has(observation.stage)) return;
      entry.startupStages.add(observation.stage);
      const observedPid =
        typeof observation.pid === 'number' &&
        Number.isInteger(observation.pid) &&
        observation.pid > 0
          ? observation.pid
          : readChildDiagnosticPid();
      if (observedPid !== undefined) {
        attemptDiagnostic.pid = observedPid;
        entry.diagnosticPid = observedPid;
      }
      const observedAt = this.diagnosticNow();
      debugDiagnostic(this.deps.log, 'ghost node startup stage', {
        ghostId: ghost.manifest.id,
        entry: entryRel,
        appRunId: attemptDiagnostic.appRunId,
        attemptId: attemptDiagnostic.attemptId,
        ...(observedPid !== undefined ? { pid: observedPid } : {}),
        stage: observation.stage,
        // main 从 fork 调用开始到观测该阶段的延迟；不是 worker 源侧阶段耗时。
        ...(forkStartedAt !== undefined && observedAt !== undefined
          ? { elapsedMs: observedAt - forkStartedAt }
          : {}),
      });
    };
    try {
      child.onStartupObservation?.((observation) => {
        if (observation.stage === 'utility-process-spawned') {
          recordStartupObservation(observation);
        }
      });
    } catch {
      // 诊断订阅失败不能改变 ready / retry 语义。
    }
    this.workers.set(key, entry);
    if (this.destroyed || this.stoppedGhosts.has(ghost.manifest.id)) {
      this.workers.delete(key);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      throw new WorkerStartError('Node 工作进程启动已取消', false, true);
    }
    // 代启子进程的控制帧入口(childSpawn):帧形状严格把关,资格在 handle 里查。
    child.onControl?.((message) => this.handleWorkerControl(entry, message));
    child.stdout.on('data', (chunk) => this.handleStdout(entry, chunk));
    child.stderr.on('data', (chunk) => {
      const decoded = entry.stderrDecoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      if (entry.startupPhase && entry.startupStderr.length < STARTUP_STDERR_CAP) {
        entry.startupStderr = (entry.startupStderr + decoded).slice(0, STARTUP_STDERR_CAP);
      }
      // 按段带时间戳截存,退出时只取回看窗口内的段,不让老日志被新 chunk 携带。
      entry.stderrSegments.push({ text: decoded, at: this.now() });
      entry.stderrTotalChars += decoded.length;
      // 总量控制:保留尾部 EXIT_STDERR_CAP 字符——部分裁剪最老段的头部。
      if (entry.stderrTotalChars > EXIT_STDERR_CAP) {
        let excess = entry.stderrTotalChars - EXIT_STDERR_CAP;
        while (excess > 0 && entry.stderrSegments.length > 0) {
          const oldest = entry.stderrSegments[0];
          if (excess >= oldest.text.length) {
            entry.stderrSegments.shift();
            excess -= oldest.text.length;
          } else {
            oldest.text = oldest.text.slice(excess);
            excess = 0;
          }
        }
        entry.stderrTotalChars = EXIT_STDERR_CAP;
      }
      const text = decoded.trim().slice(0, 4_096);
      if (text) this.deps.log?.warn('ghost node stderr', { ghostId: ghost.manifest.id, text });
      // 进程已退出后不再续命——定时器已冻结,由 settleExit 统一结算。
      if (
        !entry.exitDrain
        && this.ownerScopeUsable(entry.ghost.manifest.id, entry.ownerScopeSnapshot)
      ) {
        // stderr 是手册钦定的日志口——构建刷日志就是活着的证据,给续命请求重置沉默窗口。
        this.renewPendingOnActivity(entry);
      }
    });
    child.on('exit', (code, signal) => this.handleExit(entry, code, signal, null));
    child.on('error', (error) => this.handleExit(entry, null, null, error));

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let startTimer: NodeJS.Timeout | null = null;
        const settle = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          if (startTimer) this.clearTimer(startTimer);
          outcome();
        };
        startTimer = this.setTimer(
          () =>
            settle(() => {
              const observedTimeoutClass: NodeWorkerObservedTimeoutClass = entry.startupStages.has(
                'utility-process-spawned',
              )
                ? 'native-observed-ready-not-observed'
                : 'native-not-observed';
              attemptDiagnostic.observedTimeoutClass = observedTimeoutClass;
              attemptDiagnostic.observedStagesAtDeadline = STARTUP_STAGE_ORDER.filter((stage) =>
                entry.startupStages.has(stage),
              );
              reject(new WorkerStartError('Node 工作进程启动超时', false));
            }),
          DEFAULT_START_TIMEOUT_MS,
        );
        startTimer.unref?.();
        child.once('spawn', () => {
          // HEAD 的 ready 结算必须先完成；PID/getter/clock/logger 都只能在其后旁路。
          settle(resolve);
          const pid = readChildDiagnosticPid();
          recordStartupObservation({
            stage: 'parent-port-ready',
            ...(pid !== undefined ? { pid } : {}),
          });
        });
        child.once('error', (error) =>
          settle(() =>
            reject(
              new WorkerStartError(error.message, true, false, false, {
                error: 'utility-process-error',
              }),
            ),
          ),
        );
        child.once('exit', (code, signal) => {
          // stderr 管道字节可能晚于 exit 事件到达:给在途 chunk 一个极短的
          // 落地窗口,诊断行(如杀软拦截的 EPERM)才截得到。
          const drainTimer = this.setTimer(() => {
            settle(() => {
              if (entry.stopping) {
                reject(new WorkerStartError('Node 工作进程启动已取消', false, true));
              } else {
                const hint = stderrHint(entry.startupStderr);
                reject(
                  new WorkerStartError(
                    `Node 工作进程启动前退出(code=${code}, signal=${signal ?? 'none'})${hint ? `:${hint}` : ''}`,
                    true,
                    false,
                    false,
                    { error: 'utility-process-exited-before-ready' },
                  ),
                );
              }
            });
          }, 10);
          drainTimer.unref?.();
        });
      });
    } catch (error) {
      if (this.workers.get(key) === entry) this.workers.delete(key);
      try {
        child.kill('SIGKILL');
      } catch {
        // no-op
      }
      const failedPid = readChildDiagnosticPid();
      if (failedPid !== undefined) attemptDiagnostic.pid = failedPid;
      throw error;
    }
    entry.startupPhase = false;
    this.assertOwnerScopeUsable(ghost.manifest.id, ownerScopeSnapshot);
    this.sendStatus(ghost, 'running', undefined, entryRel);
    this.scheduleIdleStop(entry);
    return entry;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.setTimer(resolve, ms);
      timer.unref?.();
    });
  }

  private async ensureMcpInitialized(entry: WorkerEntry): Promise<void> {
    if (!entry.mcpInitPromise) {
      entry.mcpInitPromise = this.sendRpc(
        entry,
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Cindy', version: '1' },
        },
        10_000,
      ).then(() => {
        this.assertOwnerScopeUsable(entry.ghost.manifest.id, entry.ownerScopeSnapshot);
        this.writeLine(entry, {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        });
      });
      entry.mcpInitPromise.catch(() => {
        entry.mcpInitPromise = null;
      });
    }
    await entry.mcpInitPromise;
  }

  private sendRpc(
    entry: WorkerEntry,
    method: string,
    params: unknown,
    timeoutMs: number,
    maxTotalMs?: number,
    hostSecrets?: Readonly<Record<string, string>>,
    ownerScopeSnapshot: unknown = entry.ownerScopeSnapshot,
  ): Promise<unknown> {
    this.assertOwnerScopeUsable(entry.ghost.manifest.id, ownerScopeSnapshot);
    this.clearIdleTimer(entry);
    const id = String(entry.nextId++);
    return new Promise((resolve, reject) => {
      const pending: PendingRpc = {
        resolve,
        reject,
        // 先占位,armPendingTimer 里立即赋真值(expire 闭包要先于 timer 存在)。
        timer: null as unknown as NodeJS.Timeout,
        timeoutMs,
        deadlineAt: maxTotalMs !== undefined ? this.now() + maxTotalMs : null,
        expire: () => {
          entry.pending.delete(id);
          reject(new NodeRpcError('timeout', `Node 请求 ${method} 等待超时`));
          this.scheduleIdleStop(entry);
        },
        ownerScopeSnapshot,
      };
      entry.pending.set(id, pending);
      this.armPendingTimer(pending);
      try {
        this.writeLine(entry, {
          jsonrpc: '2.0',
          id,
          method,
          params,
          ...(hostSecrets && Object.keys(hostSecrets).length > 0
            ? { cindy: { secrets: hostSecrets } }
            : {}),
        });
      } catch (error) {
        entry.pending.delete(id);
        this.clearTimer(pending.timer);
        reject(error);
      }
    });
  }

  /** 初臂/续命共用:按沉默窗口与绝对截止的较小者上闹钟。 */
  private armPendingTimer(pending: PendingRpc): void {
    const delay =
      pending.deadlineAt === null
        ? pending.timeoutMs
        : Math.min(pending.timeoutMs, Math.max(0, pending.deadlineAt - this.now()));
    pending.timer = this.setTimer(pending.expire, delay);
    pending.timer.unref?.();
  }

  /**
   * 续命(2026-07-23,长构建):worker 有任何动静(stdout 协议消息 / stderr
   * 日志)时,给声明了 maxTotalMs 的在途请求重置沉默窗口。手册要求日志走
   * stderr,所以只盯 stdout 会漏掉"边干活边打日志"的正常构建。未声明
   * maxTotalMs 的请求不碰——旧语义(总时长 = timeoutMs)零变化。
   */
  private renewPendingOnActivity(entry: WorkerEntry): void {
    if (entry.pending.size === 0) return;
    const now = this.now();
    for (const pending of entry.pending.values()) {
      if (pending.deadlineAt === null) continue;
      this.clearTimer(pending.timer);
      if (now >= pending.deadlineAt) {
        pending.expire();
        continue;
      }
      this.armPendingTimer(pending);
    }
  }

  private writeLine(entry: WorkerEntry, message: Record<string, unknown>): void {
    if (entry.child.stdin.destroyed) throw new NodeRpcError('exit', 'Node stdin 已关闭');
    entry.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(entry: WorkerEntry, chunk: Buffer | string): void {
    const key = GhostNodeRuntimeBroker.keyOf(entry.ghost.manifest.id, entry.entryRel);
    if (this.workers.get(key) !== entry) return;
    if (!this.ownerScopeUsable(entry.ghost.manifest.id, entry.ownerScopeSnapshot)) return;
    entry.stdoutBuffer += entry.stdoutDecoder.write(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
    );
    for (;;) {
      const newline = entry.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = entry.stdoutBuffer.slice(0, newline).trim();
      entry.stdoutBuffer = entry.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.failProtocol(entry, 'Node stdout 不是合法的逐行 JSON-RPC');
        return;
      }
      // stdout 每条合法协议消息(进度 notification / 别单的 response)都算动静。
      this.renewPendingOnActivity(entry);
      this.handleRpcMessage(entry, message);
      if (this.workers.get(key) !== entry) return;
    }
    // 只限制“还没遇到换行的一条消息”，同一 chunk 里很多合法短消息不会误伤。
    if (Buffer.byteLength(entry.stdoutBuffer, 'utf8') > MAX_STDIO_LINE_BYTES) {
      this.failProtocol(entry, 'Node stdout 单行超过 1MB');
    }
  }

  private handleRpcMessage(entry: WorkerEntry, message: unknown): void {
    if (!this.ownerScopeUsable(entry.ghost.manifest.id, entry.ownerScopeSnapshot)) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.failProtocol(entry, 'Node 返回的 JSON-RPC 消息必须是对象');
      return;
    }
    const msg = message as Record<string, unknown>;
    if (msg.jsonrpc !== '2.0') {
      this.failProtocol(entry, 'Node 返回的消息缺少 jsonrpc: "2.0"');
      return;
    }
    if (msg.id !== undefined && typeof msg.method !== 'string') {
      const pending = entry.pending.get(String(msg.id));
      if (!pending) return; // 迟到或未知 response，静默丢弃。
      entry.pending.delete(String(msg.id));
      this.clearTimer(pending.timer);
      if (!this.ownerScopeUsable(entry.ghost.manifest.id, pending.ownerScopeSnapshot)) {
        pending.reject(new NodeRpcError('exit', 'Plugin owner boundary changed before response'));
        return;
      }
      if (msg.error && typeof msg.error === 'object') {
        const rpcError = msg.error as Record<string, unknown>;
        pending.reject(
          new NodeRpcError(
            'remote',
            typeof rpcError.message === 'string' ? rpcError.message : 'Node JSON-RPC 返回错误',
            rpcError.data,
          ),
        );
      } else if ('result' in msg) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new NodeRpcError('protocol', 'Node response 同时缺少 result 与 error'));
      }
      this.scheduleIdleStop(entry);
      return;
    }
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      // MCP server→client 反向请求不接 Cindy 能力，明确回“不支持”。这条是
      // Node 不能直接控制 Cindy 的代码边界，不靠作者自觉。
      this.writeLine(entry, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Cindy host does not expose reverse RPC methods' },
      });
      return;
    }
    if (typeof msg.method === 'string') {
      this.deps.sendToGhost?.(entry.ghost.manifest.id, {
        type: 'event',
        name: 'node-notification',
        method: msg.method,
        ...('params' in msg ? { params: msg.params } : {}),
        ts: this.now(),
      });
      return;
    }
    this.failProtocol(entry, '无法识别 Node JSON-RPC 消息');
  }

  private failProtocol(entry: WorkerEntry, message: string): void {
    for (const pending of entry.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new NodeRpcError('protocol', message));
    }
    entry.pending.clear();
    this.deps.log?.warn('ghost node protocol failed', {
      ghostId: entry.ghost.manifest.id,
      message,
    });
    try {
      entry.child.kill('SIGKILL');
    } catch {
      // exit handler still converges state when available
    }
  }

  private captureOwnerScope(): unknown {
    return this.deps.ownerScope?.capture();
  }

  private ownerScopeUsable(ghostId: string, captured: unknown): boolean {
    if (isGhostOwnerScopeUsable(this.deps.ownerScope, captured)) return true;
    let hasCurrentWorker = false;
    // Tear down every stale worker for this ghost, but preserve a worker that
    // already belongs to the new owner. The runtime-level invalidation callback
    // is only safe when no fresh generation exists for the same ghost.
    for (const [key, entry] of [...this.workers]) {
      if (entry.ghost.manifest.id !== ghostId) continue;
      if (isGhostOwnerScopeUsable(this.deps.ownerScope, entry.ownerScopeSnapshot)) {
        hasCurrentWorker = true;
        continue;
      }
      this.stopWorker(key, entry);
    }
    if (!hasCurrentWorker) {
      for (const [key, scope] of this.startingWorkerScopes) {
        if (key.startsWith(`${ghostId}::`) && isGhostOwnerScopeUsable(this.deps.ownerScope, scope)) {
          hasCurrentWorker = true;
          break;
        }
      }
    }
    if (!hasCurrentWorker) this.deps.ownerScope?.onInvalidated?.(ghostId);
    return false;
  }

  private assertOwnerScopeUsable(ghostId: string, captured: unknown): void {
    if (this.ownerScopeUsable(ghostId, captured)) return;
    throw new WorkerStartError(
      'Plugin owner boundary changed before Node dispatch',
      false,
      true,
      true,
    );
  }

  private handleExit(
    entry: WorkerEntry,
    code: number | null,
    signal: string | null,
    error: Error | null,
  ): void {
    const ghostId = entry.ghost.manifest.id;
    const key = GhostNodeRuntimeBroker.keyOf(ghostId, entry.entryRel);
    if (this.workers.get(key) !== entry) {
      // stopWorker 已先移除 map。只有真实 exit 才能取消强杀；error 仍可能
      // 对应一个活着并占用插件目录的 utilityProcess。
      if (!error && entry.hardKillTimer) {
        this.clearTimer(entry.hardKillTimer);
        entry.hardKillTimer = null;
      }
      // stopWorker 或先到的 error 已完成业务收口；真实 exit 日志只能在其后。
      // error 路径没有 stopping baseline，但仍须记录随后到达的真实进程退出。
      if (!error) this.debugProcessExit(entry, code, signal, Date.now());
      return;
    }
    if (error && !entry.stopping && !entry.hardKillTimer) {
      // error 只说明 utilityProcess 通道失效。业务状态可以立即收口，但 OS
      // 进程仍须主动终止，并由 liveProcesses 保留到真实 exit。
      try {
        entry.child.kill('SIGTERM');
        entry.hardKillTimer = this.setTimer(() => {
          entry.hardKillTimer = null;
          try {
            entry.child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }, PROCESS_STOP_GRACE_MS);
        entry.hardKillTimer.unref?.();
      } catch {
        // stopAndWait 仍会以真实 exit 或有界超时收口。
      }
    }
    if (!error && entry.hardKillTimer) {
      this.clearTimer(entry.hardKillTimer);
      entry.hardKillTimer = null;
    }
    this.workers.delete(key);
    this.clearIdleTimer(entry);
    // worker 意外死亡:孩子级联收掉,不留孤儿(silent——收件人已经不在了)。
    for (const child of [...entry.children.values()]) this.stopChild(entry, child, true);
    // 立即冻结所有 pending 请求的超时定时器,防止在 drain 窗口内误报 TIMEOUT。
    for (const pending of entry.pending.values()) this.clearTimer(pending.timer);
    // stderr stream 'end' 是权威排空信号——所有管道字节已到达。
    // 定时器仅作为"end 永远不来"的兜底安全网(500ms),不做 debounce。
    const gen = (this.exitGen.get(key) ?? 0) + 1;
    this.exitGen.set(key, gen);
    const settle = () => this.settleExit(entry, code, signal, error);
    const timer = this.setTimer(settle, 500);
    timer.unref?.();
    entry.exitDrain = {
      code,
      signal,
      error,
      timer,
      exitedAt: this.now(),
      exitObservedAt: Date.now(),
      gen,
    };
    entry.child.stderr.once?.('end', settle);
  }

  private settleExit(
    entry: WorkerEntry,
    code: number | null,
    signal: string | null,
    error: Error | null,
  ): void {
    if (!entry.exitDrain) return;
    const { exitedAt, exitObservedAt, gen } = entry.exitDrain;
    this.clearTimer(entry.exitDrain.timer);
    entry.exitDrain = null;
    // flush stderrDecoder 残留字节(多字节字符被切在最后一个 chunk 边界时)
    const tail = entry.stderrDecoder.end();
    if (tail) {
      entry.stderrSegments.push({ text: tail, at: this.now() });
      entry.stderrTotalChars += tail.length;
    }
    const ghostId = entry.ghost.manifest.id;
    const exitHint = this.exitStderrHint(entry, exitedAt);
    const detail = `${error?.message ?? `code=${code}, signal=${signal ?? 'none'}`}${
      exitHint ? `:${exitHint}` : ''
    }`;
    for (const pending of entry.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new NodeRpcError('exit', `Node 工作进程已退出(${detail})`));
    }
    entry.pending.clear();
    entry.exposedSecretValues.clear();
    // 启动期退出不在这里报 crashed:ensureWorker 统一收口(可能还要重试,
    // 重试成功时插件不该看到一次假 crash)。
    if (!entry.stopping && !entry.startupPhase) {
      this.deps.log?.warn('ghost node process exited', { ghostId, entry: entry.entryRel, detail });
      // 抑制 crashed 广播:替代 worker 已启动(key 被占);drain 期间插件被
      // 主动停止/禁用;或同 key 有更新世代退出(本次已过时)。
      const key = GhostNodeRuntimeBroker.keyOf(ghostId, entry.entryRel);
      const isLatest = this.exitGen.get(key) === gen;
      if (!this.workers.has(key) && !this.stoppedGhosts.has(ghostId) && isLatest) {
        this.sendStatus(entry.ghost, 'crashed', detail, entry.entryRel);
      }
    }
    // pending reject、状态广播与所有 HEAD exit 收口完成后才允许诊断 logger 运行。
    if (!error) this.debugProcessExit(entry, code, signal, exitObservedAt);
  }

  private debugProcessExit(
    entry: WorkerEntry,
    code: number | null,
    signal: string | null,
    exitObservedAt: number,
  ): void {
    const pid = entry.diagnosticPid;
    debugDiagnostic(this.deps.log, 'ghost node process lifecycle', {
      ghostId: entry.ghost.manifest.id,
      entry: entry.entryRel,
      appRunId: entry.appRunId,
      attemptId: entry.attemptId,
      ...(pid !== undefined ? { pid } : {}),
      stage: 'exit',
      code,
      signal,
      // 基线在 signal/grace/status 完成后建立；elapsed 不包含诊断 logger 自身耗时。
      ...(entry.stoppingStartedAt !== undefined
        ? { stoppingElapsedMs: exitObservedAt - entry.stoppingStartedAt }
        : {}),
    });
  }

  /**
   * 意外死亡时的 stderr 诊断行:补上 startupStderr 那条路截不到的"就绪之后才崩"
   * (插件模块加载期抛错最典型)。绝对路径已由 stderrHint 收敛为文件名。
   * 主动 stop 不参与——那是预期内的收摊,拼诊断只会把无关日志说成死因;陈旧
   * 段同理,只认回看窗口内的段。
   */
  private exitStderrHint(entry: WorkerEntry, exitedAt: number): string | null {
    if (entry.stopping) return null;
    // 以退出时刻为锚点(而非结算时刻),避免兜底定时器延迟导致回看窗口偏移。
    // drain 期间到达的 chunk 时间戳 >= exitedAt,自然在窗口内。
    const recent = entry.stderrSegments
      .filter((seg) => exitedAt - seg.at <= EXIT_STDERR_LOOKBACK_MS)
      .map((seg) => seg.text)
      .join('');
    if (!recent) return null;
    return stderrHint(this.redactSecrets(entry, recent), true);
  }

  private redactSecrets(entry: WorkerEntry, text: string): string {
    if (!entry.exposedSecretValues.size) return text;
    const sorted = [...entry.exposedSecretValues].sort((a, b) => b.length - a.length);
    for (const secret of sorted) {
      if (text.includes(secret)) text = text.replaceAll(secret, '[REDACTED]');
    }
    return text;
  }

  private scheduleIdleStop(entry: WorkerEntry): void {
    const key = GhostNodeRuntimeBroker.keyOf(entry.ghost.manifest.id, entry.entryRel);
    if (this.workers.get(key) !== entry) return;
    if (entry.ghost.manifest.node?.lifecycle === 'resident' || entry.pending.size > 0) return;
    // 有代启子进程在世时不空闲回收——收 worker 会级联杀掉正在干活的代理。
    if (entry.children.size > 0) return;
    this.clearIdleTimer(entry);
    const timeoutMs =
      (entry.ghost.manifest.node?.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_MS / 1_000) * 1_000;
    // 空闲只收本入口的进程,不牵连同插件其它入口。
    entry.idleTimer = this.setTimer(() => {
      if (this.workers.get(key) === entry) {
        const pid = entry.diagnosticPid;
        // 先执行 HEAD 的 stopWorker；idle reason 日志不能推迟 SIGTERM/grace timer。
        this.stopWorker(key, entry);
        debugDiagnostic(this.deps.log, 'ghost node process lifecycle', {
          ghostId: entry.ghost.manifest.id,
          entry: entry.entryRel,
          appRunId: entry.appRunId,
          attemptId: entry.attemptId,
          ...(pid !== undefined ? { pid } : {}),
          stage: 'idle-stop',
        });
      }
    }, timeoutMs);
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: WorkerEntry): void {
    if (!entry.idleTimer) return;
    this.clearTimer(entry.idleTimer);
    entry.idleTimer = null;
  }

  private sendStatus(
    ghost: InstalledGhost,
    state: 'starting' | 'running' | 'stopped' | 'crashed',
    message?: string,
    entryRel?: string,
  ): void {
    // entry 字段只在非主入口时携带("缺省 = 主入口"的协议语义;老包零变化)。
    const isExtraEntry = entryRel !== undefined && entryRel !== ghost.manifest.node?.entry;
    this.deps.sendToGhost?.(ghost.manifest.id, {
      type: 'event',
      name: 'node-status',
      state,
      ...(message ? { message } : {}),
      ...(isExtraEntry ? { entry: entryRel } : {}),
      ts: this.now(),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private diagnosticNow(): number | undefined {
    try {
      return this.deps.diagnosticNow?.() ?? Date.now();
    } catch {
      return undefined;
    }
  }

  private setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
    if (this.deps.setTimer) return this.deps.setTimer(callback, delayMs);
    return setTimeout(callback, delayMs) as NodeJS.Timeout;
  }

  private clearTimer(timer: NodeJS.Timeout): void {
    if (this.deps.clearTimer) this.deps.clearTimer(timer);
    else clearTimeout(timer);
  }
}
