import type { Maker } from '@cindy/maker-core';

import { createPiPackageStore } from '../../../desktop/src/main/maker-host/piPackageStoreCore.js';
import { createPiManagedPackageMutation } from '../../../desktop/src/main/maker-host/piManagedPackageMutationCore.js';
import {
  captureLocalPiPackageRuntimeInvalidationSnapshot,
  invalidateLocalPiPackageRuntimesForObservedChange,
  settleLocalPiPackageRuntimeSnapshot,
  type PiPackageRuntimeInvalidationSnapshot,
} from '../../../desktop/src/main/maker-host/pi-package-runtime-invalidation.js';
import { createLogger } from '../../../desktop/src/main/logger.js';

const log = createLogger('host-pi-packages');

/**
 * The Host does not manage engine binaries yet (release table row 34, 8k), so it cannot install a new
 * Pi core the way the desktop does (into its own directory, then publish it). It refuses instead of
 * updating Pi in place in a directory live tasks use; package install, update and remove still work.
 * The refusal is classified as hostStage 'unsupported', which Pi's receipt states without a retry.
 */
class HostPiCoreUpdateUnsupportedError extends Error {
  constructor() { super('The Host does not update the Pi core yet'); }
}

/**
 * Pi packages on the Host: the desktop's package store and managed mutation (piPackageStoreCore.ts,
 * piManagedPackageMutationCore.ts) over this profile's pi-package-home and the Host's Pi binary, and
 * the desktop's runtime retirement around a mutation (maker-host/index.ts) and after a change another
 * process made (maker-ipc/register.ts, without the renderer broadcast, which is M2).
 */
export function createHostPiPackages(options: { userDataDir: string; piBinaryPath: string | null }) {
  const store = createPiPackageStore({
    getUserDataDir: () => options.userDataDir,
    getReadyBinaryPath: () => options.piBinaryPath ?? undefined,
    updateReadyPiBinary: async () => { throw new HostPiCoreUpdateUnsupportedError(); },
    piBinaryUpdateFailureStage: (error) => (error instanceof HostPiCoreUpdateUnsupportedError ? 'unsupported' : undefined),
  });
  const mutation = createPiManagedPackageMutation(store);
  let _maker: Maker | null = null;
  let stopObserving: (() => void) | null = null;

  // As the desktop (maker-host/index.ts): store mutations are serialized; each settled callback
  // consumes the exact latest-byte-edge runtime snapshot for its durable mutation.
  const pendingPiPackageRuntimeSnapshots: PiPackageRuntimeInvalidationSnapshot[] = [];
  const onPiManagedPackageMutationCommitted = async (phase: 'commit' | 'post-build' = 'commit') => {
    const maker = _maker;
    if (!maker) return;
    const snapshot = await captureLocalPiPackageRuntimeInvalidationSnapshot(maker);
    if (phase === 'post-build' && pendingPiPackageRuntimeSnapshots.length > 0) {
      // The mutation lock prevents another commit edge from interleaving.
      // Replace the earlier snapshot so settled retirement includes every
      // runtime admitted while optional package bytes were being written.
      pendingPiPackageRuntimeSnapshots[pendingPiPackageRuntimeSnapshots.length - 1] = snapshot;
    } else {
      pendingPiPackageRuntimeSnapshots.push(snapshot);
    }
  };
  const onPiManagedPackageMutationSettled: NonNullable<import('@cindy/maker-core').AgentDeps['onPiManagedPackageMutationSettled']> =
    async (callerSessionId, publishOutcome, createRetirementFailureEvent) => {
      const partial = () => publishOutcome({
        runtimeConvergence: 'partial',
        recoveryAction: 'restart-cindy-to-refresh-packages',
      });
      const maker = _maker;
      const snapshot = pendingPiPackageRuntimeSnapshots.shift();
      if (!maker || !snapshot) {
        partial();
        return;
      }
      // The receipt has been sent, not necessarily consumed by Pi. Keep the
      // caller and busy siblings alive until their owned turn settles.
      await settleLocalPiPackageRuntimeSnapshot(maker, snapshot, callerSessionId, publishOutcome, createRetirementFailureEvent);
    };

  return {
    store,
    deps: {
      resolvePiManagedPackageResources: store.resolveManagedPiPackageResources,
      resolvePiNativePackagePaths: store.resolveManagedPiNativePackagePaths,
      mutatePiManagedPackage: (request: Parameters<typeof mutation.mutateAuthorizedPiManagedPackage>[0]) =>
        mutation.mutateAuthorizedPiManagedPackage(request, undefined, {
          onRuntimeInvalidationPublished: onPiManagedPackageMutationCommitted,
        }),
      onPiManagedPackageMutationSettled,
    },
    /** Attach the Host's Maker: mutation retirement, and retirement after another process changed the packages. */
    attachMaker(maker: Maker): void {
      _maker = maker;
      stopObserving?.();
      // As the desktop (maker-ipc/register.ts): a change another process made (the window's Settings
      // in client mode) retires this process's local Pi runtimes after their current turn.
      stopObserving = store.onPiPackagesChanged((origin) => {
        void invalidateLocalPiPackageRuntimesForObservedChange(maker, origin)
          .then((invalidation) => {
            if (invalidation && invalidation.failedSessionIds.length > 0) {
              log.warn('Cross-process Pi package change did not retire every local runtime', {
                failedSessionIds: invalidation.failedSessionIds,
              });
            }
          })
          .catch((error) => {
            log.warn('Cross-process Pi package runtime invalidation failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      });
    },
    close(): void {
      stopObserving?.();
      stopObserving = null;
      _maker = null;
    },
  };
}
