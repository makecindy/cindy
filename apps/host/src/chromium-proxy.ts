/**
 * The Host side of the Chromium proxy helper (release table row 28, 28c). The helper
 * (chromium-proxy-worker.cjs, run by the Electron the Host release carries on macOS and Windows) asks
 * Chromium which proxy a URL takes, PAC and auto-discovery included, as the desktop's session.resolveProxy
 * does. This module starts it on demand, waits for it with limits, restarts it with backoff and stops it by its
 * handle. outbound-proxy.ts decides when it is asked: never while proxy environment variables are set (the
 * resolver core answers from them first); on macOS only when the system settings use PAC or auto-discovery;
 * on Windows from the first resolution on.
 *
 * Every wait has a limit: a resolution that the helper cannot answer within ANSWER_WAIT_MS (starting,
 * restarting, slow or gone) rejects, and the caller falls back (macOS: the static settings, 28b; Windows:
 * direct, reported unknown by the resolver core). The limit stays under the core's own 2 s timeout so that the
 * caller's fallback, not the core's, applies. A helper that does not become ready within START_TIMEOUT_MS, or
 * stops answering a ping, is stopped and started again later, after a backoff that doubles up to
 * MAX_BACKOFF_MS and resets once it is ready.
 *
 * The helper is told only the URL, without user info, query or fragment, and answers only a PAC result string.
 * The helper process, its stdio and its start timer are unreferenced, so an idle helper never keeps a short Host
 * command alive; a resolution in progress keeps it alive through its own bounded timer. When the Host exits, the
 * helper's stdin closes and it quits.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createMakerLogger } from '../../desktop/src/main/maker-host/logger-adapter.ts';
import { hostRuntimeLayout } from './runtime-layout.mjs';

const log = createMakerLogger('outbound-proxy');

/** Total wait of one resolution, from the call to the answer (below the resolver core's 2 s). */
export const ANSWER_WAIT_MS = 1800;
/** A helper not ready by then is stopped and started again after the backoff. */
export const START_TIMEOUT_MS = 15_000;
/** A helper that does not answer a ping within this, after a resolution timed out, is stopped. */
export const PING_TIMEOUT_MS = 3000;
export const FIRST_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;
const MAX_LINE = 8192;

export type ChromiumProxyHelperState = 'not-started' | 'starting' | 'ready' | 'backoff' | 'unavailable' | 'stopped';

export class ChromiumProxyUnavailableError extends Error {
  constructor(reason: string) {
    super(`the Chromium proxy helper is unavailable (${reason})`);
    this.name = 'ChromiumProxyUnavailableError';
  }
}

export interface ChromiumProxyHelper {
  /** Chromium's PAC result string for the URL; rejects with ChromiumProxyUnavailableError when it has none in time. */
  resolveProxy(url: string): Promise<string>;
  state(): ChromiumProxyHelperState;
  /** Stops the helper by its handle (stdin closed, then SIGTERM, then SIGKILL); nothing starts afterwards. */
  close(): Promise<void>;
}

export interface ChromiumProxyHelperOptions {
  /** The Host data directory; the helper's userData is its own subdirectory. */
  profileDir: string;
  /** Electron and the helper script; by default the release's, or the repository's when run from source. */
  assets?: () => { binary: string; script: string } | null;
  spawnImpl?: typeof nodeSpawn;
  now?: () => number;
}

/** Only scheme, host, port and path go to the helper: never user info, a query or a fragment. */
export function helperUrl(url: string): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

/** Only platform paths and locale reach Chromium. Host environments can carry arbitrary provider credentials. */
const SYSTEM_ENV = new Set([
  'HOME', 'PATH', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA',
  'SYSTEMDRIVE', 'HOMEDRIVE', 'HOMEPATH',
]);
export function helperEnv(profile: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (SYSTEM_ENV.has(key.toUpperCase())) env[key] = value;
  }
  env.CINDY_PROXY_WORKER_PROFILE = profile;
  return env;
}

function defaultAssets(): { binary: string; script: string } | null {
  const layout = hostRuntimeLayout();
  if (layout.packaged) {
    return layout.electronBinary && layout.proxyWorker ? { binary: layout.electronBinary, script: layout.proxyWorker } : null;
  }
  try {
    const binary = createRequire(new URL('../../desktop/package.json', import.meta.url))('electron') as string;
    return { binary, script: fileURLToPath(new URL('./chromium-proxy-worker.cjs', import.meta.url)) };
  } catch {
    return null;
  }
}

interface Pending { resolve: (value: string) => void; reject: (error: Error) => void }

interface Worker {
  child: ChildProcess;
  ready: Promise<void>;
  isReady: () => boolean;
  request: (message: Record<string, unknown>, timeoutMs: number) => Promise<string>;
  exited: Promise<void>;
}

export function createChromiumProxyHelper(options: ChromiumProxyHelperOptions): ChromiumProxyHelper {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const now = options.now ?? Date.now;
  const assets = options.assets ?? defaultAssets;
  let worker: Worker | null = null;
  let state: ChromiumProxyHelperState = 'not-started';
  let retryAt = 0;
  let backoff = FIRST_BACKOFF_MS;
  let closed = false;
  let warned = false;

  function warnOnce(reason: string): void {
    if (warned) return;
    warned = true;
    log.warn('Chromium proxy helper unavailable — using the fallback for system proxy settings', { reason });
  }

  function stopWorker(target: Worker): Promise<void> {
    if (worker === target) worker = null;
    target.child.stdin?.end();
    const terminate = setTimeout(() => target.child.kill('SIGTERM'), 500);
    const kill = setTimeout(() => target.child.kill('SIGKILL'), 1500);
    terminate.unref?.();
    kill.unref?.();
    return target.exited.finally(() => { clearTimeout(terminate); clearTimeout(kill); });
  }

  function deferRestart(reason: string, nextState: 'backoff' | 'unavailable' = 'backoff'): void {
    state = nextState;
    retryAt = now() + backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    warnOnce(reason);
  }

  /** Stop this worker and allow the next start only after the backoff. */
  function fail(target: Worker, reason: string): void {
    if (worker !== target) return;
    void stopWorker(target);
    if (!closed) deferRestart(reason);
  }

  function start(): Worker | null {
    const found = assets();
    if (!found) {
      deferRestart('no Electron runtime', 'unavailable');
      return null;
    }
    const profile = path.join(options.profileDir, 'proxy-helper');
    let child: ChildProcess;
    try {
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      child = spawnImpl(found.binary, [found.script], {
        env: helperEnv(profile), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
    } catch {
      deferRestart('start failed');
      return null;
    }
    child.unref?.();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    let ready = false;
    let sequence = 0;
    const pending = new Map<number, Pending>();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    readyPromise.catch(() => {});
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    const self: Worker = {
      child,
      ready: readyPromise,
      isReady: () => ready,
      exited,
      request(message, timeoutMs) {
        const id = ++sequence;
        return new Promise<string>((resolve, reject) => {
          // Referenced: a short command (cindy-host login) waiting for this answer must not exit meanwhile.
          const timer = setTimeout(() => { pending.delete(id); reject(new ChromiumProxyUnavailableError('no answer in time')); }, timeoutMs);
          pending.set(id, {
            resolve: (value) => { clearTimeout(timer); resolve(value); },
            reject: (error) => { clearTimeout(timer); reject(error); },
          });
          child.stdin?.write(`${JSON.stringify({ id, ...message })}\n`, (error) => {
            if (error) {
              pending.get(id)?.reject(new ChromiumProxyUnavailableError('write failed'));
              pending.delete(id);
            }
          });
        });
      },
    };
    const gone = () => {
      const error = new ChromiumProxyUnavailableError('the helper exited');
      rejectReady(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      fail(self, 'the helper exited');
    };
    child.once('exit', gone);
    child.once('error', gone);
    child.stdin?.on('error', () => {});
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      if (line.length > MAX_LINE) return;
      let value: { ready?: unknown; pid?: unknown; id?: unknown; result?: unknown; error?: unknown };
      try { value = JSON.parse(line); } catch { return; }
      if (worker !== self || !value || typeof value !== 'object') return;
      if (value.ready === true && value.pid === child.pid) {
        ready = true;
        state = 'ready';
        backoff = FIRST_BACKOFF_MS;
        warned = false;
        resolveReady();
        return;
      }
      const entry = typeof value.id === 'number' ? pending.get(value.id) : undefined;
      if (!entry) return;
      pending.delete(value.id as number);
      if (typeof value.result === 'string') entry.resolve(value.result);
      else entry.reject(new ChromiumProxyUnavailableError(typeof value.error === 'string' ? value.error : 'no result'));
    });
    const startTimer = setTimeout(() => { if (!ready) fail(self, 'not ready in time'); }, START_TIMEOUT_MS);
    startTimer.unref?.();
    void readyPromise.then(() => clearTimeout(startTimer), () => clearTimeout(startTimer));
    state = 'starting';
    return self;
  }

  /** After a resolution timed out: a helper that does not answer a ping is stopped. */
  function checkAlive(target: Worker): void {
    target.request({ method: 'ping' }, PING_TIMEOUT_MS).catch(() => fail(target, 'no answer to a ping'));
  }

  return {
    async resolveProxy(url) {
      const deadline = now() + ANSWER_WAIT_MS;
      if (closed) throw new ChromiumProxyUnavailableError('stopped');
      if (!worker) {
        if (state === 'unavailable' && now() < retryAt) throw new ChromiumProxyUnavailableError('no Electron runtime');
        if (state === 'backoff' && now() < retryAt) throw new ChromiumProxyUnavailableError('restarting');
        worker = start();
        if (!worker) throw new ChromiumProxyUnavailableError((state as ChromiumProxyHelperState) === 'unavailable' ? 'no Electron runtime' : 'start failed');
      }
      const target = worker;
      if (!target.isReady()) {
        // Never an answer before the helper is ready: wait for it, within the limit.
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([target.ready, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ChromiumProxyUnavailableError('not ready yet')), Math.max(0, deadline - now()));
          })]);
        } finally { clearTimeout(timer); }
      }
      try {
        return await target.request({ method: 'resolve', url: helperUrl(url) }, Math.max(1, deadline - now()));
      } catch (error) {
        if (error instanceof ChromiumProxyUnavailableError && error.message.includes('no answer in time')) checkAlive(target);
        throw error;
      }
    },
    state: () => state,
    async close() {
      closed = true;
      state = 'stopped';
      if (worker) await stopWorker(worker);
    },
  };
}
