import { useEffect } from 'react';
import type { PluginUiEntry } from './PluginUiContributions';
import { collectPluginUiCompletions, type PluginUiCompletion } from './pluginUiCompletion';

export interface PluginUiCompletionRequest { key: string; trigger: '/' | '@'; query: string; from: number }
export interface PluginUiCompletionResult { key: string; items: PluginUiCompletion[] }

/** Mounted only for an actual provider; observes existing trigger props, never the editor. */
export function PluginUiCompletionBridge({ entries, request, sessionId, onResult }: {
  entries: readonly PluginUiEntry[]; request: PluginUiCompletionRequest | null; sessionId: string | null;
  onResult(value: PluginUiCompletionResult | null): void;
}) {
  useEffect(() => {
    if (!request) { onResult(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]);
      void collectPluginUiCompletions(entries, request.trigger, request.query, signal, async (entry, input, signal) => {
        if (signal.aborted) return undefined;
        const requestId = crypto.randomUUID();
        const cancel = () => { void window.electronAPI.maker.mcpApps(sessionId, { op: 'plugin-action-cancel', requestId }).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          return await window.electronAPI.maker.mcpApps(sessionId, { op: 'plugin-action',
            instanceId: entry.instanceId, id: entry.contribution.id, input, requestId });
        } finally { signal.removeEventListener('abort', cancel); }
      }).then(items => { if (!controller.signal.aborted) onResult({ key: request.key, items }); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // Identity includes task, trigger anchor and query; unrelated typing/rendering cannot restart a call.
  }, [entries, request?.key, sessionId, onResult]);
  return null;
}
