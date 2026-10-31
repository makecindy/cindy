import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PROJECT_PINS_APPLY_MAX_KEYS } from '@cindy/maker-shared/project-pin-sync';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import { remoteProjectPins, useRemoteProjectPins } from '@/features/device-link/remoteProjectPins';
import { createLogger } from '@/lib/logger';
import type { DataOwnerPushStamp } from '../../../../shared/dataOwnerPush';
import type { SidebarSettingsSnapshot } from '../../../../shared/sidebarSettings';
import {
  hostProjectPinTarget,
  legacyProjectPinsForHost,
  resolvePinnedProjectKeys,
  staleProjectPinHints,
} from '../lib/hostProjectPins';
import { pinnedProjectEntryId } from '../lib/pinnedSidebarOrder';

const log = createLogger('project-pin-sync');
/** Handoff waits out a host that is still starting or briefly unreachable. */
const HANDOFF_RETRY_DELAYS_MS = [10_000, 30_000, 90_000, 300_000] as const;

/** The owning desktop holds this project's pin, but it cannot be reached right now. */
export class ProjectPinHostUnavailableError extends Error {
  constructor() {
    super('the desktop that owns this project is unavailable');
    this.name = 'ProjectPinHostUnavailableError';
  }
}

function sameMembers(current: ReadonlySet<string>, next: readonly string[]): boolean {
  if (current.size !== new Set(next).size) return false;
  return next.every((value) => current.has(value));
}

interface RetryState {
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Pinned projects across computers. Another desktop's project pins are stored on that
 * desktop; this computer reads them, writes changes back and keeps only its display order.
 */
export function useProjectPinSync(input: {
  initialSnapshot: SidebarSettingsSnapshot;
  manualPinnedOrder: readonly string[];
  /** The sidebar's own project keys; pins use their spelling for a matching identity. */
  knownProjectKeys: readonly string[];
  promotePin: (entryId: string) => Promise<void>;
  removePin: (entryId: string) => Promise<void>;
}): {
  pinnedProjectKeys: ReadonlySet<string>;
  toggleProjectPin: (projectKey: string, currentlyPinned: boolean) => Promise<void>;
} {
  const { initialSnapshot, manualPinnedOrder, knownProjectKeys, promotePin, removePin } = input;
  const hostPins = useRemoteProjectPins();
  const ownerStamp = useMemo<DataOwnerPushStamp>(
    () => ({
      dataOwnerId: initialSnapshot.dataOwnerId,
      ownerGeneration: initialSnapshot.ownerGeneration,
    }),
    [initialSnapshot.dataOwnerId, initialSnapshot.ownerGeneration],
  );
  const [pinHostDeviceIds, setPinHostDeviceIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSnapshot.projectPinHostDeviceIds ?? []),
  );

  useLayoutEffect(() => {
    const api = window.electronAPI?.sidebarSettings;
    if (!api?.onProjectPinHostsChanged) return undefined;
    const reconcile = (deviceIds: readonly string[], nextOwnerStamp: DataOwnerPushStamp) => {
      if (
        nextOwnerStamp.dataOwnerId !== ownerStamp.dataOwnerId ||
        nextOwnerStamp.ownerGeneration !== ownerStamp.ownerGeneration ||
        !isDataOwnerPushStampCurrent(nextOwnerStamp)
      ) {
        return;
      }
      setPinHostDeviceIds((current) =>
        sameMembers(current, deviceIds) ? current : new Set(deviceIds),
      );
    };
    const unsubscribe = api.onProjectPinHostsChanged(reconcile);
    // Subscribe before re-reading so a change between render and effect is not lost.
    const latest = api.loadSnapshot();
    reconcile(latest.projectPinHostDeviceIds ?? [], latest);
    return unsubscribe;
  }, [ownerStamp]);

  const pinnedProjectKeys = useMemo(
    () =>
      resolvePinnedProjectKeys({ manualPinnedOrder, hostPins, pinHostDeviceIds, knownProjectKeys }),
    [manualPinnedOrder, hostPins, pinHostDeviceIds, knownProjectKeys],
  );

  const inFlightRef = useRef(new Set<string>());
  const retriesRef = useRef(new Map<string, RetryState>());
  const [retryTick, setRetryTick] = useState(0);

  useEffect(
    () => () => {
      for (const state of retriesRef.current.values()) {
        if (state.timer) clearTimeout(state.timer);
      }
      retriesRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const scheduleRetry = (deviceId: string) => {
      const state = retriesRef.current.get(deviceId) ?? { attempt: 0, timer: null };
      if (state.timer) return;
      const delay =
        HANDOFF_RETRY_DELAYS_MS[Math.min(state.attempt, HANDOFF_RETRY_DELAYS_MS.length - 1)];
      state.attempt += 1;
      state.timer = setTimeout(() => {
        state.timer = null;
        setRetryTick((tick) => tick + 1);
      }, delay);
      retriesRef.current.set(deviceId, state);
    };
    // Both kinds back off after a failure, so a persistently failing write cannot loop.
    const run = (deviceId: string, task: () => Promise<void>) => {
      inFlightRef.current.add(deviceId);
      void task()
        .then(
          () => {
            const state = retriesRef.current.get(deviceId);
            if (state?.timer) clearTimeout(state.timer);
            retriesRef.current.delete(deviceId);
          },
          (error: unknown) => {
            log.warn('project pin maintenance failed; retrying later', error);
            scheduleRetry(deviceId);
          },
        )
        .finally(() => inFlightRef.current.delete(deviceId));
    };

    for (const [deviceId, snapshot] of hostPins) {
      if (!snapshot.available || !snapshot.ownerStamp) continue;
      if (inFlightRef.current.has(deviceId) || retriesRef.current.get(deviceId)?.timer) continue;
      if (pinHostDeviceIds.has(deviceId)) {
        const stale = staleProjectPinHints(manualPinnedOrder, deviceId, snapshot);
        if (stale.length === 0) continue;
        run(deviceId, async () => {
          for (const entryId of stale) await removePin(entryId);
        });
        continue;
      }
      // First contact with a host that owns project pins: hand over this computer's
      // older local pins once, then treat local entries as display order only.
      const legacy = legacyProjectPinsForHost(manualPinnedOrder, deviceId, snapshot);
      const batches: string[][] = [];
      for (let index = 0; index < legacy.length; index += PROJECT_PINS_APPLY_MAX_KEYS) {
        batches.push(legacy.slice(index, index + PROJECT_PINS_APPLY_MAX_KEYS));
      }
      run(deviceId, async () => {
        // Each batch is promoted to the host's top; send the last one first to keep the order.
        for (const batch of batches.reverse()) {
          await remoteProjectPins.setPinned(deviceId, batch, true);
        }
        await window.electronAPI.sidebarSettings.markProjectPinHost(deviceId, ownerStamp);
      });
    }
  }, [hostPins, pinHostDeviceIds, manualPinnedOrder, ownerStamp, removePin, retryTick]);

  const hostPinsRef = useRef(hostPins);
  hostPinsRef.current = hostPins;
  const pinHostDeviceIdsRef = useRef(pinHostDeviceIds);
  pinHostDeviceIdsRef.current = pinHostDeviceIds;

  const toggleProjectPin = useCallback(
    async (projectKey: string, currentlyPinned: boolean) => {
      const entryId = pinnedProjectEntryId(projectKey);
      const target = hostProjectPinTarget(projectKey);
      if (target) {
        const snapshot = hostPinsRef.current.get(target.deviceId);
        if (snapshot?.available && snapshot.ownerStamp) {
          await remoteProjectPins.setPinned(target.deviceId, [target.hostKey], !currentlyPinned);
          // The owning desktop has decided; the local entry only ranks the project here,
          // so a failed ranking write must not report the pin itself as failed.
          await (currentlyPinned ? removePin(entryId) : promotePin(entryId)).catch(
            (error: unknown) => {
              log.warn('failed to update local order for a remote project pin', error);
            },
          );
          return;
        }
        // A pin host that cannot be reached must not gain a local-only pin.
        if (pinHostDeviceIdsRef.current.has(target.deviceId) && snapshot?.available !== false) {
          throw new ProjectPinHostUnavailableError();
        }
      }
      if (currentlyPinned) await removePin(entryId);
      else await promotePin(entryId);
    },
    [promotePin, removePin],
  );

  return useMemo(
    () => ({ pinnedProjectKeys, toggleProjectPin }),
    [pinnedProjectKeys, toggleProjectPin],
  );
}
