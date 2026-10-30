import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GHOST_COMPOSER_LIST_CHANNEL,
  ghostComposerListSchema,
  type GhostComposerEntry,
} from '../../shared/ghostComposer';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isSharedTaskPeer } from '@cindy/device-link';

const EMPTY: GhostComposerEntry[] = [];

/** Async device/workdir-scoped catalog; opening the menu never awaits this read. */
export function useRemoteComposerGhosts(
  deviceId: string | null | undefined,
  workingDir: string | null | undefined,
  menuOpen: boolean,
  reconnectEpoch: number,
) {
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([owner.dataOwnerId, owner.generation, deviceId, workingDir ?? '']);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    ghosts: GhostComposerEntry[];
    failed: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  const reload = useCallback(() => setRetry((value) => value + 1), []);

  const wasMenuOpen = useRef(menuOpen);
  useEffect(() => {
    if (menuOpen && !wasMenuOpen.current) reload();
    wasMenuOpen.current = menuOpen;
  }, [menuOpen, reload]);

  useEffect(() => {
    if (!deviceId || isSharedTaskPeer(deviceId)) return;
    let cancelled = false;
    const capturedOwner = getDataOwnerGeneration();
    const current = () =>
      !cancelled && currentKey.current === key && isDataOwnerGenerationCurrent(capturedOwner);
    void window.electronAPI.deviceLink
      .invoke(deviceId, GHOST_COMPOSER_LIST_CHANNEL, workingDir ? [workingDir] : [])
      .then((raw) => {
        const result = ghostComposerListSchema.safeParse(raw);
        if (!result.success) throw new Error('Invalid remote plugin catalog');
        if (current()) setSnapshot({ key, ghosts: result.data, failed: false });
      })
      .catch(() => {
        // Old hosts may reject the channel. Never substitute the controller's catalog.
        if (current()) setSnapshot({ key, ghosts: EMPTY, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, workingDir, key, reconnectEpoch, retry]);

  return {
    ghosts: snapshot?.key === key ? snapshot.ghosts : EMPTY,
    failed: snapshot?.key === key && snapshot.failed,
    reload,
  };
}
