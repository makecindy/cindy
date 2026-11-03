/**
 * 伙伴近况里的「待办」数据：本机伙伴读本机宿主，别的电脑上的伙伴经 device-link 读那台的远程资源
 * （与手机同一条 `todos:<botId>` 路径，宿主已裁掉模型指令与内部来源标识）。
 *
 * 近况只展示、不编辑：点一条交给对话，右键删除可撤销。完成、改期、不再提示都由伙伴在对话里按主人的话去改。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  parseRemoteResourceChangedPayload,
  type RemoteResourceGetRequest,
} from '@cindy/device-link';
import {
  queryTodoItems,
  scheduleTodoDeferralRefresh,
  todoDue,
  todoDueKey,
  type TeammateTodo,
  type TodoListQuery,
  type TodoPatch,
} from '@cindy/maker-shared/teammate-todo';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';

/** 宿主每页最多 25 条；近况按页读完，单类最多读这么多条，免得异常数据让浮层一次拉太多页。 */
const PAGE = 25;
const MAX_ITEMS = 200;

export interface GlanceTodoHost {
  botId: string;
  /** 伙伴所在的另一台电脑；本机伙伴为 undefined。 */
  deviceId?: string;
}

export interface GlanceTodos {
  open: TeammateTodo[];
  openTotal: number;
  /** 已完成的，最近完成的在前。 */
  done: TeammateTodo[];
  doneTotal: number;
  /** 最早一条「稍后再说」到期的时刻；到时重读，让它回到列表。 */
  nextDeferredAt: string | null;
  /** 「每天帮我查一次」是否开着；那台电脑的宿主还不支持时为 null，开关不出现。 */
  dailyCheck: boolean | null;
}

const EMPTY: GlanceTodos = { open: [], openTotal: 0, done: [], doneTotal: 0, nextDeferredAt: null, dailyCheck: null };

interface TodoPage {
  items: TeammateTodo[];
  total: number;
  nextDeferredAt?: string | null;
  dailyCheck?: boolean;
}

function todosRef(botId: string) {
  return { collectionId: 'teammates', kind: 'bot', id: `todos:${botId}` } as const;
}

async function readRemotePage(deviceId: string, botId: string, query: TodoListQuery): Promise<TodoPage> {
  const request: RemoteResourceGetRequest = {
    client: { protocolVersion: 1, primitives: ['teammate-todos'], locale: document.documentElement.lang || undefined },
    ref: todosRef(botId),
    query: JSON.stringify(query),
  };
  const resource = await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [request]);
  const blocks = (resource as { blocks?: Array<{ primitive?: string; data?: unknown }> } | null)?.blocks;
  const page = blocks?.find((block) => block.primitive === 'teammate-todos')?.data as
    | { items?: TeammateTodo[]; total?: number; nextDeferredAt?: string | null; dailyCheck?: unknown }
    | undefined;
  if (!page || !Array.isArray(page.items)) throw new Error('invalid todo page');
  return {
    items: page.items,
    total: page.total ?? page.items.length,
    nextDeferredAt: page.nextDeferredAt ?? null,
    ...(typeof page.dailyCheck === 'boolean' ? { dailyCheck: page.dailyCheck } : {}),
  };
}

/** 一类待办按页读完（宿主单页上限 25）；页数在开头读到的总数内收敛，总数中途变化时以最新一页为准。 */
async function readAll(
  readPage: (query: TodoListQuery) => Promise<TodoPage>,
  view: 'open' | 'done',
): Promise<TodoPage> {
  const order = view === 'open' ? 'due' : 'created';
  const first = await readPage({ view, order, offset: 0, limit: PAGE });
  const items = [...first.items];
  let total = first.total;
  while (items.length < Math.min(total, MAX_ITEMS)) {
    const page = await readPage({ view, order, offset: items.length, limit: PAGE });
    total = page.total;
    if (page.items.length === 0) break;
    items.push(...page.items);
  }
  return { items: items.slice(0, MAX_ITEMS), total, nextDeferredAt: first.nextDeferredAt ?? null, dailyCheck: first.dailyCheck };
}

async function readTodos(host: GlanceTodoHost): Promise<GlanceTodos> {
  let readPage: (query: TodoListQuery) => Promise<TodoPage>;
  let dailyCheck: Promise<boolean | null> | null = null;
  if (host.deviceId) {
    const deviceId = host.deviceId;
    readPage = (query) => readRemotePage(deviceId, host.botId, query);
  } else {
    const { items } = await window.electronAPI.localDb.bots.todos.list(host.botId);
    const now = new Date();
    readPage = async (query) => queryTodoItems(items, query, now);
    // 读不到开关（伙伴暂停等）时只是不显示开关，待办照常。
    dailyCheck = (async () => window.electronAPI.localDb.bots.todos.dailyCheck(host.botId))().catch(() => null);
  }
  const [open, done, localDailyCheck] = await Promise.all([readAll(readPage, 'open'), readAll(readPage, 'done'), dailyCheck]);
  return {
    open: open.items,
    openTotal: open.total,
    done: [...done.items].reverse(),
    doneTotal: done.total,
    nextDeferredAt: open.nextDeferredAt ?? null,
    dailyCheck: host.deviceId ? (open.dailyCheck ?? null) : (localDailyCheck ?? null),
  };
}

/** 只重读「每天帮我查一次」：例行任务列表里暂停或恢复它时用，不必重读整份待办。 */
async function readDailyCheck(host: GlanceTodoHost): Promise<boolean | null> {
  if (!host.deviceId) return window.electronAPI.localDb.bots.todos.dailyCheck(host.botId);
  const page = await readRemotePage(host.deviceId, host.botId, { view: 'open', order: 'due', offset: 0, limit: 1 });
  return page.dailyCheck ?? null;
}

/** 打开或关掉伙伴的「每天帮我查一次」（宿主上的内置例行任务）；返回宿主确认后的状态。 */
export async function setGlanceDailyCheck(host: GlanceTodoHost, enabled: boolean): Promise<boolean> {
  if (!host.deviceId) return window.electronAPI.localDb.bots.todos.dailyCheck(host.botId, enabled);
  const result = await window.electronAPI.deviceLink.invoke(host.deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{
    client: { protocolVersion: 1, primitives: ['teammate-todos'] },
    collectionId: 'teammates',
    actionId: 'todo-daily-check',
    resourceRef: todosRef(host.botId),
    input: { enabled },
  }]);
  const value = (result as { dailyCheck?: unknown } | null)?.dailyCheck;
  if (typeof value !== 'boolean') throw new Error('invalid daily check result');
  return value;
}

/** 本机或那台电脑上的一次待办更新；撤销删除走同一条路径的 `restore`。 */
export async function patchGlanceTodo(host: GlanceTodoHost, patch: TodoPatch): Promise<TeammateTodo | null> {
  if (!host.deviceId) return window.electronAPI.localDb.bots.todos.update(host.botId, patch);
  const result = await window.electronAPI.deviceLink.invoke(host.deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{
    client: { protocolVersion: 1, primitives: ['teammate-todos'] },
    collectionId: 'teammates',
    actionId: 'todo-update',
    resourceRef: todosRef(host.botId),
    input: patch as unknown as Record<string, unknown>,
  }]);
  return (result as { todo?: TeammateTodo | null } | null)?.todo ?? null;
}

/**
 * 读一位伙伴的待办。`enabled=false` 时不读也不订阅（例如名册里伙伴主任务还没就绪）。
 * 本机随宿主推送刷新；别的电脑上的随那台的远程资源变更推送刷新；回到前台时再读一次。
 */
export function useGlanceTodos(host: GlanceTodoHost, enabled = true) {
  const [state, setState] = useState<{ todos: GlanceTodos; loaded: boolean; failed: boolean }>({
    todos: EMPTY,
    loaded: false,
    failed: false,
  });
  const epoch = useRef(0);
  const { botId, deviceId } = host;

  const refresh = useCallback(async () => {
    if (!enabled || !botId) return;
    const mine = ++epoch.current;
    const owner = getDataOwnerGeneration();
    try {
      const todos = await readTodos({ botId, deviceId });
      if (mine !== epoch.current || !isDataOwnerGenerationCurrent(owner)) return;
      setState({ todos, loaded: true, failed: false });
    } catch {
      if (mine !== epoch.current || !isDataOwnerGenerationCurrent(owner)) return;
      setState((previous) => ({ ...previous, loaded: true, failed: true }));
    }
  }, [botId, deviceId, enabled]);

  const refreshDailyCheck = useCallback(async () => {
    const owner = getDataOwnerGeneration();
    const dailyCheck = await readDailyCheck({ botId, deviceId }).catch(() => undefined);
    if (dailyCheck === undefined || !isDataOwnerGenerationCurrent(owner)) return;
    setState((previous) => ({ ...previous, todos: { ...previous.todos, dailyCheck } }));
  }, [botId, deviceId]);

  useEffect(() => {
    setState({ todos: EMPTY, loaded: false, failed: false });
    if (!enabled || !botId) return;
    void refresh();
    const unsubscribe = deviceId
      ? window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
          if (push.deviceId !== deviceId || push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL) return;
          if (!isDeviceLinkRemotePushCurrent(push, stamp)) return;
          const payload = parseRemoteResourceChangedPayload(push.payload);
          // 例行任务列表里暂停或恢复「每天查待办」：只重读开关。
          if (payload?.collectionId === 'routines') return void refreshDailyCheck();
          if (payload?.collectionId !== 'teammates') return;
          if (
            payload.resourceRefs?.length &&
            !payload.resourceRefs.some((ref) => ref.id === botId || ref.id === `todos:${botId}`)
          )
            return;
          void refresh();
        })
      : window.electronAPI.maker.onBotWorkbenchChanged((event) => {
          if (event.botId === botId) void refresh();
        });
    const offRoutines = deviceId ? undefined : window.electronAPI.routines?.onChanged(() => void refreshDailyCheck());
    const foreground = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', foreground);
    return () => {
      epoch.current++;
      unsubscribe?.();
      offRoutines?.();
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', foreground);
    };
  }, [botId, deviceId, enabled, refresh, refreshDailyCheck]);

  // 浮层开着时也要跟上时间：「稍后再说」到时回到列表，跨过午夜时重算今天到期的红点。
  const nextDeferredAt = state.todos.nextDeferredAt;
  useEffect(() => {
    if (!enabled || !botId || !state.loaded) return;
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const next = nextDeferredAt && Date.parse(nextDeferredAt) < Date.parse(midnight) ? nextDeferredAt : midnight;
    return scheduleTodoDeferralRefresh(next, () => void refresh());
  }, [botId, enabled, nextDeferredAt, refresh, state.loaded, state.todos]);

  /** 宿主确认后的开关状态先写进当前列表，不等下一次读取。 */
  const setDailyCheck = useCallback((dailyCheck: boolean) => {
    setState((previous) => ({ ...previous, todos: { ...previous.todos, dailyCheck } }));
  }, []);

  return { ...state, refresh, setDailyCheck };
}

const SEEN_PREFIX = 'cindy:bots:glance-due-seen:';

function readSeen(botId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_PREFIX + botId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

/** 到期的待办；入口红点只看主人还没在近况里看过的那几条。 */
export function dueTodos(todos: GlanceTodos, now = new Date()): TeammateTodo[] {
  return todos.open.filter((t) => todoDue(t, now));
}

export function hasUnseenDue(botId: string, due: readonly TeammateTodo[]): boolean {
  if (due.length === 0) return false;
  const seen = readSeen(botId);
  return due.some((t) => !seen.has(todoDueKey(t)));
}

/** 打开近况就算看过了：只记当前到期的这几条，旧记录随之淘汰。 */
export function markDueSeen(botId: string, due: readonly TeammateTodo[]): void {
  try {
    window.localStorage.setItem(SEEN_PREFIX + botId, JSON.stringify(due.map(todoDueKey)));
  } catch {
    // 本地存储不可用时只是红点多亮一次，不影响待办本身。
  }
}
