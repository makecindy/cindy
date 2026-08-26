/**
 * main/im/shared/sessionBroadcast.ts
 * ---------------------------------------------------------------------------
 * IM 渠道新建会话行后的 renderer 通知。sidebar 的 Projects 列表靠
 * `local-db:sessions:created` push 增量感知新会话(renderer sessionsStore.onCreated
 * → 重拉列表),不广播的话 IM 进来的新会话要等用户手动刷新才出现。
 * 创建通知统一走 emitSessionCreated。
 */

import { BrowserWindow } from 'electron';

import { tapWindowBroadcast } from '../../device-link/broadcast-tap';
import { emitSessionCreated } from '../../localDb/ipc/sessionCreatedBroadcast';

/** 广播「session 行已创建」到本机所有窗口 + device-link 控制端。best-effort。 */
export function broadcastSessionCreated(sessionId: string): void {
  emitSessionCreated(sessionId);
}

/**
 * 广播「session 行字段已更新」(标题回写等)到本机所有窗口 + device-link
 * 控制端。与 created 同一条 tap 通道; 放本模块是因为它只依赖 electron —
 * fbotTitle 那层还拖着 maker-ipc/title 的重型链, sessionRepo 不能为一条
 * 广播消息反向 import 它。
 */
export function broadcastSessionPatched(sessionId: string, patch: Record<string, unknown>): void {
  tapWindowBroadcast('local-db:sessions:patched', { sessionId, patch });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:sessions:patched', { sessionId, patch });
    } catch {
      // best-effort UI 刷新失败不影响 IM 业务
    }
  }
}
