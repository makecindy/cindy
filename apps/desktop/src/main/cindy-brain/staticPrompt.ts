import { assembleSystemPromptSections, type SystemPromptSection } from '@cindy/maker-core';
import { GHOST_CONTEXT_MAX_CHARS } from '@cindy/plugin-protocol';
import { ghostControlPointActive, type InstalledGhost } from '../../shared/ghost.js';
import type { RuntimePluginSettings } from '../../shared/pluginRuntime.js';
import { RuntimePluginControlError } from './runtimeControl.js';

export function createStaticPromptProvider(deps: {
  readSettings(sessionId: string): RuntimePluginSettings | undefined;
  find(pluginId: string): InstalledGhost | undefined;
}) {
  return (sessionId: string, agentKind: 'cc' | 'codex' | 'pi', supported = true): string => {
    const targets = deps.readSettings(sessionId)?.['system-prompt'];
    if (!targets?.length) return '';
    const sections: SystemPromptSection[] = [];
    let size = 0;
    for (const target of targets) {
      try {
        if (!supported) throw new Error('Task system prompt is unsupported at this execution location');
        const ghost = deps.find(target.pluginId);
        if (!ghost || !ghostControlPointActive(ghost, 'system-prompt')) throw new Error('Prompt provider is unavailable');
        const added = (ghost.manifest.systemPrompt ?? []).filter(fragment => !fragment.agentKinds || fragment.agentKinds.includes(agentKind))
          .map(fragment => ({ name: `${target.pluginId}:${fragment.id}`, order: fragment.order, text: fragment.text }));
        const nextSize = size + added.reduce((sum, section) => sum + section.text.length + 2, 0);
        if (nextSize > GHOST_CONTEXT_MAX_CHARS) throw new Error('Task prompt fragments exceed the assembly budget');
        sections.push(...added);
        size = nextSize;
      } catch {
        if (target.onFailure !== 'allow') throw new RuntimePluginControlError(target.onFailure, target.pluginId, true, 'prompt-provider-unavailable');
      }
    }
    return assembleSystemPromptSections('', sections);
  };
}
