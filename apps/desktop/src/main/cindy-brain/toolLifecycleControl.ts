import { assertToolLifecycleVerdict, type ToolLifecycleControl, type ToolLifecycleVerdict } from '@cindy/maker-core';
import type { GhostToolPointData } from '../../shared/ghost.js';
import type { RuntimePluginSettings } from '../../shared/pluginRuntime.js';
import { type createRuntimePluginControl, RuntimePluginControlError } from './runtimeControl.js';

export function createPluginToolLifecycle(deps: {
  readSettings(sessionId: string): RuntimePluginSettings | undefined;
  control(): ReturnType<typeof createRuntimePluginControl>;
}): ToolLifecycleControl {
  return {
    enabled: sessionId => {
      const settings = deps.readSettings(sessionId);
      return !!(settings?.['will-tool-call']?.length || settings?.['did-tool-result']?.length);
    },
    async run(sessionId, event, signal) {
      const point = event.phase === 'call' ? 'will-tool-call' : 'did-tool-result';
      if (!deps.readSettings(sessionId)?.[point]?.length) return {};
      const verdict: ToolLifecycleVerdict = {};
      const inputError = JSON.stringify(event).length > 1_048_576 ? new Error('Tool event exceeds the plugin transport budget') : undefined;
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
          if (JSON.stringify(next).length > 1_048_576) throw new Error('Combined tool hook verdict exceeds the transport budget');
          Object.assign(verdict, next);
          return { ...data, ...(result.tool.input ? { input: result.tool.input } : {}),
            ...('result' in result.tool ? { result: verdict.result } : {}) };
        }, signal, inputError);
      if (!pending) return {};
      try { await pending; return verdict; }
      catch (error) {
        if (error instanceof RuntimePluginControlError && error.action === 'block') return { decision: 'deny', reason: error.reason || 'Plugin tool hook blocked this operation' };
        throw error;
      }
    },
  };
}
