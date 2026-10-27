/**
 * Codex exec-server 中继(控制端)。
 *
 * 对方电脑上的 Codex 把本机当成一个远程执行环境(Codex 原生的 environment/exec-server 机制)：
 * 它连到对方本机隧道的 WebSocket，帧经设备互联到达这里，本机为每条连接起一个
 * `codex exec-server --listen stdio://`，命令、读写文件、补丁都在本机执行。
 *
 * 每个请求转给 exec-server 之前先过本机权限上限(与 Claude Code / Pi 同一个闸门)：
 * 凭证类路径与高危命令只认本机用户批准过的同一操作；不通过就直接回 JSON-RPC 错误。供应商分享的
 * 受邀者任务里，凭证类操作没有批准时先在本机弹确认卡，等待期间这条连接后面的消息排在它后面。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS,
  REMOTE_AGENT_MAX_PUSH_CHARS,
  REMOTE_AGENT_MAX_PUSH_FRAMES,
  type RemoteAgentPushFrame,
  type RemoteAgentStreamItem,
} from '@cindy/device-link';

import { readExistingTextSync } from '../executor/files';
import type { ExecutorAction, ExecutorGateDecision } from '../executor/gate';
import { resolveExecutorShell } from '../executor/shell';
import type { ExecutorAgentProjection, ExecutorWorkspace } from '../executor/workspace';

export const EXEC_SERVER_WS_PATH = '/ws/exec-server';
/** exec-server 单行(一条 JSON-RPC 消息)上限：大文件读写的 base64 也在这里面。 */
const MAX_LINE_CHARS = 48 * 1024 * 1024;
/** 单帧数据上限，留出 JSON 包装余量。 */
const FRAME_CHARS = REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS - 1024;
/** 一次回推超过这么久算慢链路(每个 Codex 文件请求都要等一次回推)。 */
const SLOW_PUSH_MS = 2_000;
/**
 * 本机 exec-server 从启动到第一次输出(initialize 的回包)超过这么久就记一条：对方的 Codex 握手只等 10 秒，
 * 这段时间要与链路往返一起算进去。
 */
const SLOW_FIRST_REPLY_MS = 2_000;

export interface ExecServerRelayDeps {
  codexPath: string;
  cwd: string;
  workspace: ExecutorWorkspace;
  authorize(action: ExecutorAction): ExecutorGateDecision;
  /** 凭证类操作在本机补问(供应商分享的受邀者任务)；允许后再 authorize 一次即放行。 */
  confirm?(action: ExecutorAction): Promise<boolean>;
  push(frames: RemoteAgentPushFrame[]): Promise<void>;
  env?: NodeJS.ProcessEnv;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
  now?: () => number;
  /**
   * 由忙转闲：各连接上的工作(在跑的进程含后台终端、启动中的请求、待确认的消息)由有变无，包括进程结束、
   * 启动失败、确认处理完、带着工作的连接被整条关掉。对连接池来说这是一次活动。
   */
  onProcessesEnded?(): void;
}

/**
 * 中继的往来统计(只含计数与耗时)。任务结束时有慢回推或闸门拒绝就记一条日志：前者说明链路慢
 * (托管 Codex 启动要等几十次回推，#5764)，后者说明 Agent 有文件或命令没拿到(如任务在子目录时
 * 上级目录的 Skill 遍历)。
 */
export interface ExecServerRelayStats {
  requests: number;
  rejected: number;
  pushes: number;
  pushMaxMs: number;
  pushAvgMs: number;
  slowPushes: number;
}

interface Connection {
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  closed: boolean;
  /** 有消息在等本机确认时，后面的消息按顺序排在它后面。 */
  queue?: Promise<void>;
  /** 异步准备输出路径时保持连接内顺序；不占用入站确认队列。 */
  output?: Promise<void>;
  /**
   * 还在运行的进程(`process/start` 起的，收到 `process/closed` / `process/exited` 或启动失败前都算)。
   * Codex 的后台终端就是这些：编号在对方的 Codex 里，进程在这里，连接一断就没了。
   */
  processes: Set<string>;
  /** 启动请求 id → 进程编号(启动失败时据此移除)。 */
  starting: Map<string, string>;
}

/** `["/bin/zsh","-lc","cmd"]` → `cmd`；其它形态按空格拼接。 */
export function execServerCommand(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === 'string')) return null;
  const parts = argv as string[];
  if (parts.length >= 3 && /^-l?c$/.test(parts[parts.length - 2]) && /(^|\/)(ba|z|da|k)?sh$/.test(parts[0])) {
    return parts[parts.length - 1];
  }
  return parts.join(' ');
}

function fromFileUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

// exec-server 的只读操作按读取过闸门；不在下面几组里的 `fs/` 方法一律按写入处理(新版 Codex 新增的
// 方法先从严)。`fs/walk`、`fs/canonicalize`、`fs/open` 曾落进写入：计划模式下工作区里的项目 Skill
// 加载被拒，工作区外的单文件读取也被当成区外写入拒掉(#5764)。

/** 读单个文件或单层目录；fs/open 的显式写入模式在下方按写入处理。 */
const READ_METHODS = new Set(['fs/readFile', 'fs/open', 'fs/readDirectory', 'fs/readDir', 'fs/listDirectory']);
/** 递归遍历：按目录级读取过闸门，根在工作区外与本机任务的搜索一样要本机确认。 */
const TREE_READ_METHODS = new Set(['fs/walk']);
/** 只看元数据、不读内容的操作不过闸门(`fs/canonicalize` 只解析真实路径)。 */
const METADATA_METHODS = new Set(['fs/getMetadata', 'fs/exists', 'fs/stat', 'fs/canonicalize']);

/** 把一个 exec-server 请求换成要过闸门的操作。 */
export function execServerActions(method: string, params: unknown, cwd: string): ExecutorAction[] {
  const record = params && typeof params === 'object' ? params as Record<string, unknown> : {};
  if (method === 'process/start') {
    const command = execServerCommand(record.argv);
    const processCwd = fromFileUrl(record.cwd, cwd) ?? cwd;
    return command ? [{ kind: 'exec', command, cwd: processCwd }] : [{ kind: 'exec', command: '<unknown>', cwd: processCwd }];
  }
  if (!method.startsWith('fs/') || METADATA_METHODS.has(method)) return [];
  const paths = ['path', 'sourcePath', 'destinationPath', 'source', 'destination', 'from', 'to', 'target']
    .map((key) => fromFileUrl(record[key], cwd))
    .filter((value): value is string => !!value);
  if (TREE_READ_METHODS.has(method)) return paths.map((target) => ({ kind: 'read', path: target, scope: 'tree' }));
  // Pinned Codex 0.159.2 uses a read-only fs/open and writes through fs/writeFile.
  // Keep explicit non-read modes fail-closed for newer protocols; they are not evidence that
  // their later handle-based write methods are supported by this relay.
  const readOnlyOpen = method !== 'fs/open' || record.mode === undefined || record.mode === 'read';
  const kind = READ_METHODS.has(method) && readOnlyOpen ? 'read' : 'write';
  return paths.map((target) => ({ kind, path: target }) as ExecutorAction);
}

/** 映射协议路径、命令和可逆的 UTF-8 文件数据；二进制内容保持原样。 */
export function mapExecServerParams(value: unknown, workspace: ExecutorWorkspace, method?: string, mapFileData = true): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value as Record<string, unknown> };
  for (const key of ['cwd', 'path', 'sourcePath', 'destinationPath', 'source', 'destination', 'from', 'to', 'target']) {
    const item = result[key];
    if (typeof item !== 'string') continue;
    if (item.startsWith('file://')) {
      const url = new URL(item);
      const foreign = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
      result[key] = pathToFileURL(workspace.resolve(foreign)).href;
    } else result[key] = workspace.resolve(item);
  }
  if (Array.isArray(result.argv)) result.argv = result.argv.map((part, index) => {
    if (typeof part !== 'string') return part;
    // argv[0] is passed directly to the OS as an executable name, so Shell quoting would
    // become part of the filename. Only expand a registered workspace alias here.
    return index === 0 ? workspace.mapAlias(part) : workspace.mapCommand(part, resolveExecutorShell().dialect);
  });
  if (typeof result.command === 'string') result.command = workspace.mapCommand(result.command, resolveExecutorShell().dialect);
  if (result.sandbox !== undefined) result.sandbox = mapExecServerSandbox(result.sandbox, workspace);
  return mapFileData ? mapExecServerFileData(result, workspace, method) : result;
}

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

/**
 * 本机能用的绝对路径：任务电脑是 Windows 时必须带盘符或是 UNC，以 `/` 开头的 POSIX 路径不算；
 * 是 POSIX 时 `//server/share` 是 Windows 网络路径(本机 exec-server 不认带主机名的 file URI)，也不算。
 */
function isLocalAbsolutePath(value: string): boolean {
  return process.platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value)
    : path.posix.isAbsolute(value) && !/^[\\/]{2}/.test(value);
}

/** 转换沙箱用到的 Agent 一侧信息：它的路径约定按虚拟工作区(Agent 主机上的路径)判断，不按单个 URI 的长相猜。 */
interface SandboxMapping {
  workspace: ExecutorWorkspace;
  windowsAgent: boolean;
}

/** Agent 发来的 file URI 还原成它那边的路径写法(Windows Agent：`file:///C:/x` → `C:/x`；UNC 带回主机名)。 */
function agentPathFromUri(value: unknown, windowsAgent: boolean): string | null {
  if (typeof value !== 'string' || !value.startsWith('file://')) return null;
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    if (url.host) return `//${url.host}${pathname}`;
    // POSIX 上 `/C:/secret` 是根目录下的普通路径，只有 Windows Agent 才去掉盘符前的 `/`。
    return windowsAgent ? pathname.replace(/^\/([A-Za-z]:)/, '$1') : pathname;
  } catch {
    return null;
  }
}

/** 虚拟工作区内的 file URI 换成本机 file URI；Agent 主机自己的路径返回 null。 */
function localUriFromAgent(value: unknown, { workspace, windowsAgent }: SandboxMapping): string | null {
  const agentPath = agentPathFromUri(value, windowsAgent);
  const local = agentPath === null ? null : workspace.localPathFromAgent(agentPath);
  return local === null ? null : pathToFileURL(local).href;
}

/**
 * 沙箱上下文里解释权限条目用的目录(policyContext 里同名字段同样处理)。用户目录对不上时用本机的：
 * Codex 缺了它会把 `~/…` 规则当作解析失败、一律拒绝读取。
 */
function mapSandboxDirs(record: JsonRecord, mapping: SandboxMapping): JsonRecord {
  const result = { ...record };
  if (result.cwd !== undefined) {
    const local = localUriFromAgent(result.cwd, mapping);
    if (local === null) delete result.cwd;
    else result.cwd = local;
  }
  if (result.userHomeDir !== undefined) {
    result.userHomeDir = localUriFromAgent(result.userHomeDir, mapping) ?? pathToFileURL(os.homedir()).href;
  }
  for (const key of ['workspaceRoots', 'temporaryDirectories']) {
    const items = result[key];
    if (Array.isArray(items)) result[key] = items.flatMap((item) => localUriFromAgent(item, mapping) ?? []);
  }
  return result;
}

/**
 * 一条文件权限：虚拟工作区内的路径换成本机路径。Agent 主机自己的路径(如它的 Codex 记忆目录)在本机
 * 没有对应位置，读写授权直接丢掉，只收不放。禁止规则不因转换失效：路径条目在本机也是合法绝对路径时
 * 原样保留(不合法的会让本机 exec-server 拒绝整个请求)；没映射上的禁止 glob 一律原样保留——相对的由本机
 * 按工作目录解释，Agent 主机的绝对路径在本机匹配不到东西，无需判断它是不是绝对路径。特殊路径(`:tmpdir`、
 * 项目根等)由本机 exec-server 按映射后的目录解释。
 */
function mapSandboxEntry(entry: unknown, mapping: SandboxMapping): unknown[] {
  const record = asJsonRecord(entry);
  const target = asJsonRecord(record?.path);
  if (!record || !target) return [entry];
  const deny = record.access === 'deny' || record.access === 'none';
  if (target.type === 'path') {
    const local = localUriFromAgent(target.path, mapping);
    if (local !== null) return [{ ...record, path: { ...target, path: local } }];
    const agentPath = agentPathFromUri(target.path, mapping.windowsAgent);
    return deny && agentPath !== null && isLocalAbsolutePath(agentPath) ? [entry] : [];
  }
  if (target.type === 'glob_pattern' && typeof target.pattern === 'string') {
    const local = mapping.workspace.localGlobFromAgent(target.pattern);
    if (local !== null) return [{ ...record, path: { ...target, pattern: local } }];
    // 读写 glob 只有明确是绝对路径(盘符加分隔符、`/` 开头、`\\server`)才是 Agent 主机的路径，丢掉；判断不准只会少放。
    return deny || !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(target.pattern) ? [entry] : [];
  }
  return [entry];
}

/**
 * Codex 请求(process/start、fs/*)里的 `sandbox`：权限条目和解释它们用的目录都是 Agent 主机上看到的
 * file URI。原样转给本机 exec-server，两端系统不同时会因路径不属于本机被拒(`invalid sandbox
 * permission path URI`)，相同时则放行的是本机不存在的虚拟目录。这里换成本机路径，规则见 mapSandboxEntry。
 */
function mapExecServerSandbox(value: unknown, workspace: ExecutorWorkspace): unknown {
  const record = asJsonRecord(value);
  const agentPrefixes = workspace.agentPathPrefixes();
  if (!record || agentPrefixes.length === 0) return value;
  const mapping: SandboxMapping = { workspace, windowsAgent: /^(?:[A-Za-z]:|[\\/]{2})/.test(agentPrefixes[0]) };
  const sandbox = mapSandboxDirs(record, mapping);
  const policyContext = asJsonRecord(sandbox.policyContext);
  if (policyContext) sandbox.policyContext = mapSandboxDirs(policyContext, mapping);
  const permissions = asJsonRecord(sandbox.permissions);
  const fileSystem = asJsonRecord(permissions?.file_system);
  if (permissions && fileSystem && Array.isArray(fileSystem.entries)) {
    const entries = fileSystem.entries.flatMap((entry) => mapSandboxEntry(entry, mapping));
    sandbox.permissions = { ...permissions, file_system: { ...fileSystem, entries } };
  }
  return sandbox;
}

/**
 * 授权通过后、实际转发前才读写入目标的原内容，排队中的请求也在出队后读取最新内容。
 * 路径与命令的映射仍在权限检查前完成，确保 gate 检查的是实际执行的操作。
 */
function mapExecServerFileData(value: unknown, workspace: ExecutorWorkspace, method?: string): unknown {
  if (!method?.startsWith('fs/write') || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (typeof result.dataBase64 !== 'string') return value;
  return { ...result, dataBase64: workspace.mapInputFromAgent(Buffer.from(result.dataBase64, 'base64'),
    existingTextFor(result.path, workspace)).toString('base64') };
}

/** 旧内容仅用于还原写入路径的原写法，不回给 Agent；凭证类文件不预读。 */
function existingTextFor(target: unknown, workspace: ExecutorWorkspace): string | null {
  if (typeof target !== 'string') return null;
  let local: string;
  try {
    local = target.startsWith('file://') ? fileURLToPath(target) : target;
  } catch {
    return null;
  }
  return workspace.isSensitive(local) ? null : readExistingTextSync(local);
}

/** 一条结果只解析一次目录；磁盘 realpath 走异步文件系统，不阻塞 Electron 主线程。 */
export async function mapExecServerResult(value: unknown, workspace: ExecutorWorkspace, method?: string): Promise<unknown> {
  const directories: string[] = [];
  const collect = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(collect); return; }
    const record = item as Record<string, unknown>;
    if (record.environmentInfo && typeof record.environmentInfo === 'object') {
      const info = record.environmentInfo as Record<string, unknown>;
      for (const dir of [info.userHomeDir, info.tempDir, ...(Array.isArray(info.temporaryDirectories) ? info.temporaryDirectories : [])]) {
        if (typeof dir !== 'string') continue;
        try { directories.push(dir.startsWith('file://') ? fileURLToPath(dir) : dir); } catch { /* 无效 URI 不登记。 */ }
      }
    }
    Object.values(record).forEach(collect);
  };
  collect(value);
  if (directories.length) await workspace.virtualizeDirsAsync(directories);
  return projectExecServerResult(value, await workspace.prepareAgentProjection(), method);
}

/** JSON 层逐字符串投影；文件 base64 数据保持原始字节，进程输出单独解码。 */
function projectExecServerResult(value: unknown, projection: ExecutorAgentProjection, method?: string): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('file://')) {
      try {
        const uri = new URL(value);
        const real = fileURLToPath(uri);
        const virtual = projection.toAgentPath(real);
        if (virtual === real) return value;
        uri.host = '';
        uri.pathname = virtual.replace(/\\/g, '/');
        return uri.href;
      } catch { return value; }
    }
    return projection.mapTextForAgent(value);
  }
  if (Array.isArray(value)) return value.map((item) => projectExecServerResult(item, projection, method));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const currentMethod = typeof record.method === 'string' ? record.method : method;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => {
    if (currentMethod === 'process/output' && key === 'chunk' && typeof item === 'string') {
      return [key, projection.mapOutputForAgent(Buffer.from(item, 'base64')).toString('base64')];
    }
    return [key, projectExecServerResult(item, projection, currentMethod)];
  }));
}

export class ExecServerRelay {
  private readonly connections = new Map<string, Connection>();
  private outbox: RemoteAgentPushFrame[] = [];
  private flushing: Promise<void> | null = null;
  private closed = false;
  private readonly counts = { requests: 0, rejected: 0, pushes: 0, pushTotalMs: 0, pushMaxMs: 0, slowPushes: 0 };

  constructor(private readonly deps: ExecServerRelayDeps) {}

  stats(): ExecServerRelayStats {
    const { requests, rejected, pushes, pushTotalMs, pushMaxMs, slowPushes } = this.counts;
    return { requests, rejected, pushes, pushMaxMs, pushAvgMs: pushes ? Math.round(pushTotalMs / pushes) : 0, slowPushes };
  }

  handle(item: Extract<RemoteAgentStreamItem, { t: 'ws' }>): void {
    if (this.closed) return;
    switch (item.kind) {
      case 'open':
        this.open(item.connId, item.path ?? '/');
        return;
      case 'message':
        if (typeof item.data === 'string') this.forward(item.connId, item.data);
        return;
      case 'close':
        this.dropConnection(item.connId, false);
        return;
    }
  }

  /**
   * 还有放不下的工作：有进程在跑(含 Codex 的后台终端)、有消息在等本机确认，或还有帧没推完。
   * 这时断开对方的 Agent 会丢掉它们，连接池不让出名额。
   */
  busy(): boolean {
    return this.outbox.length > 0 || Boolean(this.flushing) || this.hasWork()
      || [...this.connections.values()].some((connection) => Boolean(connection.output));
  }

  /** 各条连接上还有没有工作(在跑的进程、启动中的请求、待确认的消息)；还没推完的帧不算。 */
  private hasWork(): boolean {
    for (const connection of this.connections.values()) {
      if (connection.processes.size || connection.starting.size || connection.queue) return true;
    }
    return false;
  }

  /**
   * 对方的 Agent 已断开(连接池让出名额)：关掉本机为它起的 exec-server，中继本身留给连回来的 Agent。
   */
  reset(): void {
    if (this.closed) return;
    this.outbox = [];
    for (const connId of [...this.connections.keys()]) this.dropConnection(connId, false);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const connId of [...this.connections.keys()]) this.dropConnection(connId, false);
    const stats = this.stats();
    if (stats.slowPushes > 0 || stats.rejected > 0) this.deps.log?.warn('remote agent: exec-server relay summary', { ...stats });
  }

  private open(connId: string, wsPath: string): void {
    if (wsPath.split('?')[0] !== EXEC_SERVER_WS_PATH || this.connections.has(connId)) {
      this.send({ connId, kind: 'close' });
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.deps.codexPath, ['exec-server', '--listen', 'stdio://'], {
        cwd: this.deps.cwd,
        env: this.deps.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.deps.log?.warn('remote agent: exec-server failed to start', { error: String(error) });
      this.send({ connId, kind: 'close' });
      return;
    }
    const connection: Connection = { child, buffer: '', closed: false, processes: new Set(), starting: new Map() };
    this.connections.set(connId, connection);
    // 只记耗时、字节数与退出码(不记输出内容)：首次握手失败时能分清是本机进程起得慢、异常退出，还是链路慢。
    const now = this.deps.now ?? Date.now;
    const openedAt = now();
    let firstReplyMs: number | undefined;
    let stderrBytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (firstReplyMs === undefined) {
        firstReplyMs = now() - openedAt;
        if (firstReplyMs >= SLOW_FIRST_REPLY_MS) this.deps.log?.warn('remote agent: exec-server first reply slow', { connId, firstReplyMs });
      }
      if (connection.closed) return;
      connection.buffer += chunk;
      for (;;) {
        const index = connection.buffer.indexOf('\n');
        if (index < 0) break;
        const line = connection.buffer.slice(0, index);
        connection.buffer = connection.buffer.slice(index + 1);
        if (line.trim()) {
          this.trackOutbound(connection, line);
          this.enqueueOutput(connId, connection, line);
        }
      }
      if (connection.buffer.length > MAX_LINE_CHARS) {
        this.deps.log?.warn('remote agent: exec-server line too long; closing', { connId });
        this.dropConnection(connId, true);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
    });
    child.on('error', (error) => {
      if (this.connections.get(connId) !== connection) return;
      this.deps.log?.warn('remote agent: exec-server process error', { connId, code: (error as NodeJS.ErrnoException).code ?? 'unknown' });
      this.dropConnection(connId, true);
    });
    // close 在 stdout 完全读完后触发；尾部结果的异步投影完成后才通知对端连接结束。
    child.on('close', (exitCode, signal) => {
      // 本机这边关掉的(对方断开、让出名额)不算；进程自己退出的记下退出码，对方的 Codex 会看到环境断开。
      if (!connection.closed) {
        this.deps.log?.warn('remote agent: exec-server exited', {
          connId, exitCode, signal, stderrBytes, uptimeMs: now() - openedAt, answered: firstReplyMs !== undefined,
        });
      }
      void (connection.output ?? Promise.resolve()).then(() => {
        if (this.connections.get(connId) === connection) this.dropConnection(connId, true);
      });
    });
  }

  private forward(connId: string, data: string): void {
    const connection = this.connections.get(connId);
    if (!connection || connection.closed) return;
    type JsonRpcMessage = { id?: unknown; method?: unknown; params?: unknown };
    let message: JsonRpcMessage | null = null;
    try {
      const parsed: unknown = JSON.parse(data);
      message = parsed && typeof parsed === 'object' ? parsed as JsonRpcMessage : null;
    } catch {
      message = null;
    }
    let actions: ExecutorAction[] = [];
    if (message && typeof message.method === 'string' && message.id !== undefined) {
      this.counts.requests += 1;
      message.params = mapExecServerParams(message.params, this.deps.workspace, message.method, false);
      data = JSON.stringify(message);
      actions = execServerActions(message.method, message.params, this.deps.cwd);
      if (message.method === 'process/start') {
        const processId = (message.params as { processId?: unknown } | undefined)?.processId;
        if (typeof processId === 'string') connection.starting.set(JSON.stringify(message.id), processId);
      }
    }
    const id = message?.id;
    // 延迟到所有 action 获准之后，不能为了内容保真提前读取被拒绝的目标。
    const line = () => {
      if (message && typeof message.method === 'string' && message.id !== undefined) {
        return JSON.stringify({ ...message, params: mapExecServerFileData(message.params, this.deps.workspace, message.method) }) + '\n';
      }
      return data + '\n';
    };
    if (connection.queue) {
      this.enqueue(connection, () => this.deliver(connId, connection, id, line, actions));
      return;
    }
    for (const [index, action] of actions.entries()) {
      const decision = this.deps.authorize(action);
      if (decision.ok) continue;
      if (!this.deps.confirm) {
        this.reject(connId, id, decision);
        return;
      }
      // 等本机用户确认(凭证类)：这一条与之后的消息都按顺序等它。已放行的操作不再检查(批准只能用一次)。
      const rest = actions.slice(index);
      this.enqueue(connection, () => this.deliver(connId, connection, id, line, rest));
      return;
    }
    connection.child.stdin.write(line());
  }

  private enqueue(connection: Connection, task: () => Promise<void>): void {
    const next = (connection.queue ?? Promise.resolve()).then(task).catch((error: unknown) => {
      this.deps.log?.warn('remote agent: exec-server message failed', { error: String(error) });
    });
    connection.queue = next;
    void next.then(() => {
      if (connection.queue !== next) return;
      const hadWork = this.hasWork();
      connection.queue = undefined;
      this.settleWork(hadWork);
    });
  }

  private async deliver(connId: string, connection: Connection, id: unknown, line: () => string, actions: ExecutorAction[]): Promise<void> {
    for (const action of actions) {
      let decision = this.deps.authorize(action);
      if (!decision.ok && this.deps.confirm && await this.deps.confirm(action)) decision = this.deps.authorize(action);
      if (connection.closed) return;
      if (!decision.ok) {
        this.reject(connId, id, decision);
        return;
      }
    }
    if (!connection.closed) connection.child.stdin.write(line());
  }

  /** 记下 exec-server 报的进程起止(只看编号，不改消息)。 */
  private trackOutbound(connection: Connection, line: string): void {
    // 大段文件内容不必再解析一遍：进程通知带方法名，启动回包很短。
    if (!line.includes('"process/') && !(connection.starting.size && line.length < 64 * 1024)) return;
    let message: { id?: unknown; method?: unknown; params?: { processId?: unknown }; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.method === undefined) {
      const key = JSON.stringify(message.id);
      const processId = connection.starting.get(key);
      if (processId === undefined) return;
      const hadWork = this.hasWork();
      connection.starting.delete(key);
      // 启动失败(JSON-RPC 错误)不会留下进程；等了很久才失败时同样是一次由忙转闲。
      if (message.error === undefined) connection.processes.add(processId);
      this.settleWork(hadWork);
      return;
    }
    if ((message.method === 'process/closed' || message.method === 'process/exited') && typeof message.params?.processId === 'string') {
      const processId = message.params.processId;
      const hadWork = this.hasWork();
      connection.processes.delete(processId);
      for (const [key, starting] of connection.starting) if (starting === processId) connection.starting.delete(key);
      this.settleWork(hadWork);
    }
  }

  /**
   * 改动连接上的工作记录之后调用：由有工作变为没有工作，就是一次由忙转闲(对连接池来说是一次活动)。
   * 进程结束、启动失败、待确认的消息处理完、连接被整条删掉，都经过这里。
   */
  private settleWork(hadWork: boolean): void {
    if (hadWork && !this.hasWork()) this.deps.onProcessesEnded?.();
  }

  private reject(connId: string, id: unknown, decision: ExecutorGateDecision): void {
    this.counts.rejected += 1;
    // 被闸门拦下的启动没有到 exec-server，不会有进程。
    this.connections.get(connId)?.starting.delete(JSON.stringify(id));
    this.sendMessage(connId, JSON.stringify({
      id,
      error: { code: -32001, message: this.deps.workspace.mapTextForAgent(decision.reason ?? 'Not allowed in this workspace.') },
    }));
  }

  private enqueueOutput(connId: string, connection: Connection, line: string): void {
    connection.child.stdout.pause();
    const next = (connection.output ?? Promise.resolve()).then(async () => {
      if (connection.closed) return;
      const projected = await this.projectOutbound(line);
      if (!connection.closed) this.sendMessage(connId, projected);
    }).catch(() => {
      // 不发送未投影的本机路径；只结束这条连接，不能影响同一设备上的其它任务。
      if (!connection.closed) {
        this.deps.log?.warn('remote agent: exec-server output projection failed; closing connection', { connId });
        this.dropConnection(connId, true);
      }
    });
    connection.output = next;
    void next.then(() => {
      if (connection.output !== next) return;
      connection.output = undefined;
      if (!connection.closed) connection.child.stdout.resume();
    });
  }

  private async projectOutbound(line: string): Promise<string> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      const projection = await this.deps.workspace.prepareAgentProjection();
      return projection.mapTextForAgent(line);
    }
    return JSON.stringify(await mapExecServerResult(value, this.deps.workspace));
  }

  private dropConnection(connId: string, notifyRemote: boolean): void {
    const connection = this.connections.get(connId);
    if (!connection || connection.closed) return;
    // 连接带着在跑的进程、启动中的请求或待确认的消息被整条删掉(异常退出、交付失败、对方关闭)，同样是一次
    // 由忙转闲。只看各连接上的工作：本机这侧断开时紧接着排进去的关闭帧不算忙。
    const hadWork = this.hasWork();
    connection.closed = true;
    this.connections.delete(connId);
    try {
      connection.child.stdin.end();
      connection.child.kill();
    } catch {
      // 进程已退出。
    }
    if (notifyRemote) this.send({ connId, kind: 'close' });
    this.settleWork(hadWork);
  }

  /** 一条消息：超过单帧上限时拆成多段(除最后一段外带 more)。 */
  private sendMessage(connId: string, data: string): void {
    for (let offset = 0; offset < data.length; offset += FRAME_CHARS) {
      const part = data.slice(offset, offset + FRAME_CHARS);
      const more = offset + FRAME_CHARS < data.length;
      this.send({ connId, kind: 'message', data: part, ...(more ? { more: true as const } : {}) });
    }
  }

  /** 发往对方的帧按顺序成批推送(一次只有一个 push 在途)。 */
  private send(frame: RemoteAgentPushFrame): void {
    if (this.closed && frame.kind === 'message') return;
    this.outbox.push(frame);
    this.kick();
  }

  private kick(): void {
    if (this.flushing) return;
    this.flushing = this.flush().finally(() => {
      this.flushing = null;
      if (this.outbox.length) this.kick();
    });
  }

  private async flush(): Promise<void> {
    await Promise.resolve();
    while (this.outbox.length) {
      const batch: RemoteAgentPushFrame[] = [];
      let size = 0;
      while (this.outbox.length && batch.length < REMOTE_AGENT_MAX_PUSH_FRAMES) {
        const next = this.outbox[0];
        const length = next.data?.length ?? 0;
        if (batch.length && size + length > REMOTE_AGENT_MAX_PUSH_CHARS) break;
        batch.push(this.outbox.shift()!);
        size += length;
      }
      const now = this.deps.now ?? Date.now;
      const startedAt = now();
      try {
        await this.deps.push(batch);
        const elapsed = now() - startedAt;
        this.counts.pushes += 1;
        this.counts.pushTotalMs += elapsed;
        this.counts.pushMaxMs = Math.max(this.counts.pushMaxMs, elapsed);
        if (elapsed >= SLOW_PUSH_MS) {
          this.counts.slowPushes += 1;
          // 第一次慢就记一条(任务可能要很久才结束，汇总那条来得晚)。
          if (this.counts.slowPushes === 1) this.deps.log?.warn('remote agent: exec-server push slow', { pushMs: elapsed, frames: batch.length });
        }
      } catch (error) {
        // 批次已从 outbox 取出但交付失败(push 同序号重试耗尽)：不能只记日志就继续发后续帧
        // ——远端 Codex 会永久缺这条 JSON-RPC 回复卡住，丢失的中间分片还会把后续分片拼成
        // 损坏消息。丢弃未发帧并关掉全部 exec-server 连接，让对方按连接断开明确恢复。
        this.deps.log?.warn('remote agent: exec-server frames could not be delivered; closing connections', { error: String(error) });
        this.dropAll();
        return;
      }
    }
  }

  /** 交付链路断了：丢掉未发帧，关掉全部连接触发对方的明确恢复。 */
  private dropAll(): void {
    this.outbox = [];
    for (const connId of [...this.connections.keys()]) this.dropConnection(connId, true);
  }
}
