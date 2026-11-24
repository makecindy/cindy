import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { OfficialModelPlugin } from '../../../shared/pluginMarket';

export function useOfficialModelPlugins(enabled: boolean, locale: string) {
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const [request, setRequest] = useState<{ owner: typeof owner; locale: string; cursor: string | null }>();
  const currentRequest = request?.owner === owner && request.locale === locale ? request : undefined;
  const [result, setResult] = useState<{ owner: typeof owner; locale: string; request: typeof currentRequest;
    items: OfficialModelPlugin[]; next: string | null; failed: boolean }>();
  const cache = useRef(result);
  const progress = useRef<{ owner: typeof owner; locale: string; ids: Set<string>; cursors: Set<string>; total: number | null } | undefined>(undefined);

  useEffect(() => {
    const market = window.electronAPI?.pluginMarket;
    if (!enabled || !market?.officialModelPlugins) return;
    const previous = cache.current;
    if (previous?.owner === owner && previous.locale === locale && previous.request === currentRequest) return;
    let cancelled = false;
    const current = () => !cancelled && isDataOwnerGenerationCurrent(owner);
    const cursor = currentRequest?.cursor ?? null;
    if (!progress.current || progress.current.owner !== owner || progress.current.locale !== locale) {
      progress.current = { owner, locale, ids: new Set(), cursors: new Set(), total: null };
    }
    const pages = progress.current;
    const items = new Map((previous?.owner === owner && previous.locale === locale ? previous.items : []).map(item => [item.pluginId, item]));
    const publish = (next: string | null, failed: boolean) => {
      cache.current = { owner, locale, request: currentRequest, items: [...items.values()], next, failed };
      setResult(cache.current);
    };
    async function readPage() {
      try {
        const page = await market.officialModelPlugins(cursor);
        if (!current()) return;
        for (const item of page.items) items.set(item.pluginId, item);
        for (const id of page.officialIds) pages.ids.add(id);
        pages.total ??= page.totalOfficial;
        if (cursor) pages.cursors.add(cursor);
        const next = page.nextCursor;
        publish(next && !pages.cursors.has(next) && (pages.total === null || pages.ids.size < pages.total) ? next : null, page.incomplete === true);
      } catch {
        if (current()) publish(null, true);
      }
    }
    void readPage();
    return () => {
      cancelled = true;
      void market.cancelOfficialModelPlugins().catch(() => undefined);
    };
  }, [enabled, owner, locale, currentRequest]);

  const visible = enabled && result?.owner === owner && result.locale === locale ? result : undefined;
  const settled = visible?.request === currentRequest;
  return {
    items: visible?.items ?? [],
    failed: settled && !!visible?.failed,
    hasMore: settled && !!visible?.next && !visible.failed,
    retry: () => setRequest({ owner, locale, cursor: currentRequest?.cursor ?? null }),
    loadMore: () => { if (visible?.next) setRequest({ owner, locale, cursor: visible.next }); },
  };
}
