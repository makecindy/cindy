/**
 * Desktop wiring of the upgrade-split repair (upgradeSplitRepair.ts). Checks after each catalog
 * refresh, when placements or pauses change, and when an account read shows a sign-in change.
 * Each merge is the user's own「并入其他供应商」command (executeSubscriptionAccountCommand), one
 * provider at a time with the conditions read again before the next one. The window process owns
 * this write; Host client mode does not start it and the Host only reads the result.
 */
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getProviderShareHostCompleteSnapshot, onProviderShareHostChanged } from '../device-link/providerShareHost.js';
import { createLogger } from '../logger.js';
import { setUpgradeSplitRepair } from '../maker-host/createDesktopProviderService.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { readProviderPresentation } from '../maker-host/provider-presentation-store.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { readProviderGroup } from '../provider-group/store.js';
import {
  onSubscriptionAccountSignInEvidenceChanged,
  onSubscriptionAccountsChanged,
  subscriptionAccountSignInEvidence,
} from './runtime.js';
import { executeSubscriptionAccountCommand } from './service.js';
import {
  findUpgradeSplitRepair,
  recordUpgradeSplitRepairStarted,
  settleUpgradeSplitRepairs,
  type UpgradeSplitRepairDeps,
} from './upgradeSplitRepair.js';

const log = createLogger('subscription-upgrade-repair');
/** Upper bound per run; each merge also leaves one fewer candidate. */
const MAX_MERGES_PER_RUN = 16;

export const upgradeSplitRepairDeps: UpgradeSplitRepairDeps = {
  signInEvidence: subscriptionAccountSignInEvidence,
  remoteInvocationAllowed: isRemoteProviderInvocationAllowed,
  sharedProviderIds: () => {
    const shares = getProviderShareHostCompleteSnapshot();
    return shares ? new Set(shares.map((share) => share.providerId)) : null;
  },
  hasProviderGroup: (providerId) => !!readProviderGroup(providerId),
  renamed: (providerId) => !!readProviderPresentation(providerId).name,
  disabled: (providerId) => readModelDisableOverrides().disabledProviders?.[providerId] === true,
};

async function repairOnce(): Promise<void> {
  const owner = activeOwnerScopeKey();
  const isCurrent = () => owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending();
  for (let merges = 0; merges < MAX_MERGES_PER_RUN && isCurrent(); merges++) {
    // Whatever already left its split provider (this repair's merges included) is never undone.
    await settleUpgradeSplitRepairs(owner);
    if (!isCurrent()) return;
    const repair = findUpgradeSplitRepair(upgradeSplitRepairDeps);
    if (!repair) return;
    await recordUpgradeSplitRepairStarted(repair.providerId, owner);
    if (!isCurrent()) return;
    try {
      await executeSubscriptionAccountCommand(
        { action: 'merge', providerId: repair.providerId, target: repair.kind },
        () => {
          // Recording the attempt and acquiring the placement lock both yield to user actions.
          if (!isCurrent() || !findUpgradeSplitRepair(upgradeSplitRepairDeps, repair.providerId))
            throw new Error('Subscription upgrade repair no longer applies');
        },
      );
    } finally {
      // A merge that went through is settled as done even if the command failed afterwards; one that
      // did not stays pending and eligible for a later check. Any throw ends this run.
      if (isCurrent()) await settleUpgradeSplitRepairs(owner);
    }
    log.info('merged an upgrade-split subscription provider back into its built-in provider', repair);
  }
}

let flight: Promise<void> | null = null;
let again = false;

/** One run at a time; a request during a run checks once more afterwards. Never throws. */
function scheduleRepair(): Promise<void> {
  again = true;
  if (flight) return flight;
  flight = (async () => {
    while (again) {
      again = false;
      try {
        await repairOnce();
      } catch (error) {
        // Files or the owner changed under it; the next refresh or account change tries again.
        log.warn('upgrade-split repair did not complete', { error: error instanceof Error ? error.name : typeof error });
      }
    }
    // Cleared in the same turn as the last check of `again`, so no request falls in between.
    flight = null;
  })();
  return flight;
}

let started = false;
export function startUpgradeSplitRepair(): void {
  if (started) return;
  started = true;
  setUpgradeSplitRepair(scheduleRepair);
  // Placement and pause changes; usage and load notices change neither.
  onSubscriptionAccountsChanged((_provider, resetAccountId, change) => {
    if (!resetAccountId && !change) void scheduleRepair();
  });
  onSubscriptionAccountSignInEvidenceChanged(() => void scheduleRepair());
  onProviderShareHostChanged(() => void scheduleRepair());
}
