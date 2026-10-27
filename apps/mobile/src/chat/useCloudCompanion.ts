import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { ChatActor, ChatSetHomeResult } from './chatServerClient';
import { useChatClient } from './useChatServer';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { cacheCloudHome, peekCachedCloudHome, readCachedCloudHome,
  remoteResourceCacheRevision, subscribeRemoteResourceCache } from '@/device-link/remoteResourceCache';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import { forgetCloudConversation } from './cloudConversationCache';

const NO_ACTORS: ChatActor[] = [];
const NO_NAMES: ReadonlyMap<string, string> = new Map();

/**
 * Whether the account's Chat Server supports main computers (`/me` capabilities.companionHome),
 * and the account's companion actors with their main computers (and those computers' names,
 * best effort, for rows of computers this phone never listed). Read on focus and foreground;
 * an older server, a missing chat endpoint or a failed read leaves the feature off (or the last answer).
 */
export function useCloudCompanionHome(enabled: boolean) {
  const api = useChatClient();
  const { readDeviceList } = useDeviceLink();
  useSyncExternalStore(subscribeRemoteResourceCache, remoteResourceCacheRevision);
  const cached = peekCachedCloudHome(api.userId, api.realm);
  const deviceNames = useMemo(() => cached ? new Map(cached.deviceNames) : NO_NAMES, [cached]);
  const [failure, setFailure] = useState<{ owner: string; error: string } | null>(null);
  const generation = useRef(0);
  useEffect(() => { if (api.enabled) void readCachedCloudHome(api.userId, api.realm); }, [api]);
  const refresh = useCallback(async () => {
    if (!enabled || !api.enabled) return;
    const run = ++generation.current;
    const current = () => run === generation.current && api.current();
    try {
      const { companionHome } = await api.client.capabilities();
      const actors = companionHome ? await api.client.actors() : NO_ACTORS;
      if (!current()) return;
      const previous = peekCachedCloudHome(api.userId, api.realm);
      const previousNames = previous?.deviceNames ?? [];
      // A capability/network failure is not a deletion. A successful roster is authoritative.
      if (companionHome) {
        const ids = new Set(actors.map(actor => actor.id));
        await Promise.all((previous?.actors ?? []).filter(actor => !ids.has(actor.id)).map(actor => forgetCloudConversation(actor.id)));
        if (!current()) return;
      }
      await cacheCloudHome(api.userId, api.realm, { supported: companionHome, actors, deviceNames: previousNames }, current);
      if (!current()) return;
      setFailure(null);
      // Optional computer labels never delay the companion roster itself.
      if (companionHome && actors.length) {
        const names = await readDeviceList().then(({ devices }) => devices.map(device => [device.deviceId, device.name] as [string, string]), () => null);
        if (names && current()) await cacheCloudHome(api.userId, api.realm, { supported: companionHome, actors, deviceNames: names }, current);
      }
    } catch (error) {
      if (!current()) return;
      const candidate = (error as { code?: unknown })?.code;
      const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : 'CLOUD_ROSTER_FAILED';
      mobileDebugLog('warn', 'recovery', 'companion-roster-refresh', { source: 'cloud', code, status: (error as { status?: number })?.status });
      setFailure({ owner: api.owner, error: code });
    }
  }, [api, enabled, readDeviceList]);
  useFocusEffect(useCallback(() => {
    if (!enabled || !api.enabled) return;
    void refresh();
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') void refresh(); });
    return () => { generation.current += 1; foreground.remove(); };
  }, [api.enabled, enabled, refresh]));
  // Never move the home before its profile snapshot is in the cloud: the new computer could not
  // build the companion, and the old one would already be demoted (cloud-companions.md).
  const setHome = useCallback(async (actorId: string, homeDeviceId: string, expected: string | null): Promise<ChatSetHomeResult> => {
    if (!(await api.client.hasProfileSnapshot(actorId))) throw new Error('PROFILE_SNAPSHOT_MISSING');
    return api.client.setHome(actorId, homeDeviceId, expected);
  }, [api]);
  return { supported: cached?.supported === true, actors: cached?.actors ?? NO_ACTORS,
    deviceNames, error: failure?.owner === api.owner ? failure.error : null, refresh, setHome };
}
