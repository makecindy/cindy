/**
 * Main-window host for the Migration Assistant and the get-started guide:
 * - answers another computer's read of this window's interface preferences (whitelist only);
 * - after a sign-in or local-mode entry made in this run, asks Main once whether to show the
 *   get-started guide and which path it takes (docs/product-rules/first-run-guide.md). A
 *   session restored at startup is not a sign-in and never opens it;
 * - renders the setup dialog wherever it was opened from.
 */
import { useEffect, useRef } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { getFirstRunGuideState, openFirstRunGuide } from '@/features/first-run-guide/firstRunGuideStore';
import { createLogger } from '@/lib/logger';
import { readPortableRendererPrefs } from './rendererPrefs';
import { SetupMigrationDialog } from './SetupMigrationDialog';
import { SetupMigrationWalkthroughBar } from './SetupMigrationWalkthroughBar';
import { getSetupMigrationState } from './setupMigrationStore';

const log = createLogger('setup-migration');
/** Leave the first seconds after sign-in to the login hand-off, restore and update prompts. */
const SIGN_IN_SETTLE_MS = 6000;

const LEGACY_POLL_MS = 1000;

/**
 * Resolves once the earlier-version data screen is no longer up (confirming, copying, or
 * showing that it failed). Main clears the failed screen without a push, so this polls.
 */
async function legacyMigrationSettled(stillWanted: () => boolean): Promise<void> {
  const api = window.electronAPI?.legacyMigration;
  if (!api) return;
  while (stillWanted()) {
    const phase = (await api.getState().catch(() => null))?.phase ?? null;
    if (phase !== 'confirm' && phase !== 'running' && phase !== 'failed') return;
    await new Promise((resolve) => window.setTimeout(resolve, LEGACY_POLL_MS));
  }
}

export function SetupMigrationHost() {
  const { mode, dataOwnerId, isAuthenticated, isInitializing } = useAuth();
  // An account, or local mode: both are a person starting to use this computer.
  const signedInOwner =
    !isInitializing && ((mode === 'cloud' && isAuthenticated) || mode === 'local') ? dataOwnerId : null;
  const signedInOwnerRef = useRef(signedInOwner);
  useEffect(() => {
    signedInOwnerRef.current = signedInOwner;
  }, [signedInOwner]);
  /** The startup auth decision has been seen; owners that appear after it started in this run. */
  const startupSeen = useRef(false);
  const askedOwners = useRef(new Set<string>());

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
    if (isInitializing) return;
    if (!startupSeen.current) {
      startupSeen.current = true;
      // Restored at startup: this account signed in on this computer before.
      if (signedInOwner) askedOwners.current.add(signedInOwner);
      return;
    }
    if (!signedInOwner || askedOwners.current.has(signedInOwner)) return;
    const timer = window.setTimeout(() => {
      askedOwners.current.add(signedInOwner);
      void (async () => {
        try {
          // Earlier-version data is confirmed and copied before the app opens; the guide
          // follows it instead of appearing on top of it.
          await legacyMigrationSettled(() => signedInOwnerRef.current === signedInOwner);
          // Older preloads (and partial test shells) have no such call; Settings still opens it.
          const guide = await window.electronAPI?.setupMigration?.firstRunGuide?.();
          // Main answers `show` only once, so honor it unless the account changed meanwhile.
          if (!guide?.show || signedInOwnerRef.current !== signedInOwner) return;
          // Already in the assistant or the guide by hand: do not stack a second window.
          if (getSetupMigrationState().open || getFirstRunGuideState().open) return;
          openFirstRunGuide({ manual: false, migration: guide.migration, legacyMigrated: guide.legacyMigrated });
        } catch (error) {
          log.warn('get-started guide check unavailable', error);
        }
      })();
    }, SIGN_IN_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [isInitializing, signedInOwner]);

  return (
    <>
      <SetupMigrationDialog />
      <SetupMigrationWalkthroughBar />
    </>
  );
}
