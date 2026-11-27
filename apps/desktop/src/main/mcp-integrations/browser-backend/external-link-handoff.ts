// External link handoff (macOS) — keeps the user's link clicks out of the
// managed browser.
//
// The managed browser runs the same app as the user's everyday browser (the
// runtime prefers the system default Chromium browser), only with another
// user-data-dir. LaunchServices routes a clicked link's open-URL event by
// bundle id, so it may land in the managed instance instead of the user's own.
// Such a tab has no opener and its first document request carries no Referer.
//
// This watcher pauses top-level document requests browser-wide, recognizes
// those tabs before the request leaves the machine (one-time login links stay
// unused), and reopens the URL with `open -n -a <app> --args <url>`: the fresh
// process forwards the URL to the user's running instance through Chrome's
// process singleton, or launches it. The managed tab is then closed.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import WebSocket from 'ws';

import { commandLineHasExactArgument, fetchBrowserWebSocketUrl } from './proxy-auth.js';

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 10_000;
/** A clicked link's request follows its tab creation within milliseconds. */
const CANDIDATE_TTL_MS = 10_000;

type CdpMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type TargetInfo = { targetId?: unknown; type?: unknown; url?: unknown; openerId?: unknown };

export interface ExternalLinkHandoffOptions {
  cdpHttpUrl: () => string;
  /**
   * Profile directory of the managed browser. Only a browser launched with
   * this directory on this port is touched; unknown means do not attach.
   */
  managedUserDataDir: () => string | undefined;
  /** True while an agent `open` may be creating a tab with a URL. */
  isAgentOpeningTab: () => boolean;
  logger: { warn(message: string, ...args: unknown[]): void };
  /** Test seam; production runs `open -n -a <app> --args <url>`. */
  openInUserBrowser?: (appPath: string, url: string) => Promise<void>;
  /** Test seam for the app bundle check. */
  appExists?: (appPath: string) => boolean;
}

async function openWithDefaultProfile(appPath: string, url: string): Promise<void> {
  await execFileAsync('/usr/bin/open', ['-n', '-a', appPath, '--args', url], {
    timeout: COMMAND_TIMEOUT_MS,
  });
}

/** `SystemInfo.getInfo` reports the unquoted executable path first. */
function appPathFromCommandLine(commandLine: unknown): string | undefined {
  if (typeof commandLine !== 'string') return undefined;
  return /^(\/.+?\.app)\/Contents\/MacOS\//.exec(commandLine)?.[1];
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function hasReferer(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') return false;
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === 'referer' && typeof value === 'string' && value !== '',
  );
}

export class ExternalLinkHandoff {
  private socket: WebSocket | undefined;
  private connecting = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Tabs that look externally opened, keyed by target id, until their first request. */
  private readonly candidates = new Map<string, { url: string; expiresAt: number }>();
  /** Targets reported before this id's reply already existed when we attached. */
  private discoverCommandId: number | undefined;
  private live = false;
  private appPath: string | undefined;
  /** Bumped by every reset, so a connect that started before one gives up. */
  private epoch = 0;

  constructor(private readonly options: ExternalLinkHandoffOptions) {}

  /**
   * Attach to the managed browser if not attached. A miss costs one refused
   * loopback request, so every browser call may retry: the browser often comes
   * up only a moment after the call that found it stopped.
   */
  ensure(): void {
    if (this.socket || this.connecting) return;
    this.connecting = true;
    void this.connect()
      .catch(() => this.reset())
      .finally(() => {
        this.connecting = false;
      });
  }

  /**
   * Detach from the browser. Reversible: the backend object outlives a switch
   * to the embedded browser and back, so the next `ensure()` attaches again.
   */
  dispose(): void {
    this.reset();
  }

  private async connect(): Promise<void> {
    const epoch = this.epoch;
    const cdpHttpUrl = this.options.cdpHttpUrl();
    const wsUrl = await fetchBrowserWebSocketUrl(cdpHttpUrl);
    const socket = new WebSocket(wsUrl, { handshakeTimeout: COMMAND_TIMEOUT_MS });
    socket.on('message', (data) => {
      if (this.socket === socket) this.handleMessage(data);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.reset();
    });
    socket.on('error', () => {
      if (this.socket === socket) this.reset();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', () => reject(new Error('link handoff channel could not open')));
      socket.once('close', () => reject(new Error('link handoff channel closed before setup')));
    });
    if (this.epoch !== epoch) {
      socket.terminate();
      return;
    }
    this.socket = socket;

    const info = (await this.command('SystemInfo.getInfo')) as { commandLine?: unknown };
    const appPath = appPathFromCommandLine(info.commandLine);
    if (!appPath || !(this.options.appExists ?? existsSync)(appPath)) {
      throw new Error('managed browser app bundle is unknown');
    }
    // A loopback DevTools endpoint alone does not prove it is ours: the port
    // may be held by another Cindy or a user's Chrome. Same proof as
    // closeAdoptedManagedBrowser.
    const userDataDir = this.options.managedUserDataDir();
    const commandLine = info.commandLine as string;
    const port = new URL(cdpHttpUrl).port || '80';
    if (
      !userDataDir
      || !commandLineHasExactArgument(commandLine, `--remote-debugging-port=${port}`)
      || !commandLineHasExactArgument(commandLine, `--user-data-dir=${userDataDir}`)
    ) {
      throw new Error('browser on the CDP port is not the managed browser');
    }
    this.appPath = appPath;
    this.discoverCommandId = this.nextId;
    await this.command('Target.setDiscoverTargets', { discover: true });
    await this.command('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
  }

  private reset(): void {
    this.epoch += 1;
    const socket = this.socket;
    this.socket = undefined;
    this.live = false;
    this.discoverCommandId = undefined;
    this.appPath = undefined;
    this.candidates.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('link handoff channel closed'));
      this.pending.delete(id);
    }
    // Closing the client ends its interception; Chrome resumes paused requests.
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      // Set synchronously: frames parsed from one chunk dispatch back to back,
      // before any continuation of the awaited command could run.
      if (message.id === this.discoverCommandId) this.live = true;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error('link handoff command failed'));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'Target.targetCreated') {
      this.noteCreatedTarget(params.targetInfo as TargetInfo | undefined);
    } else if (message.method === 'Target.targetDestroyed') {
      if (typeof params.targetId === 'string') this.candidates.delete(params.targetId);
    } else if (message.method === 'Fetch.requestPaused') {
      this.handlePausedRequest(params);
    }
  }

  private noteCreatedTarget(info: TargetInfo | undefined): void {
    if (!this.live || !info || info.type !== 'page' || info.openerId) return;
    if (typeof info.targetId !== 'string' || typeof info.url !== 'string') return;
    // Agent tabs are created with their URL too; they are told apart only by
    // the agent's own open call being in flight.
    if (!isWebUrl(info.url) || this.options.isAgentOpeningTab()) return;
    this.candidates.set(info.targetId, { url: info.url, expiresAt: Date.now() + CANDIDATE_TTL_MS });
  }

  private handlePausedRequest(params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
    if (!requestId) return;
    // A main-frame request reports the tab's target id as its frame id.
    const targetId = typeof params.frameId === 'string' ? params.frameId : undefined;
    const candidate = targetId ? this.candidates.get(targetId) : undefined;
    if (targetId) this.candidates.delete(targetId);
    const request = params.request as { headers?: unknown } | undefined;
    const appPath = this.appPath;
    if (
      !targetId
      || !candidate
      || candidate.expiresAt < Date.now()
      // ⌘-click inside the managed window also makes an opener-less tab, but
      // its request carries the source page as Referer.
      || hasReferer(request?.headers)
      || !appPath
    ) {
      void this.command('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    void this.handOff(requestId, targetId, candidate.url, appPath);
  }

  private async handOff(requestId: string, targetId: string, url: string, appPath: string): Promise<void> {
    try {
      await (this.options.openInUserBrowser ?? openWithDefaultProfile)(appPath, url);
    } catch {
      this.options.logger.warn('could not hand an external link to the user browser; keeping it in the managed browser');
      await this.command('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    await this.command('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
    await this.command('Target.closeTarget', { targetId }).catch(() => {});
  }

  private command(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('link handoff channel is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('link handoff command timed out'));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('link handoff command failed'));
      }
    });
  }
}
