import { assertToolLifecycleBudget, assertToolLifecycleVerdict, type ToolLifecycleControl, type ToolLifecycleVerdict } from '@cindy/maker-core/tool-lifecycle';
import type { GhostToolPointData } from '../../shared/ghost.js';
import type { RuntimePluginSettings } from '../../shared/pluginRuntime.js';
import { type createRuntimePluginControl, RuntimePluginControlError } from './runtimeControl.js';

export function createPluginToolLifecycle(deps: {
  readSettings(sessionId: string): RuntimePluginSettings | undefined;
  control(): ReturnType<typeof createRuntimePluginControl>;
}): ToolLifecycleControl {
  return {
    enabled: (sessionId, phase) => {
      const settings = deps.readSettings(sessionId);
      if (phase) return !!settings?.[phase === 'call' ? 'will-tool-call' : 'did-tool-result']?.length;
      return !!(settings?.['will-tool-call']?.length || settings?.['did-tool-result']?.length);
    },
    async run(sessionId, event, signal) {
      const point = event.phase === 'call' ? 'will-tool-call' : 'did-tool-result';
      if (!deps.readSettings(sessionId)?.[point]?.length) return {};
      let verdict: ToolLifecycleVerdict = {};
      let inputError: Error | undefined;
      try { assertToolLifecycleBudget(event); } catch (error) { inputError = error as Error; }
      const pending = deps.control().run<GhostToolPointData>(point, sessionId, async () => ({ ...event, sessionId }),
        async (result, data, assertCurrent) => {
          if (result.action !== 'tool') return;
          assertToolLifecycleVerdict(event, result.tool);
          assertCurrent();
          if (result.tool.decision === 'deny') throw new RuntimePluginControlError('block', result.ghostId, false, result.tool.reason);
          const next = { ...verdict, ...result.tool,
            ...(result.tool.additionalContext ? { additionalContext: [verdict.additionalContext, result.tool.additionalContext].filter(Boolean).join('\n') } : {}),
            ...('result' in result.tool && event.engine === 'pi'
              ? { result: { ...data.result as Record<string, unknown>, ...result.tool.result as Record<string, unknown> } } : {}),
          };
          assertToolLifecycleBudget(next);
          verdict = next;
          return { ...data, ...(result.tool.input ? { input: result.tool.input } : {}),
            ...('result' in result.tool ? { result: verdict.result } : {}) };
        }, signal, inputError);
      if (!pending) return {};
      try { await pending; return verdict; }
      catch (error) {
        if (error instanceof RuntimePluginControlError && error.failure && error.reason === 'selection-changed') return {};
        if (error instanceof RuntimePluginControlError && error.action === 'block') return { decision: 'deny', reason: error.reason || 'Plugin tool hook blocked this operation' };
        throw error;
      }
    },
  };
}
