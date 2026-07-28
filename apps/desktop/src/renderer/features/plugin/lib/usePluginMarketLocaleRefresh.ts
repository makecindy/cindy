import { useEffect, useRef } from 'react';

type Refresh = () => void | Promise<void>;

/**
 * Re-fetches locale-sensitive market data after the host language changes.
 *
 * The initial render already has its normal market load. Keeping the previous
 * locale in a ref avoids a duplicate request on mount while still refreshing
 * both the catalog and an open detail view after a language switch.
 */
export function usePluginMarketLocaleRefresh(
  locale: string | undefined,
  refreshMarket: Refresh,
  refreshDetail?: Refresh,
): void {
  const previousLocaleRef = useRef(locale);
  const refreshMarketRef = useRef(refreshMarket);
  const refreshDetailRef = useRef(refreshDetail);
  refreshMarketRef.current = refreshMarket;
  refreshDetailRef.current = refreshDetail;

  useEffect(() => {
    if (previousLocaleRef.current === locale) return;
    previousLocaleRef.current = locale;

    void Promise.resolve()
      .then(() => refreshMarketRef.current())
      .catch(() => undefined);
    if (refreshDetailRef.current) {
      void Promise.resolve()
        .then(() => refreshDetailRef.current?.())
        .catch(() => undefined);
    }
  }, [locale]);
}
