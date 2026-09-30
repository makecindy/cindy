import { useContext, useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { MainViewHistoryContext } from '@/contexts/MainViewHistoryContext';
import { readMainEntryRoute, rememberMainEntry } from '@/lib/mainEntryPreference';

/** Only the unqualified home route restores; explicit routes always win. */
export function MainEntryRedirect() {
  const { dataOwnerId } = useAuth();
  return <Navigate to={readMainEntryRoute(dataOwnerId)} replace />;
}

export function useRememberMainEntry(): void {
  const { dataOwnerId } = useAuth();
  const location = useLocation();
  const history = useContext(MainViewHistoryContext);
  useEffect(() => {
    // The singleton router can retain the previous account's route while the
    // new protected tree mounts. It must not seed this account's preference.
    if (history?.current.ignoredLocationKey === location.key) return;
    rememberMainEntry(dataOwnerId, location.pathname);
  }, [dataOwnerId, history, location.key, location.pathname]);
}
