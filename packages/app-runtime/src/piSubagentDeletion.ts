/**
 * IM 软删行复活时撤回「已删除」墓碑与进行中的清理。
 * 实现绑定在 sessions.ts，避免 sessionRepo 静态拉整份 IPC 模块。
 */

import { clearPiSubagentDeletedTombstone } from "@cindy/maker-core/pi-subagent-runs";

export function createPiSubagentDeletion(
  agentHomeForSession: (sessionId: string) => string,
) {
  let cancelImpl: ((sessionId: string) => void) | null = null;

  function bindDeletedPiSubagentCleanupCancel(
    fn: (sessionId: string) => void,
  ): void {
    cancelImpl = fn;
  }

  function cancelDeletedPiSubagentCleanup(sessionId: string): void {
    cancelImpl?.(sessionId);
  }

  async function retireDeletedPiSubagentState(
    sessionId: string,
  ): Promise<void> {
    cancelDeletedPiSubagentCleanup(sessionId);
    await clearPiSubagentDeletedTombstone(
      agentHomeForSession(sessionId),
      sessionId,
    );
  }

  return {
    bindDeletedPiSubagentCleanupCancel,
    cancelDeletedPiSubagentCleanup,
    retireDeletedPiSubagentState,
  };
}
