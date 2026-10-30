import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import type { ChatMaskAction, ChatMaskMention, ChatMaskSettings, ChatMaskState, BotGroupRemoteActionId } from '@cindy/maker-shared/botGroupChat';
import { useChatClient } from '@/chat/useChatServer';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';

type RemoteAct = (action: BotGroupRemoteActionId, input?: Record<string, unknown>) => Promise<unknown>;
/** One account/room controller shared by settings, composer and catch-up. Reads never participate. */
export function useGroupPersonalMask(groupId: string, deviceId: string, enabled: boolean, act: RemoteAct, change: unknown) {
  const api = useChatClient(), focused = useIsFocused();
  const { getPresenceAvailability } = useDeviceLink();
  const key = `${api.owner}:${deviceId}:${groupId}`;
  const active = useRef(key); active.current = key;
  const mounted = useRef(true), busy = useRef(false), pending = useRef(false), version = useRef(0), authority = useRef(0);
  const deps = useRef({ act, enabled }); deps.current = { act, enabled };
  const queue = useRef(Promise.resolve()), failed = useRef(new Map<string, () => Promise<void>>());
  const operations = useRef(new Map<string, () => Promise<void>>());
  const [data, setData] = useState<{ key: string; state: ChatMaskState | null; mentions: ChatMaskMention[] }>({ key, state: null, mentions: [] });
  const state = data.key === key ? data.state : null, mentions = data.key === key ? data.mentions : [];
  const stateRef = useRef(state); stateRef.current = state;
  const [saving, setSaving] = useState(false), [error, setError] = useState(false), [connectionLost, setConnectionLost] = useState(false);
  const current = useCallback(() => mounted.current && active.current === key && deps.current.enabled && api.current(), [key, api]);
  const call = useCallback(async (kind: 'mask' | 'mask-mentions', input: Record<string, unknown> = {}) => {
    if (!current()) throw new Error('OWNER_CHANGED');
    if (!deviceId) return kind === 'mask'
      ? { state: await api.client.mask(groupId, input.action as ChatMaskAction | undefined, input.operationId as string | undefined) }
      : api.client.maskMentions(groupId, input.before as string | undefined, input.readIds as string[] | undefined, input.operationId as string | undefined);
    const response = await deps.current.act(kind, input) as { result?: { state?: ChatMaskState; mentions?: ChatMaskMention[]; hasMore?: boolean } };
    if (!response.result) throw new Error('INVALID_MASK_RESPONSE');
    return response.result;
  }, [current, deviceId, api, groupId]);
  const reload = useCallback(async () => {
    if (!deps.current.enabled || !current() || AppState.currentState !== 'active') return;
    if (busy.current) { pending.current = true; return; }
    busy.current = true;
    const revision = version.current, valid = () => current() && version.current === revision;
    try {
      const response = await call('mask');
      if (!valid()) return;
      if (!('state' in response) || !response.state) { setData({ key, state: null, mentions: [] }); return; }
      const all: ChatMaskMention[] = [];
      let before: string | undefined;
      do {
        const page = await call('mask-mentions', { before });
        if (!valid()) return;
        if (!('mentions' in page) || !page.mentions) throw new Error('INVALID_MASK_RESPONSE');
        all.push(...page.mentions);
        if (!page.hasMore || !page.mentions.length) break;
        const next = page.mentions.at(-1)!.sequence;
        if (before && BigInt(next) >= BigInt(before)) throw new Error('INVALID_MASK_CURSOR');
        before = next;
      } while (valid());
      if (valid()) { stateRef.current = response.state; setData({ key, state: response.state, mentions: all }); setError(failed.current.size > 0); setConnectionLost(false); }
    } catch (e) {
      if (valid()) {
        if (e && typeof e === 'object' && 'status' in e && (e.status === 403 || e.status === 404)) {
          authority.current++; failed.current.clear(); operations.current.clear();
          stateRef.current = null; setData({ key, state: null, mentions: [] });
        }
        setError(true); setConnectionLost(true);
      }
    } finally { busy.current = false; if (pending.current && current()) { pending.current = false; void reload(); } }
  }, [call, current, key]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; }; }, []);
  useEffect(() => {
    failed.current.clear(); operations.current.clear(); version.current++; authority.current++;
    setError(false); setSaving(false); setConnectionLost(false);
    if (!enabled) { stateRef.current = null; setData({ key, state: null, mentions: [] }); }
  }, [key, enabled]);
  useEffect(() => {
    if (!enabled || !focused) return;
    void reload();
    const timer = setInterval(() => void reload(), 15000);
    const subscription = AppState.addEventListener('change', value => { if (value === 'active') void reload(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [enabled, focused, reload]);
  useEffect(() => { if (focused) void reload(); }, [change, focused, reload]);
  const run = useCallback((retryKey: string, work: (valid: () => boolean) => Promise<void>) => {
    const generation = authority.current;
    const valid = () => current() && generation === authority.current;
    const send = async () => {
      if (!valid() || operations.current.get(retryKey) !== send) return;
      version.current++; setSaving(true); setError(failed.current.size > 0);
      try { await work(valid); if (valid()) {
        if (operations.current.get(retryKey) === send) failed.current.delete(retryKey);
        setError(failed.current.size > 0);
      } }
      catch { if (valid() && operations.current.get(retryKey) === send) { failed.current.set(retryKey, send); setError(true); } }
      finally { if (valid()) { setSaving(false); void reload();
        if (operations.current.get(retryKey) === send && !failed.current.has(retryKey)) operations.current.delete(retryKey);
      } }
    };
    // New intent supersedes only the same operation, never another setting/read.
    failed.current.delete(retryKey); operations.current.set(retryKey, send);
    queue.current = queue.current.then(send, send);
  }, [current, reload]);
  const action = useCallback((retryKey: string, make: (state: ChatMaskState) => ChatMaskAction) => {
    let operationId = randomUUID(), value: ChatMaskAction | undefined;
    run(retryKey, async valid => {
      if (!stateRef.current || !valid()) return;
      value ??= make(stateRef.current);
      try {
        const response = await call('mask', { action: value, operationId });
        if (valid() && 'state' in response && response.state) {
          stateRef.current = response.state;
          setData(old => ({ ...old, key, state: response.state! }));
        }
      } catch (e) {
        if (e && typeof e === 'object' && ('code' in e && e.code === 'REVISION_CONFLICT' || 'message' in e && String(e.message).includes('REVISION_CONFLICT'))) {
          value = undefined; operationId = randomUUID();
        }
        throw e;
      }
    });
  }, [call, current, key, run]);
  const markRead = useCallback((ids: string[]) => {
    const batches = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ({ readIds: ids.slice(index * 100, index * 100 + 100), operationId: randomUUID() }));
    run(`read:${[...ids].sort().join(',')}`, async valid => {
      for (const batch of batches) { if (!valid()) return; await call('mask-mentions', batch); }
      if (valid()) setData(old => ({ ...old, mentions: old.mentions.filter(m => !ids.includes(m.messageId)) }));
    });
  }, [call, current, run]);
  const lastParticipation = useRef(0);
  const homeOffline = !!state?.homeDeviceId && getPresenceAvailability(state.homeDeviceId) === false;
  return { state: state ? { ...state, status: (connectionLost || homeOffline) && state.status === 'enabled' ? 'offline' as const : state.status, settings: { ...state.settings, companionId: state.settings.companionId ?? state.defaultCompanionId ?? null } } : null, mentions, saving, error, reload, markRead,
    update: (patch: Partial<ChatMaskSettings>) => action(`save:${Object.keys(patch).sort().join(',')}`, s => ({ type: 'save', expectedRevision: s.revision,
      settings: { ...s.settings, companionId: s.settings.companionId ?? s.defaultCompanionId ?? null, ...patch, timeZone: s.revision ? s.settings.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone } })),
    perform: (type: 'resume' | 'stop' | 'digest' | 'participate') => action(type, () => ({ type })),
    participate: () => { if (!stateRef.current?.settings.enabled || Date.now() - lastParticipation.current < 2000) return;
      lastParticipation.current = Date.now(); action('participate', () => ({ type: 'participate' })); },
    retry: () => { if (failed.current.size) for (const send of failed.current.values()) queue.current = queue.current.then(send, send); else void reload(); },
  };
}
export type GroupPersonalMask = ReturnType<typeof useGroupPersonalMask>;
