import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import type { SessionEntryNavigator } from './botSessionOwners';

/**
 * Reports each location the router has committed to the session entry navigator.
 * An Agent Island click into a target without a disposal control is only
 * disposed once its target location shows up here (see createSessionEntryNavigator).
 */
export function useSessionEntryLocationCommits(navigator: SessionEntryNavigator): void {
  const location = useLocation();
  const committedPath = `${location.pathname}${location.search}`;
  useEffect(() => {
    navigator.locationCommitted(committedPath);
  }, [committedPath, navigator]);
}
