/**
 * sessionBrowseHistory —— 任务浏览栈(浏览器式后退/前进)的纯逻辑。
 *
 * 为什么需要:会话一多,用户从一个任务切去处理更急的任务后,回不到刚才那个。
 * 这里按访问顺序记下打开过的任务,左上按钮簇(ChromeActions)与 ⌘[ / ⌘] 都能
 * 沿栈走回去,前进侧与浏览器同义:走到中间后打开新任务会截断前进侧。
 *
 * 只记任务视图 `/cc-agent/<sessionId>` 一条路由。草稿(new)、自动任务、文件树、
 * Orca 工作流都不进栈 —— 用户要的是「刚看过的那个任务」,不是走过的每一页;
 * 栈里也就能保证后退永远落在任务上。
 */

/** 超过这个数量的最旧记录被丢弃,避免长期使用后无限增长。 */
const MAX_ENTRIES = 50;

const SESSION_VIEW_PATH = /^\/cc-agent\/([^/]+)$/;
/** `/cc-agent/<静态段>` 不是任务 id(路由另有对应页面,见 router.tsx)。 */
const NON_SESSION_SEGMENTS = new Set(['new', 'new-dialogue', 'scheduled', 'boot']);

/** 当前路径是一个任务视图时返回其 sessionId,否则 null。 */
export function sessionIdFromPathname(pathname: string): string | null {
  const match = SESSION_VIEW_PATH.exec(pathname);
  if (!match || NON_SESSION_SEGMENTS.has(match[1])) return null;
  return match[1];
}

export interface SessionBrowseSnapshot {
  ids: readonly string[];
  index: number;
}

export interface SessionBrowseHistory {
  /** 打开了一个任务:同类去重,截断前进侧后入栈。 */
  record(sessionId: string): void;
  /** 沿栈走一步;到边界返回 null(调用方据此置灰/不消费快捷键)。 */
  step(direction: -1 | 1): string | null;
  /** 任务已删 / 打不开:把它从栈里摘掉(可能多处),游标落在原来的位置附近。 */
  forget(sessionId: string): void;
  /** 账号(数据所有者)已切换:整栈清空,不把上一个账号的任务带进新账号。 */
  bindOwner(ownerKey: string): void;
  snapshot(): SessionBrowseSnapshot;
  subscribe(listener: () => void): () => void;
}

export function createSessionBrowseHistory(maxEntries = MAX_ENTRIES): SessionBrowseHistory {
  let state: SessionBrowseSnapshot = { ids: [], index: -1 };
  let ownerKey = '';
  const listeners = new Set<() => void>();
  const commit = (next: SessionBrowseSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    record(sessionId) {
      // 同一任务的重复导航(标题刷新、同 id 深链)不该占一格,否则后退按一下没反应。
      if (state.ids[state.index] === sessionId) return;
      const ids = [...state.ids.slice(0, state.index + 1), sessionId];
      if (ids.length > maxEntries) ids.splice(0, ids.length - maxEntries);
      commit({ ids, index: ids.length - 1 });
    },
    step(direction) {
      const next = state.index + direction;
      if (next < 0 || next >= state.ids.length) return null;
      commit({ ids: state.ids, index: next });
      return state.ids[next];
    },
    forget(sessionId) {
      if (!state.ids.includes(sessionId)) return;
      // 游标前保留的条数就是新游标;越界时钳到末尾,空栈回到 -1。
      const keptBefore = state.ids.slice(0, Math.max(0, state.index)).filter((id) => id !== sessionId).length;
      const ids = state.ids.filter((id) => id !== sessionId);
      commit({ ids, index: ids.length === 0 ? -1 : Math.min(keptBefore, ids.length - 1) });
    },
    bindOwner(nextOwnerKey) {
      if (nextOwnerKey === ownerKey) return;
      ownerKey = nextOwnerKey;
      if (state.ids.length === 0) return;
      commit({ ids: [], index: -1 });
    },
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 生产环境唯一的栈:同一窗口内所有消费方(按钮/快捷键)共享。 */
export const sessionBrowseHistory = createSessionBrowseHistory();
