import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { readRemoteResourceSnapshot } from '@/device-link/remoteResourceCache';
import {
  listRemoteCollection,
  normalizeRemoteCollectionItems,
  type HostedRemoteCollectionItem,
  type RemoteResourceHostTarget,
} from '@/device-link/remoteResources';
import { BOT_GROUP_TEAMMATES_COLLECTION_ID } from './botGroupRemote';

/**
 * Teammates of one computer for the group pickers (create, add member). A group lives on
 * one computer, so only that computer's Bots can join it. The cached roster shows at once;
 * a live read replaces it while the sheet is open. The host still validates every pick.
 */
export function useHostTeammates(host: RemoteResourceHostTarget | null, enabled: boolean) {
  const { user, accountGeneration } = useAuth();
  const { invoke, openLink } = useDeviceLink();
  const { i18n } = useTranslation();
  const deviceId = host?.deviceId ?? '';
  const deviceName = host?.deviceName ?? '';
  const scope = JSON.stringify([accountGeneration, deviceId]);
  const [state, setState] = useState<{ scope: string; rows: HostedRemoteCollectionItem[]; loading: boolean; failed: boolean }>(
    { scope, rows: [], loading: false, failed: false },
  );
  useEffect(() => {
    if (!enabled || !deviceId) return;
    let cancelled = false;
    const target = { deviceId, deviceName };
    setState((previous) => ({ scope, rows: previous.scope === scope ? previous.rows : [], loading: true, failed: false }));
    void readRemoteResourceSnapshot(user?.id ?? '').then((snapshot) => {
      if (cancelled) return;
      const cached = (snapshot.items[BOT_GROUP_TEAMMATES_COLLECTION_ID] ?? [])
        .filter((row) => row.host.deviceId === deviceId && row.item.ref.kind === 'bot');
      setState((previous) => previous.scope === scope && previous.rows.length === 0 && previous.loading
        ? { ...previous, rows: cached }
        : previous);
    });
    void (async () => {
      try {
        await openLink(deviceId);
        const response = await listRemoteCollection(invoke, target, BOT_GROUP_TEAMMATES_COLLECTION_ID, i18n.language);
        if (cancelled) return;
        const rows = normalizeRemoteCollectionItems(response, BOT_GROUP_TEAMMATES_COLLECTION_ID)
          .filter((item) => item.ref.kind === 'bot')
          .map((item) => ({ host: target, item, key: JSON.stringify([deviceId, item.ref.collectionId, item.ref.kind, item.ref.id]) }));
        setState({ scope, rows, loading: false, failed: false });
      } catch {
        if (!cancelled) setState((previous) => ({ ...previous, scope, loading: false, failed: previous.rows.length === 0 }));
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId, deviceName, enabled, i18n.language, invoke, openLink, scope, user?.id]);
  const own = state.scope === scope;
  return { rows: own ? state.rows : [], loading: own && state.loading, failed: own && state.failed };
}
