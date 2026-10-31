import { useContext, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { MainViewHistoryContext } from '@/contexts/MainViewHistoryContext';
import { mainEntryRouteForPath, readMainEntryRoute, rememberMainEntry } from '@/lib/mainEntryPreference';

/** Only the unqualified home route restores; explicit routes always win. */
export function MainEntryRedirect() {
  const { dataOwnerId } = useAuth();
  return <Navigate to={readMainEntryRoute(dataOwnerId)} replace />;
}

export function useRememberMainEntry(): void {
  const { dataOwnerId } = useAuth();
  const location = useLocation();
  const history = useContext(MainViewHistoryContext);
  const entryRoute = mainEntryRouteForPath(location.pathname);
  const ignoredLocation = history?.current.ignoredLocationKey === location.key;
  useEffect(() => {
    // The singleton router can retain the previous account's route while the
    // new protected tree mounts. It must not seed this account's preference.
    if (ignoredLocation || !entryRoute) return;
    // Only the area is persisted. Changing tasks within it must not synchronously
    // ask Main for owner authority and rewrite the same preference on every click.
    rememberMainEntry(dataOwnerId, entryRoute);
  }, [dataOwnerId, entryRoute, ignoredLocation]);
}
