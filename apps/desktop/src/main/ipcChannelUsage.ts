/**
 * IPC channel usage counts, used to rank what the window still needs from
 * cindy-host before it can run as a client every day.
 *
 * Client mode always counts invokes that find no handler and logs each channel
 * once. A source run with `CINDY_IPC_USAGE_FILE` also counts handled invokes
 * and events (see `tapIpcChannelUsage`), so a UI fixture run can be ranked
 * against `scripts/host-channel-coverage.mjs`. No Electron imports.
 */

import fs from 'node:fs';
import path from 'node:path';

export type IpcUsageKind = 'invoke' | 'event';
export type IpcUsageOutcome = 'handled' | 'missing' | 'unsupported';

export interface IpcChannelUsageEntry {
  kind: IpcUsageKind;
  count: number;
  handled: number;
  missing: number;
  unsupported: number;
}

export interface IpcChannelUsageReport {
  /** v2 keys channels by `${kind}:${channel}` to keep invoke/event distinct. */
  version: 2;
  source: string;
  mode: 'client' | 'embedded';
  startedAt: string;
  updatedAt: string;
  channels: Record<string, IpcChannelUsageEntry>;
  /** Channels with a main-process handler when the report was written. */
  registered?: IpcRegisteredChannels;
}

export interface IpcRegisteredChannels {
  invoke: string[];
  event: string[];
}

export interface IpcChannelUsage {
  record(channel: string, kind: IpcUsageKind, outcome: IpcUsageOutcome): void;
  report(): IpcChannelUsageReport;
  /** Channels without a handler, most called first. */
  topUnserved(limit: number): Array<[string, IpcChannelUsageEntry]>;
  flush(): void;
}

export interface IpcChannelUsageOptions {
  readonly mode: 'client' | 'embedded';
  /** JSON report path; written shortly after each change and on flush. */
  readonly file?: string;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly flushDelayMs?: number;
  /** Snapshot of registered handlers to include in the report (see `registeredIpcChannels`). */
  readonly registered?: () => IpcRegisteredChannels;
}

/** Invoke handlers and event listeners currently registered on an Electron-shaped ipcMain. */
export function registeredIpcChannels(ipcMain: unknown): IpcRegisteredChannels {
  const target = ipcMain as TappableIpcMain & { eventNames?: () => Array<string | symbol> };
  const invoke = target._invokeHandlers instanceof Map ? [...target._invokeHandlers.keys()] : [];
  const event = typeof target.eventNames === 'function'
    ? target.eventNames().filter((name): name is string => typeof name === 'string')
    : [];
  return { invoke: invoke.sort(), event: event.sort() };
}

export function createIpcChannelUsage(options: IpcChannelUsageOptions): IpcChannelUsage {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const channels = new Map<string, IpcChannelUsageEntry>();
  let updatedAt = startedAt;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const report = (): IpcChannelUsageReport => ({
    version: 2,
    source: `desktop ${options.mode} mode`,
    mode: options.mode,
    startedAt,
    updatedAt,
    channels: Object.fromEntries([...channels].map(([channel, entry]) => [channel, { ...entry }])),
    ...(options.registered ? { registered: options.registered() } : {}),
  });

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!options.file) return;
    try {
      fs.mkdirSync(path.dirname(options.file), { recursive: true });
      const temp = `${options.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(report(), null, 2)}\n`);
      fs.renameSync(temp, options.file);
    } catch (error) {
      options.log?.(`[ipc-usage] report write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    record(channel, kind, outcome) {
      const key = `${kind}:${channel}`;
      let entry = channels.get(key);
      if (!entry) {
        entry = { kind, count: 0, handled: 0, missing: 0, unsupported: 0 };
        channels.set(key, entry);
      }
      const firstUnserved = outcome !== 'handled' && entry.missing + entry.unsupported === 0;
      entry.count += 1;
      entry[outcome] += 1;
      updatedAt = now().toISOString();
      if (firstUnserved) options.log?.(`[ipc-usage] no handler for ${kind} ${channel} (${outcome})`);
      if (options.file && !timer) {
        timer = setTimeout(flush, options.flushDelayMs ?? 1000);
        timer.unref?.();
      }
    },
    report,
    topUnserved(limit) {
      return [...channels]
        .filter(([, entry]) => entry.missing + entry.unsupported > 0)
        .sort(([a, x], [b, y]) => (y.missing + y.unsupported) - (x.missing + x.unsupported) || a.localeCompare(b))
        .slice(0, limit)
        .map(([key, entry]) => [key.slice(entry.kind.length + 1), { ...entry }]);
    },
    flush,
  };
}

type InvokeHandlerMap = Map<string, unknown>;

interface TappableIpcMain {
  _invokeHandlers?: InvokeHandlerMap;
  handle?: (...args: never[]) => unknown;
  handleOnce?: (...args: never[]) => unknown;
  __originalHandle?: (...args: never[]) => unknown;
  emit?: (name: string | symbol, ...args: unknown[]) => boolean;
  listenerCount?: (name: string | symbol) => number;
}

/**
 * Electron's `handle()` asks `_invokeHandlers.has()` before it registers, the
 * same lookup an invoke makes. Wrap the registration entry points so a lookup
 * made while registering is never mistaken for a renderer call.
 */
export function guardIpcRegistration(ipcMain: unknown): () => boolean {
  const target = ipcMain as TappableIpcMain & { __ipcRegistrationGuard?: () => boolean };
  if (target.__ipcRegistrationGuard) return target.__ipcRegistrationGuard;
  let depth = 0;
  const wrap = (key: 'handle' | 'handleOnce' | '__originalHandle') => {
    const original = target[key];
    if (typeof original !== 'function') return;
    target[key] = ((...args: never[]) => {
      depth += 1;
      try {
        return original.apply(target, args);
      } finally {
        depth -= 1;
      }
    }) as never;
  };
  wrap('handle');
  wrap('handleOnce');
  wrap('__originalHandle');
  const registering = () => depth > 0;
  target.__ipcRegistrationGuard = registering;
  return registering;
}

/**
 * Count every renderer invoke and event (source runs only). Lookups keep their
 * results; this only observes them.
 */
export function tapIpcChannelUsage(ipcMain: unknown, usage: IpcChannelUsage): void {
  const target = ipcMain as TappableIpcMain;
  const registering = guardIpcRegistration(ipcMain);
  const handlers = target._invokeHandlers;
  if (handlers instanceof Map) {
    const has = handlers.has.bind(handlers);
    handlers.has = (channel: string) => {
      const found = has(channel);
      if (!registering() && typeof channel === 'string') usage.record(channel, 'invoke', found ? 'handled' : 'missing');
      return found;
    };
  }
  if (typeof target.emit === 'function' && typeof target.listenerCount === 'function') {
    const emit = target.emit.bind(target);
    const listenerCount = target.listenerCount.bind(target);
    target.emit = (name: string | symbol, ...args: unknown[]) => {
      if (typeof name === 'string') usage.record(name, 'event', listenerCount(name) > 0 ? 'handled' : 'missing');
      return emit(name, ...args);
    };
  }
}
