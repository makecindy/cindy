import { useCallback, useRef } from 'react';
import { diagnosticRef } from '@cindy/device-link';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { DeviceLinkContextValue } from '@/device-link/DeviceLinkContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

/** A visible pending send can miss the online presence edge while iOS is suspended. */
export function useWaitingComputerRecovery(
  deviceId: string,
  clientId: string | undefined,
  readDeviceList: DeviceLinkContextValue['readDeviceList'],
  recoverPeer: DeviceLinkContextValue['recoverWaitingPeer'],
) {
  const action = useRef<(() => void) | null>(null);
  useFocusEffect(useCallback(() => {
    if (!clientId) return;
    const owner = getMobileAuthOwner();
    let active = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 15_000;
    const current = () => active && isMobileAuthOwnerCurrent(owner) && AppState.currentState === 'active';
    const check = async () => {
      if (!current() || busy) return;
      busy = true;
      let retry = true;
      clearTimeout(timer);
      const fields = { client: clientId.slice(-8), peer: diagnosticRef(deviceId) };
      try {
        mobileDebugLog('debug', 'recovery', 'outbox checking computer', fields);
        const roster = await readDeviceList();
        if (!current() || roster.stale) return;
        const row = roster.devices.find(device => device.deviceId === deviceId);
        if (row?.online && !row.remoteControlEnabled) retry = false;
        if (row?.online && row.remoteControlEnabled) {
          mobileDebugLog('debug', 'recovery', 'outbox computer available', fields);
          if (await recoverPeer(deviceId) && current()) {
            mobileDebugLog('debug', 'recovery', 'outbox handshake confirmed', fields);
          }
        }
      } catch {
        // The original outbox record and its delivery retry remain authoritative.
      } finally {
        busy = false;
        if (retry && current()) {
          timer = setTimeout(check, delay);
          delay = Math.min(delay * 2, 120_000);
        }
      }
    };
    action.current = check;
    void check();
    const sub = AppState.addEventListener('change', state => {
      clearTimeout(timer);
      if (state === 'active') void check();
    });
    return () => {
      active = false;
      action.current = null;
      clearTimeout(timer);
      sub.remove();
    };
  }, [clientId, deviceId, readDeviceList, recoverPeer]));
  return useCallback(() => action.current?.(), []);
}
