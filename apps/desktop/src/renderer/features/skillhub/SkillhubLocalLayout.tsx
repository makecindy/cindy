import { useState } from 'react';
import { Outlet, useLocation, useMatch, type Location } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { SkillhubHomeView } from './SkillhubHomeView';

/** Keep the visited catalog alive only within this owner's local skill routes. */
export function SkillhubLocalLayout() {
  const { dataOwnerId, mode } = useAuth();
  return <LocalSkillPages key={JSON.stringify([mode, dataOwnerId])} />;
}

function LocalSkillPages() {
  const location = useLocation();
  const showingCatalog = useMatch({ path: '/skillhub/local', end: true }) !== null;
  const [catalogLocation, setCatalogLocation] = useState<Location | null>(
    showingCatalog ? location : null,
  );

  if (showingCatalog && catalogLocation !== location) {
    setCatalogLocation(location);
  }

  return (
    <div className="relative h-full min-h-0 w-full">
      {catalogLocation && (
        <div
          className="absolute inset-0"
          style={{ visibility: showingCatalog ? 'visible' : 'hidden' }}
          aria-hidden={!showingCatalog}
          inert={!showingCatalog}
        >
          {/* Keep the scroll container's geometry as well as its DOM identity.
              A detail URL must not change the hidden catalog's filters. */}
          <SkillhubHomeView active={showingCatalog} navigationLocation={catalogLocation} />
        </div>
      )}
      {!showingCatalog && <Outlet />}
    </div>
  );
}
