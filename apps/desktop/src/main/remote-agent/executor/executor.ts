/**
 * 远程 Agent 执行器(控制端)：一个任务一份，任务结束即关闭。
 *
 * Agent 所在电脑发来的每个文件 / 命令请求都在这里先过权限上限，再在本机执行：
 *  - `handle(op, body)`：原始操作(Pi 的工具后端)；
 *  - `callTool(name, args)`：Claude Code 风格的 Bash / BashOutput / KillShell / Read / Write / Edit /
 *    NotebookEdit(Claude Code 的自带文件与命令工具关掉后由它顶替)；供应商分享的受邀者任务另有
 *    WebFetch(自带的 WebFetch 对受邀者关闭，改在本机抓取)。
 * 写文件前通知「每轮改动对比」抓取改前内容；命令执行后登记一次无法预知范围的改动。
 * 供应商分享的受邀者任务里，凭证类操作没有本机批准时由这里直接在本机弹确认卡(confirm)。
 */
import path from 'node:path';

import {
  ccEdit,
  ccNotebookEdit,
  ccRead,
  ccWrite,
  createRipgrepRunner,
  detectImageMime,
  rawAccess,
  rawGlob,
  rawMkdir,
  rawReadFile,
  rawReaddir,
  rawStat,
  rawWriteFile,
  readExistingText,
  ReadStateTracker,
  textResult,
  type FileWriteHooks,
  type PdfTextExtractor,
  type RipgrepRunner,
  type ToolResult,
} from './files';
import type { ExecutorAction, ExecutorGate, ExecutorGateDecision, ExecutorGateMode } from './gate';
import type { GitCredentialHistory } from './gitCredentials';
import { piGrep, type PiGrepInput } from './search';
import { resolveExecutorShell, runOnce, ShellSession } from './shell';
import { fetchWebPage, WEB_FETCH_PAGE_CHARS, type GuardedFetch } from './webFetch';
import { ExecutorPathError, type ExecutorWorkspace } from './workspace';

/** Pi bash 的超时(秒)上限，与 Pi 侧 Cindy 桥的上限一致。 */
const PI_BASH_MAX_TIMEOUT_SECONDS = 1800;

export interface ExecutorCaptureHooks {
  beforeWrite(absPath: string): Promise<void>;
  noteOpaqueWrite(): void;
}

/** `session` 免除当前任务后续的分享凭证确认，普通权限上限仍由 gate 判断。 */
export type ExecutorConfirmation = boolean | 'session';

export interface RemoteExecutorOptions {
  workspace: ExecutorWorkspace;
  gate: ExecutorGate;
  rgPath: string;
  capture?: ExecutorCaptureHooks;
  /** 后台命令输出文件所在目录。 */
  tempDir?: string;
  /** Read 读 PDF 时取文字；缺省时 PDF 不能用 Read 读取。 */
  extractPdfText?: PdfTextExtractor;
  /** 提供 WebFetch(在本机抓取网页)所用的出站通道；缺省时不提供这个工具。 */
  webFetch?: GuardedFetch;
  /**
   * 在本机弹确认卡问本机用户(供应商分享的受邀者任务)：凭证类操作没有本机批准时用它补问，允许后
   * 默认只放行这一个操作；用户明确选择会话级允许后免除后续的分享凭证确认。缺省时直接拒绝。
   */
  confirm?(action: ExecutorAction, signal: AbortSignal): Promise<ExecutorConfirmation>;
  /** 与 confirm 一起提供：git 查看内容、打出 git 配置的命令先在本机核实，读不到凭证时不弹卡。 */
  gitCredentials?: GitCredentialHistory;
  /**
   * 「本任务总是允许」的任务级记录(credentialGrants.ts，由启动方按当前原始权限档写入)：Agent 实例被系统
   * 回收重建后据此恢复；缺省时只在本执行器内有效。
   */
  credentialGrant?: { remember(): void; forget(): void; watch?(revoke: () => void): () => void };
}

export class ExecutorRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExecutorRequestError';
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : 'EXECUTOR_ERROR';
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExecutorRequestError('INVALID', 'request body must be an object');
  return value as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) throw new ExecutorRequestError('INVALID', `${key} must be a non-empty string`);
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ExecutorRequestError('INVALID', `${key} must be a number`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ExecutorRequestError('INVALID', `${key} must be a string`);
  return value;
}

/** Claude Code 风格工具名(与自带工具同名，模型和界面看到的都是这些名字)。WebFetch 只在启用时提供。 */
export const EXECUTOR_CC_TOOL_NAMES = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'WebFetch'] as const;
export type ExecutorCcToolName = (typeof EXECUTOR_CC_TOOL_NAMES)[number];

export class RemoteExecutor {
  readonly workspace: ExecutorWorkspace;
  private readonly gate: ExecutorGate;
  private readonly rg: RipgrepRunner;
  private readonly readState = new ReadStateTracker();
  private readonly shell: ShellSession;
  private readonly writeHooks: FileWriteHooks;
  private closed = false;
  private permissionGeneration = 0;
  private credentialConfirmationAbort = new AbortController();
  private credentialConfirmationTail?: Promise<void>;
  private readonly unwatchCredentialGrant?: () => void;

  constructor(private readonly opts: RemoteExecutorOptions) {
    // 任务级授权在别处被删除(如 Agent 重建期间用户改了权限档)：收回本执行器已恢复的授权。
    this.unwatchCredentialGrant = opts.credentialGrant?.watch?.(() => this.revokeCredentialGrant());
    this.workspace = opts.workspace;
    this.gate = opts.gate;
    this.rg = createRipgrepRunner(opts.rgPath);
    this.shell = new ShellSession({
      workingDir: opts.workspace.workingDir,
      isAllowedCwd: (cwd) => opts.workspace.contains(cwd),
      tempDir: opts.tempDir,
    });
    this.writeHooks = {
      beforeWrite: async (absPath) => {
        await opts.capture?.beforeWrite(absPath);
      },
    };
  }

  /** 本机任务的权限档变化时更新上限档位。 */
  setGateMode(mode: ExecutorGateMode): void {
    this.gate.setMode(mode);
    this.cancelPendingConfirmations();
    this.opts.credentialGrant?.forget();
  }

  /** 撤销分享凭证的任务授权：与权限档变化一样清掉授权，并作废等待中的确认。 */
  private revokeCredentialGrant(): void {
    this.gate.setMode(this.gate.getMode());
    this.cancelPendingConfirmations();
  }

  /**
   * 停止、权限变化或撤权时取消已显示和排队中的确认。停止本身不撤销先前有效的任务授权。
   */
  cancelPendingConfirmations(): void {
    this.permissionGeneration += 1;
    const previous = this.credentialConfirmationAbort;
    this.credentialConfirmationAbort = new AbortController();
    previous.abort();
  }

  /** 本机用户在确认卡上允许了一个操作。 */
  recordApproval(action: ExecutorAction): void {
    this.gate.recordApproval(action);
  }

  /** 权限上限检查(Codex exec-server 中继用；本执行器自己的操作在内部检查)。 */
  check(action: ExecutorAction): ExecutorGateDecision {
    if (this.closed) return { ok: false, reason: 'The task has ended on the computer where it runs.' };
    return this.gate.authorize(action);
  }

  /**
   * 凭证类操作在本机补问一次(供应商分享的受邀者任务)；本机用户允许后登记批准，调用方再检查一次即可
   * 放行。git 查看内容、打出 git 配置的命令在本机核实过读不到凭证时不弹卡，直接登记批准。不是凭证类、
   * 没有确认通道或任务已结束时返回 false。
   */
  async confirm(action: ExecutorAction, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || signal?.aborted || !this.opts.confirm || !this.gate.needsCredentialConsent(action)) return false;
    signal = signal
      ? AbortSignal.any([signal, this.credentialConfirmationAbort.signal])
      : this.credentialConfirmationAbort.signal;
    const permissionGeneration = this.permissionGeneration;
    // 只有要核实的 git 命令才在弹卡前等核实结果；核实通过不弹卡，也不必排在其他确认卡后面。
    const gitCheck = this.gitReadsCheck(action, signal);
    if (gitCheck && await gitCheck) {
      // 核实期间任务结束、请求被取消或权限已切换：同样不放行。
      if (this.closed || signal?.aborted || permissionGeneration !== this.permissionGeneration) return false;
      this.gate.recordCredentialExemption(action);
      return true;
    }
    // 核实需要时间：期间请求被取消就不再排队(abort 事件不会重放给之后登记的监听)。
    if (gitCheck && (this.closed || signal?.aborted || permissionGeneration !== this.permissionGeneration)) return false;
    // 同一任务可能并行调用工具。只排队确认，不排队执行；前一张卡建立任务授权后，
    // 后续请求重新检查，避免已经弹出的多张卡仍逐一等待用户回答。
    // 排队位置要等前一个位置放行、且自己的卡处理完才放行。
    const previous = this.credentialConfirmationTail;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const slot = previous ? previous.then(() => settled) : settled;
    this.credentialConfirmationTail = slot;
    // 自己的请求取消后立即让出：还在排队就不再等(后面的请求仍等前一张卡)；
    // 卡已弹出就不再挡住后面的请求，这张卡之后的回答会被丢弃。
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => { settle(); resolve(); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (previous) await Promise.race([previous, aborted]);
      if (this.closed || signal?.aborted || permissionGeneration !== this.permissionGeneration) return false;
      // 调用方仍会重新检查普通权限上限；这里只免除已授权的分享凭证确认。
      if (!this.gate.needsCredentialConsent(action)) return true;
      const allowed = await Promise.race([
        this.opts.confirm(action, signal).catch(() => false),
        aborted.then(() => false as const),
      ]);
      // 等确认期间任务结束、请求被取消或权限已切换：不接受旧确认。
      if ((allowed !== true && allowed !== 'session') || this.closed || signal?.aborted
        || permissionGeneration !== this.permissionGeneration) return false;
      if (allowed === 'session') {
        this.gate.allowCredentialsForSession();
        this.opts.credentialGrant?.remember();
        if (this.gate.getMode() === 'full') return true;
      }
      this.gate.recordApproval(action);
      return true;
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      settle();
      void slot.then(() => {
        if (this.credentialConfirmationTail === slot) this.credentialConfirmationTail = undefined;
      });
    }
  }

  /** 要在本机核实的 git 命令返回核实结果(true = 读不到凭证)；不需要核实的返回 null。 */
  private gitReadsCheck(action: ExecutorAction, signal?: AbortSignal): Promise<boolean> | null {
    const history = this.opts.gitCredentials;
    if (!history || action.kind !== 'exec') return null;
    const reads = this.gate.credentialGitReads(action);
    return reads ? history.provesSafe(action.command, reads, signal)
      .then((safe) => safe && this.gate.credentialGitReads(action) !== null)
      .catch(() => false) : null;
  }

  /** 检查上限；凭证类操作没有批准时先在本机问一次。 */
  private async decide(action: ExecutorAction, signal?: AbortSignal): Promise<ExecutorGateDecision> {
    const decision = this.gate.authorize(action);
    if (decision.ok || !(await this.confirm(action, signal))) return decision;
    return this.gate.authorize(action);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelPendingConfirmations();
    this.unwatchCredentialGrant?.();
    await this.shell.close();
  }

  /** 给 Claude Code 的工具定义(cindy_exec 的 tools/list)。 */
  toolDefinitions(): ReturnType<typeof executorCcToolDefinitions> {
    return executorCcToolDefinitions(process.platform, { webFetch: this.opts.webFetch !== undefined });
  }

  private ensureOpen(): void {
    if (this.closed) throw new ExecutorRequestError('CLOSED', 'The task has ended on the computer where it runs.');
  }

  private resolvePath(input: string, baseDir?: string): string {
    try {
      return this.workspace.resolve(input, baseDir ? this.workspace.resolve(baseDir) : undefined);
    } catch (error) {
      if (error instanceof ExecutorPathError) throw new ExecutorRequestError('INVALID', error.message);
      throw error;
    }
  }

  private async authorize(action: ExecutorAction, signal?: AbortSignal): Promise<void> {
    const decision = await this.decide(action, signal);
    if (!decision.ok) throw new ExecutorRequestError('EACCES', decision.reason ?? 'Not allowed.');
  }

  // ─── 原始操作 ──────────────────────────────────────────────────

  async handle(op: string, rawBody: unknown, signal?: AbortSignal): Promise<unknown> {
    this.ensureOpen();
    const body = record(rawBody);
    try {
      switch (op) {
        case 'fs.read': {
          const target = this.resolvePath(str(body, 'path'));
          await this.authorize({ kind: 'read', path: target }, signal);
          return { data: this.workspace.mapOutputForAgent(await rawReadFile(target)).toString('base64') };
        }
        case 'fs.access': {
          const target = this.resolvePath(str(body, 'path'));
          const mode = body.mode === 'write' ? 'write' : 'read';
          await this.authorize({ kind: mode, path: target }, signal);
          await rawAccess(target, mode);
          return {};
        }
        case 'fs.write': {
          const target = this.resolvePath(str(body, 'path'));
          await this.authorize({ kind: 'write', path: target }, signal);
          if (typeof body.data !== 'string') throw new ExecutorRequestError('INVALID', 'data must be a base64 string');
          const data = this.workspace.mapInputFromAgent(Buffer.from(body.data, 'base64'), await readExistingText(target));
          await this.writeHooks.beforeWrite(target);
          await rawWriteFile(target, data);
          return {};
        }
        case 'fs.mkdir': {
          const target = this.resolvePath(str(body, 'path'));
          await this.authorize({ kind: 'write', path: target }, signal);
          await rawMkdir(target);
          return {};
        }
        case 'fs.stat': {
          const target = this.resolvePath(str(body, 'path'));
          await this.authorize({ kind: 'read', path: target }, signal);
          return await rawStat(target);
        }
        case 'fs.readdir': {
          const target = this.resolvePath(str(body, 'path'));
          await this.authorize({ kind: 'read', path: target, scope: 'tree' }, signal);
          return { entries: await rawReaddir(target) };
        }
        case 'fs.glob': {
          const cwd = this.resolvePath(str(body, 'cwd'));
          await this.authorize({ kind: 'read', path: cwd, scope: 'tree' }, signal);
          const limit = Math.max(1, Math.floor(optionalNumber(body, 'limit') ?? 1000));
          return { paths: (await rawGlob(this.rg, str(body, 'pattern'), cwd, limit, signal)).map((item) => this.workspace.toAgentPath(item)) };
        }
        case 'fs.mime': {
          const target = this.resolvePath(str(body, 'path'));
          await this.authorize({ kind: 'read', path: target }, signal);
          return { mime: await detectImageMime(target) };
        }
        case 'pi.grep': {
          const params = record(body.params) as unknown as PiGrepInput;
          if (typeof params.pattern !== 'string' || !params.pattern) throw new ExecutorRequestError('INVALID', 'pattern is required');
          const root = this.resolvePath(typeof params.path === 'string' && params.path ? params.path : '.');
          await this.authorize({ kind: 'read', path: root, scope: 'tree' }, signal);
          // 供应商分享的受邀者任务：凭证类文件的内容不进搜索结果(要看须单独读取并经本机确认)。
          // 本机用户刚批准过搜索的就是凭证目录或文件时不再过滤。
          const skipFile = this.opts.confirm && !this.gate.needsCredentialConsent({ kind: 'read', path: root })
            ? (file: string) => this.gate.needsCredentialConsent({ kind: 'read', path: file })
            : undefined;
          const result = await piGrep(this.opts.rgPath, root, params, signal, skipFile);
          return { ...result, text: this.workspace.mapTextForAgent(result.text) };
        }
        case 'exec.run': {
          this.workspace.virtualizeDirs([this.shell.getTempDir()]);
          const command = this.workspace.mapCommand(str(body, 'command'), resolveExecutorShell().dialect);
          const cwd = this.resolvePath(optionalString(body, 'cwd') ?? this.workspace.workingDir);
          await this.authorize({ kind: 'exec', command, cwd }, signal);
          const timeoutSeconds = optionalNumber(body, 'timeout');
          const timeoutMs = timeoutSeconds && timeoutSeconds > 0
            ? Math.min(timeoutSeconds, PI_BASH_MAX_TIMEOUT_SECONDS) * 1000
            : undefined;
          try {
            const result = await runOnce(command, { cwd, timeoutMs, signal });
            return {
              output: this.workspace.mapOutputForAgent(result.output).toString('base64'),
              exitCode: result.exitCode,
              ...(result.timedOut ? { timedOut: true } : {}),
              ...(result.aborted ? { aborted: true } : {}),
            };
          } finally {
            this.opts.capture?.noteOpaqueWrite();
          }
        }
        default:
          throw new ExecutorRequestError('UNSUPPORTED', `unknown operation ${op}`);
      }
    } catch (error) {
      if (error instanceof ExecutorRequestError) throw error;
      throw new ExecutorRequestError(errorCode(error), this.workspace.mapTextForAgent((error as Error)?.message ?? String(error)));
    }
  }

  // ─── Claude Code 风格工具 ──────────────────────────────────────

  async callTool(name: string, rawArgs: unknown, signal?: AbortSignal): Promise<ToolResult> {
    this.workspace.virtualizeDirs([this.shell.getTempDir()]);
    if (this.closed) return textResult('The task has ended on the computer where it runs.', true);
    let args: Record<string, unknown>;
    try {
      args = record(rawArgs ?? {});
    } catch {
      return textResult('Tool arguments must be an object.', true);
    }
    try {
      switch (name as ExecutorCcToolName) {
        case 'Bash':
          return await this.bash(args, signal);
        case 'BashOutput': {
          const id = optionalString(args, 'bash_id') ?? optionalString(args, 'task_id') ?? optionalString(args, 'shell_id');
          if (!id) return textResult('bash_id is required.', true);
          const result = await this.shell.readBackground(id, optionalString(args, 'filter'));
          return textResult(this.workspace.mapTextForAgent(result.text), result.isError);
        }
        case 'KillShell': {
          const id = optionalString(args, 'shell_id') ?? optionalString(args, 'task_id') ?? optionalString(args, 'bash_id');
          if (!id) return textResult('shell_id is required.', true);
          const result = this.shell.killBackground(id);
          return textResult(this.workspace.mapTextForAgent(result.text), result.isError);
        }
        case 'Read': {
          const target = this.resolvePath(str(args, 'file_path'), this.shell.getCwd());
          await this.authorizeTool({ kind: 'read', path: target }, signal);
          return this.mapToolResult(await ccRead(target, {
            file_path: target,
            offset: optionalNumber(args, 'offset'),
            limit: optionalNumber(args, 'limit'),
            pages: optionalString(args, 'pages'),
          }, this.readState, this.workspace.toAgentPath(this.workspace.workingDir), this.opts.extractPdfText, this.workspace.toAgentPath(target)));
        }
        case 'Write': {
          const target = this.resolvePath(str(args, 'file_path'), this.shell.getCwd());
          const content = args.content;
          if (typeof content !== 'string') return textResult('content must be a string.', true);
          await this.authorizeTool({ kind: 'write', path: target }, signal);
          const local = this.workspace.mapContentFromAgent(content, await readExistingText(target));
          return this.mapToolResult(await ccWrite(target, local, this.readState, this.writeHooks, this.workspace.toAgentPath(target)));
        }
        case 'Edit': {
          const target = this.resolvePath(str(args, 'file_path'), this.shell.getCwd());
          if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
            return textResult('old_string and new_string must be strings.', true);
          }
          await this.authorizeTool({ kind: 'write', path: target }, signal);
          return this.mapToolResult(await ccEdit(target, {
            old_string: args.old_string,
            new_string: args.new_string,
            replace_all: args.replace_all === true,
          }, this.readState, this.writeHooks, this.workspace.toAgentPath(target),
          (oldString, newString, original) => this.workspace.mapEditFromAgent(oldString, newString, original)));
        }
        case 'NotebookEdit': {
          const target = this.resolvePath(str(args, 'notebook_path'), this.shell.getCwd());
          if (typeof args.new_source !== 'string') return textResult('new_source must be a string.', true);
          const cellType = args.cell_type === 'markdown' || args.cell_type === 'code' ? args.cell_type : undefined;
          const editMode = args.edit_mode === 'insert' || args.edit_mode === 'delete' || args.edit_mode === 'replace'
            ? args.edit_mode : undefined;
          await this.authorizeTool({ kind: 'write', path: target }, signal);
          return this.mapToolResult(await ccNotebookEdit(target, {
            cell_id: optionalString(args, 'cell_id'),
            new_source: args.new_source,
            cell_type: cellType,
            edit_mode: editMode,
          }, this.readState, this.writeHooks, (source, original) => this.workspace.mapContentFromAgent(source, original)));
        }
        case 'WebFetch':
          if (!this.opts.webFetch) return textResult(`Unknown tool: ${name}`, true);
          return this.mapToolResult(await this.webFetch(this.opts.webFetch, args, signal));
        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (error) {
      if (error instanceof ExecutorDenied) return textResult(this.workspace.mapTextForAgent(error.message), true);
      if (error instanceof ExecutorRequestError) return textResult(this.workspace.mapTextForAgent(error.message), true);
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' || code === 'EPERM') return textResult(this.workspace.mapTextForAgent(`Permission denied: ${(error as Error).message}`), true);
      return textResult(this.workspace.mapTextForAgent((error as Error)?.message ?? String(error)), true);
    }
  }

  private async authorizeTool(action: ExecutorAction, signal?: AbortSignal): Promise<void> {
    const decision = await this.decide(action, signal);
    if (!decision.ok) throw new ExecutorDenied(decision.reason ?? 'Not allowed.');
  }

  private mapToolResult(result: ToolResult): ToolResult {
    return {
      ...result,
      content: result.content.map((item) => item.type === 'text'
        ? { ...item, text: this.workspace.mapTextForAgent(item.text) }
        : item),
    };
  }

  private async webFetch(fetchImpl: GuardedFetch, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const raw = str(args, 'url').trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return textResult(`Not a valid URL: ${raw}`, true);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return textResult('Only http and https URLs can be fetched.', true);
    if (url.username || url.password) return textResult('URLs with a user name or password cannot be fetched.', true);
    const startIndex = Math.max(0, Math.floor(optionalNumber(args, 'start_index') ?? 0));
    // 按 Agent 给的原样地址核对：本机用户在确认卡上批准的就是这个地址。
    const decision = this.gate.authorize({ kind: 'fetch', url: raw });
    if (!decision.ok) throw new ExecutorDenied(decision.reason ?? 'Not allowed.');
    return fetchWebPage(fetchImpl, { url, startIndex, allowPrivateNetwork: decision.elevated === true, signal });
  }

  private async bash(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const rawCommand = args.command;
    if (typeof rawCommand !== 'string' || !rawCommand.trim()) return textResult('command is required.', true);
    const command = this.workspace.mapCommand(rawCommand, resolveExecutorShell().dialect);
    await this.authorizeTool({ kind: 'exec', command, cwd: this.shell.getCwd() }, signal);
    const timeout = optionalNumber(args, 'timeout');
    try {
      const result = args.run_in_background === true
        ? await this.shell.startBackground(command)
        : await this.shell.run(command, timeout, signal);
      return textResult(this.workspace.mapTextForAgent(result.text), result.isError);
    } finally {
      this.opts.capture?.noteOpaqueWrite();
    }
  }
}

class ExecutorDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorDenied';
  }
}

/** 给 Claude Code 的工具定义(参数名与自带工具一致；说明是 Cindy 自己写的)。 */
export function executorCcToolDefinitions(
  platform: NodeJS.Platform = process.platform,
  options: { webFetch?: boolean } = {},
): Array<{
  name: ExecutorCcToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const where = 'in the current workspace';
  const shellNote = platform === 'win32'
    ? 'Commands run in Git Bash when available, otherwise cmd.exe.'
    : `Commands run with ${path.basename(process.env.SHELL || 'bash')}.`;
  const webFetch = options.webFetch ? [{
    name: 'WebFetch' as const,
    description: [
      "Fetch a web page using the network of the user's computer and return its text.",
      'HTML is converted to plain text with headings, links, lists and code blocks kept; other text types are returned as they are. Images, PDFs and other files are not returned.',
      'HTTP URLs are upgraded to HTTPS. A redirect to another host is not followed: the result gives the new URL, so call WebFetch again with it.',
      `Long pages come in parts of ${WEB_FETCH_PAGE_CHARS} characters; pass start_index to read further.`,
      "Addresses on the user's computer or a private network need the user's confirmation.",
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        prompt: { type: 'string', description: 'What you are looking for on the page, shown to the user. The page text is returned for you to read.' },
        start_index: { type: 'integer', minimum: 0, description: 'Character position to start from when reading a long page (default 0)' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  }] : [];
  return [
    {
      name: 'Bash',
      description: [
        `Run a shell command ${where}. ${shellNote}`,
        'The working directory persists between calls; environment variables do not. Prefer absolute paths.',
        'Default timeout is 120000 ms (max 600000). Output longer than 30000 characters is shortened in the middle.',
        'Set run_in_background to true for long-running processes such as dev servers, then read their output with BashOutput and stop them with KillShell.',
        'Use the dedicated Read, Edit and Write tools for file contents instead of cat, sed or echo redirection.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 600000)' },
          description: { type: 'string', description: 'A short description of what the command does, in plain words' },
          run_in_background: { type: 'boolean', description: 'Run the command in the background' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      name: 'BashOutput',
      description: 'Read new output from a background command started with Bash run_in_background, plus whether it is still running. Each call returns only output produced since the previous call.',
      inputSchema: {
        type: 'object',
        properties: {
          bash_id: { type: 'string', description: 'The ID returned when the background command started' },
          filter: { type: 'string', description: 'Optional regular expression; only matching lines are returned' },
        },
        required: ['bash_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'KillShell',
      description: 'Stop a background command started with Bash run_in_background.',
      inputSchema: {
        type: 'object',
        properties: {
          shell_id: { type: 'string', description: 'The ID of the background command to stop' },
        },
        required: ['shell_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'Read',
      description: [
        `Read a file ${where}. file_path should be absolute.`,
        'Returns up to 2000 lines starting at offset, each prefixed with its line number and a tab; lines longer than 2000 characters are cut.',
        'Images (PNG, JPEG, GIF, WebP and other common formats) are returned as images; PDFs as the text of each page (at most 20 pages per call, use pages); Jupyter notebooks with their cells and outputs.',
        'Read a file before editing or overwriting it. Reading a directory fails; use Bash with ls instead.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The absolute path to the file to read' },
          offset: { type: 'integer', minimum: 0, description: 'The line number to start reading from. Only provide if the file is too large to read at once' },
          limit: { type: 'integer', exclusiveMinimum: 0, description: 'The number of lines to read. Only provide if the file is too large to read at once' },
          pages: { type: 'string', description: 'Page range for PDF files (e.g. "1-5"). Defaults to the first 20 pages' },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
    },
    {
      name: 'Write',
      description: `Write a file ${where}, creating parent directories as needed and replacing any existing content. An existing file must have been read first in this task. Prefer Edit for changes to existing files.`,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The absolute path to the file to write (must be absolute, not relative)' },
          content: { type: 'string', description: 'The content to write to the file' },
        },
        required: ['file_path', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: 'Edit',
      description: [
        `Replace exact text in a file ${where}. The file must have been read first in this task.`,
        'old_string must match the file exactly (do not include the line-number prefix from Read) and be unique unless replace_all is true; add surrounding context to make it unique.',
        'An empty old_string creates a new file with new_string as its content.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The absolute path to the file to modify' },
          old_string: { type: 'string', description: 'The text to replace' },
          new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' },
          replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences of old_string (default false)' },
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false,
      },
    },
    {
      name: 'NotebookEdit',
      description: `Replace, insert or delete one cell of a Jupyter notebook ${where}. Read the notebook first to get cell IDs.`,
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'The absolute path to the Jupyter notebook file to edit' },
          cell_id: { type: 'string', description: 'The ID of the cell to edit. When inserting, the new cell goes after this cell, or at the beginning if omitted' },
          new_source: { type: 'string', description: 'The new source for the cell' },
          cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'The cell type. Required for insert' },
          edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'The type of edit (default replace)' },
        },
        required: ['notebook_path', 'new_source'],
        additionalProperties: false,
      },
    },
    ...webFetch,
  ];
}
