import { assertToolLifecycleBudget, assertToolLifecycleVerdict, type ToolLifecycleControl, type ToolLifecycleVerdict } from '@cindy/maker-core';
import type { GhostToolPointData } from '../../shared/ghost.js';
import type { RuntimePluginSettings } from '../../shared/pluginRuntime.js';
import { type createRuntimePluginControl, RuntimePluginControlError } from './runtimeControl.js';

export function createPluginToolLifecycle(deps: {
  readSettings(sessionId: string): RuntimePluginSettings | undefined;
  control(): ReturnType<typeof createRuntimePluginControl>;
}): ToolLifecycleControl {
  return {
    bind: sessionId => {
      const settings = deps.readSettings(sessionId);
      if (!settings?.['will-tool-call']?.length && !settings?.['did-tool-result']?.length) return;
      const control = deps.control().withSettings(sessionId, settings);
      return createPluginToolLifecycle({ readSettings: () => settings, control: () => control });
    },
    enabled: sessionId => {
      const settings = deps.readSettings(sessionId);
      return !!(settings?.['will-tool-call']?.length || settings?.['did-tool-result']?.length);
    },
    async run(sessionId, event, signal) {
      const point = event.phase === 'call' ? 'will-tool-call' : 'did-tool-result';
      if (!deps.readSettings(sessionId)?.[point]?.length) return {};
      const verdict: ToolLifecycleVerdict = {};
      const contributors: Array<() => void> = [];
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
          Object.assign(verdict, next);
          contributors.push(assertCurrent);
          return { ...data, ...(result.tool.input ? { input: result.tool.input } : {}),
            ...('result' in result.tool ? { result: verdict.result } : {}) };
        }, signal, inputError);
      if (!pending) return {};
      try {
        await pending;
        // A prior contributor may have stopped while another plugin answered.
        try { for (const current of contributors) current(); }
        catch { return {}; }
        return verdict;
      }
      catch (error) {
        if (error instanceof RuntimePluginControlError && error.action === 'block') return { decision: 'deny', reason: error.reason || 'Plugin tool hook blocked this operation' };
        throw error;
      }
    },
  };
}
