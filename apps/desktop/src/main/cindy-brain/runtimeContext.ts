import { GHOST_CONTEXT_MAX_CHARS } from '@cindy/plugin-protocol';
import type { MemoryProviderHit } from '@cindy/mcps';
import type { GhostComposeContextPointData, GhostMemorySearchPointData } from '../../shared/ghost.js';
import { createRuntimePluginControl } from './runtimeControl.js';

export function createRuntimeContextProviders(control: ReturnType<typeof createRuntimePluginControl>) {
  return {
    compose(sessionId: string, text: string | (() => string), signal?: AbortSignal): Promise<string> | undefined {
      const sections: string[] = [];
      let chars = 0;
      const pending = control.run<GhostComposeContextPointData>('will-compose-context', sessionId,
        async () => ({ sessionId, text: typeof text === 'function' ? text() : text }), async result => {
          if (result.action !== 'context' || !result.blocks.length) return;
          const section = JSON.stringify({ sourcePlugin: { id: result.ghostId, name: result.ghostName }, blocks: result.blocks });
          const nextChars = chars + (sections.length ? 1 : 0) + section.length;
          if (nextChars > GHOST_CONTEXT_MAX_CHARS) throw new Error('Runtime context exceeds the reference-material budget');
          sections.push(section);
          chars = nextChars;
        }, signal);
      return pending?.then(() => sections.join('\n'));
    },
    search(input: GhostMemorySearchPointData): Promise<import('@cindy/mcps').MemoryProviderSearchResult> | undefined {
      const hits: MemoryProviderHit[] = [];
      let chars = 0;
      let truncated = false;
      const pending = control.run<GhostMemorySearchPointData>('will-search-memory', input.sessionId,
        async () => input, async result => {
          if (result.action !== 'memories') return;
          for (const entry of result.entries) {
            if (input.type && entry.type && entry.type !== input.type) continue;
            if (hits.length >= 50 || chars >= GHOST_CONTEXT_MAX_CHARS) { truncated = true; break; }
            const content = entry.content.slice(0, GHOST_CONTEXT_MAX_CHARS - chars);
            const cut = content.length < entry.content.length;
            hits.push({ ...entry, content, sourcePlugin: { id: result.ghostId, name: result.ghostName },
              ...(cut ? { truncated: true } : {}) });
            chars += content.length;
            if (cut) truncated = true;
          }
        });
      // A stale owner/selection must not leak an already-collected provider result.
      return pending?.then(() => ({ hits, ...(truncated ? { truncated: true } : {}) })).catch(() => ({ hits: [] }));
    },
  };
}
