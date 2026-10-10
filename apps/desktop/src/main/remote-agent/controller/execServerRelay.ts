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
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS,
  REMOTE_AGENT_MAX_PUSH_CHARS,
  REMOTE_AGENT_MAX_PUSH_FRAMES,
  type RemoteAgentPushFrame,
  type RemoteAgentStreamItem,
} from '@cindy/device-link';

import type { ExecutorAction, ExecutorGateDecision } from '../executor/gate';
import { resolveExecutorShell } from '../executor/shell';
import type { ExecutorWorkspace } from '../executor/workspace';

export const EXEC_SERVER_WS_PATH = '/ws/exec-server';
/** exec-server 单行(一条 JSON-RPC 消息)上限：大文件读写的 base64 也在这里面。 */
const MAX_LINE_CHARS = 48 * 1024 * 1024;
/** 单帧数据上限，留出 JSON 包装余量。 */
const FRAME_CHARS = REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS - 1024;
/** 一次回推超过这么久算慢链路(每个 Codex 文件请求都要等一次回推)。 */
const SLOW_PUSH_MS = 2_000;

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
  // fs/open also handles writes: Codex replace/write mode creates or truncates a file, while
  // the later fs/writeBlock request carries only a handle and no path. Check the write at open.
  // An omitted mode is the legacy read-only shape; every explicit unknown mode is fail-closed.
  const readOnlyOpen = method !== 'fs/open' || record.mode === undefined || record.mode === 'read';
  const kind = READ_METHODS.has(method) && readOnlyOpen ? 'read' : 'write';
  return paths.map((target) => ({ kind, path: target }) as ExecutorAction);
}

/** 映射协议路径、命令和可逆的 UTF-8 文件数据；二进制内容保持原样。 */
export function mapExecServerParams(value: unknown, workspace: ExecutorWorkspace, method?: string): unknown {
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
  if (Array.isArray(result.argv)) result.argv = result.argv.map((part) => typeof part === 'string' ? workspace.mapCommand(part, resolveExecutorShell().dialect) : part);
  if (typeof result.command === 'string') result.command = workspace.mapCommand(result.command, resolveExecutorShell().dialect);
  if (method?.startsWith('fs/write') && typeof result.dataBase64 === 'string') {
    result.dataBase64 = workspace.mapInputFromAgent(Buffer.from(result.dataBase64, 'base64')).toString('base64');
  }
  return result;
}

/** JSON 层逐字符串投影；文件 base64 数据保持原始字节，进程输出单独解码。 */
export function mapExecServerResult(value: unknown, workspace: ExecutorWorkspace, method?: string): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('file://')) {
      try {
        const uri = new URL(value);
        const real = fileURLToPath(uri);
        const virtual = workspace.toAgentPath(real);
        if (virtual === real) return value;
        uri.host = '';
        uri.pathname = virtual.replace(/\\/g, '/');
        return uri.href;
      } catch { return value; }
    }
    return workspace.mapTextForAgent(value);
  }
  if (Array.isArray(value)) return value.map((item) => mapExecServerResult(item, workspace, method));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  // 初始化里的 HOME / temp 同样只暴露本机虚拟目录；这些别名不增加执行权限。
  if (record.environmentInfo && typeof record.environmentInfo === 'object') {
    const info = record.environmentInfo as Record<string, unknown>;
    const directories = [info.userHomeDir, info.tempDir, ...(Array.isArray(info.temporaryDirectories) ? info.temporaryDirectories : [])];
    workspace.virtualizeDirs(directories.flatMap((dir) => {
      if (typeof dir !== 'string') return [];
      try { return [dir.startsWith('file://') ? fileURLToPath(dir) : dir]; } catch { return []; }
    }));
  }
  const currentMethod = typeof record.method === 'string' ? record.method : method;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => {
    if (currentMethod === 'process/output' && key === 'chunk' && typeof item === 'string') {
      return [key, workspace.mapOutputForAgent(Buffer.from(item, 'base64')).toString('base64')];
    }
    return [key, mapExecServerResult(item, workspace, currentMethod)];
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
    const connection: Connection = { child, buffer: '', closed: false };
    this.connections.set(connId, connection);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      connection.buffer += chunk;
      for (;;) {
        const index = connection.buffer.indexOf('\n');
        if (index < 0) break;
        const line = connection.buffer.slice(0, index);
        connection.buffer = connection.buffer.slice(index + 1);
        if (line.trim()) this.sendMessage(connId, this.projectOutbound(line));
      }
      if (connection.buffer.length > MAX_LINE_CHARS) {
        this.deps.log?.warn('remote agent: exec-server line too long; closing', { connId });
        this.dropConnection(connId, true);
      }
    });
    child.stderr.resume();
    child.on('error', () => this.dropConnection(connId, true));
    child.on('exit', () => this.dropConnection(connId, true));
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
      message.params = mapExecServerParams(message.params, this.deps.workspace, message.method);
      data = JSON.stringify(message);
      actions = execServerActions(message.method, message.params, this.deps.cwd);
    }
    const id = message?.id;
    const line = `${data}\n`;
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
    connection.child.stdin.write(line);
  }

  private enqueue(connection: Connection, task: () => Promise<void>): void {
    const next = (connection.queue ?? Promise.resolve()).then(task).catch((error: unknown) => {
      this.deps.log?.warn('remote agent: exec-server message failed', { error: String(error) });
    });
    connection.queue = next;
    void next.then(() => {
      if (connection.queue === next) connection.queue = undefined;
    });
  }

  private async deliver(connId: string, connection: Connection, id: unknown, line: string, actions: ExecutorAction[]): Promise<void> {
    for (const action of actions) {
      let decision = this.deps.authorize(action);
      if (!decision.ok && this.deps.confirm && await this.deps.confirm(action)) decision = this.deps.authorize(action);
      if (connection.closed) return;
      if (!decision.ok) {
        this.reject(connId, id, decision);
        return;
      }
    }
    if (!connection.closed) connection.child.stdin.write(line);
  }

  private reject(connId: string, id: unknown, decision: ExecutorGateDecision): void {
    this.counts.rejected += 1;
    this.sendMessage(connId, JSON.stringify({
      id,
      error: { code: -32001, message: this.deps.workspace.mapTextForAgent(decision.reason ?? 'Not allowed in this workspace.') },
    }));
  }

  private projectOutbound(line: string): string {
    try {
      return JSON.stringify(mapExecServerResult(JSON.parse(line), this.deps.workspace));
    } catch {
      return this.deps.workspace.mapTextForAgent(line);
    }
  }

  private dropConnection(connId: string, notifyRemote: boolean): void {
    const connection = this.connections.get(connId);
    if (!connection || connection.closed) return;
    connection.closed = true;
    this.connections.delete(connId);
    try {
      connection.child.stdin.end();
      connection.child.kill();
    } catch {
      // 进程已退出。
    }
    if (notifyRemote) this.send({ connId, kind: 'close' });
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
