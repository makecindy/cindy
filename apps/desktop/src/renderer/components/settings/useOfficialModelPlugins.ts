import { useEffect, useState, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { PluginMarketItem } from '../../../shared/pluginMarket';

// Cache only the immutable release capability. Visibility, publisher and install
// state always come from the current owner's catalog.
const releaseCapabilities = new Map<string, { releaseId: string; hasEngine: boolean }>();
function isOfficial(item: PluginMarketItem): boolean {
  return item.sourceType === 'server' && item.scope === 'public' && item.publisherKind === 'official';
}

export function useOfficialModelPlugins(enabled: boolean, locale: string): PluginMarketItem[] {
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const [result, setResult] = useState<{ owner: typeof owner; locale: string; items: PluginMarketItem[] }>();

  useEffect(() => {
    const market = window.electronAPI?.pluginMarket;
    if (!enabled || !market?.query) return;
    let cancelled = false;
    const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);

    async function discover() {
      const engines: PluginMarketItem[] = [];
      const seen = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let totalOfficial: number | undefined;
      setResult({ owner, locale, items: [] });
      do {
        const page = await market.query({ scope: 'public', limit: 100, cursor, counts: cursor === null });
        if (!current()) return;
        if (page.counts) totalOfficial = page.counts.official;
        for (const item of page.items) {
          if (!isOfficial(item) || seen.has(item.pluginId)) continue;
          seen.add(item.pluginId);
          let capability = releaseCapabilities.get(item.pluginId);
          if (capability?.releaseId !== item.releaseId) {
            const detail = await market.detail(item.pluginId, false).catch(() => null);
            if (!current()) return;
            if (!detail || !isOfficial(detail) || detail.pluginId !== item.pluginId || detail.releaseId !== item.releaseId) continue;
            capability = { releaseId: item.releaseId, hasEngine: detail.manifest.harnesses?.some(engine => engine.protocol === 'acp') === true };
            releaseCapabilities.set(item.pluginId, capability);
          }
          if (capability.hasEngine) {
            engines.push(item);
            setResult({ owner, locale, items: [...engines] });
          }
        }
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor) || (totalOfficial !== undefined && seen.size >= totalOfficial)) return;
        cursors.add(cursor);
      } while (current());
    }
    // The existing provider catalog stays usable offline.
    void discover().catch(() => undefined);
    return () => { cancelled = true; };
  }, [enabled, locale, owner]);

  return enabled && result?.owner === owner && result.locale === locale ? result.items : [];
}
