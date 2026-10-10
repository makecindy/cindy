import {
  PR_STATUS_REFRESH_INTERVAL_MS,
  prStatusKey,
  type PrStatusResult,
  type SessionPrRef,
} from '@cindy/maker-shared';

/**
 * 首页「任务信息 · PR 状态」的按任务缓存。
 *
 * 列表行会随滚动反复挂载 / 卸载,不能把结果放在行组件 state 里:那样每次回到视口都会闪一下
 * 空白并重新打两次远程调用。这里与桌面查看远程任务时的 PrRefsContext 同口径:
 *   - 只有勾选了 PR 的可见行才发起查询(挂载即查,卸载停刷新);
 *   - 每个任务先 `git-context:pr-refs:list` 取引用,再只查最新一条的状态
 *     (被控端会按该任务已有引用过滤,不能借这条通道查无关仓库);
 *   - 结果按 PR_STATUS_REFRESH_INTERVAL_MS 刷新,任务有更新时最快 10 秒重查一次。
 * 缓存键带账号代次,切账号后旧结果自然失效。
 */
export interface HomeSessionPrInfo {
  ref: SessionPrRef;
  status: PrStatusResult | null;
}

type Invoke = <T>(deviceId: string, channel: string, args: unknown[]) => Promise<T>;

interface Entry {
  value: HomeSessionPrInfo | null;
  fetchedAt: number;
  refreshKey: string | undefined;
  inflight: boolean;
}

const MIN_REFETCH_MS = 10_000;
/** 在途请求通常很快结束;任务有变化时至少隔这么久再补查一次。 */
const IN_FLIGHT_RETRY_MS = 1_000;
const MAX_ENTRIES = 300;
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

export function homeSessionPrCacheKey(scope: string, deviceId: string, sessionId: string): string {
  return JSON.stringify([scope, deviceId, sessionId]);
}

export function readHomeSessionPr(key: string): HomeSessionPrInfo | null {
  return entries.get(key)?.value ?? null;
}

export function subscribeHomeSessionPr(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/**
 * 按新鲜度决定是否发起加载;同一任务同时只有一个请求在途。所有刷新时机都走这里,分两档:
 *   - 例行(挂载、定时轮询):结果不足 PR_STATUS_REFRESH_INTERVAL_MS 时沿用缓存;
 *   - 事件(任务有更新即 refreshKey 变化,或 eventful:回到首页 / 回到前台):绕过上面的缓存期,
 *     只保留 MIN_REFETCH_MS 防抖;被在途请求或防抖挡住时返回多少毫秒后再调用即可补查。
 * 例行档被挡住返回 0(下一轮轮询自然会查)。
 */
export function refreshHomeSessionPr(
  key: string,
  load: (previous: HomeSessionPrInfo | null) => Promise<HomeSessionPrInfo | null>,
  options: { now: number; refreshKey?: string; eventful?: boolean },
): number {
  const entry = entries.get(key);
  if (entry) {
    const age = options.now - entry.fetchedAt;
    const eventful = options.eventful === true || entry.refreshKey !== options.refreshKey;
    if (entry.inflight) return eventful ? Math.max(MIN_REFETCH_MS - age, IN_FLIGHT_RETRY_MS) : 0;
    if (age < (eventful ? MIN_REFETCH_MS : PR_STATUS_REFRESH_INTERVAL_MS)) {
      return eventful ? MIN_REFETCH_MS - age : 0;
    }
  }
  const next: Entry = {
    fetchedAt: options.now,
    inflight: true,
    refreshKey: options.refreshKey,
    value: entry?.value ?? null,
  };
  entries.delete(key);
  entries.set(key, next);
  trimEntries();
  void load(next.value)
    .then((value) => {
      if (entries.get(key) !== next) return;
      next.value = value;
    })
    // 失败保留上次结果:网络抖动不该让已显示的 PR 号消失;下一个刷新周期再试。
    .catch(() => undefined)
    .finally(() => {
      next.inflight = false;
      listeners.get(key)?.forEach((listener) => listener());
    });
  return 0;
}

export async function loadHomeSessionPr(
  invoke: Invoke,
  deviceId: string,
  sessionId: string,
  previous: HomeSessionPrInfo | null = null,
): Promise<HomeSessionPrInfo | null> {
  const refs = await invoke<unknown>(deviceId, 'git-context:pr-refs:list', [sessionId]);
  const ref = latestPrRef(refs);
  if (!ref) return null;
  // 状态查询失败只是这一轮没拿到,不是「状态未知」:同一 PR 沿用上次已知状态
  // (已合并 / 已关闭不该退回中性图标);换了 PR 才没有可沿用的状态。
  const carried = previous && prStatusKey(previous.ref) === prStatusKey(ref) ? previous.status : null;
  let statuses: unknown;
  try {
    statuses = await invoke<unknown>(deviceId, 'git-context:pr-status', [{
      sessionId,
      queries: [{ owner: ref.owner, repo: ref.repo, prNumber: ref.prNumber }],
    }]);
  } catch {
    return { ref, status: carried };
  }
  const status = Array.isArray(statuses)
    ? (statuses as PrStatusResult[]).find((item) => item && prStatusKey(item) === prStatusKey(ref)) ?? null
    : null;
  return { ref, status: status ?? carried };
}

/** 与桌面信息槽一致:只显示最近一次出现的 PR(lastSeenAt 最大)。 */
export function latestPrRef(value: unknown): SessionPrRef | null {
  if (!Array.isArray(value)) return null;
  let latest: SessionPrRef | null = null;
  for (const item of value as Partial<SessionPrRef>[]) {
    if (
      !item
      || typeof item.owner !== 'string'
      || typeof item.repo !== 'string'
      || typeof item.prNumber !== 'number'
      || !Number.isSafeInteger(item.prNumber)
      || item.prNumber <= 0
    ) continue;
    const ref = item as SessionPrRef;
    if (!latest || (ref.lastSeenAt ?? 0) > (latest.lastSeenAt ?? 0)) latest = ref;
  }
  return latest;
}

function trimEntries(): void {
  // Map 按插入序;刷新时重新插入,最早的就是最久未用的。
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

export const __testing = {
  reset(): void {
    entries.clear();
    listeners.clear();
  },
};
