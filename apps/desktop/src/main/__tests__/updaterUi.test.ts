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
              return new Promise<void>((_resolve, reject) => {
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
});
