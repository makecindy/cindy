import { useEffect, useState } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isProviderManagementOutdated, providerShareManagementCommand } from '@/features/provider-group/providerManagement';
import type { ProviderShareCommandResult } from '../../../shared/providerShare';

type SharedProviders = ReadonlyMap<string | null, ReadonlySet<string>>;
const EMPTY: SharedProviders = new Map();

/** Settings-only classification; null identifies this computer, other keys identify my other computers. */
export function useOwnedProviderShares(deviceIds: readonly string[]): SharedProviders {
  const owner = getDataOwnerGeneration();
  const devicesKey = JSON.stringify([...new Set(deviceIds)].sort());
  const [snapshot, setSnapshot] = useState<{ owner: typeof owner; providers: SharedProviders } | null>(null);

  useEffect(() => {
    let disposed = false;
    const current = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const visible = () => document.visibilityState !== 'hidden';
    const hosts: (string | null)[] = [null, ...JSON.parse(devicesKey)];
    const inFlight = new Set<string | null>();
    const refreshAgain = new Set<string | null>();
    const legacyRefreshAfter = new Map<string, number>();
    const readLegacy = async (deviceId: string) => {
      // Old computers only support owned, which enables fast polling for 60 seconds.
      // Leave a quiet period between reads rather than continually extending that window.
      legacyRefreshAfter.set(deviceId, Date.now() + 90_000);
      const state = await providerShareManagementCommand({ action: 'owned', range: 'month' }, deviceId);
      return { ready: state.ready, providerIds: state.shares.filter(share => share.members.length > 0).map(share => share.providerId) };
    };
    const load = async (deviceId: string | null) => {
      if (!current() || !visible()) return;
      if (deviceId && Date.now() < (legacyRefreshAfter.get(deviceId) ?? 0)) return;
      if (inFlight.has(deviceId)) {
        refreshAgain.add(deviceId);
        return;
      }
      if (deviceId ? !window.electronAPI?.providerGroup : !window.electronAPI?.providerShare) return;
      inFlight.add(deviceId);
      try {
        let state: ProviderShareCommandResult['shared-provider-ids'];
        if (deviceId && legacyRefreshAfter.has(deviceId)) {
          state = await readLegacy(deviceId);
        } else {
          try {
            state = await providerShareManagementCommand({ action: 'shared-provider-ids' }, deviceId ?? undefined);
          } catch (error) {
            if (!deviceId || !isProviderManagementOutdated(error) || !current() || !visible()) throw error;
            state = await readLegacy(deviceId);
          }
        }
        if (!current() || !state.ready) return;
        const ids = new Set(state.providerIds);
        setSnapshot(previous => {
          const providers = new Map(previous && previous.owner.dataOwnerId === owner.dataOwnerId
            && previous.owner.generation === owner.generation ? previous.providers : EMPTY);
          providers.set(deviceId, ids);
          return { owner, providers };
        });
      } catch {
        // Keep the last display classification on temporary failures.
      } finally {
        inFlight.delete(deviceId);
        if (refreshAgain.delete(deviceId) && current()) void load(deviceId);
      }
    };
    const refresh = () => {
      if (visible()) hosts.forEach(deviceId => { void load(deviceId); });
    };
    refresh();
    const off = window.electronAPI?.providerShare?.onOwnedChanged?.(() => { void load(null); });
    // Other computers do not push their sharing changes to this settings page.
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      off?.();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [owner, devicesKey]);

  return snapshot && snapshot.owner.dataOwnerId === owner.dataOwnerId
    && snapshot.owner.generation === owner.generation ? snapshot.providers : EMPTY;
}
