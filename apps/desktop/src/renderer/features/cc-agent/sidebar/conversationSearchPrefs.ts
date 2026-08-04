/**
 * conversationSearchPrefs —— 会话搜索的本地偏好(目前只有排序方式)。
 * ---------------------------------------------------------------------------
 * 排序是「个人习惯」而不是一次性收窄条件:用户挑过「最近活跃」后,重开搜索 / 重启客户端
 * 都应保持该选择,否则每次都要重挑一遍。故排序落 localStorage,与侧栏主列表的
 * groupBy / sortBy 偏好同款(见 hooks/helpers/sidebarFilterCore.ts)。
 *
 * 其余筛选(状态 / Agent / 最近活跃范围 / 项目)刻意**不**持久化:它们会静默收窄结果集,
 * 跨会话记住会让「搜不到东西」变得难以察觉。
 *
 * **为什么是订阅式 store 而不是各自 useState 初始值**:搜索有两个常驻挂载的实例——
 * rail 态的 ConversationSearchBox 与展开态 Provider 里的内联搜索(CCAgentSidebarUpper
 * 用 opacity / hidden 切换可见性,两个视图都不卸载)。若各自只在挂载时读一次 localStorage,
 * 在一处改排序后另一处会停在旧值,直到重挂载 / 重启才「记住」(PR #963 review)。这里把
 * 偏好收成模块级单一真源 + useSyncExternalStore 订阅,任一处改动即时同步到所有实例;
 * 同 origin 的其它窗口经 storage 事件跟随。
 *
 * load / persist 保持纯函数(不依赖 React)以便在 node 环境下直接单测,策略同
 * sidebarFilterCore;store 层则在 jsdom 下测。
 */

import { createLogger } from '@/lib/logger';

import type { ConversationSearchSortBy } from '../../../../shared/conversationSearch';

const log = createLogger('ConversationSearchPrefs');

export const SEARCH_SORT_BY_KEY = 'cc-agent.search.sortBy';

/** 未做过选择时的默认排序:相关度(混合检索的最佳匹配优先)。 */
export const DEFAULT_SEARCH_SORT_BY: ConversationSearchSortBy = 'relevance';

const SORT_BY_VALUES: ReadonlySet<string> = new Set<ConversationSearchSortBy>([
  'relevance',
  'activityDesc',
  'activityAsc',
]);

/**
 * 安全访问 localStorage —— 测试 / 非浏览器环境下可能不存在,
 * 甚至访问即抛(security error);一律降级为 null。
 */
function safeStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.localStorage !== 'undefined') {
      return globalThis.localStorage;
    }
  } catch {
    // 某些环境访问 localStorage 即抛异常,视为不可用。
  }
  return null;
}

/** 读上次选择的排序;未设置 / 非法值 / 读取异常 → 默认排序。 */
export function loadSearchSortBy(): ConversationSearchSortBy {
  const storage = safeStorage();
  if (!storage) return DEFAULT_SEARCH_SORT_BY;
  let raw: string | null = null;
  try {
    raw = storage.getItem(SEARCH_SORT_BY_KEY);
  } catch (err) {
    log.warn('failed to read sortBy:', err);
    return DEFAULT_SEARCH_SORT_BY;
  }
  if (raw && SORT_BY_VALUES.has(raw)) return raw as ConversationSearchSortBy;
  return DEFAULT_SEARCH_SORT_BY;
}

/** 写入排序选择;storage 不可用或写失败只告警,不影响本次搜索。 */
export function persistSearchSortBy(sortBy: ConversationSearchSortBy): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(SEARCH_SORT_BY_KEY, sortBy);
  } catch (err) {
    log.warn('failed to persist sortBy:', err);
  }
}

/* ==================== 共享 store(所有搜索实例的单一真源) ==================== */

/** 进程内当前值。null = 还没读过 storage(首次 get 时惰性加载)。 */
let cached: ConversationSearchSortBy | null = null;
const listeners = new Set<() => void>();
/** storage 事件监听只挂一次(模块级),用变量存 handler 以便测试重置时摘掉。 */
let storageHandler: ((event: StorageEvent) => void) | null = null;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** 把 storage 里的原始值收敛成合法排序值。 */
function normalize(raw: string | null | undefined): ConversationSearchSortBy {
  return raw && SORT_BY_VALUES.has(raw)
    ? (raw as ConversationSearchSortBy)
    : DEFAULT_SEARCH_SORT_BY;
}

function attachStorageListener(): void {
  if (storageHandler || typeof window === 'undefined') return;
  // 同 origin 的其它窗口改了排序 → 本窗口跟随(storage 事件只在**其它**窗口触发)。
  storageHandler = (event: StorageEvent) => {
    if (event.key !== SEARCH_SORT_BY_KEY) return;
    const next = normalize(event.newValue);
    if (next === cached) return;
    cached = next;
    emit();
  };
  window.addEventListener('storage', storageHandler);
}

/** 读当前排序(useSyncExternalStore 的 getSnapshot:同值必须返回同引用,字符串天然满足)。 */
export function getSearchSortBy(): ConversationSearchSortBy {
  if (cached === null) cached = loadSearchSortBy();
  return cached;
}

/** 改排序:写 storage + 通知所有挂载中的搜索实例(rail 与内联即时一致)。 */
export function setSearchSortBy(next: ConversationSearchSortBy): void {
  if (getSearchSortBy() === next) return;
  cached = next;
  persistSearchSortBy(next);
  emit();
}

/** 订阅排序变化;返回退订函数(useSyncExternalStore 契约)。 */
export function subscribeSearchSortBy(onStoreChange: () => void): () => void {
  attachStorageListener();
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/** 仅测试用:清掉进程内缓存与订阅者,让下次 get 重新读 storage。 */
export function __resetSearchSortByStoreForTests(): void {
  cached = null;
  listeners.clear();
  if (storageHandler && typeof window !== 'undefined') {
    window.removeEventListener('storage', storageHandler);
  }
  storageHandler = null;
}
