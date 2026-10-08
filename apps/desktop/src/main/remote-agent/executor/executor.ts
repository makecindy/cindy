/**
 * 远程 Agent 执行器(控制端)：一个任务一份，任务结束即关闭。
 *
 * Agent 所在电脑发来的每个文件 / 命令请求都在这里先过权限上限，再在本机执行：
 *  - `handle(op, body)`：原始操作(Pi 的工具后端)；
 *  - `callTool(name, args)`：Claude Code 风格的 Bash / BashOutput / KillShell / Read / Write / Edit /
 *    NotebookEdit(Claude Code 的自带文件与命令工具关掉后由它顶替)。
 * 写文件前通知「每轮改动对比」抓取改前内容；命令执行后登记一次无法预知范围的改动。
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
  ReadStateTracker,
  textResult,
  type FileWriteHooks,
  type PdfTextExtractor,
  type RipgrepRunner,
  type ToolResult,
} from './files';
import type { ExecutorAction, ExecutorGate, ExecutorGateDecision, ExecutorGateMode } from './gate';
import { piGrep, type PiGrepInput } from './search';
import { resolveExecutorShell, runOnce, ShellSession } from './shell';
import { ExecutorPathError, type ExecutorWorkspace } from './workspace';

/** Pi bash 的超时(秒)上限，与 Pi 侧 Cindy 桥的上限一致。 */
const PI_BASH_MAX_TIMEOUT_SECONDS = 1800;

export interface ExecutorCaptureHooks {
  beforeWrite(absPath: string): Promise<void>;
  noteOpaqueWrite(): void;
}

export interface RemoteExecutorOptions {
  workspace: ExecutorWorkspace;
  gate: ExecutorGate;
  rgPath: string;
  capture?: ExecutorCaptureHooks;
  /** 后台命令输出文件所在目录。 */
  tempDir?: string;
  /** Read 读 PDF 时取文字；缺省时 PDF 不能用 Read 读取。 */
  extractPdfText?: PdfTextExtractor;
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

/** Claude Code 风格工具名(与自带工具同名，模型和界面看到的都是这些名字)。 */
export const EXECUTOR_CC_TOOL_NAMES = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit'] as const;
export type ExecutorCcToolName = (typeof EXECUTOR_CC_TOOL_NAMES)[number];

export class RemoteExecutor {
  readonly workspace: ExecutorWorkspace;
  private readonly gate: ExecutorGate;
  private readonly rg: RipgrepRunner;
  private readonly readState = new ReadStateTracker();
  private readonly shell: ShellSession;
  private readonly writeHooks: FileWriteHooks;
  private closed = false;

  constructor(private readonly opts: RemoteExecutorOptions) {
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.shell.close();
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

  private authorize(action: ExecutorAction): void {
    const decision = this.gate.authorize(action);
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
          this.authorize({ kind: 'read', path: target });
          return { data: this.workspace.mapOutputForAgent(await rawReadFile(target)).toString('base64') };
        }
        case 'fs.access': {
          const target = this.resolvePath(str(body, 'path'));
          const mode = body.mode === 'write' ? 'write' : 'read';
          this.authorize({ kind: mode, path: target });
          await rawAccess(target, mode);
          return {};
        }
        case 'fs.write': {
          const target = this.resolvePath(str(body, 'path'));
          this.authorize({ kind: 'write', path: target });
          if (typeof body.data !== 'string') throw new ExecutorRequestError('INVALID', 'data must be a base64 string');
          const data = this.workspace.mapInputFromAgent(Buffer.from(body.data, 'base64'));
          await this.writeHooks.beforeWrite(target);
          await rawWriteFile(target, data);
          return {};
        }
        case 'fs.mkdir': {
          const target = this.resolvePath(str(body, 'path'));
          this.authorize({ kind: 'write', path: target });
          await rawMkdir(target);
          return {};
        }
        case 'fs.stat': {
          const target = this.resolvePath(str(body, 'path'));
          this.authorize({ kind: 'read', path: target });
          return await rawStat(target);
        }
        case 'fs.readdir': {
          const target = this.resolvePath(str(body, 'path'));
          this.authorize({ kind: 'read', path: target, scope: 'tree' });
          return { entries: await rawReaddir(target) };
        }
        case 'fs.glob': {
          const cwd = this.resolvePath(str(body, 'cwd'));
          this.authorize({ kind: 'read', path: cwd, scope: 'tree' });
          const limit = Math.max(1, Math.floor(optionalNumber(body, 'limit') ?? 1000));
          return { paths: (await rawGlob(this.rg, str(body, 'pattern'), cwd, limit, signal)).map((item) => this.workspace.toAgentPath(item)) };
        }
        case 'fs.mime': {
          const target = this.resolvePath(str(body, 'path'));
          this.authorize({ kind: 'read', path: target });
          return { mime: await detectImageMime(target) };
        }
        case 'pi.grep': {
          const params = record(body.params) as unknown as PiGrepInput;
          if (typeof params.pattern !== 'string' || !params.pattern) throw new ExecutorRequestError('INVALID', 'pattern is required');
          const root = this.resolvePath(typeof params.path === 'string' && params.path ? params.path : '.');
          this.authorize({ kind: 'read', path: root, scope: 'tree' });
          const result = await piGrep(this.opts.rgPath, root, params, signal);
          return { ...result, text: this.workspace.mapTextForAgent(result.text) };
        }
        case 'exec.run': {
          this.workspace.virtualizeDirs([this.shell.getTempDir()]);
          const command = this.workspace.mapCommand(str(body, 'command'), resolveExecutorShell().dialect);
          const cwd = this.resolvePath(optionalString(body, 'cwd') ?? this.workspace.workingDir);
          this.authorize({ kind: 'exec', command, cwd });
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
          this.authorizeTool({ kind: 'read', path: target });
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
          this.authorizeTool({ kind: 'write', path: target });
          return this.mapToolResult(await ccWrite(target, this.workspace.mapTextFromAgent(content), this.readState, this.writeHooks, this.workspace.toAgentPath(target)));
        }
        case 'Edit': {
          const target = this.resolvePath(str(args, 'file_path'), this.shell.getCwd());
          if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
            return textResult('old_string and new_string must be strings.', true);
          }
          this.authorizeTool({ kind: 'write', path: target });
          return this.mapToolResult(await ccEdit(target, {
            old_string: this.workspace.mapTextFromAgent(args.old_string),
            new_string: this.workspace.mapTextFromAgent(args.new_string),
            replace_all: args.replace_all === true,
          }, this.readState, this.writeHooks, this.workspace.toAgentPath(target)));
        }
        case 'NotebookEdit': {
          const target = this.resolvePath(str(args, 'notebook_path'), this.shell.getCwd());
          if (typeof args.new_source !== 'string') return textResult('new_source must be a string.', true);
          const cellType = args.cell_type === 'markdown' || args.cell_type === 'code' ? args.cell_type : undefined;
          const editMode = args.edit_mode === 'insert' || args.edit_mode === 'delete' || args.edit_mode === 'replace'
            ? args.edit_mode : undefined;
          this.authorizeTool({ kind: 'write', path: target });
          return this.mapToolResult(await ccNotebookEdit(target, {
            cell_id: optionalString(args, 'cell_id'),
            new_source: this.workspace.mapTextFromAgent(args.new_source),
            cell_type: cellType,
            edit_mode: editMode,
          }, this.readState, this.writeHooks));
        }
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

  private authorizeTool(action: ExecutorAction): void {
    const decision = this.gate.authorize(action);
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

  private async bash(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const rawCommand = args.command;
    if (typeof rawCommand !== 'string' || !rawCommand.trim()) return textResult('command is required.', true);
    const command = this.workspace.mapCommand(rawCommand, resolveExecutorShell().dialect);
    this.authorizeTool({ kind: 'exec', command, cwd: this.shell.getCwd() });
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
export function executorCcToolDefinitions(platform: NodeJS.Platform = process.platform): Array<{
  name: ExecutorCcToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const where = 'in the current workspace';
  const shellNote = platform === 'win32'
    ? 'Commands run in Git Bash when available, otherwise cmd.exe.'
    : `Commands run with ${path.basename(process.env.SHELL || 'bash')}.`;
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
  ];
}
