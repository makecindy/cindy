import type { WorkLouderCodexRendererAction } from '../../shared/workLouderCodex';

export type WorkLouderCodexActionHandler = (
  action: WorkLouderCodexRendererAction,
) => boolean | void;

const handlers = new Set<WorkLouderCodexActionHandler>();
let unsubscribeBridge: (() => void) | null = null;

/**
 * One preload subscription fans hardware actions into the currently mounted
 * shell and composer. Newest subscribers run first so the active task view can
 * consume a command before the app shell applies a fallback.
 */
export function subscribeWorkLouderCodexAction(handler: WorkLouderCodexActionHandler): () => void {
  handlers.add(handler);
  ensureBridge();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      unsubscribeBridge?.();
      unsubscribeBridge = null;
    }
  };
}

function ensureBridge(): void {
  if (unsubscribeBridge || typeof window === 'undefined') return;
  unsubscribeBridge =
    window.electronAPI?.workLouderCodex?.onAction((action) => {
      const listeners = [...handlers].reverse();
      for (const listener of listeners) {
        if (listener(action) === true) break;
      }
    }) ?? null;
}
