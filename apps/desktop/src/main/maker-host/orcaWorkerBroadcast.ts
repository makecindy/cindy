import { BrowserWindow } from 'electron';

import { MAKER_PUSH } from '../maker-ipc/channels.js';

export interface OrcaWorkerBroadcastWindow {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
}

/** 向所有存活窗口广播 Orca worker 变更，单个窗口失败不影响其它窗口刷新。 */
export function broadcastOrcaWorkerChangedToWindows(
  windows: Iterable<OrcaWorkerBroadcastWindow>,
  leadSessionId: string,
): void {
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
    } catch {
      // Best-effort UI refresh only.
    }
  }
}

export function broadcastOrcaWorkerChanged(leadSessionId: string): void {
  broadcastOrcaWorkerChangedToWindows(BrowserWindow.getAllWindows(), leadSessionId);
}
