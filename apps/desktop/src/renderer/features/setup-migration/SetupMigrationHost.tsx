/**
 * Main-window host for new-computer setup:
 * - answers another computer's read of this window's interface preferences (whitelist only);
 * - offers setup once on a computer that has none of the user's plugins/providers yet while
 *   another computer of the account can be read;
 * - renders the setup dialog wherever it was opened from.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { createLogger } from '@/lib/logger';
import { readPortableRendererPrefs } from './rendererPrefs';
import { SetupMigrationDialog } from './SetupMigrationDialog';
import { SetupMigrationWalkthroughBar } from './SetupMigrationWalkthroughBar';
import { getSetupMigrationState, openSetupMigration } from './setupMigrationStore';

const log = createLogger('setup-migration');
/** Leave the first seconds after sign-in to login, restore and update prompts. */
const SUGGESTION_DELAY_MS = 6000;
const offeredOwners = new Set<string>();

export function SetupMigrationHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { mode, dataOwnerId, isAuthenticated } = useAuth();
  const offering = useRef(false);

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

  useEffect(() => {
    if (mode !== 'cloud' || !isAuthenticated || !dataOwnerId || offeredOwners.has(dataOwnerId)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled || offering.current) return;
      offering.current = true;
      void (async () => {
        try {
          const state = await window.electronAPI.setupMigration.state();
          if (cancelled || !state.suggestion || getSetupMigrationState().open) return;
          offeredOwners.add(dataOwnerId);
          const accepted = await confirm({
            presentation: 'standard',
            autoFocusConfirm: true,
            title: t('setupMigration.suggestion.title', { name: state.suggestion.name }),
            description: t('setupMigration.suggestion.description'),
            confirmText: t('setupMigration.suggestion.confirm'),
            cancelText: t('setupMigration.suggestion.later'),
          });
          if (accepted) openSetupMigration(state.suggestion.deviceId);
          else await window.electronAPI.setupMigration.dismiss({ kind: 'suggestion' });
        } catch (error) {
          log.warn('setup suggestion unavailable', error);
        } finally {
          offering.current = false;
        }
      })();
    }, SUGGESTION_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [confirm, dataOwnerId, isAuthenticated, mode, t]);

  return (
    <>
      <SetupMigrationDialog />
      <SetupMigrationWalkthroughBar />
    </>
  );
}
