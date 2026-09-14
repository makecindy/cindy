/**
 * IM 软删行复活时撤回「已删除」墓碑与进行中的清理。
 * 实现绑定在 sessions.ts，避免 sessionRepo 静态拉整份 IPC 模块。
 */
import path from 'node:path';

import { app } from 'electron';

import { clearPiSubagentDeletedTombstone } from '@cindy/maker-core/pi-subagent-runs';

let cancelImpl: ((sessionId: string) => void) | null = null;

export function bindDeletedPiSubagentCleanupCancel(fn: (sessionId: string) => void): void {
  cancelImpl = fn;
}

export function cancelDeletedPiSubagentCleanup(sessionId: string): void {
  cancelImpl?.(sessionId);
}

export async function retireDeletedPiSubagentState(sessionId: string): Promise<void> {
  cancelDeletedPiSubagentCleanup(sessionId);
  await clearPiSubagentDeletedTombstone(
    path.join(app.getPath('userData'), 'pi-agent-home'),
    sessionId,
  );
}
