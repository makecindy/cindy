import spawn from 'cross-spawn';
import { spawn as spawnNative, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { killProcessTree } from '../scheduler-host/proc-util.js';
import { prepareWindowsStdioLaunch } from './windowsStdioLaunch.js';

export interface StdioAppParameters {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

/** Reuse the launcher's recovered PATH without inheriting Cindy's credentials. */
export async function stdioAppEnvironment(selected: Record<string, string>, host: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, home = homedir()): Promise<Record<string, string>> {
  const basics = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']);
  const nameOf = (name: string) => platform === 'win32' ? name.toUpperCase() : name;
  const env: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(host)) {
    if (typeof value === 'string' && basics.has(name.toUpperCase()) && !value.startsWith('()')) env[nameOf(name)] = value;
  }
  // uv's user install is not necessarily in a Dock-launched login-shell PATH.
  // Append fallbacks, preserving version-manager order and explicit user PATH.
  if (platform !== 'win32' && !Object.hasOwn(selected, 'PATH')) {
    const entries = env.PATH?.split(path.posix.delimiter).filter(Boolean) ?? [];
    const candidates = [path.join(home, '.local', 'bin'), ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])];
    for (const directory of candidates) {
      if (!entries.includes(directory) && await fs.stat(directory).then(stat => stat.isDirectory(), () => false)) entries.push(directory);
    }
    if (entries.length) env.PATH = entries.join(path.posix.delimiter);
  }
  for (const [name, value] of Object.entries(selected)) env[nameOf(name)] = value;
  return env;
}

/** Foreign output can echo configuration secrets, including in protocol errors/log messages. */
function privateOutput(env: Record<string, string>) {
  const values = [...new Set(Object.values(env).filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = values.map(value => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return value.length < 8 ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped;
  }).join('|');
  if (!pattern) return (message: JSONRPCMessage) => message;
  const matcher = new RegExp(pattern, 'gu');
  const displayFields = new Set(['title', 'description', 'text', 'instructions', 'systemPrompt', 'message', 'statusMessage', 'reason']);
  function redactRecord(record: Record<string, unknown>, freeText: boolean, isResult = false): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [
      key, visit(value, freeText || (isResult && (key === 'structuredContent' || key === 'completion')), displayFields.has(key)),
    ]));
  }
  // MCP uses these display fields across tools, prompts, resources and nested
  // content blocks. Keep names, URIs, schema keys and other protocol identifiers
  // intact. Structured tool output and diagnostics can use arbitrary field names.
  function visit(value: unknown, freeText: boolean, display = false): unknown {
    if (typeof value === 'string' && (freeText || display)) return value.replace(matcher, '[redacted]');
    if (Array.isArray(value)) return value.map(item => visit(item, freeText));
    if (value && typeof value === 'object') return redactRecord(value as Record<string, unknown>, freeText);
    return value;
  }
  const redact = (value: unknown) => visit(value, true);
  return (message: JSONRPCMessage): JSONRPCMessage => {
    if ('result' in message) return { ...message, result: redactRecord(message.result, false, true) };
    if ('error' in message) return { ...message, error: redact(message.error) } as JSONRPCMessage;
    if ('method' in message && message.method === 'notifications/message' && message.params)
      return { ...message, params: { ...message.params, data: redact(message.params.data),
        ...(typeof message.params.logger === 'string' ? { logger: redact(message.params.logger) } : {}) } } as JSONRPCMessage;
    if ('method' in message && message.params)
      return { ...message, params: redactRecord(message.params, false) } as JSONRPCMessage;
    return message;
  };
}

/** SDK framing with an owned process tree. SDK 1.29's stdio close only kills its direct child. */
export class AppStdioTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private child?: ChildProcess;
  private readonly buffer = new ReadBuffer();
  private readonly redact: ReturnType<typeof privateOutput>;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private ended?: Promise<boolean>;
  private treeStopping?: Promise<void>;
  private treeStopFailed = false;

  constructor(private readonly config: StdioAppParameters, private readonly platform: NodeJS.Platform = process.platform) { this.redact = privateOutput(config.env); }

  start(): Promise<void> {
    if (this.starting || this.closed) return Promise.reject(new Error('MCP_STDIO_CONNECTION_CLOSED'));
    return this.starting = this.startProcess();
  }

  private async startProcess(): Promise<void> {
    const env = await stdioAppEnvironment(this.config.env, process.env, this.platform);
    const cwd = this.config.cwd ?? homedir();
    if (!path.isAbsolute(cwd) || !await fs.stat(cwd).then(stat => stat.isDirectory(), () => false)) throw new Error('MCP_STDIO_INVALID_CWD');
    const windows = this.platform === 'win32';
    const launch = windows ? await prepareWindowsStdioLaunch(this.config.command, this.config.args, { cwd, env }) : this.config;
    if (this.closed) throw new Error('MCP_STDIO_CONNECTION_CLOSED');
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = (windows ? spawnNative : spawn)(launch.command, launch.args, {
          cwd, env, shell: false, detached: !windows, windowsHide: true,
          stdio: ['pipe', 'pipe', windows ? 'pipe' : 'ignore'],
        });
      } catch { reject(new Error('MCP_STDIO_START_FAILED')); return; }
      this.child = child;
      const startFailed = () => reject(new Error('MCP_STDIO_START_FAILED'));
      if (windows) {
        // Only the supervisor writes to this pipe. The server's stderr goes to NUL.
        const status = createInterface({ input: child.stderr! });
        // The SDK starts its initialize-request timeout only after start() returns.
        const readyTimeout = setTimeout(() => status.close(), 30_000);
        status.once('line', line => {
          if (line === 'READY') resolve();
          else reject(new Error(line === 'NOT_FOUND' ? 'MCP_STDIO_COMMAND_NOT_FOUND' : 'MCP_STDIO_START_FAILED'));
          status.close();
        });
        status.on('error', startFailed);
        status.once('close', () => { clearTimeout(readyTimeout); startFailed(); });
      } else {
        child.once('spawn', resolve);
        child.once('exit', () => this.stopPosixGroup(child));
      }
      this.ended = new Promise(done => child.once('close', code => {
        this.buffer.clear();
        // The supervisor's exit status is independent of the tool's. Both 0
        // (drained) and 2 (safe startup failure) confirm no owned process remains.
        done(!windows || !child.pid || code === 0 || code === 2);
        // The owner still awaits and reports a failed tree stop. Retire the
        // disconnected client without an unobserved event-handler rejection.
        void (this.treeStopping ?? Promise.resolve()).then(() => this.onclose?.(), () => this.onclose?.());
      }));
      child.on('error', (error: NodeJS.ErrnoException) => {
        const safe = new Error(!windows && error.code === 'ENOENT' ? 'MCP_STDIO_COMMAND_NOT_FOUND' : 'MCP_STDIO_START_FAILED');
        reject(safe); this.onerror?.(safe);
      });
      child.stdin?.on('error', () => this.onerror?.(new Error('MCP_STDIO_WRITE_FAILED')));
      child.stdout?.on('error', () => this.onerror?.(new Error('MCP_STDIO_READ_FAILED')));
      child.stdout?.on('data', (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (;;) {
          try {
            const message = this.buffer.readMessage();
            if (message === null) break;
            this.onmessage?.(this.redact(message));
          } catch {
            this.onerror?.(new Error('MCP_STDIO_INVALID_MESSAGE'));
          }
        }
      });
    });
  }

  close(): Promise<void> {
    this.closed = true;
    if (!this.closing) {
      const closing = this.closeProcess();
      this.closing = closing;
      void closing.catch(() => { if (this.closing === closing) this.closing = undefined; });
    }
    return this.closing;
  }

  private trackTreeStop(stopping: Promise<void>): Promise<void> {
    this.treeStopping = stopping;
    this.treeStopFailed = false;
    void stopping.catch(() => { if (this.treeStopping === stopping) this.treeStopFailed = true; });
    return stopping;
  }

  private stopPosixGroup(child: ChildProcess): Promise<void> {
    if (this.treeStopping) return this.treeStopping;
    return this.trackTreeStop((async () => {
      if (!child.pid) return;
      const pid = child.pid;
      const waitForExit = async () => {
        const deadline = Date.now() + 500;
        for (;;) {
          try { process.kill(-pid, 0); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
            // Darwin may briefly report EPERM while the last group member is
            // exiting. Only ESRCH confirms absence; a persistent denial fails.
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw new Error('MCP_STDIO_CLOSE_FAILED');
          }
          if (Date.now() >= deadline) return false;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw new Error('MCP_STDIO_CLOSE_FAILED');
      }
      if (await waitForExit()) return;
      await new Promise<void>(resolve => killProcessTree(pid, child, () => resolve()));
      // A successful signal is not an exit receipt. Conversely the group may
      // have disappeared just before a failed SIGKILL; confirm in both cases.
      if (!await waitForExit()) throw new Error('MCP_STDIO_CLOSE_FAILED');
    })());
  }

  private async closeProcess(): Promise<void> {
    // Environment/cwd resolution may still be pending (for example on a mounted
    // filesystem). Observe it without blocking release: the closed check directly
    // before spawn prevents that pending attempt from creating a late process.
    void this.starting?.catch(() => {});
    const child = this.child;
    if (!child) return;
    // A process group can be retried while its original POSIX launcher is alive.
    if (this.treeStopFailed && child.exitCode === null && child.signalCode === null) {
      this.treeStopping = undefined;
      this.treeStopFailed = false;
    }
    let force: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      child.stdin?.end();
      if (this.platform !== 'win32') force = setTimeout(() => { void this.stopPosixGroup(child); }, 500);
      const clean = await Promise.race([
        this.ended!.then(async confirmed => { await this.treeStopping; return confirmed; }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            // Even an unresponsive supervisor owns a kill-on-close job. Use its
            // original process handle; without its receipt we must report failure.
            if (this.platform === 'win32') {
              try { child.kill(); } catch { /* The cleanup remains unconfirmed below. */ }
            }
            reject(new Error('MCP_STDIO_CLOSE_FAILED'));
          }, 3_000);
        }),
      ]);
      if (!clean) throw new Error('MCP_STDIO_CLOSE_FAILED');
    } finally {
      clearTimeout(force); clearTimeout(deadline);
      this.buffer.clear();
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('MCP_STDIO_CONNECTION_CLOSED');
    await new Promise<void>((resolve, reject) => this.child!.stdin!.write(serializeMessage(message), error => {
      if (error) reject(new Error('MCP_STDIO_WRITE_FAILED')); else resolve();
    }));
  }
}
