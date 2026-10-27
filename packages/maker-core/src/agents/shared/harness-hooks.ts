import type { HarnessHookHandler, HarnessHookRequest, HarnessHookResult } from '../../types/harness-capabilities.js';

/** Native callbacks remain optional and bounded; they never grant tool permission. */
export function createHarnessHookBridge() {
  let handler: HarnessHookHandler | undefined;
  let closed = false;
  const pending = new Map<symbol, (result: HarnessHookResult) => void>();
  const release = (result: HarnessHookResult) => {
    for (const settle of pending.values()) settle(result);
  };
  return {
    setHandler(next: HarnessHookHandler): () => void {
      if (closed) return () => {};
      release({ action: 'continue' });
      handler = next;
      return () => {
        if (handler !== next) return;
        handler = undefined;
        release({ action: 'continue' });
      };
    },
    run(request: HarnessHookRequest): Promise<HarnessHookResult> {
      if (closed) return Promise.resolve({ action: 'block' });
      const current = handler;
      if (!current) return Promise.resolve({ action: 'continue' });
      return new Promise(resolve => {
        const id = Symbol();
        const settle = (result: HarnessHookResult) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => settle({ action: 'continue' }), 1750);
        timer.unref?.();
        pending.set(id, settle);
        Promise.resolve().then(() => pending.has(id) ? current(request) : { action: 'continue' as const }).then(
          result => settle(result?.action === 'block' ? { action: 'block' } : { action: 'continue' }),
          () => settle({ action: 'continue' }),
        );
      });
    },
    close() {
      closed = true;
      handler = undefined;
      release({ action: 'block' });
    },
  };
}
