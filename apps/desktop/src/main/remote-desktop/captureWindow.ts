import { BrowserWindow, session, type IpcMainInvokeEvent, type Session } from 'electron';
import path from 'node:path';
import { REMOTE_DESKTOP_OFFER_BUDGET } from '@cindy/device-link';
import { readFile } from 'node:fs/promises';
import { installContentSecurityPolicy, parseOrigin } from '../security/csp';
import { throwIpcError } from '../utils/ipcValidate';

declare const DESKTOP_CAPTURE_VITE_DEV_SERVER_URL: string | undefined;
declare const DESKTOP_CAPTURE_VITE_NAME: string;
const CAPTURE_URL = 'cindy-desktop-capture://capture/index.html';

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
    return this.mode === 'files' ? `${base}?mode=files` : base;
  }

  constructor(
    private readonly failed: () => void,
    private readonly mode: 'desktop' | 'files' = 'desktop',
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
      this.mode === 'files' ? 'cindy-file-peer' : 'cindy-desktop-capture',
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
      (owner, permission, requestingOrigin) =>
        this.mode === 'desktop' &&
        owner === this.contents &&
        owner?.mainFrame.url === this.url &&
        (requestingOrigin === origin || requestingOrigin === `${origin}/`) &&
        permission === 'media',
    );
    ses.setPermissionRequestHandler((owner, permission, callback, details) => {
      callback(
        this.mode === 'desktop' &&
          owner === this.contents &&
          owner?.mainFrame.url === this.url &&
          details.isMainFrame === true &&
          details.requestingUrl === this.url &&
          permission === 'media' &&
          'mediaTypes' in details &&
          details.mediaTypes?.length === 0,
      );
    });
    ses.on('will-download', (event) => event.preventDefault());
    if (!DESKTOP_CAPTURE_VITE_DEV_SERVER_URL) {
      // Only packaged HTML/JS assets in this build's separate output directory.
      // No main app pages, user files, remote URL proxy or percent-decoded paths.
      ses.protocol.handle('cindy-desktop-capture', async (request) => {
        const url = new URL(request.url);
        if (
          request.method !== 'GET' ||
          url.host !== 'capture' ||
          (url.search !== '' &&
            !(
              this.mode === 'files' &&
              url.search === '?mode=files' &&
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
        spellcheck: false,
      },
    });
    this.window = win;
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
