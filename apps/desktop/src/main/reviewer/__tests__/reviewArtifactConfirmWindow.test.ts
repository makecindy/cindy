import { EventEmitter } from 'node:events';

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewArtifactConfirmDialogModel } from '../reviewArtifactDialog.js';
import {
  buildReviewArtifactConfirmDocument,
  showReviewArtifactConfirmWindow,
} from '../reviewArtifactConfirmWindow.js';
import { isReviewArtifactConfirmWebContentsId } from '../reviewArtifactConfirmWindowRegistry.js';

const MODEL: ReviewArtifactConfirmDialogModel = {
  title: 'Allow review?',
  message: 'One item is outside the workspace.',
  detail: 'Review the item before allowing access.',
  items: [
    { kind: 'external-path', label: 'report.pdf', path: 'D:\\outside\\report.pdf' },
    { kind: 'inline', label: 'notes.txt', inlineLabel: 'inline attachment' },
  ],
  allowText: 'Allow',
  cancelText: 'Cancel',
};

let nextWebContentsId = 1_000;

class FakeWebContents extends EventEmitter {
  readonly id = nextWebContentsId++;
  loadedUrl = '';
  openHandler: (() => { action: 'deny' }) | null = null;

  setWindowOpenHandler(handler: () => { action: 'deny' }): void {
    this.openHandler = handler;
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  destroyed = false;
  shown = false;
  focused = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }

  show(): void {
    this.shown = true;
  }

  focus(): void {
    this.focused = true;
  }

  loadURL(url: string): Promise<void> {
    this.webContents.loadedUrl = url;
    return Promise.resolve();
  }
}

function createHarness(timeoutMs = 60_000) {
  const parent = new FakeWindow();
  const dialog = new FakeWindow();
  let windowOptions: BrowserWindowConstructorOptions | null = null;
  const result = showReviewArtifactConfirmWindow(
    parent as unknown as BrowserWindow,
    MODEL,
    {
      timeoutMs,
      isDark: false,
      createWindow: (options) => {
        windowOptions = options;
        return dialog as unknown as BrowserWindow;
      },
    },
  );
  return { parent, dialog, result, getWindowOptions: () => windowOptions };
}

function readEmbeddedStylesheet(document: string): string {
  const match = document.match(
    /<link rel="stylesheet" href="data:text\/css;base64,([^"]+)">/,
  );
  expect(match).not.toBeNull();
  return Buffer.from(match?.[1] ?? '', 'base64').toString('utf8');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Review artifact confirmation window', () => {
  it('escapes every model field and keeps the document script-free', () => {
    const document = buildReviewArtifactConfirmDocument(
      {
        ...MODEL,
        title: '<img src=x onerror=alert(1)>',
        message: '</title><script>alert(1)</script>',
        items: [
          {
            kind: 'external-path',
            label: '<svg onload=alert(1)>',
            path: 'D:\\<script>bad</script>',
          },
        ],
      },
      true,
    );

    expect(document).toContain('data-theme="dark"');
    expect(document).toContain("default-src 'none'; style-src data:");
    expect(document).not.toContain("'unsafe-inline'");
    expect(document).not.toContain('<script>');
    expect(document).not.toContain('<img');
    expect(document).not.toContain('<svg');
    expect(document).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(document).toContain('class="button primary" href="#allow" autofocus');
    expect(document).not.toContain('href="#cancel" autofocus');
  });

  it('uses a hardened modal with no preload or renderer authorization bridge', async () => {
    const harness = createHarness();
    const options = harness.getWindowOptions();

    expect(options).toMatchObject({
      parent: harness.parent,
      modal: true,
      show: false,
      backgroundColor: '#f8f8f6',
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
        navigateOnDragDrop: false,
      },
    });
    expect(options?.webPreferences).not.toHaveProperty('preload');
    expect(harness.dialog.webContents.openHandler?.()).toEqual({ action: 'deny' });
    expect(isReviewArtifactConfirmWebContentsId(harness.dialog.webContents.id)).toBe(true);

    harness.dialog.emit('ready-to-show');
    expect(harness.dialog.shown).toBe(true);
    expect(harness.dialog.focused).toBe(true);

    const preventDefault = vi.fn();
    harness.dialog.webContents.emit('will-navigate', { preventDefault }, 'https://example.com');
    expect(preventDefault).toHaveBeenCalledOnce();

    harness.dialog.webContents.emit(
      'did-navigate-in-page',
      {},
      `${harness.dialog.webContents.loadedUrl}#allow`,
      true,
    );
    await expect(harness.result).resolves.toBe(true);
    expect(harness.dialog.destroyed).toBe(true);
  });

  it('keeps consent copy and actions visible while artifact details scroll', () => {
    const document = buildReviewArtifactConfirmDocument(
      {
        ...MODEL,
        items: Array.from({ length: 20 }, (_, index) => ({
          kind: 'external-path' as const,
          label: `artifact-${index}.pdf`,
          path: `D:\\outside\\${'deeply-nested\\'.repeat(20)}artifact-${index}.pdf`,
        })),
      },
      false,
    );
    const stylesheet = readEmbeddedStylesheet(document);

    expect(stylesheet).toContain('height: 100%; overflow: hidden');
    expect(stylesheet).toContain('height: 100vh; min-height: 0');
    expect(stylesheet).toContain(
      'ul { flex: 1; min-height: 0; margin: 0; padding: 0; overflow-y: auto;',
    );
    expect(stylesheet).toContain('footer { display: flex; flex: none;');
  });

  it('fails closed on cancel, timeout, parent close, and renderer failure', async () => {
    const cancelled = createHarness();
    cancelled.dialog.webContents.emit(
      'did-navigate-in-page',
      {},
      `${cancelled.dialog.webContents.loadedUrl}#cancel`,
      true,
    );
    await expect(cancelled.result).resolves.toBe(false);

    vi.useFakeTimers();
    const timedOut = createHarness(10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(timedOut.result).resolves.toBe(false);
    expect(timedOut.dialog.destroyed).toBe(true);

    const parentClosed = createHarness();
    parentClosed.parent.emit('closed');
    await expect(parentClosed.result).resolves.toBe(false);

    const rendererGone = createHarness();
    rendererGone.dialog.webContents.emit('render-process-gone');
    await expect(rendererGone.result).resolves.toBe(false);

    const escaped = createHarness();
    const preventDefault = vi.fn();
    escaped.dialog.webContents.emit(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'Escape' },
    );
    await expect(escaped.result).resolves.toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
