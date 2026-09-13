import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveWindowsInputHelper } from '../input-devices/windowsHelperBinary.js';
import { isWorkLouderCodexHostMessage } from './protocol.js';
import type { WorkLouderCodexChildLike } from './WorkLouderCodexHostClient.js';

export const WINDOWS_MICRO_NATIVE_ENTRY = 'cindy:windows-micro';
const PREPARATION_STATE_REQUESTS = new Set([
  'init',
  'discover',
  'probe',
  'listen',
  'apply',
  'rebind-creator-keymap',
]);

interface WindowsMicroHostDeps {
  resolveBinary(): Promise<string>;
  spawn(binary: string): ChildProcessWithoutNullStreams;
}

/** Adapts native NDJSON to the existing utility-host lifecycle; no separate retry loop. */
export class WindowsMicroHost extends EventEmitter implements WorkLouderCodexChildLike {
  readonly whenReady: Promise<void>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly queued = new Map<string, string>();
  private ended = false;

  constructor(
    deps: WindowsMicroHostDeps = {
      resolveBinary: () => resolveWindowsInputHelper('micro'),
      spawn: (binary) => spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
    },
  ) {
    super();
    this.whenReady = Promise.resolve()
      .then(() => deps.resolveBinary())
      .then((binary) => {
        if (this.ended) return;
        const child = deps.spawn(binary);
        this.child = child;
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (this.ended) return;
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (this.ended) return;
            if (line.length > 65_536) {
              this.fail();
              return;
            }
            try {
              const message: unknown = JSON.parse(line);
              if (isWorkLouderCodexHostMessage(message)) this.emit('message', message);
            } catch {
              /* Ignore malformed device-host output. */
            }
          }
          if (!this.ended && buffer.length > 65_536) this.fail();
        });
        // Drain stderr; native diagnostics are intentionally not forwarded with raw paths.
        child.stderr.resume();
        child.stdin.on('error', () => this.fail());
        child.on('error', () => this.fail());
        child.on('exit', (code) => this.finish(code ?? 1));
        for (const line of this.queued.values()) child.stdin.write(line);
        this.queued.clear();
      })
      .catch(() => this.fail());
  }

  postMessage(message: unknown): void {
    if (this.ended) throw new Error('Windows Micro host stopped');
    const line = `${JSON.stringify(message)}\n`;
    if (line.length > 65_536) throw new Error('Windows Micro host queue exceeded');
    if (this.child) {
      this.child.stdin.write(line);
      return;
    }
    const kind =
      message && typeof message === 'object' ? (message as { kind?: unknown }).kind : undefined;
    // Stopping during preparation must never replay obsolete input/lighting work.
    if (kind === 'stop') {
      this.queued.clear();
      this.queued.set('stop', line);
      return;
    }
    if (this.queued.has('stop')) return;
    // Pollers and lighting may run throughout a slow Cargo build. Keep the latest
    // desired state per idempotent command, rather than charging them to a FIFO limit.
    const key =
      typeof kind === 'string' && PREPARATION_STATE_REQUESTS.has(kind)
        ? kind
        : `unknown:${this.queued.size}`;
    if (!this.queued.has(key) && this.queued.size >= 64)
      throw new Error('Windows Micro host queue exceeded');
    this.queued.set(key, line);
  }

  kill(): boolean {
    if (this.ended) return false;
    this.child?.kill();
    this.finish(0);
    return true;
  }

  private fail(): void {
    if (this.ended) return;
    this.emit('error', new Error('Windows Micro helper failed'));
    this.child?.kill();
    this.finish(1);
  }

  private finish(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.child = null;
    this.queued.clear();
    this.emit('exit', code);
  }
}
