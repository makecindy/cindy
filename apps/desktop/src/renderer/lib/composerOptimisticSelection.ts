import type { SessionRuntimeProfileProjection } from '@/lib/ccAgent.types';

/**
 * 远程任务输入框此刻乐观显示的模型(被控端回流前的同引擎切换，见 ChatInput pendingRemoteSwitch)。
 *
 * 输入框登记、路由辅助函数(新建任务沿用当前模型)同步读取：回流窗口内点新建，沿用的是用户
 * 看到的那一份，而不是尚未追上的镜像。只放纯数据，不引入 store 依赖图。
 */
export type ComposerOptimisticSelection = Pick<
  SessionRuntimeProfileProjection,
  'model' | 'providerId' | 'effort' | 'fastMode'
>;

const selections = new Map<string, ComposerOptimisticSelection>();

export function publishComposerOptimisticSelection(
  sessionId: string,
  selection: ComposerOptimisticSelection,
): () => void {
  selections.set(sessionId, selection);
  // 只撤销自己登记的那份：同一任务的新登记已覆盖时不误删。
  return () => {
    if (selections.get(sessionId) === selection) selections.delete(sessionId);
  };
}

export function readComposerOptimisticSelection(
  sessionId: string,
): ComposerOptimisticSelection | null {
  return selections.get(sessionId) ?? null;
}
