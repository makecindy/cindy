import { app } from 'electron';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RemoteClipboardContent } from '@cindy/device-link';
import { isGnomeWaylandSession } from './gnomeDesktop';
import { supportsLinuxLock } from './linuxDesktop';
import { isLogindSessionUnlocked } from './linuxSessionLock';

const exec = promisify(execFile);
const SCRIPT_NAME = 'linux-gnome-clipboard.py';
const MAX_LINE_BYTES = 34 * 1024 * 1024;
const IDLE_MS = 15_000;
const ALLOWED_ERRORS = new Set([
  'DESKTOP_CLIPBOARD_UNAVAILABLE',
  'DESKTOP_CLIPBOARD_CHANGED',
  'DESKTOP_CLIPBOARD_WRITE_FAILED',
  'CLIPBOARD_TOO_LONG',
  'CLIPBOARD_UNSUPPORTED',
]);

type Pending = {
  id: number;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type Session = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending: Pending | null;
  buffer: string;
  idle?: ReturnType<typeof setTimeout>;
  closed: boolean;
};

export interface GnomeClipboardRuntime {
  scriptPath(): string;
  spawn(script: string): ChildProcessWithoutNullStreams;
  hasLoginSession(): boolean;
  isLogindUnlocked(): Promise<boolean>;
}

const defaultRuntime: GnomeClipboardRuntime = {
  scriptPath: () =>
    app.isPackaged
      ? path.join(process.resourcesPath, 'tools', 'remote-desktop', SCRIPT_NAME)
      : path.join(app.getAppPath(), 'native', 'remote-desktop', SCRIPT_NAME),
  spawn: (script) =>
    spawn('/usr/bin/python3', ['-I', '-B', '-u', script], { stdio: 'pipe', windowsHide: true }),
  hasLoginSession: () => Boolean(process.env.XDG_SESSION_ID?.length),
  isLogindUnlocked: () => isLogindSessionUnlocked(),
};

function sanitizeError(code: unknown): Error {
  return new Error(
    typeof code === 'string' && ALLOWED_ERRORS.has(code) ? code : 'DESKTOP_CLIPBOARD_UNAVAILABLE',
  );
}

/** Persistent, lazy GNOME (Mutter) RemoteDesktop clipboard helper client.
 * Never starts during capability probes; retires on idle, lock, stop or quit
 * so GNOME's remote-control indicator is not left active after disconnect. */
export class GnomeClipboardClient {
  private session: Session | null = null;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: GnomeClipboardRuntime = defaultRuntime) {}

  stop(): void {
    if (this.session) this.retire(this.session, true);
  }

  private retire(session: Session, graceful = false): void {
    if (session.closed) return;
    session.closed = true;
    if (this.session === session) this.session = null;
    if (session.idle) clearTimeout(session.idle);
    if (session.pending) {
      const pending = session.pending;
      session.pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
    }
    if (graceful && !session.child.stdin.destroyed) {
      session.child.stdin.end();
      const timer = setTimeout(() => session.child.kill('SIGKILL'), 1500);
      timer.unref();
      session.child.once('exit', () => clearTimeout(timer));
    } else {
      session.child.stdin.destroy();
      session.child.kill('SIGKILL');
    }
  }

  private scheduleIdle(session: Session): void {
    if (session.idle) clearTimeout(session.idle);
    if (!session.pending && this.session === session && !session.closed) {
      session.idle = setTimeout(() => this.retire(session, true), IDLE_MS);
      session.idle.unref?.();
    }
  }

  private start(): Session {
    const child = this.runtime.spawn(this.runtime.scriptPath());
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const session: Session = {
      child,
      ready,
      pending: null,
      buffer: '',
      closed: false,
    };
    this.session = session;
    let started = false;
    const startTimer = setTimeout(() => {
      rejectReady(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
      this.retire(session);
    }, 5000);
    const fail = () => {
      clearTimeout(startTimer);
      if (!started) rejectReady(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
      this.retire(session);
    };
    child.stderr.resume(); // never log helper diagnostics
    child.once('error', fail);
    child.once('exit', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.session !== session || session.closed) return;
      session.buffer += chunk;
      if (Buffer.byteLength(session.buffer) > MAX_LINE_BYTES) {
        fail();
        return;
      }
      let end: number;
      while ((end = session.buffer.indexOf('\n')) !== -1) {
        const line = session.buffer.slice(0, end);
        session.buffer = session.buffer.slice(end + 1);
        if (!started) {
          clearTimeout(startTimer);
          if (line !== 'ready') {
            fail();
            return;
          }
          started = true;
          resolveReady();
          this.scheduleIdle(session);
          continue;
        }
        let reply: unknown;
        try {
          reply = JSON.parse(line);
        } catch {
          fail();
          return;
        }
        if (
          !reply ||
          typeof reply !== 'object' ||
          !('id' in reply) ||
          !session.pending ||
          reply.id !== session.pending.id
        ) {
          fail();
          return;
        }
        const pending = session.pending;
        session.pending = null;
        clearTimeout(pending.timer);
        if ('error' in reply && reply.error !== undefined) {
          pending.reject(sanitizeError(reply.error));
        } else {
          pending.resolve(reply as Record<string, unknown>);
        }
        this.scheduleIdle(session);
      }
    });
    return session;
  }

  private async assertLogindUnlocked(): Promise<void> {
    if (!this.runtime.hasLoginSession()) return;
    if (!(await this.runtime.isLogindUnlocked())) {
      this.stop();
      throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    }
  }

  private request(
    body: Record<string, unknown>,
    timeoutMs: number,
    beforeSend?: () => void,
  ): Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      beforeSend?.();
      await this.assertLogindUnlocked();
      beforeSend?.();
      const session = this.session ?? this.start();
      if (session.idle) clearTimeout(session.idle);
      await session.ready;
      beforeSend?.();
      if (this.session !== session || session.closed)
        throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
      const id = ++this.sequence;
      const line = `${JSON.stringify({ id, ...body })}\n`;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('CLIPBOARD_TOO_LONG');
      const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.retire(session);
        }, timeoutMs);
        session.pending = { id, resolve, reject, timer };
        session.child.stdin.write(line, (error) => {
          if (error) this.retire(session);
        });
      });
      await this.assertLogindUnlocked();
      return reply;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async version(): Promise<string> {
    const reply = await this.request({ op: 'version' }, 3000);
    if (typeof reply.version !== 'string' || !/^\d{1,128}$/.test(reply.version))
      throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    return reply.version;
  }

  async read(primary = false): Promise<{ formats: string[]; content: RemoteClipboardContent }> {
    // Mutter's RemoteDesktop API exposes CLIPBOARD only (no PRIMARY selection).
    // Verify the session is unlocked, then return empty so copy falls back to CLIPBOARD.
    if (primary) {
      await this.version();
      return { formats: [], content: {} };
    }
    const reply = await this.request({ op: 'read' }, 6000);
    if (
      !Array.isArray(reply.formats) ||
      !reply.formats.every((f) => typeof f === 'string') ||
      !reply.content ||
      typeof reply.content !== 'object'
    )
      throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
    const raw = reply.content as Record<string, unknown>;
    const content: RemoteClipboardContent = {};
    if (typeof raw.text === 'string' && raw.text) content.text = raw.text;
    if (typeof raw.html === 'string' && raw.html) content.html = raw.html;
    if (typeof raw.rtf === 'string' && raw.rtf) content.rtf = raw.rtf;
    if (typeof raw.png === 'string' && raw.png) content.png = raw.png;
    return { formats: reply.formats, content };
  }

  async write(content: RemoteClipboardContent, current: () => boolean): Promise<void> {
    const check = () => {
      if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
    };
    const reply = await this.request(
      {
        op: 'write',
        content: {
          ...content,
          ...(content.url && !content.text ? { text: content.url } : {}),
        },
      },
      6000,
      check,
    );
    check();
    if (reply.ok !== true) throw new Error('DESKTOP_CLIPBOARD_WRITE_FAILED');
  }
}

const client = new GnomeClipboardClient();
let ready = false;
let probing: Promise<boolean> | null = null;

/** Synchronous view of the last probe, matching gnomeDesktopReady(). */
export function gnomeClipboardReady(): boolean {
  return ready && isGnomeWaylandSession();
}

/** Probe Mutter RemoteDesktop + GNOME ScreenSaver without creating a session. */
export function readGnomeClipboardSupport(): Promise<boolean> {
  if (!isGnomeWaylandSession()) return Promise.resolve(false);
  if (process.env.XDG_SESSION_ID?.length && !supportsLinuxLock()) return Promise.resolve(false);
  if (ready) return Promise.resolve(true);
  probing ??= (async () => {
    try {
      const { stdout } = await exec('/usr/bin/python3', ['-I', '-B', '-u', defaultRuntime.scriptPath(), '--check'], {
        timeout: 3000,
        maxBuffer: 1024,
      });
      ready = stdout.trim() === 'ready';
    } catch {
      ready = false;
    }
    return ready;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

export function readGnomeClipboardVersion(): Promise<string> {
  if (!gnomeClipboardReady()) return Promise.reject(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
  return client.version();
}

export function readGnomeClipboardSnapshot(
  primary = false,
): Promise<{ formats: string[]; content: RemoteClipboardContent }> {
  if (!gnomeClipboardReady()) return Promise.reject(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
  return client.read(primary);
}

export function writeGnomeClipboard(
  content: RemoteClipboardContent,
  current: () => boolean,
): Promise<void> {
  if (!gnomeClipboardReady()) return Promise.reject(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
  return client.write(content, current);
}

export function stopGnomeClipboard(): void {
  client.stop();
}
