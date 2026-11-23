import { useEffect, useState, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { OfficialModelPlugin } from '../../../shared/pluginMarket';

export function useOfficialModelPlugins(enabled: boolean, locale: string): OfficialModelPlugin[] {
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const [result, setResult] = useState<{ owner: typeof owner; locale: string; items: OfficialModelPlugin[] }>();

  useEffect(() => {
    const market = window.electronAPI?.pluginMarket;
    if (!enabled || !market?.officialModelPlugins) return;
    let cancelled = false;
    const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);

    async function discover() {
      const engines: OfficialModelPlugin[] = [];
      const seen = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      setResult({ owner, locale, items: [] });
      do {
        const page = await market.officialModelPlugins(cursor);
        if (!current()) return;
        for (const item of page.items) {
          if (seen.has(item.pluginId)) continue;
          seen.add(item.pluginId);
          engines.push(item);
        }
        setResult({ owner, locale, items: [...engines] });
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor)) return;
        cursors.add(cursor);
      } while (current());
    }
    // The existing provider catalog stays usable offline.
    void discover().catch(() => undefined);
    return () => { cancelled = true; };
  }, [enabled, locale, owner]);

  return enabled && result?.owner === owner && result.locale === locale ? result.items : [];
}
