/**
 * 远程 Agent 执行器的命令执行(控制端)。
 *
 * 命令在本机执行，进程组可整体结束；输出合并 stdout/stderr(与终端里看到的顺序一致)。
 *  - `runOnce`：一次性执行，给 Pi 的 bash 用(Pi 自己负责截断与超时提示)；
 *  - `ShellSession`：给 Claude Code 风格的 Bash 用，跨调用保留当前目录(环境变量不保留，
 *    与 Claude Code 一致)，默认 2 分钟、最长 10 分钟超时，输出超过 30000 字符时保留首尾；
 *    支持后台命令，输出写到本机临时文件，可查看增量输出、可结束。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CC_BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const CC_BASH_MAX_TIMEOUT_MS = 600_000;
export const CC_BASH_MAX_OUTPUT_CHARS = 30_000;
/** 一次性执行的输出上限(超出部分丢弃头部，保留最新输出)。 */
const RUN_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const MAX_BACKGROUND_JOBS = 32;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PATH 上的可执行文件(Windows)。 */
function findOnWindowsPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (!dir) continue;
    const candidate = path.win32.join(dir.replace(/^"|"$/g, ''), name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Windows 上的 Git Bash(Agent 的命令都是 bash 写法；与 Claude Code 在 Windows 上的要求一致)：
 * CLAUDE_CODE_GIT_BASH_PATH → PATH 上 git.exe 旁的 bin\bash.exe → 常见安装位置。找不到返回 null。
 */
export function findWindowsGitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  // 只接受名为 bash.exe 的现存文件，避免环境变量里的任意字符串被当成可执行体。
  const valid = (value: string | undefined): string | null =>
    value && /[/\\]bash\.exe$/i.test(value) && fs.existsSync(value) ? value : null;
  const explicit = valid(env.CLAUDE_CODE_GIT_BASH_PATH);
  if (explicit) return explicit;
  const git = findOnWindowsPath('git.exe', env);
  if (git) {
    const gitDir = path.win32.dirname(git);
    for (const candidate of [
      path.win32.join(path.win32.dirname(gitDir), 'bin', 'bash.exe'),
      path.win32.join(gitDir, 'bash.exe'),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]
    .filter((root): root is string => !!root);
  for (const root of roots) {
    const candidate = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 脚本方言：bash 系与 cmd 的包装语法完全不同，按方言生成脚本。 */
export type ExecutorShellDialect = 'bash' | 'cmd';

export interface ExecutorShell {
  file: string;
  dialect: ExecutorShellDialect;
  /** 脚本文件名(固定值；执行目录即脚本所在目录)。 */
  scriptName: string;
  /** 执行脚本文件的命令行参数(只放固定字符串，脚本内容与路径都不进命令行)。 */
  args: string[];
}

/** 本机用于执行命令的 shell。 */
export function resolveExecutorShell(): ExecutorShell {
  if (process.platform === 'win32') {
    const gitBash = findWindowsGitBash();
    if (gitBash) return { file: gitBash, dialect: 'bash', scriptName: 'script.sh', args: ['script.sh'] };
    return {
      file: process.env.ComSpec || 'cmd.exe',
      dialect: 'cmd',
      scriptName: 'script.cmd',
      args: ['/d', '/s', '/c', 'script.cmd'],
    };
  }
  const preferred = process.env.SHELL;
  const file = preferred && /\/(zsh|bash)$/.test(preferred) && fs.existsSync(preferred)
    ? preferred
    : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file, dialect: 'bash', scriptName: 'script.sh', args: ['script.sh'] };
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 进程已退出。
    }
  }
}

function terminate(child: ChildProcess): void {
  killTree(child, 'SIGTERM');
  const timer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
}

export interface RunResult {
  output: Buffer;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** 有上限的输出缓冲：超过上限时丢弃最早的内容。 */
class OutputBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  dropped = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
      this.dropped += first.length;
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onData?: (chunk: Buffer) => void;
}

interface ScriptFile {
  /** 脚本所在目录(执行时作为 cwd，脚本里再 cd 到真正的命令目录)。 */
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * 把脚本内容写成临时脚本文件，交给 shell 按文件执行。
 *
 * 脚本内容与任何动态路径都不进命令行(命令行只带固定脚本文件名)：既避免路径里的
 * 引号 / 空格 / 元字符改变命令行语义，也绕开 Windows 命令行长度上限；bash 与 cmd
 * 各按自己的方言包装开头的 `cd`(脚本目录是临时目录，命令目录在脚本里切过去)。
 */
async function writeScriptFile(
  baseDir: string,
  shell: ExecutorShell,
  cwd: string,
  body: string,
): Promise<ScriptFile> {
  const dir = await fsp.mkdtemp(path.join(baseDir, 'cindy-run-'));
  const content = shell.dialect === 'cmd'
    ? `@echo off\r\ncd /d "${cwd.replace(/"/g, '')}" || exit /b 1\r\n${body}\r\n`
    : `cd -- ${shellQuote(cwd)} || exit 1\n${body}\n`;
  await fsp.writeFile(path.join(dir, shell.scriptName), content);
  return {
    dir,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}

/** 执行一条 shell 命令直到结束；超时 / 取消时结束整个进程组。 */
export function runOnce(script: string, opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ output: Buffer.alloc(0), exitCode: null, timedOut: false, aborted: true });
      return;
    }
    void (async () => {
      const shell = resolveExecutorShell();
      let file: ScriptFile;
      try {
        file = await writeScriptFile(os.tmpdir(), shell, opts.cwd, script);
      } catch (error) {
        reject(error);
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(shell.file, shell.args, {
          cwd: file.dir,
          env: opts.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error) {
        await file.cleanup();
        reject(error);
        return;
      }
      const buffer = new OutputBuffer(RUN_MAX_OUTPUT_BYTES);
      let timedOut = false;
      let aborted = false;
      const onChunk = (chunk: Buffer) => {
        buffer.push(chunk);
        opts.onData?.(chunk);
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);
      const timer = opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate(child);
          }, opts.timeoutMs)
        : undefined;
      const onAbort = () => {
        aborted = true;
        terminate(child);
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', (error) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        void file.cleanup();
        reject(error);
      });
      child.once('close', (code) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        void file.cleanup();
        resolve({ output: buffer.toBuffer(), exitCode: code, timedOut, aborted });
      });
    })();
  });
}

/** 超过上限时保留首尾，中间注明省略了多少行。 */
export function truncateOutput(text: string, max = CC_BASH_MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  const omitted = text.slice(half, text.length - half);
  const omittedLines = omitted.split('\n').length - 1;
  return `${head}\n\n... [${omittedLines} lines truncated] ...\n\n${tail}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

export interface ShellCommandResult {
  text: string;
  isError: boolean;
}

interface BackgroundJob {
  id: string;
  command: string;
  outputPath: string;
  child: ChildProcess;
  exitCode: number | null;
  done: boolean;
  killed: boolean;
  readOffset: number;
}

export interface ShellSessionOptions {
  workingDir: string;
  /** 当前目录离开这些目录时重置回工作目录(与 Claude Code 一致)。 */
  isAllowedCwd: (cwd: string) => boolean;
  /** 后台命令输出文件所在目录(本机)。 */
  tempDir?: string;
}

/** Git Bash 的 pwd 使用 MSYS 挂载路径，权限与后续文件工具必须回到 Windows 本机路径。 */
export function normalizeShellCwd(cwd: string): string {
  if (process.platform !== 'win32') return cwd;
  if (/^\/tmp(?:\/|$)/.test(cwd)) return path.join(os.tmpdir(), cwd.slice(4));
  const drive = /^\/([A-Za-z])(?:\/|$)/.exec(cwd);
  return drive ? path.win32.normalize(drive[1].toUpperCase() + ':/' + cwd.slice(drive[0].length)) : cwd;
}

export class ShellSession {
  private cwd: string;
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly tempDir: string;
  private closed = false;

  constructor(private readonly opts: ShellSessionOptions) {
    this.cwd = opts.workingDir;
    this.tempDir = opts.tempDir ?? path.join(os.tmpdir(), 'cindy-remote-agent');
  }

  getCwd(): string {
    return this.cwd;
  }

  getTempDir(): string {
    return this.tempDir;
  }

  /** 执行一条命令；命令结束后记下它所在的目录，下一条命令从那里开始。 */
  async run(command: string, timeoutMs: number | undefined, signal?: AbortSignal): Promise<ShellCommandResult> {
    if (this.closed) return { text: 'The shell session has ended.', isError: true };
    const timeout = Math.min(Math.max(1, Math.floor(timeoutMs ?? CC_BASH_DEFAULT_TIMEOUT_MS)), CC_BASH_MAX_TIMEOUT_MS);
    await fsp.mkdir(this.tempDir, { recursive: true });
    const cwdFile = path.join(this.tempDir, `cwd-${randomUUID()}`);
    const startCwd = await this.validCwd();
    const shell = resolveExecutorShell();
    // 开头的 `cd` 到命令目录由 runOnce 按方言包装；cmd 没有 eval 也没有 /dev/null
    // 重定向，脚本体按方言分别生成(cmd 不跟踪 cwd，与 cmd 回退路径的既有行为一致)。
    const script = shell.dialect === 'cmd'
      ? command
      : `eval ${shellQuote(command)} < /dev/null; __cindy_status=$?; pwd -P >| ${shellQuote(cwdFile)}; exit $__cindy_status`;
    const started = Date.now();
    let result: RunResult;
    try {
      result = await runOnce(script, { cwd: startCwd, timeoutMs: timeout, signal });
    } catch (error) {
      await fsp.rm(cwdFile, { force: true });
      return { text: `Failed to run command: ${(error as Error).message}`, isError: true };
    }
    let resetNote = '';
    try {
      const next = normalizeShellCwd((await fsp.readFile(cwdFile, 'utf8')).trim());
      if (next) {
        if (this.opts.isAllowedCwd(next)) this.cwd = next;
        else {
          this.cwd = this.opts.workingDir;
          resetNote = `\nShell cwd was reset to ${this.opts.workingDir}`;
        }
      }
    } catch {
      // 命令中途退出(exit / 超时 / 取消)时没有写出目录，保持原目录。
    } finally {
      await fsp.rm(cwdFile, { force: true });
    }
    const output = truncateOutput(result.output.toString('utf8').replace(/\s+$/, ''));
    if (result.aborted) {
      return { text: `${output}\n[Command was interrupted]`.trim(), isError: true };
    }
    if (result.timedOut) {
      return { text: `${output}\nCommand timed out after ${formatDuration(Date.now() - started)}`.trim(), isError: true };
    }
    if (result.exitCode !== 0) {
      return { text: `${output}${resetNote}\nExit code ${String(result.exitCode)}`.trim(), isError: true };
    }
    return { text: `${output}${resetNote}`.trim() || '(No output)', isError: false };
  }

  /** 后台执行：立即返回编号与输出文件位置。 */
  async startBackground(command: string): Promise<ShellCommandResult> {
    if (this.closed) return { text: 'The shell session has ended.', isError: true };
    this.pruneJobs();
    if ([...this.jobs.values()].filter((job) => !job.done).length >= MAX_BACKGROUND_JOBS) {
      return { text: `Too many background commands are running (limit ${MAX_BACKGROUND_JOBS}). Stop one with KillShell first.`, isError: true };
    }
    await fsp.mkdir(this.tempDir, { recursive: true });
    const id = `bash_${randomUUID().slice(0, 8)}`;
    const outputPath = path.join(this.tempDir, `${id}.output`);
    const startCwd = await this.validCwd();
    const shell = resolveExecutorShell();
    // 后台命令同样按方言生成脚本(cmd 没有 eval / /dev/null)：脚本写临时文件，
    // 命令行只带固定脚本文件名，脚本内容与路径都不进命令行。
    const body = shell.dialect === 'cmd' ? command : `eval ${shellQuote(command)} < /dev/null`;
    let file: ScriptFile;
    try {
      file = await writeScriptFile(this.tempDir, shell, startCwd, body);
    } catch (error) {
      return { text: `Failed to start command: ${(error as Error).message}`, isError: true };
    }
    const out = fs.openSync(outputPath, 'w');
    let child: ChildProcess;
    try {
      child = spawn(shell.file, shell.args, {
        cwd: file.dir,
        env: process.env,
        stdio: ['ignore', out, out],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      fs.closeSync(out);
      void file.cleanup();
      return { text: `Failed to start command: ${(error as Error).message}`, isError: true };
    }
    fs.closeSync(out);
    const job: BackgroundJob = { id, command, outputPath, child, exitCode: null, done: false, killed: false, readOffset: 0 };
    child.once('exit', (code) => {
      job.exitCode = code;
      job.done = true;
      void file.cleanup();
    });
    child.once('error', () => {
      job.done = true;
      void file.cleanup();
    });
    this.jobs.set(id, job);
    return {
      text: `Command running in background with ID: ${id}. Output is being written to: ${outputPath}. Use BashOutput with this ID to read new output, and KillShell to stop it.`,
      isError: false,
    };
  }

  /** 读取后台命令自上次读取以来的新输出。 */
  async readBackground(id: string, filter?: string): Promise<ShellCommandResult> {
    const job = this.jobs.get(id);
    if (!job) return { text: `No background command found with ID: ${id}`, isError: true };
    let text = '';
    try {
      const handle = await fsp.open(job.outputPath, 'r');
      try {
        const stat = await handle.stat();
        const length = Math.max(0, stat.size - job.readOffset);
        if (length > 0) {
          const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, job.readOffset);
          job.readOffset += bytesRead;
          text = buffer.subarray(0, bytesRead).toString('utf8');
        }
      } finally {
        await handle.close();
      }
    } catch {
      text = '';
    }
    if (filter) {
      try {
        const pattern = new RegExp(filter);
        text = text.split('\n').filter((line) => pattern.test(line)).join('\n');
      } catch {
        return { text: `Invalid filter regular expression: ${filter}`, isError: true };
      }
    }
    const status = job.killed ? 'killed' : job.done ? 'completed' : 'running';
    const lines = [
      `<status>${status}</status>`,
      ...(job.done && job.exitCode !== null ? [`<exit_code>${job.exitCode}</exit_code>`] : []),
      text ? `<output>\n${truncateOutput(text.replace(/\s+$/, ''))}\n</output>` : '<output>(No new output)</output>',
    ];
    return { text: lines.join('\n'), isError: false };
  }

  killBackground(id: string): ShellCommandResult {
    const job = this.jobs.get(id);
    if (!job) return { text: `No background command found with ID: ${id}`, isError: true };
    if (job.done) return { text: `Background command ${id} has already finished.`, isError: false };
    job.killed = true;
    terminate(job.child);
    return { text: `Successfully killed background command ${id} (${job.command})`, isError: false };
  }

  /** 任务结束：结束所有后台命令并清理输出文件。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (!job.done) terminate(job.child);
      await fsp.rm(job.outputPath, { force: true });
    }
    this.jobs.clear();
  }

  private pruneJobs(): void {
    if (this.jobs.size < MAX_BACKGROUND_JOBS * 2) return;
    for (const [id, job] of this.jobs) {
      if (job.done) {
        void fsp.rm(job.outputPath, { force: true });
        this.jobs.delete(id);
      }
    }
  }

  private async validCwd(): Promise<string> {
    try {
      const stat = await fsp.stat(this.cwd);
      if (stat.isDirectory()) return this.cwd;
    } catch {
      // 目录被删时退回工作目录。
    }
    this.cwd = this.opts.workingDir;
    return this.cwd;
  }
}
