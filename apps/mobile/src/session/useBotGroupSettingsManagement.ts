import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BOT_GROUP_REMOTE_COLLECTION_ID, type BotGroupRemoteActionId, type BotGroupRemoteChatData } from '@cindy/maker-shared/botGroupChat';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useRemoteSyncCoordinator } from '@/device-link/remoteSyncTask';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { getRemoteResource, invokeRemoteResourceAction, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { BOT_GROUP_CLIENT_PRIMITIVES, botGroupChatDataFromResource, botGroupResourceRef, canManageBotGroup } from './botGroupRemote';
import { useTeammateRoster } from './useTeammateRoster';

type Manager = { host: RemoteResourceHostTarget; group: BotGroupRemoteChatData };

/** Associate a direct server chat with computers that actually expose this exact room. */
export function useBotGroupSettingsManagement(groupId: string, enabled: boolean) {
  const { accountGeneration } = useAuth();
  const { i18n } = useTranslation();
  const { invoke, openLink, connectionEpoch, status, getPresenceAvailability, onRemoteResourceChanged } = useDeviceLink();
  const revoked = useRevokedDevices();
  const roster = useTeammateRoster(enabled);
  const scope = JSON.stringify([accountGeneration, groupId, enabled, connectionEpoch]);
  // Reopening the same group must not revive an earlier authorization or receipt.
  const binding = useMemo(() => Symbol(scope), [scope]);
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const activeBinding = useRef<typeof binding | null>(null);
  useEffect(() => {
    activeBinding.current = binding;
    return () => { if (activeBinding.current === binding) activeBinding.current = null; };
  }, [binding]);
  const [selectedId, select] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ binding: typeof binding; key: string; managers: Manager[]; reason: 'noHost' | 'permission' | 'upgrade' | 'unavailable' | null }>();
  const writing = useRef(false);
  const candidates = roster.groupTargets.filter(host => status === 'online'
    && !revoked.has(host.deviceId) && getPresenceAvailability(host.deviceId) !== false);
  const candidateKey = JSON.stringify(candidates.map(host => host.deviceId));
  const onlineHost = roster.groupTargets.some(host => !revoked.has(host.deviceId) && getPresenceAvailability(host.deviceId) !== false);
  const emptyReason = status === 'online' && roster.error && (!roster.groupTargets.length || onlineHost)
    ? 'unavailable' : 'noHost';
  const key = JSON.stringify([candidateKey, refreshVersion, status, emptyReason, i18n.language]);
  const ready = !roster.loading;
  const currentRef = useRef({ key, enabled, ready, managers: [] as Manager[] });
  const own = snapshot?.binding === binding && snapshot.key === key;
  // Content refreshes preserve verified authority until a new detail read replaces it.
  const managers = snapshot?.binding === binding ? snapshot.managers.filter(manager =>
    candidates.some(host => host.deviceId === manager.host.deviceId) && canManageBotGroup(manager.group)) : [];
  currentRef.current = { key, enabled, ready, managers };
  const selected = managers.find(manager => manager.host.deviceId === selectedId) ?? managers[0];
  // Remember only the display name, never authorization or an editable snapshot.
  const displayIdentity = JSON.stringify([accountGeneration, groupId]);
  const rememberedHost = useRef<{ identity: string; host: RemoteResourceHostTarget } | undefined>(undefined);
  const previousHost = rememberedHost.current?.identity === displayIdentity
    && !revoked.has(rememberedHost.current.host.deviceId) ? rememberedHost.current.host : undefined;
  const displayHost = selected?.host ?? previousHost ?? candidates[0];
  useEffect(() => {
    if (displayHost) rememberedHost.current = { identity: displayIdentity, host: displayHost };
    else if (rememberedHost.current?.identity !== displayIdentity) rememberedHost.current = undefined;
  }, [displayIdentity, displayHost]);

  const read = useRemoteSyncCoordinator(async run => {
    if (!enabled || !ready) return;
    const current = () => !run.isStale() && bindingRef.current === binding && currentRef.current.key === key && currentRef.current.ready;
    const found: Manager[] = [];
    let reason: NonNullable<typeof snapshot>['reason'] = candidates.length ? 'unavailable' : emptyReason;
    for (let offset = 0; offset < candidates.length; offset += 2) {
      const replies = await Promise.allSettled(candidates.slice(offset, offset + 2).map(async host => {
        await openLink(host.deviceId);
        if (!current()) return null;
        const resource = await getRemoteResource(invoke, host, botGroupResourceRef(groupId), i18n.language, BOT_GROUP_CLIENT_PRIMITIVES);
        const group = botGroupChatDataFromResource(resource);
        return group?.id === groupId && group.serverBacked ? { host, group } : null;
      }));
      if (!current()) return;
      for (const reply of replies) {
        if (reply.status !== 'fulfilled' || !reply.value) continue;
        const manager = reply.value;
        if (canManageBotGroup(manager.group)) found.push(manager);
        else if (!manager.group.supportsSettingsManagement) reason = 'upgrade';
        else reason = 'permission';
      }
    }
    if (current()) setSnapshot({ binding, key, managers: found, reason: found.length ? null : reason });
  }, scope);
  useEffect(() => {
    if (enabled && ready) void read({ reason: 'settings' });
  }, [binding, key, enabled, ready, read]);

  const refresh = useCallback(() => { setRefreshVersion(value => value + 1); }, []);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onRemoteResourceChanged((deviceId, payload) => {
      if (!candidates.some(host => host.deviceId === deviceId) || payload.collectionId !== BOT_GROUP_REMOTE_COLLECTION_ID) return;
      if (payload.resourceRefs?.length && !payload.resourceRefs.some(ref => ref.id === groupId)) return;
      if (!timer) timer = setTimeout(() => { timer = undefined; refresh(); }, 150);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, groupId, candidateKey, onRemoteResourceChanged, refresh]);

  const act = useCallback(async (actionId: BotGroupRemoteActionId, input?: Record<string, unknown>) => {
    const manager = selected;
    if (!currentRef.current.enabled || !manager || writing.current) throw new Error('PERMISSION_DENIED');
    writing.current = true;
    const valid = () => activeBinding.current === binding && bindingRef.current === binding && currentRef.current.enabled
      && currentRef.current.managers.some(current => current.host.deviceId === manager.host.deviceId && canManageBotGroup(current.group))
      && getPresenceAvailability(manager.host.deviceId) !== false;
    try {
      await openLink(manager.host.deviceId);
      if (!valid()) throw new Error('PERMISSION_DENIED');
      const receipt = await invokeRemoteResourceAction(<T,>(deviceId: string, channel: string, args?: unknown[]) =>
        invoke<T>(deviceId, channel, args, { preSend: () => { if (!valid()) throw new Error('PERMISSION_DENIED'); } }), manager.host, {
        collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, resourceRef: botGroupResourceRef(groupId), actionId,
        input: { expectedRevision: manager.group.revision, ...input },
      }, i18n.language);
      // A reply from a prior account/sheet must not close the current screen.
      if (bindingRef.current !== binding || activeBinding.current !== binding) throw new Error('PERMISSION_DENIED');
      // Fence pre-write reads and edits until the new revision is verified.
      currentRef.current = { ...currentRef.current, key: '', managers: [] };
      setSnapshot(undefined);
      return receipt;
    } finally {
      writing.current = false;
      if (bindingRef.current === binding && activeBinding.current === binding) refresh();
    }
  }, [binding, groupId, selected, getPresenceAvailability, openLink, invoke, i18n.language, refresh]);

  const loading = enabled && !selected && (roster.loading || !own);
  return { selected, displayHost, managers, select, act, loading, reason: loading ? null : snapshot ? snapshot.reason : 'noHost',
    refresh: () => { void roster.refresh(); refresh(); } };
}
