/**
 * 长耗时会话操作的 renderer 侧作用域守卫。
 *
 * 同一视图组件可在请求尚未结束时切换 session；锁必须按 sessionId 隔离，且迟到响应
 * 只能影响当前仍展示的会话。Set 允许 A/B 请求短暂重叠，A 的 finally 只释放 A，绝不
 * 清掉 B 的锁。
 *
 * 代(epoch)语义(#1927 / greptile review):每次 setCurrentSession 都换代。A 在途时
 * 切到 B 再切回 A,旧 A 请求(旧代)不得再视为当前——迟到 toast 不弹;新点击按新代
 * 登记,不被旧请求的锁挡住(否则 pi 长压缩数分钟内新点击会静默丢弃)。
 */
export interface SessionScopedRequestGuard {
  setCurrentSession(sessionId: string | null): void;
  /**
   * 尝试登记一次请求;返回 `{ release, epoch }` 表示成功(调用方在 finally 里 release),
   * 返回 null 表示同代同会话已有 in-flight(防重复点击)。
   */
  tryBegin(sessionId: string): { release: () => void; epoch: number } | null;
  /**
   * sessionId 仍是当前展示会话;传 epoch 时额外要求请求代与当前代一致
   * (切走再切回后旧代请求返回 false,迟到响应/确认结果不再生效)。
   */
  isCurrent(sessionId: string, epoch?: number): boolean;
}

export function createSessionScopedRequestGuard(): SessionScopedRequestGuard {
  const inFlightKeys = new Set<string>();
  let currentSessionId: string | null = null;
  let epoch = 0;

  return {
    setCurrentSession(sessionId) {
      currentSessionId = sessionId;
      epoch += 1; // 每次进入(含从 B 切回 A)换代:旧代请求不再匹配当前作用域
    },
    tryBegin(sessionId) {
      const key = `${sessionId}#${epoch}`;
      if (inFlightKeys.has(key)) return null;
      inFlightKeys.add(key);
      return {
        release: () => {
          inFlightKeys.delete(key);
        },
        epoch,
      };
    },
    isCurrent(sessionId, sinceEpoch) {
      if (currentSessionId !== sessionId) return false;
      return sinceEpoch === undefined || sinceEpoch === epoch;
    },
  };
}
