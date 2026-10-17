import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { ChatActor, ChatSetHomeResult } from './chatServerClient';
import { useChatClient } from './useChatServer';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';

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
  const [state, setState] = useState({ owner: api.owner, supported: false, actors: NO_ACTORS, deviceNames: NO_NAMES });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled || !api.enabled) return;
    const run = ++generation.current;
    try {
      const { companionHome } = await api.client.capabilities();
      const actors = companionHome ? await api.client.actors() : NO_ACTORS;
      const deviceNames = companionHome && actors.length
        ? await readDeviceList().then(({ devices }) => new Map(devices.map(device => [device.deviceId, device.name] as const)), () => NO_NAMES)
        : NO_NAMES;
      if (run !== generation.current || !api.current()) return;
      setState({ owner: api.owner, supported: companionHome, actors, deviceNames });
    } catch {
      // Keep the previous answer: rows simply behave as before when the server cannot be read.
    }
  }, [api, enabled, readDeviceList]);
  useFocusEffect(useCallback(() => {
    if (!enabled || !api.enabled) return;
    void refresh();
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') void refresh(); });
    return () => { generation.current += 1; foreground.remove(); };
  }, [api.enabled, enabled, refresh]));
  const own = state.owner === api.owner;
  // Never move the home before its profile snapshot is in the cloud: the new computer could not
  // build the companion, and the old one would already be demoted (cloud-companions.md).
  const setHome = useCallback(async (actorId: string, homeDeviceId: string, expected: string | null): Promise<ChatSetHomeResult> => {
    if (!(await api.client.hasProfileSnapshot(actorId))) throw new Error('PROFILE_SNAPSHOT_MISSING');
    return api.client.setHome(actorId, homeDeviceId, expected);
  }, [api]);
  return { supported: own && state.supported, actors: own ? state.actors : NO_ACTORS,
    deviceNames: own ? state.deviceNames : NO_NAMES, refresh, setHome };
}
