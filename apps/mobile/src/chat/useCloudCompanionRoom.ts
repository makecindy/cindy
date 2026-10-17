import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { chatAccessLost, type ChatMessage } from './chatServerClient';
import { useChatClient } from './useChatServer';

/** Same name-keyed room operation as the desktop (sha256 hex of the room name). */
const sha256Hex = (text: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });

type RoomState = {
  identity: string; roomId: string | null; messages: ChatMessage[]; before: string | null;
  status: 'loading' | 'ready' | 'error'; loadingOlder: boolean;
};

/** The companion's read-only 1:1 cloud conversation: the latest page, then older pages on demand. */
export function useCloudCompanionRoom(actorId: string, name: string, enabled: boolean) {
  const api = useChatClient();
  const identity = `${api.owner}:${actorId}`;
  const active = useRef(identity); active.current = identity;
  const initial = (): RoomState => ({ identity, roomId: null, messages: [], before: null, status: 'loading', loadingOlder: false });
  const [state, setState] = useState<RoomState>(initial);
  const latest = useRef(state); latest.current = state;
  const generation = useRef(0);
  const olderPending = useRef(false);
  const valid = () => api.current() && active.current === identity;
  const reload = useCallback(async () => {
    if (!enabled || !api.enabled || !actorId) return;
    const run = ++generation.current;
    const previous = latest.current.identity === identity ? latest.current : null;
    try {
      const roomId = previous?.roomId ?? await api.client.companionRoom(actorId, name, sha256Hex);
      const page = await api.client.history(roomId);
      if (run !== generation.current || !valid()) return;
      // Keep pages already loaded above the refreshed newest page.
      const fresh = new Set(page.messages.map(message => message.id));
      const kept = previous?.roomId === roomId && previous.messages.length > page.messages.length
        ? previous.messages.filter(message => !fresh.has(message.id)) : [];
      setState({ identity, roomId, messages: [...page.messages, ...kept], before: kept.length ? previous!.before : page.before,
        status: 'ready', loadingOlder: false });
    } catch (error) {
      if (run !== generation.current || !valid()) return;
      setState(old => old.identity === identity && old.status === 'ready' && !chatAccessLost(error)
        ? old : { ...initial(), status: 'error' });
    }
  }, [actorId, api, enabled, identity, name]);
  useFocusEffect(useCallback(() => {
    if (!enabled || !api.enabled) return;
    void reload();
    const foreground = AppState.addEventListener('change', value => { if (value === 'active') void reload(); });
    return () => { generation.current += 1; foreground.remove(); };
  }, [api.enabled, enabled, reload]));
  const loadOlder = useCallback(async () => {
    const current = latest.current;
    if (current.identity !== identity || !current.roomId || !current.before || olderPending.current) return;
    olderPending.current = true;
    setState(old => ({ ...old, loadingOlder: true }));
    try {
      const page = await api.client.history(current.roomId, current.before);
      if (!valid() || latest.current.roomId !== current.roomId) return;
      setState(old => ({ ...old, messages: [...old.messages, ...page.messages], before: page.before, loadingOlder: false }));
    } catch {
      if (valid()) setState(old => ({ ...old, loadingOlder: false }));
    } finally { olderPending.current = false; }
  }, [api, identity]);
  const own = state.identity === identity ? state : initial();
  return { ...own, reload, loadOlder };
}
