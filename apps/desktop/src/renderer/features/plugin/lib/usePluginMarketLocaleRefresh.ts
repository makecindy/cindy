import { useEffect, useRef } from 'react';

type Refresh = () => void | Promise<void>;
type SyncLocale = (locale: string) => void | Promise<void>;

/**
 * Re-fetches locale-sensitive market data after main confirms the host locale.
 *
 * Main initially falls back to the OS locale until Renderer synchronizes the
 * stored preference. The mount-time refresh is therefore intentional: it
 * corrects any catalog request that raced ahead of that first synchronization.
 */
export function usePluginMarketLocaleRefresh(
  locale: string | undefined,
  syncLocale: SyncLocale,
  refreshMarket: Refresh,
  refreshDetail?: Refresh,
): void {
  const syncLocaleRef = useRef(syncLocale);
  const refreshMarketRef = useRef(refreshMarket);
  const refreshDetailRef = useRef(refreshDetail);
  syncLocaleRef.current = syncLocale;
  refreshMarketRef.current = refreshMarket;
  refreshDetailRef.current = refreshDetail;

  useEffect(() => {
    if (!locale) return;
    let cancelled = false;

    void Promise.resolve()
      .then(() => syncLocaleRef.current(locale))
      .then(() => {
        if (cancelled) return;
        const refreshes: Promise<void>[] = [
          Promise.resolve().then(() => refreshMarketRef.current()),
        ];
        const refreshDetail = refreshDetailRef.current;
        if (refreshDetail) {
          refreshes.push(Promise.resolve().then(() => refreshDetail()));
        }
        return Promise.allSettled(refreshes);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [locale]);
}
