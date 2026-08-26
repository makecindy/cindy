import {
  BrowserWindow,
  nativeTheme,
  type BrowserWindowConstructorOptions,
} from 'electron';

import { resolveAppThemeIsDark } from '../resolved-app-theme.js';
import { readWindowThemeSnapshot } from '../window-theme-mode-store.js';
import type { ReviewArtifactConfirmDialogModel } from './reviewArtifactDialog.js';
import { markReviewArtifactConfirmWebContentsId } from './reviewArtifactConfirmWindowRegistry.js';

const DEFAULT_TIMEOUT_MS = 90_000;

export interface ReviewArtifactConfirmWindowOptions {
  timeoutMs?: number;
  isDark?: boolean;
  createWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  log?: { warn(message: string, meta?: Record<string, unknown>): void };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}

const DIALOG_CSS = `
:root {
  color-scheme: light;
  --surface: #f8f8f6;
  --surface-raised: #ffffff;
  --text: #252523;
  --muted: #696966;
  --border: #deded9;
  --accent: #252523;
  --accent-text: #ffffff;
  --hover: #efefeb;
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --surface: #1f1f1e;
  --surface-raised: #292927;
  --text: #f1f1ed;
  --muted: #aaa9a3;
  --border: #41413d;
  --accent: #f1f1ed;
  --accent-text: #242422;
  --hover: #333330;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--surface); color: var(--text); }
body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
main { display: flex; height: 100vh; min-height: 0; flex-direction: column; padding: 28px; }
.brand { margin: 0 0 12px; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }
.message { margin: 8px 0 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
.detail { margin: 24px 0 10px; font-size: 13px; line-height: 1.5; }
ul { flex: 1; min-height: 0; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
li { margin-top: 8px; padding: 11px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-raised); }
.label { overflow-wrap: anywhere; font-size: 13px; font-weight: 500; }
.path { margin-top: 4px; overflow-wrap: anywhere; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
footer { display: flex; flex: none; justify-content: flex-end; gap: 10px; margin-top: auto; padding-top: 26px; }
.button { display: inline-flex; min-width: 88px; height: 36px; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 13px; font-weight: 600; text-decoration: none; }
.button:hover, .button:focus-visible { background: var(--hover); outline: none; }
.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-text); }
.primary:hover, .primary:focus-visible { background: var(--accent); opacity: .88; }
`;

/** Build a script-free document whose only decisions are same-document fragments. */
export function buildReviewArtifactConfirmDocument(
  model: ReviewArtifactConfirmDialogModel,
  isDark: boolean,
): string {
  const stylesheet = `data:text/css;base64,${Buffer.from(DIALOG_CSS).toString('base64')}`;
  const items = model.items
    .map((item) => {
      const secondary =
        item.kind === 'external-path'
          ? item.path
          : item.inlineLabel;
      return `<li><div class="label">${escapeHtml(item.label)}</div>${
        secondary
          ? `<div class="path" dir="ltr">${escapeHtml(secondary)}</div>`
          : ''
      }</li>`;
    })
    .join('');
  return `<!doctype html>
<html lang="und" data-theme="${isDark ? 'dark' : 'light'}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${stylesheet}">
  <title>${escapeHtml(model.title)}</title>
</head>
<body>
  <main aria-labelledby="review-confirm-title">
    <p class="brand">Cindy</p>
    <h1 id="review-confirm-title">${escapeHtml(model.title)}</h1>
    <p class="message">${escapeHtml(model.message)}</p>
    <p class="detail">${escapeHtml(model.detail)}</p>
    <ul>${items}</ul>
    <footer>
      <a class="button" href="#cancel">${escapeHtml(model.cancelText)}</a>
      <a class="button primary" href="#allow" autofocus>${escapeHtml(model.allowText)}</a>
    </footer>
  </main>
</body>
</html>`;
}

function readDecision(url: string): boolean | null {
  try {
    const hash = new URL(url).hash;
    if (hash === '#allow') return true;
    if (hash === '#cancel') return false;
  } catch {
    // Invalid or non-URL navigation is denied below.
  }
  return null;
}

/**
 * One authorization request owns one modal window. Reusing this security
 * prompt would risk carrying a stale parent, focus, or decision into another
 * grant, so it intentionally does not use the reusable auxiliary-tool window
 * lifecycle. The document has no preload, IPC, or script: an XSS in the main
 * app Renderer cannot observe or answer this prompt.
 */
export async function showReviewArtifactConfirmWindow(
  parent: BrowserWindow,
  model: ReviewArtifactConfirmDialogModel,
  options: ReviewArtifactConfirmWindowOptions = {},
): Promise<boolean> {
  if (parent.isDestroyed()) return false;
  const persistedTheme = options.isDark === undefined ? readWindowThemeSnapshot() : null;
  const isDark =
    options.isDark ??
    resolveAppThemeIsDark(
      nativeTheme.shouldUseDarkColors,
      persistedTheme?.mode,
      persistedTheme?.resolvedIsDark,
    );
  const createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions));
  let win: BrowserWindow;
  try {
    win = createWindow({
      parent,
      modal: true,
      width: 600,
      height: Math.min(720, 330 + model.items.length * 76),
      minWidth: 520,
      minHeight: 360,
      show: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: model.title,
      backgroundColor: isDark ? '#1f1f1e' : '#f8f8f6',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        plugins: false,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });
    markReviewArtifactConfirmWebContentsId(win.webContents.id);
  } catch (error) {
    options.log?.warn('failed to create Review artifact confirmation window; access denied', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const settle = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      parent.removeListener('closed', onParentClosed);
      win.removeListener('closed', onClosed);
      win.removeListener('ready-to-show', onReadyToShow);
      win.webContents.removeListener('will-navigate', onWillNavigate);
      win.webContents.removeListener('did-navigate-in-page', onDidNavigateInPage);
      win.webContents.removeListener('before-input-event', onBeforeInput);
      win.webContents.removeListener('render-process-gone', onRendererGone);
      if (!win.isDestroyed()) win.destroy();
      resolve(confirmed);
    };
    const onParentClosed = (): void => settle(false);
    const onClosed = (): void => settle(false);
    const onReadyToShow = (): void => {
      if (win.isDestroyed()) return;
      // This data document is already complete and has no script or async
      // resources, so ready-to-show is also its business-content ready signal.
      win.show();
      win.focus();
    };
    const onWillNavigate = (event: { preventDefault(): void }): void => {
      event.preventDefault();
    };
    const onDidNavigateInPage = (
      _event: unknown,
      url: string,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return;
      const decision = readDecision(url);
      if (decision !== null) settle(decision);
    };
    const onBeforeInput = (
      event: { preventDefault(): void },
      input: { type: string; key: string },
    ): void => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return;
      event.preventDefault();
      settle(false);
    };
    const onRendererGone = (): void => settle(false);

    parent.once('closed', onParentClosed);
    win.once('closed', onClosed);
    win.once('ready-to-show', onReadyToShow);
    win.webContents.on('will-navigate', onWillNavigate);
    win.webContents.on('did-navigate-in-page', onDidNavigateInPage);
    win.webContents.on('before-input-event', onBeforeInput);
    win.webContents.on('render-process-gone', onRendererGone);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    timeoutId = setTimeout(() => {
      options.log?.warn('review artifact confirmation timed out; access denied');
      settle(false);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeoutId.unref?.();

    const document = buildReviewArtifactConfirmDocument(model, isDark);
    try {
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`).catch(
        (error) => {
          options.log?.warn('failed to load Review artifact confirmation; access denied', {
            error: error instanceof Error ? error.message : String(error),
          });
          settle(false);
        },
      );
    } catch (error) {
      options.log?.warn('failed to load Review artifact confirmation; access denied', {
        error: error instanceof Error ? error.message : String(error),
      });
      settle(false);
    }
  });
}
