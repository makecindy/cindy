import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { homeEntryForRoute, readHomeEntry, saveHomeEntry, type CompanionListHref } from './homeEntryPreference';

const HomeEntryContext = createContext<{ ready: boolean; href: CompanionListHref | null }>({ ready: false, href: null });
export const useHomeEntry = () => useContext(HomeEntryContext);

/** Hydrate before home mounts. A later navigation or owner change cancels restoration. */
export function HomeEntryProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const owner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner);
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ resourceKind?: string }>();
  const resourceKind = Array.isArray(params.resourceKind) ? params.resourceKind[0] : params.resourceKind;
  const routeKey = JSON.stringify([pathname, resourceKind]);
  const route = useRef({ key: routeKey, pathname });
  if (route.current.key !== routeKey) route.current = { key: routeKey, pathname };
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; href: CompanionListHref | null } | null>(null);
  const previousOwner = useRef(owner);
  const ignoredRoute = useRef<string | null>(null);
  if (previousOwner.current !== owner) {
    // Account switches can leave a screen from the old navigation stack visible.
    // Never record that inherited screen as the new account's preference.
    if (previousOwner.current.accountKey || previousOwner.current.switching) ignoredRoute.current = routeKey;
    previousOwner.current = owner;
  }
  const ready = auth.initialized && (!auth.isAuthenticated || snapshot?.owner === owner);
  const href = snapshot?.owner === owner ? snapshot.href : null;

  useEffect(() => {
    if (!auth.initialized || !auth.isAuthenticated || !owner.accountKey) return;
    let cancelled = false;
    const initialRoute = route.current;
    void readHomeEntry(owner.accountKey, owner.accountId).then((destination) => {
      if (cancelled || !isMobileAuthOwnerCurrent(owner)) return;
      setSnapshot({ owner, href: initialRoute.pathname === '/' && route.current === initialRoute ? destination : null });
    });
    return () => { cancelled = true; };
    // Route changes deliberately do not restart hydration: explicit navigation wins.
  }, [auth.initialized, auth.isAuthenticated, owner]);

  useEffect(() => {
    if (!ready || !auth.isAuthenticated || !isMobileAuthOwnerCurrent(owner)) return;
    if (ignoredRoute.current === routeKey) return;
    ignoredRoute.current = null;
    // The root awaiting its redirect must not overwrite the stored choice with tasks.
    if (pathname === '/' && href) return;
    if (href) setSnapshot({ owner, href: null });
    const entry = homeEntryForRoute(pathname, resourceKind);
    if (entry) void saveHomeEntry(owner.accountKey, entry);
  }, [auth.isAuthenticated, href, owner, pathname, ready, resourceKind, routeKey]);

  return <HomeEntryContext.Provider value={{ ready, href }}>{children}</HomeEntryContext.Provider>;
}
