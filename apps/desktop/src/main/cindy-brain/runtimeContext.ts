import { GHOST_CONTEXT_MAX_CHARS } from '@cindy/plugin-protocol';
import type { MemoryProviderHit } from '@cindy/mcps';
import type { GhostComposeContextPointData, GhostMemorySearchPointData } from '../../shared/ghost.js';
import { createRuntimePluginControl } from './runtimeControl.js';

export function createRuntimeContextProviders(control: ReturnType<typeof createRuntimePluginControl>) {
  return {
    compose(sessionId: string, text: string, signal?: AbortSignal): Promise<string> | undefined {
      const sections: string[] = [];
      const pending = control.run<GhostComposeContextPointData>('will-compose-context', sessionId,
        async () => ({ sessionId, text }), async result => {
          if (result.action !== 'context' || !result.blocks.length) return;
          const section = JSON.stringify({ sourcePlugin: { id: result.ghostId, name: result.ghostName }, blocks: result.blocks });
          if (sections.join('\n').length + section.length > GHOST_CONTEXT_MAX_CHARS) throw new Error('Runtime context exceeds the reference-material budget');
          sections.push(section);
        }, signal);
      return pending?.then(() => sections.join('\n'));
    },
    search(input: GhostMemorySearchPointData): Promise<MemoryProviderHit[]> | undefined {
      const hits: MemoryProviderHit[] = [];
      const pending = control.run<GhostMemorySearchPointData>('will-search-memory', input.sessionId,
        async () => input, async result => {
          if (result.action !== 'memories') return;
          for (const entry of result.entries) {
            if (input.type && entry.type && entry.type !== input.type) continue;
            if (hits.length >= 50) break;
            hits.push({ ...entry, sourcePlugin: { id: result.ghostId, name: result.ghostName } });
          }
        });
      // A stale owner/selection must not leak an already-collected provider result.
      return pending?.then(() => hits).catch(() => []);
    },
  };
}
