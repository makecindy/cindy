/**
 * Main-window host for new-computer setup:
 * - answers another computer's read of this window's interface preferences (whitelist only);
 * - opens no migration suggestion on login; entry is an explicit Settings action;
 * - renders the setup dialog wherever it was opened from.
 */
import { useEffect } from 'react';

import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { readPortableRendererPrefs } from './rendererPrefs';
import { SetupMigrationDialog } from './SetupMigrationDialog';
import { SetupMigrationWalkthroughBar } from './SetupMigrationWalkthroughBar';

export function SetupMigrationHost() {
  useEffect(() => {
    const api = window.electronAPI?.setupMigration;
    if (!api) return;
    const unsubscribe = api.host.onRequest((request) => {
      if (!isDataOwnerPushStampCurrent(request.ownerStamp) || Date.now() > request.expiresAt) {
        api.host.reply({ requestId: request.requestId, failed: true });
        return;
      }
      try {
        api.host.reply({ requestId: request.requestId, prefs: readPortableRendererPrefs() });
      } catch {
        api.host.reply({ requestId: request.requestId, failed: true });
      }
    });
    api.host.ready();
    return unsubscribe;
  }, []);


  return (
    <>
      <SetupMigrationDialog />
      <SetupMigrationWalkthroughBar />
    </>
  );
}
