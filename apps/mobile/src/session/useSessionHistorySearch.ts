import { useEffect, useState } from 'react';

/** A new navigation request opens search even when the task screen is reused. */
export function useSessionHistorySearch(openSearch: string | null, request: string | null) {
  const [searchOpen, setSearchOpen] = useState(openSearch === '1');
  useEffect(() => {
    if (openSearch === '1') setSearchOpen(true);
  }, [openSearch, request]);
  // Keep openSearch on the route: it also permits read-only invitation history.
  return [searchOpen, setSearchOpen] as const;
}
