/**
 * 跨任务的「用户开栏」标记。
 *
 * 用户在任务 A 里打开右栏并要求切到任务 B 时，导航落地后那次记忆恢复仍算用户触发；
 * 其余切任务恢复都按导航处理（窗口宽度不变）。标记只对发起它的那次导航有效：
 * 目标被别的任务顶掉时（慢查询期间用户又去了别处）必须作废，否则以后普通切到
 * 目标任务会被当成用户手势把窗口拉宽。
 */
export interface UserRevealMarker {
  mark(targetSessionId: string): void;
  /** 当前任务提交时消费标记；返回这次提交是不是标记的那次用户开栏。 */
  consume(committedSessionId: string | null): boolean;
}

export function createUserRevealMarker(): UserRevealMarker {
  let pending: string | null = null;
  return {
    mark(targetSessionId: string): void {
      pending = targetSessionId;
    },
    consume(committedSessionId: string | null): boolean {
      const target = pending;
      if (!target) return false;
      // 不管这次提交是不是目标，标记都只用一次：被顶掉的手势不能留给以后的导航。
      pending = null;
      return target === committedSessionId;
    },
  };
}
