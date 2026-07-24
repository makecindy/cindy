/**
 * nodeRuntimeBroker — 随意识安装的本地 Node 工作进程守门与 stdio 中继。
 *
 * 安全边界：
 * - 只执行已安装目录内、ghost.json 明确声明的单个 JS 入口；无 command / args / shell；
 * - 子进程拥有当前系统用户级本机权限，绝不把它描述成系统沙箱；
 * - 子进程只有 JSON-RPC stdio，不能直接拿到 Cindy IPC。所有 Cindy 能力仍须
 *   Node → main.js → contextBridge → 主机，并再次经过对应 slot 守门；
 * - 一段启用的意识最多一个 Node 进程，多会话复用；按需启动、闲置关闭，
 *   停用/更新/卸载/主机退出时由上层 stop；
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

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_PENDING_REQUESTS = 32;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_STDIO_LINE_BYTES = 1024 * 1024;
const MCP_PROTOCOL_VERSION = '2025-06-18';

interface NodeWorkerReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
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
  /** 订阅 worker 引导层就绪后经 parentPort 上行的控制帧(代启子进程用;可选)。 */
  onControl?(listener: (message: unknown) => void): void;
  /** 给 worker 引导层下行一条控制帧(代启结果/子进程输出等;可选)。 */
  sendControl?(message: unknown): boolean;
}

export interface GhostNodeRuntimeBrokerDeps {
  getGhost(id: string): InstalledGhost | null;
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
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
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
}

/** 宿主代启的原样 stdio 子进程(childSpawn;挂在某个 worker 名下)。 */
interface ChildProcEntry {
  childId: string;
  entryRel: string;
  proc: NodeWorkerProcess;
  hardKillTimer: NodeJS.Timeout | null;
  stopping: boolean;
}

interface WorkerEntry {
  ghost: InstalledGhost;
  /** 本进程对应的入口(相对路径;主入口 = manifest.node.entry)。 */
  entryRel: string;
  child: NodeWorkerProcess;
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
  let destroyed = false;
  let killed = false;
  let ready = false;
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

  constructor(private readonly deps: GhostNodeRuntimeBrokerDeps) {}

  private static keyOf(ghostId: string, entryRel: string): string {
    return `${ghostId}::${entryRel}`;
  }

  stateOf(ghostId: string): 'off' | 'running' {
    for (const entry of this.workers.values()) {
      if (entry.ghost.manifest.id === ghostId) return 'running';
    }
    return 'off';
  }

  /** resident 档在插件启用/启动时调用；按需档保持零进程。常驻只覆盖主入口。 */
  async startResident(ghost: InstalledGhost): Promise<void> {
    if (!ghost.enabled || ghost.manifest.node?.lifecycle !== 'resident') return;
    const entry = await this.ensureWorker(ghost, ghost.manifest.node.entry);
    if (ghost.manifest.node.protocol === 'mcp-stdio') await this.ensureMcpInitialized(entry);
  }

  /** main.js 的 node-request 入口。 */
  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeNodeResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('node') || !ghost.manifest.node) {
      return errorResult('PERMISSION_DENIED', '插件未申请本地 Node 权限，或当前未启用');
    }
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

    let hostSecrets: Record<string, string> | undefined;
    if (secretBindings.length > 0) {
      hostSecrets = Object.create(null) as Record<string, string>;
      try {
        for (const binding of secretBindings) {
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
      } catch {
        clearHostSecrets(hostSecrets);
        return errorResult('INTERNAL', '读取 Node 请求所需凭证失败');
      }
    }

    let entry: WorkerEntry;
    try {
      entry = await this.ensureWorker(ghost, entryRel);
    } catch (error) {
      clearHostSecrets(hostSecrets);
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
        if (entry.pending.size >= MAX_PENDING_REQUESTS) {
          return errorResult('RATE_LIMITED', '这个插件同时等待的 Node 请求太多');
        }
      }
      const pendingResult = this.sendRpc(
        entry,
        request.method,
        request.params ?? null,
        effectiveTimeoutMs,
        request.maxTotalMs as number | undefined,
        hostSecrets,
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
      try {
        proc.kill('SIGKILL');
      } catch {
        // no-op
      }
      fail(error instanceof Error ? error.message : '子进程启动失败');
      return;
    }

    // worker 在等待答复期间死了/被停:孩子不能变孤儿,就地收掉。
    if (this.workers.get(GhostNodeRuntimeBroker.keyOf(ghostId, entry.entryRel)) !== entry) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // no-op
      }
      return;
    }

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
    proc.on('error', () => this.handleChildExit(entry, child, null));
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
    if (silent) {
      entry.children.delete(child.childId);
      child.stopping = true;
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
      }, 2_000);
      child.hardKillTimer.unref?.();
    } catch {
      // 已退出即视为停止成功。
    }
  }

  /** 停用、更新或卸载一个插件时立即停止其名下**全部** Node 进程。 */
  stop(ghostId: string): void {
    for (const [key, entry] of [...this.workers]) {
      if (entry.ghost.manifest.id === ghostId) this.stopWorker(key, entry);
    }
  }

  private stopWorker(key: string, entry: WorkerEntry): void {
    entry.stopping = true;
    this.workers.delete(key);
    this.clearIdleTimer(entry);
    // 级联:先收孩子再收本体,不留孤儿进程。
    for (const child of [...entry.children.values()]) this.stopChild(entry, child, true);
    for (const pending of entry.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new NodeRpcError('exit', 'Node 工作进程已停止'));
    }
    entry.pending.clear();
    try {
      entry.child.kill('SIGTERM');
      entry.hardKillTimer = this.setTimer(() => {
        entry.hardKillTimer = null;
        try {
          entry.child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 2_000);
      entry.hardKillTimer.unref?.();
    } catch {
      // 已退出即视为停止成功。
    }
    this.sendStatus(entry.ghost, 'stopped', undefined, entry.entryRel);
  }

  /** Cindy 退出时收掉全部随包 Node 进程。 */
  destroyAll(): void {
    for (const [key, entry] of [...this.workers]) this.stopWorker(key, entry);
  }

  private async ensureWorker(ghost: InstalledGhost, entryRel: string): Promise<WorkerEntry> {
    const key = GhostNodeRuntimeBroker.keyOf(ghost.manifest.id, entryRel);
    const existing = this.workers.get(key);
    if (existing) return existing;
    const node = ghost.manifest.node;
    if (!node) throw new Error('ghost.json 缺少 node 工作进程详单');

    const entryPath = path.resolve(ghost.dir, ...entryRel.split('/'));
    const root = path.resolve(ghost.dir);
    if (entryPath === root || !entryPath.startsWith(`${root}${path.sep}`)) {
      throw new Error('node 入口越出插件安装目录');
    }
    this.sendStatus(ghost, 'starting', undefined, entryRel);
    let child: NodeWorkerProcess;
    try {
      child = (this.deps.spawnProcess ?? defaultSpawnProcess)(entryPath, root, ghost.manifest.id);
    } catch (error) {
      this.sendStatus(ghost, 'crashed', error instanceof Error ? error.message : String(error), entryRel);
      throw error;
    }
    const entry: WorkerEntry = {
      ghost,
      entryRel,
      child,
      stdoutDecoder: new StringDecoder('utf8'),
      stdoutBuffer: '',
      nextId: 1,
      pending: new Map(),
      children: new Map(),
      idleTimer: null,
      hardKillTimer: null,
      mcpInitPromise: null,
      stopping: false,
    };
    this.workers.set(key, entry);
    // 代启子进程的控制帧入口(childSpawn):帧形状严格把关,资格在 handle 里查。
    child.onControl?.((message) => this.handleWorkerControl(entry, message));
    child.stdout.on('data', (chunk) => this.handleStdout(entry, chunk));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim().slice(0, 4_096);
      if (text) this.deps.log?.warn('ghost node stderr', { ghostId: ghost.manifest.id, text });
      // stderr 是手册钦定的日志口——构建刷日志就是活着的证据,给续命请求重置沉默窗口。
      this.renewPendingOnActivity(entry);
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
          () => settle(() => reject(new Error('Node 工作进程启动超时'))),
          DEFAULT_START_TIMEOUT_MS,
        );
        startTimer.unref?.();
        child.once('spawn', () => settle(resolve));
        child.once('error', (error) => settle(() => reject(error)));
        child.once('exit', (code, signal) => {
          settle(() =>
            reject(new Error(`Node 工作进程启动前退出(code=${code}, signal=${signal ?? 'none'})`)),
          );
        });
      });
    } catch (error) {
      if (this.workers.get(key) === entry) this.workers.delete(key);
      try {
        child.kill('SIGKILL');
      } catch {
        // no-op
      }
      throw error;
    }
    this.deps.log?.info('ghost node process started', {
      ghostId: ghost.manifest.id,
      entry: entryRel,
      pid: child.pid,
      protocol: node.protocol,
    });
    this.sendStatus(ghost, 'running', undefined, entryRel);
    this.scheduleIdleStop(entry);
    return entry;
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
  ): Promise<unknown> {
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

  private handleExit(
    entry: WorkerEntry,
    code: number | null,
    signal: string | null,
    error: Error | null,
  ): void {
    const ghostId = entry.ghost.manifest.id;
    const key = GhostNodeRuntimeBroker.keyOf(ghostId, entry.entryRel);
    if (entry.hardKillTimer) {
      this.clearTimer(entry.hardKillTimer);
      entry.hardKillTimer = null;
    }
    if (this.workers.get(key) !== entry) return;
    this.workers.delete(key);
    this.clearIdleTimer(entry);
    // worker 意外死亡:孩子级联收掉,不留孤儿(silent——收件人已经不在了)。
    for (const child of [...entry.children.values()]) this.stopChild(entry, child, true);
    const detail = error?.message ?? `code=${code}, signal=${signal ?? 'none'}`;
    for (const pending of entry.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new NodeRpcError('exit', `Node 工作进程已退出(${detail})`));
    }
    entry.pending.clear();
    if (!entry.stopping) {
      this.deps.log?.warn('ghost node process exited', { ghostId, entry: entry.entryRel, detail });
      this.sendStatus(entry.ghost, 'crashed', detail, entry.entryRel);
    }
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
      if (this.workers.get(key) === entry) this.stopWorker(key, entry);
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

  private setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
    if (this.deps.setTimer) return this.deps.setTimer(callback, delayMs);
    return setTimeout(callback, delayMs) as NodeJS.Timeout;
  }

  private clearTimer(timer: NodeJS.Timeout): void {
    if (this.deps.clearTimer) this.deps.clearTimer(timer);
    else clearTimeout(timer);
  }
}
