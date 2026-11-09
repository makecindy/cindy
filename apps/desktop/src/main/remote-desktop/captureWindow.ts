import { BrowserWindow, session, type IpcMainInvokeEvent, type Session } from 'electron';
import path from 'node:path';
import { REMOTE_DESKTOP_OFFER_BUDGET } from '@cindy/device-link';
import { readFile } from 'node:fs/promises';
import { installContentSecurityPolicy, parseOrigin } from '../security/csp';
import { throwIpcError } from '../utils/ipcValidate';
import { markCaptureWindowWebContents } from './captureWindowRegistry';
import type { RecordingAudioOptions } from '../../shared/recordingAudio';
import { createLogger } from '../logger';

declare const DESKTOP_CAPTURE_VITE_DEV_SERVER_URL: string | undefined;
declare const DESKTOP_CAPTURE_VITE_NAME: string;
const CAPTURE_URL = 'cindy-desktop-capture://capture/index.html';
const recordingSessions = new WeakSet<Session>();
const windowLog = createLogger('desktop-capture:window');

/** These data hosts must stay hidden. Keep native events separate from JS calls:
 * an Electron event callback's stack cannot identify the original native caller. */
function traceCaptureWindow(win: BrowserWindow, mode: string): void {
  let remaining = 32;
  const record = (action: string, origin: 'lifecycle' | 'js-call' | 'native-event') => {
    if (remaining < 0) return;
    try {
      if (remaining-- === 0) {
        windowLog.info('capture window diagnostic limit reached', { id: win.id, mode });
        return;
      }
      // Keep only function names and source basenames/positions, never raw paths,
      // URL queries, error messages or method arguments. Bound both work and output.
      const stack = origin === 'js-call' ? (new Error().stack ?? '').split('\n').slice(1, 13).flatMap((line) => {
        const source = /(?:[/\\]|\()([\w.-]+\.(?:[cm]?js|tsx?)):(\d+):(\d+)\)?$/.exec(line);
        if (!source) return [];
        const name = /^\s*at ([\w.$<>]+) \(/.exec(line)?.[1]?.slice(0, 120) ?? '<anonymous>';
        return [`${name} (${source[1]}:${source[2]}:${source[3]})`];
      }) : undefined;
      const state = win.isDestroyed() ? { destroyed: true } : {
        nativeHandle: Buffer.from(win.getNativeWindowHandle()).reverse().toString('hex'),
        visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized(),
        bounds: win.getBounds(), contentBounds: win.getContentBounds(),
      };
      const details = { id: win.id, mode, action, origin, ...state, ...(stack ? { stack } : {}) };
      if (origin === 'lifecycle') windowLog.info('capture window created', details);
      else windowLog.warn('capture window visibility activity', details);
    } catch {
      // Diagnostics must never interfere with transport or window teardown.
    }
  };
  for (const method of ['show', 'showInactive', 'restore', 'focus'] as const) {
    const original = win[method];
    win[method] = () => { record(method, 'js-call'); original.call(win); };
  }
  const setAlwaysOnTop = win.setAlwaysOnTop;
  win.setAlwaysOnTop = (...args: Parameters<BrowserWindow['setAlwaysOnTop']>) => {
    record('setAlwaysOnTop', 'js-call');
    setAlwaysOnTop.apply(win, args);
  };
  win.on('show', () => record('show', 'native-event'));
  win.on('hide', () => record('hide', 'native-event'));
  win.on('focus', () => record('focus', 'native-event'));
  win.on('restore', () => record('restore', 'native-event'));
  record('created', 'lifecycle');
}

/** Main owns one ephemeral capture process. Unlike a reusable UI tool window,
 * hiding is NOT a stop boundary: disposal must kill every media stream, including
 * ones that never registered a cooperative JS cleanup. No automatic restart. */
export class DesktopCaptureWindow {
  private window: BrowserWindow | null = null;
  private ready: {
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private captureSession: Session | null = null;
  private get url(): string {
    const base = DESKTOP_CAPTURE_VITE_DEV_SERVER_URL
      ? new URL('index.html', DESKTOP_CAPTURE_VITE_DEV_SERVER_URL).href
      : CAPTURE_URL;
    return this.mode === 'desktop' ? base : `${base}?mode=${this.mode}`;
  }

  constructor(
    private readonly failed: () => void,
    private readonly mode: 'desktop' | 'files' | 'direct' | 'recording' = 'desktop',
    private readonly recordingAudio?: RecordingAudioOptions,
  ) {}

  get contents() {
    return this.window?.webContents ?? null;
  }

  assertSender(event: IpcMainInvokeEvent): void {
    const owner = this.contents;
    if (
      !owner ||
      owner.isDestroyed() ||
      event.sender !== owner ||
      event.senderFrame !== owner.mainFrame ||
      event.senderFrame?.parent !== null ||
      event.senderFrame.url !== this.url
    )
      throwIpcError('PERMISSION_DENIED', 'Invalid desktop capture process');
  }

  registered(event: IpcMainInvokeEvent): void {
    this.assertSender(event);
    const pending = this.ready;
    this.ready = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
  }

  private getSession(): Session {
    if (this.captureSession) return this.captureSession;
    const ses = session.fromPartition(
      this.mode === 'desktop' ? 'cindy-desktop-capture' : this.mode === 'files' ? 'cindy-file-peer' : this.mode === 'recording' ? 'cindy-recording-audio' : 'cindy-direct-peer',
      { cache: false },
    );
    this.captureSession = ses;
    installContentSecurityPolicy(ses, {
      isDev: Boolean(DESKTOP_CAPTURE_VITE_DEV_SERVER_URL),
      devServerOrigin: parseOrigin(DESKTOP_CAPTURE_VITE_DEV_SERVER_URL),
      desktopCapture: true,
    });
    const origin = `${new URL(this.url).protocol}//${new URL(this.url).host}`;
    ses.setPermissionCheckHandler(
      (owner, permission, requestingOrigin, details) =>
        (this.mode === 'desktop' || this.mode === 'recording') &&
        owner === this.contents &&
        owner?.mainFrame.url === this.url &&
        (requestingOrigin === origin || requestingOrigin === `${origin}/`) &&
        permission === 'media' && (this.mode !== 'recording' || (
          details.isMainFrame && (this.recordingAudio?.system === true ||
            (details.mediaType === 'audio' && this.recordingAudio?.microphone === true))
        )),
    );
    ses.setPermissionRequestHandler((owner, permission, callback, details) => {
      callback(
        (this.mode === 'desktop' || this.mode === 'recording') &&
          owner === this.contents &&
          owner?.mainFrame.url === this.url &&
          details.isMainFrame === true &&
          details.requestingUrl === this.url &&
          permission === 'media' &&
          'mediaTypes' in details &&
          (this.mode === 'recording'
            ? (details.mediaTypes?.length === 0 ? this.recordingAudio?.system === true
              : this.recordingAudio?.microphone === true && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio')
            : details.mediaTypes?.length === 0),
      );
    });
    // The recording partition survives individual capture windows. Its immutable
    // assets/download policy install once; media permission callbacks above bind
    // to each new owner, so a previous process cannot retain its grant.
    const existingRecordingSession = this.mode === 'recording' && recordingSessions.has(ses);
    if (!existingRecordingSession) ses.on('will-download', (event) => event.preventDefault());
    if (!DESKTOP_CAPTURE_VITE_DEV_SERVER_URL && !existingRecordingSession) {
      // Only packaged HTML/JS assets in this build's separate output directory.
      // No main app pages, user files, remote URL proxy or percent-decoded paths.
      ses.protocol.handle('cindy-desktop-capture', async (request) => {
        const url = new URL(request.url);
        if (
          request.method !== 'GET' ||
          url.host !== 'capture' ||
          (url.search !== '' &&
            !(
              this.mode !== 'desktop' &&
              url.search === `?mode=${this.mode}` &&
              url.pathname === '/index.html'
            )) ||
          !/^\/(?:index\.html|assets\/[A-Za-z0-9_-]+\.js)$/.test(url.pathname)
        )
          return new Response(null, { status: 403 });
        try {
          const file = path.join(
            __dirname,
            '../renderer',
            DESKTOP_CAPTURE_VITE_NAME,
            url.pathname.slice(1),
          );
          const bytes = await readFile(file);
          return new Response(new Uint8Array(bytes), {
            headers: {
              'Content-Type': url.pathname.endsWith('.html') ? 'text/html' : 'text/javascript',
            },
          });
        } catch {
          return new Response(null, { status: 404 });
        }
      });
    }
    if (this.mode === 'recording') recordingSessions.add(ses);
    return ses;
  }

  async start(): Promise<void> {
    this.dispose();
    const win = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 1,
      height: 1,
      webPreferences: {
        session: this.getSession(),
        preload: path.join(__dirname, 'desktopCapturePreload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        plugins: false,
        navigateOnDragDrop: false,
        webviewTag: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    this.window = win;
    traceCaptureWindow(win, this.mode);
    markCaptureWindowWebContents(win.webContents);
    if (this.mode === 'direct') {
      // This data-only window signals exclusively to already authorized peers.
      // Chromium's default mDNS host names cannot resolve across routed LANs.
      // Expose the default route's address without enumerating other interfaces,
      // granting media permissions, or changing the SDP's ICE/DTLS credentials.
      win.webContents.setWebRTCIPHandlingPolicy('default_public_and_private_interfaces');
    }
    const failed = () => {
      if (this.window !== win) return;
      this.dispose();
      this.failed();
    };
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
      failed();
    });
    win.webContents.on('will-redirect', (event) => {
      event.preventDefault();
      failed();
    });
    win.webContents.on('render-process-gone', failed);
    win.webContents.on('destroyed', failed);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(failed, REMOTE_DESKTOP_OFFER_BUDGET.captureReadyMs);
      this.ready = { resolve, reject, timer };
      void win.loadURL(this.url).catch(failed);
    });
  }

  dispose(): void {
    const win = this.window;
    this.window = null; // Detach before destruction callbacks; never stop a replacement owner.
    const pending = this.ready;
    this.ready = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('DESKTOP_VIDEO_STOPPED'));
    }
    if (win && !win.isDestroyed()) win.destroy();
  }
}
