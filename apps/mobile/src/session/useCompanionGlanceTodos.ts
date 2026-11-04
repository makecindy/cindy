/**
 * 伙伴近况里的「待办」（与桌面 BotGlancePopover 同一份数据）：经 device-link 读伙伴所在电脑的
 * `todos:<botId>` 远程资源，宿主每页最多 25 条，这里按页读完（单类上限 200 条）。
 * 近况只展示与删除：完成、改期、不再提示都由伙伴在对话里按主人的话去改。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import {
  scheduleTodoDeferralRefresh,
  todoDue,
  todoDueKey,
  type TeammateTodo,
  type TodoListQuery,
  type TodoPatch,
} from '@cindy/maker-shared/teammate-todo';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource, invokeRemoteResourceAction } from '@/device-link/remoteResources';

const PAGE = 25;
const MAX_ITEMS = 200;

export interface GlanceTodos {
  open: TeammateTodo[];
  openTotal: number;
  /** Most recently finished first. */
  done: TeammateTodo[];
  doneTotal: number;
  nextDeferredAt: string | null;
  /** Whether 「每天帮我查一次」 is on; null when the desktop does not support it yet (the switch stays hidden). */
  dailyCheck: boolean | null;
}

const EMPTY: GlanceTodos = { open: [], openTotal: 0, done: [], doneTotal: 0, nextDeferredAt: null, dailyCheck: null };

interface Page { items: TeammateTodo[]; total: number; nextDeferredAt?: string | null; dailyCheck?: unknown }

export function todosResourceRef(botId: string) {
  return { collectionId: 'teammates', kind: 'bot', id: `todos:${botId}` } as const;
}

/**
 * Reads every page of one view. Open todos keep the first 200 by due order; completed ones are
 * listed oldest first by the host, so past the cap the read starts from the tail to keep the newest.
 */
async function readAll(readPage: (query: TodoListQuery) => Promise<Page>, view: 'open' | 'done'): Promise<Page> {
  const order = view === 'open' ? 'due' : 'created';
  const first = await readPage({ view, order, offset: 0, limit: PAGE });
  let total = first.total;
  const start = view === 'done' ? Math.max(0, total - MAX_ITEMS) : 0;
  const items = start === 0 ? [...first.items] : [];
  while (start + items.length < total && items.length < MAX_ITEMS) {
    const page = await readPage({ view, order, offset: start + items.length, limit: PAGE });
    total = page.total;
    if (page.items.length === 0) break;
    items.push(...page.items);
  }
  return { items: items.slice(0, MAX_ITEMS), total, nextDeferredAt: first.nextDeferredAt ?? null, dailyCheck: first.dailyCheck };
}

/**
 * `enabled` is false while the host has not advertised todos (older desktops) or is offline:
 * nothing is read and the section stays hidden.
 */
export function useCompanionGlanceTodos({ deviceId, deviceName, botId, enabled }: {
  deviceId: string; deviceName: string; botId: string; enabled: boolean;
}) {
  const { i18n } = useTranslation();
  const { invoke, openLink, onRemoteResourceChanged } = useDeviceLink();
  const [state, setState] = useState<{ todos: GlanceTodos; loaded: boolean; failed: boolean }>({ todos: EMPTY, loaded: false, failed: false });
  const epoch = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const mine = ++epoch.current;
    try {
      await openLink(deviceId);
      const readPage = async (query: TodoListQuery): Promise<Page> => {
        const resource = await getRemoteResource(invoke, { deviceId, deviceName }, todosResourceRef(botId), i18n.language,
          ['teammate-todos'], JSON.stringify(query));
        const data = resource.blocks?.find(block => block.primitive === 'teammate-todos')?.data as Page | undefined;
        if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.items.length > PAGE) throw new Error('INVALID_RESPONSE');
        return data;
      };
      const [open, done] = await Promise.all([readAll(readPage, 'open'), readAll(readPage, 'done')]);
      if (mine !== epoch.current) return;
      setState({
        todos: { open: open.items, openTotal: open.total, done: [...done.items].reverse(), doneTotal: done.total, nextDeferredAt: open.nextDeferredAt ?? null,
          dailyCheck: typeof open.dailyCheck === 'boolean' ? open.dailyCheck : null },
        loaded: true,
        failed: false,
      });
    } catch {
      if (mine === epoch.current) setState(previous => ({ ...previous, loaded: true, failed: true }));
    }
  }, [botId, deviceId, deviceName, enabled, i18n.language, invoke, openLink]);

  /** Only the 「每天帮我查一次」 state, re-read when the routine is paused or resumed on the desktop. */
  const refreshDailyCheck = useCallback(async () => {
    if (!enabled) return;
    try {
      await openLink(deviceId);
      const resource = await getRemoteResource(invoke, { deviceId, deviceName }, todosResourceRef(botId), i18n.language,
        ['teammate-todos'], JSON.stringify({ view: 'open', order: 'due', offset: 0, limit: 1 }));
      const value = (resource.blocks?.find(block => block.primitive === 'teammate-todos')?.data as Page | undefined)?.dailyCheck;
      if (typeof value === 'boolean') setState(previous => ({ ...previous, todos: { ...previous.todos, dailyCheck: value } }));
    } catch {
      // The next full read corrects it.
    }
  }, [botId, deviceId, deviceName, enabled, i18n.language, invoke, openLink]);

  useEffect(() => {
    setState({ todos: EMPTY, loaded: false, failed: false });
    if (!enabled) return;
    void refresh();
    const offChanged = onRemoteResourceChanged((id, payload) => {
      if (id !== deviceId) return;
      if (payload.collectionId === 'routines') { void refreshDailyCheck(); return; }
      if (payload.collectionId !== 'teammates') return;
      if (payload.resourceRefs && !payload.resourceRefs.some(ref => ref.id === botId || ref.id === `todos:${botId}`)) return;
      void refresh();
    });
    const appState = AppState.addEventListener('change', next => { if (next === 'active') void refresh(); });
    return () => { epoch.current++; offChanged(); appState.remove(); };
  }, [botId, deviceId, enabled, onRemoteResourceChanged, refresh, refreshDailyCheck]);

  // Keep up with time while the chat is open: a deferred todo comes back, and past midnight
  // today's due dots are recomputed.
  const nextDeferredAt = state.todos.nextDeferredAt;
  useEffect(() => {
    if (!enabled || !state.loaded) return;
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const next = nextDeferredAt && Date.parse(nextDeferredAt) < Date.parse(midnight) ? nextDeferredAt : midnight;
    return scheduleTodoDeferralRefresh(next, () => void refresh());
  }, [enabled, nextDeferredAt, refresh, state.loaded, state.todos]);

  /** One todo update on the teammate's computer; undoing a delete uses `restore` the same way. */
  const patch = useCallback(async (input: TodoPatch): Promise<TeammateTodo | null> => {
    await openLink(deviceId);
    const result = await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, {
      collectionId: 'teammates', resourceRef: todosResourceRef(botId), actionId: 'todo-update', input: input as unknown as Record<string, unknown>,
    }, i18n.language) as { todo?: TeammateTodo | null } | null;
    return result?.todo ?? null;
  }, [botId, deviceId, deviceName, i18n.language, invoke, openLink]);

  /** Turns the teammate's weekday-morning todo check on or off on its computer; resolves to the confirmed state. */
  const setDailyCheck = useCallback(async (enabled: boolean): Promise<boolean> => {
    await openLink(deviceId);
    const result = await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, {
      collectionId: 'teammates', resourceRef: todosResourceRef(botId), actionId: 'todo-daily-check', input: { enabled },
    }, i18n.language) as { dailyCheck?: unknown } | null;
    if (typeof result?.dailyCheck !== 'boolean') throw new Error('INVALID_RESPONSE');
    const dailyCheck = result.dailyCheck;
    setState(previous => ({ ...previous, todos: { ...previous.todos, dailyCheck } }));
    return dailyCheck;
  }, [botId, deviceId, deviceName, i18n.language, invoke, openLink]);

  return { ...state, refresh, patch, setDailyCheck };
}

/** Due todos; the entry dot only counts the ones the owner has not seen in 近况 yet. */
export function dueTodos(todos: GlanceTodos, now = new Date()): TeammateTodo[] {
  return todos.open.filter(todo => todoDue(todo, now));
}

const SEEN_PREFIX = 'cindy.companionGlance.dueSeen:';

/** Due occurrences already seen in 近况, per account, computer and teammate. */
export function useGlanceDueSeen(scope: { deviceId: string; botId: string }, due: readonly TeammateTodo[]) {
  const { user } = useAuth();
  const key = `${SEEN_PREFIX}${user?.id ?? ''}:${scope.deviceId}:${scope.botId}`;
  const [seen, setSeen] = useState<{ key: string; keys: Set<string> } | null>(null);
  useEffect(() => {
    let live = true;
    void AsyncStorage.getItem(key).then(raw => {
      if (!live) return;
      let parsed: unknown = [];
      try { parsed = raw ? JSON.parse(raw) : []; } catch { parsed = []; }
      setSeen({ key, keys: new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []) });
    }).catch(() => { if (live) setSeen({ key, keys: new Set() }); });
    return () => { live = false; };
  }, [key]);
  const ready = seen?.key === key;
  const unseen = ready && due.some(todo => !seen.keys.has(todoDueKey(todo)));
  /** Opening 近况 counts as seeing what is due now; older entries drop out. */
  const markSeen = useCallback(() => {
    const keys = due.map(todoDueKey);
    setSeen({ key, keys: new Set(keys) });
    // A failed write only lights the dot once more; the todos themselves are unaffected.
    void AsyncStorage.setItem(key, JSON.stringify(keys)).catch(() => undefined);
  }, [due, key]);
  return { unseen, markSeen };
}
