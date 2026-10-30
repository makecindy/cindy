import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  new URL('../../../cindy-updater/ui/app.js', import.meta.url),
  'utf8',
);

function createUi() {
  const elements = new Map<
    string,
    {
      hidden: boolean;
      disabled: boolean;
      textContent: string;
      className: string;
      dataset: Record<string, string>;
      style: Record<string, string>;
      classList: { add(): void; remove(): void };
      addEventListener(event: string, handler: () => Promise<void>): void;
      click?: () => Promise<void>;
    }
  >();
  let statusListener: (event: { payload: Record<string, unknown> }) => void = () => {};
  let rejectRetry: (error: Error) => void = () => {};
  let resolveRetry: () => void = () => {};
  let retryCalls = 0;
  const context = vm.createContext({
    console,
    navigator: { language: 'en-US' },
    document: {
      getElementById(id: string) {
        const element = {
          hidden: false,
          disabled: false,
          textContent: '',
          className: '',
          dataset: {},
          style: {},
          classList: { add() {}, remove() {} },
          addEventListener(_event: string, handler: () => Promise<void>) {
            Object.assign(element, { click: handler });
          },
        };
        elements.set(id, element);
        return element;
      },
    },
    window: {
      __TAURI__: {
        core: {
          invoke(command: string) {
            if (command === 'get_status') return Promise.resolve({ phase: 'waiting' });
            if (command === 'retry_update') {
              retryCalls++;
              return new Promise<void>((resolve, reject) => {
                resolveRetry = () => resolve();
                rejectRetry = reject;
              });
            }
            return Promise.resolve();
          },
        },
        event: {
          listen(_event: string, listener: typeof statusListener) {
            statusListener = listener;
            return Promise.resolve();
          },
        },
      },
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL('../../../cindy-updater/ui/retry-copy.js', import.meta.url), 'utf8'),
    context,
  );
  context.window.retryCopy = context.retryCopy;
  vm.runInContext(source, context);
  return {
    elements,
    status: (payload: Record<string, unknown>) => statusListener({ payload }),
    retryCalls: () => retryCalls,
    resolveRetry: () => resolveRetry(),
    rejectRetry: (message = 'spawn failed') => rejectRetry(new Error(message)),
  };
}

describe('updater failure retry UI', () => {
  it('provides retry copy for all supported languages with English fallback', () => {
    const context = vm.createContext({});
    vm.runInContext(
      fs.readFileSync(new URL('../../../cindy-updater/ui/retry-copy.js', import.meta.url), 'utf8'),
      context,
    );
    for (const [locale, label] of [
      ['zh-CN', '重试'],
      ['zh-Hant-HK', '重試'],
      ['en-US', 'Retry'],
      ['ja-JP', '再試行'],
      ['ko-KR', '다시 시도'],
      ['fr-FR', 'Retry'],
    ]) {
      const copy = context.retryCopy(locale);
      expect(copy.retry).toBe(label);
      expect(Object.values(copy).every((text) => typeof text === 'string' && text.length > 0)).toBe(
        true,
      );
    }
  });
  it('only offers retry for a failed status explicitly marked safe by Rust', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const button = ui.elements.get('btn-retry')!;
    for (const payload of [
      { phase: 'waiting', can_retry: true },
      { phase: 'replacing', can_retry: true },
      { phase: 'done', can_retry: true },
      { phase: 'failed' },
      { phase: 'failed', can_retry: false },
      { phase: 'failed', can_retry: 'true' },
    ]) {
      ui.status(payload);
      expect(button.hidden).toBe(true);
    }
    expect(ui.retryCalls()).toBe(0);
    ui.status({ phase: 'failed', can_retry: true });
    expect(button.hidden).toBe(false);
  });

  it('keeps retry hidden after the command is accepted until a later failed status', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ui.status({ phase: 'failed', can_retry: true });
    const button = ui.elements.get('btn-retry')!;
    const pending = button.click!();
    ui.resolveRetry();
    await pending;
    expect(button.hidden).toBe(true);
    expect(button.disabled).toBe(true);
    await button.click!();
    expect(ui.retryCalls()).toBe(1);
    ui.status({ phase: 'waiting', can_retry: false });
    expect(button.hidden).toBe(true);
    ui.status({ phase: 'failed', can_retry: true });
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
  });

  it('hides Close as soon as Retry is accepted and restores it only on a later failed status', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ui.status({ phase: 'failed', can_retry: true });
    const close = ui.elements.get('btn-quit')!;
    expect(close.hidden).toBe(false);
    const pending = ui.elements.get('btn-retry')!.click!();
    expect(close.hidden).toBe(true);
    ui.resolveRetry();
    await pending;
    expect(close.hidden).toBe(true);
    ui.status({ phase: 'waiting', can_retry: false });
    expect(close.hidden).toBe(true);
    ui.status({ phase: 'failed', can_retry: true });
    expect(close.hidden).toBe(false);
  });

  it('restores Close when Retry is rejected before a worker starts', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ui.status({ phase: 'failed', can_retry: true });
    const close = ui.elements.get('btn-quit')!;
    const pending = ui.elements.get('btn-retry')!.click!();
    expect(close.hidden).toBe(true);
    ui.rejectRetry('processes_running');
    await pending;
    expect(close.hidden).toBe(false);
  });

  it('submits one retry despite repeated clicks and restores the button on spawn failure', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ui.status({ phase: 'failed', can_retry: true });
    const button = ui.elements.get('btn-retry')!;
    const pending = button.click!();
    await button.click!();
    expect(ui.retryCalls()).toBe(1);
    expect(button.hidden).toBe(true);
    expect(button.disabled).toBe(true);
    ui.rejectRetry();
    await pending;
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(ui.elements.get('error-text')!.textContent).toBe(
      'Could not restart the updater. Close this window and check for updates again',
    );
  });

  it('asks the user to close Cindy when retry finds running installation processes', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ui.status({ phase: 'failed', can_retry: true, error: 'processes_running' });
    const message =
      'Close Cindy and any processes running from its installation folder, then retry';
    expect(ui.elements.get('error-text')!.textContent).toBe(message);
    const pending = ui.elements.get('btn-retry')!.click!();
    ui.rejectRetry('processes_running');
    await pending;
    expect(ui.elements.get('error-text')!.textContent).toBe(message);
    expect(ui.elements.get('btn-retry')!.hidden).toBe(false);
  });

  it('does not restore retry when the latest status no longer permits it', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ui.status({ phase: 'failed', can_retry: true });
    const button = ui.elements.get('btn-retry')!;
    const pending = button.click!();
    ui.status({ phase: 'failed', can_retry: false });
    ui.rejectRetry();
    await pending;
    expect(button.hidden).toBe(true);
  });

  it('hides retry after the archive is gone and keeps the check-for-updates guidance', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ui.status({ phase: 'failed', can_retry: true });
    const button = ui.elements.get('btn-retry')!;
    const pending = button.click!();
    ui.rejectRetry('archive_unavailable');
    await pending;
    expect(button.hidden).toBe(true);
    expect(ui.elements.get('error-text')!.textContent).toBe(
      'The update file is missing or unreadable. Please check for updates again',
    );
    await button.click!();
    expect(ui.retryCalls()).toBe(1);
  });

  it('hides retry when Rust reports the failure is no longer retryable', async () => {
    const ui = createUi();
    await new Promise<void>((resolve) => setImmediate(resolve));
    ui.status({ phase: 'failed', can_retry: true });
    const button = ui.elements.get('btn-retry')!;
    const pending = button.click!();
    ui.rejectRetry('unavailable');
    await pending;
    expect(button.hidden).toBe(true);
    expect(ui.elements.get('error-text')!.textContent).toBe(
      'This update failure cannot be retried',
    );
  });

  it('sizes updater actions as standard secondary pills', () => {
    const css = fs.readFileSync(
      new URL('../../../cindy-updater/ui/style.css', import.meta.url),
      'utf8',
    );
    const btnBlock = css.match(/\.btn\s*\{[^}]+\}/)?.[0] ?? '';
    expect(btnBlock).toContain('height: 32px');
    expect(btnBlock).toContain('padding: 0 24px');
    expect(btnBlock).toContain('font-size: 13px');
    expect(css).toMatch(/\.btn:active:not\(:disabled\)/);
  });
});
