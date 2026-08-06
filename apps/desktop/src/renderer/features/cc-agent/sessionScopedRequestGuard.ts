/**
 * 长耗时会话操作的 renderer 侧作用域守卫。
 *
 * 同一视图组件可在请求尚未结束时切换 session；锁必须按 sessionId 隔离，且迟到响应
 * 只能影响当前仍展示的会话。Set 允许 A/B 请求短暂重叠，A 的 finally 只删除 A，绝不
 * 清掉 B 的锁。
 */
export interface SessionScopedRequestGuard {
  setCurrentSession(sessionId: string | null): void;
  tryBegin(sessionId: string): boolean;
  isCurrent(sessionId: string): boolean;
  finish(sessionId: string): void;
}

export function createSessionScopedRequestGuard(): SessionScopedRequestGuard {
  const inFlightSessionIds = new Set<string>();
  let currentSessionId: string | null = null;

  return {
    setCurrentSession(sessionId) {
      currentSessionId = sessionId;
    },
    tryBegin(sessionId) {
      if (inFlightSessionIds.has(sessionId)) return false;
      inFlightSessionIds.add(sessionId);
      return true;
    },
    isCurrent(sessionId) {
      return currentSessionId === sessionId;
    },
    finish(sessionId) {
      inFlightSessionIds.delete(sessionId);
    },
  };
}
