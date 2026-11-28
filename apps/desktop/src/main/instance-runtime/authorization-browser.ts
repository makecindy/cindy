import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

interface Target {
  targetId: string;
  type: string;
  url: string;
  openerId?: string;
}
export interface AuthorizationBrowserConnection {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  alive(): boolean;
  exited(): Promise<void>;
  descendants?(root: string): readonly string[];
}

async function waitForBrowserExit(connection: AuthorizationBrowserConnection): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      connection.exited(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('AUTHORIZATION_BROWSER_EXIT_TIMEOUT')), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A target may destroy itself between enumeration and close (including the bootstrap tab). */
async function closeOwnedTarget(connection: AuthorizationBrowserConnection, targetId: string): Promise<void> {
  try {
    const result = await connection.call('Target.closeTarget', { targetId });
    if (result.success === false) throw new Error('AUTHORIZATION_BROWSER_CLOSE_FAILED');
  } catch (error) {
    // Do not infer success from a CDP error code: confirm absence on the same connection.
    // If Chromium is exiting, the caller still fences on process exit/profile lock release.
    if (!connection.alive()) return;
    let remaining: Target[];
    try {
      remaining = (await connection.call('Target.getTargets')).targetInfos as Target[];
    } catch (inspectionError) {
      if (!connection.alive()) return;
      throw inspectionError;
    }
    if (remaining.some((target) => target.targetId === targetId)) throw error;
  }
}

/** Private inherited pipe: no listening TCP port, renderer bridge or URL logging. */
export async function launchAuthorizationBrowser(
  userDataDir: string,
): Promise<AuthorizationBrowserConnection> {
  const profile = path.join(userDataDir, 'cloud-authorization-browser');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const child = spawn(
    '/usr/bin/chromium',
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--password-store=gnome-libsecret',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const input = child.stdio[3] as Writable;
  const output = child.stdio[4] as Readable;
  const pending = new Map<
    number,
    { resolve(v: Record<string, unknown>): void; reject(e: Error): void; timer: NodeJS.Timeout }
  >();
  let serial = 0,
    buffer = Buffer.alloc(0),
    alive = true;
  const openers = new Map<string, string>();
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const fail = () => {
    alive = false;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('AUTHORIZATION_BROWSER_CLOSED'));
    }
    pending.clear();
  };
  child.once('error', fail);
  child.once('exit', fail);
  input.on('error', fail);
  output.on('error', fail);
  output.once('end', fail);
  output.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 4 * 1024 * 1024) {
      fail();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf(0)) >= 0) {
      const frame = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try {
        const reply = JSON.parse(frame.toString('utf8'));
        if (
          reply.method === 'Target.targetCreated' ||
          reply.method === 'Target.targetInfoChanged'
        ) {
          const target = reply.params?.targetInfo;
          if (typeof target?.targetId === 'string' && typeof target.openerId === 'string')
            openers.set(target.targetId, target.openerId);
        }
        const entry = pending.get(reply.id);
        if (!entry) continue;
        pending.delete(reply.id);
        clearTimeout(entry.timer);
        if (reply.error) entry.reject(new Error('AUTHORIZATION_BROWSER_COMMAND_FAILED'));
        else entry.resolve(reply.result ?? {});
      } catch {
        fail();
      }
    }
  });
  const connection: AuthorizationBrowserConnection = {
    alive: () => alive,
    exited: () => exited,
    descendants(root) {
      const found = new Set([root]);
      for (let size = -1; size !== found.size;) {
        size = found.size;
        for (const [child, parent] of openers) if (found.has(parent)) found.add(child);
      }
      return [...found];
    },
    call(method, params = {}) {
      if (!alive) return Promise.reject(new Error('AUTHORIZATION_BROWSER_CLOSED'));
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('AUTHORIZATION_BROWSER_TIMEOUT'));
        }, 15_000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        input.write(JSON.stringify({ id, method, params }) + '\0');
      });
    },
  };
  try {
    await connection.call('Browser.getVersion');
    await connection.call('Target.setDiscoverTargets', { discover: true });
  } catch {
    child.kill('SIGTERM');
    throw new Error('AUTHORIZATION_BROWSER_START_FAILED');
  }
  return connection;
}

/** Owns only targets it creates. Ordinary Chromium and Agent browsers are separate. */
export class AuthorizationBrowser {
  private connection: AuthorizationBrowserConnection | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly roots = new Set<string>();
  constructor(private readonly launch: () => Promise<AuthorizationBrowserConnection>) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async open(raw: string): Promise<() => Promise<void>> {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('AUTHORIZATION_BROWSER_URL_INVALID');
    return this.serial(async () => {
      let initial: Target[] = [];
      if (!this.connection?.alive()) {
        if (this.connection) await waitForBrowserExit(this.connection);
        this.connection = await this.launch();
        this.roots.clear();
        initial = (await this.connection.call('Target.getTargets')).targetInfos as Target[];
      }
      const connection = this.connection;
      const { targetId } = await connection.call('Target.createTarget', {
        url: url.href,
        newWindow: true,
      });
      if (typeof targetId !== 'string' || !targetId)
        throw new Error('AUTHORIZATION_BROWSER_TARGET_MISSING');
      this.roots.add(targetId);
      let closed = false;
      const close = async () => {
        if (closed) return;
        if (this.connection !== connection) { closed = true; return; }
        if (!connection.alive()) {
          await waitForBrowserExit(connection);
          this.connection = null;
          closed = true;
          return;
        }
        const targets = (await connection.call('Target.getTargets')).targetInfos as Target[];
        const owned = new Set([targetId, ...(connection.descendants?.(targetId) ?? [])]);
        for (const target of initial)
          if (
            target.type === 'page' &&
            target.url === 'about:blank' &&
            targets.some((t) => t.targetId === target.targetId && t.url === 'about:blank')
          )
            owned.add(target.targetId);
        // SSO child popups belong to their initiating authorization, never other roots.
        for (let size = -1; size !== owned.size;) {
          size = owned.size;
          for (const t of targets)
            if (t.openerId && owned.has(t.openerId) && !this.roots.has(t.targetId))
              owned.add(t.targetId);
        }
        for (const id of [...owned].reverse())
          if (targets.some((t) => t.targetId === id)) {
            await closeOwnedTarget(connection, id);
          }
        this.roots.delete(targetId);
        // Last-window closure normally exits Chromium. Never close a browser with user tabs.
        let remaining: Target[] = [];
        const deadline = Date.now() + 2_000;
        // A close acknowledgement precedes target destruction in real Chromium.
        for (;;) {
          if (!connection.alive()) {
            await waitForBrowserExit(connection);
            this.connection = null;
            closed = true;
            return;
          }
          try {
            remaining = (await connection.call('Target.getTargets')).targetInfos as Target[];
          } catch (error) {
            if (!connection.alive()) {
              await waitForBrowserExit(connection);
              this.connection = null;
              closed = true;
              return;
            }
            throw error;
          }
          if (!remaining.some((t) => owned.has(t.targetId))) break;
          if (Date.now() >= deadline) throw new Error('AUTHORIZATION_BROWSER_CLOSE_TIMEOUT');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (this.roots.size === 0 && !remaining.some((t) => t.type === 'page')) {
          await connection.call('Browser.close').catch(() => {});
          // Keep the launch queue fenced until Chromium releases its profile lock.
          await waitForBrowserExit(connection);
          this.connection = null;
        }
        // A transient CDP failure must leave this handle usable for a retry.
        closed = true;
      };
      try {
        // Remove only this launch's untouched bootstrap blank, after the auth window exists.
        const current = (await connection.call('Target.getTargets')).targetInfos as Target[];
        for (const target of initial)
          if (
            target.type === 'page' &&
            target.url === 'about:blank' &&
            current.some((t) => t.targetId === target.targetId && t.url === 'about:blank')
          ) {
            await closeOwnedTarget(connection, target.targetId);
          }
      } catch (error) {
        // A window created before a bootstrap error must not lose its cleanup handle.
        await close();
        throw error;
      }
      return () => this.serial(close);
    });
  }
}
