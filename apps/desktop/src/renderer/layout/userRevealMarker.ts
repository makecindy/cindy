/**
 * 跨任务的「用户开栏」标记。
 *
 * 用户在任务 A 里打开右栏并要求切到任务 B 时，导航落地后那次记忆恢复仍算用户触发；
 * 其余切任务恢复都按导航处理（窗口宽度不变）。标记只对发起它的那次导航有效：
 * 落到别的任务（慢查询期间用户又去了别处）或没有落点（去了设置页）时必须作废，
 * 否则以后普通切到目标任务会被当成用户手势把窗口拉宽。
 *
 * 消费必须发生在「声明目标任务」的同一次更新里：MainLayout 用同一个 setState 批次
 * 提交落地任务的可见性与来源，LayoutRoot 才会在第一次渲染就看到正确的来源，不会
 * 拿上一个任务的来源提前改窗口宽度。
 */
export interface UserRevealMarker {
  mark(targetSessionId: string): void;
  /**
   * 落地到目标任务时消费并清空；这次声明的是别的任务时返回 false 且保留标记
   * （同任务的普通重声明不能把用户手势吃掉）。
   */
  consume(committedSessionId: string | null): boolean;
  /** 还在等哪个任务落地；没在等时为 null。 */
  target(): string | null;
  /** 导航没有落点或被别的任务顶掉：作废。 */
  cancel(): void;
}

export function createUserRevealMarker(): UserRevealMarker {
  let pending: string | null = null;
  return {
    mark(targetSessionId: string): void {
      pending = targetSessionId;
    },
    consume(committedSessionId: string | null): boolean {
      if (!pending || pending !== committedSessionId) return false;
      pending = null;
      return true;
    },
    target(): string | null {
      return pending;
    },
    cancel(): void {
      pending = null;
    },
  };
}
