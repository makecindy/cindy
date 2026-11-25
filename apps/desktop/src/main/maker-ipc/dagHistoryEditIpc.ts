/** Only the trusted local app can request an edit. The service resolves the manifest and owns its journal. */
import { BrowserWindow, ipcMain } from 'electron';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { listInstalledGhostsAsync } from '../cindy-brain/index.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';

function idArg(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throwIpcError('INVALID_ARGUMENT', '无效的历史锚点或操作编号');
  return value;
}
export async function gateDagHistoryEdit(event: Electron.IpcMainInvokeEvent, stamp: unknown) {
  assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
  if (isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', '仅支持在任务所在电脑操作');
  const scope = activeOwnerScopeKey();
  const owner = getActiveDataOwnerPushStamp();
  if (isAppSessionBoundaryPending() || !isDataOwnerPushStamp(stamp) || stamp.dataOwnerId !== owner.dataOwnerId || stamp.ownerGeneration !== owner.ownerGeneration)
    throwIpcError('PRECONDITION_FAILED', '账号已变化，请重新打开会话图');
  const enabled = (await listInstalledGhostsAsync()).some(g =>
    g.namespace === 'local' && g.enabled && g.manifest.id === 'session-dag' && g.approval.state === 'approved');
  if (!enabled || scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throwIpcError('PRECONDITION_FAILED', '插件未启用或账号已切换');
  return scope;
}
export function registerDagHistoryEditIpc(): void {
  ipcMain.handle('dag-history:preview', async (event, sid: unknown, cid: unknown, action: unknown, stamp: unknown) => {
    const owner = await gateDagHistoryEdit(event, stamp);
    if (action !== 'withdraw' && action !== 'delete') throwIpcError('INVALID_ARGUMENT', '未知的历史操作');
    const { previewDagHistoryEdit } = await import('../maker-orchestration/dagHistoryEdit.js');
    return previewDagHistoryEdit(idArg(sid), idArg(cid), action, owner);
  });
  for (const name of ['commit', 'undo', 'status'] as const) {
    ipcMain.handle(`dag-history:${name}`, async (event, id: unknown, stamp: unknown) => {
      const owner = await gateDagHistoryEdit(event, stamp);
      const service = await import('../maker-orchestration/dagHistoryEdit.js');
      const fn = { commit: service.commitDagHistoryEdit, undo: service.undoDagHistoryEdit, status: service.getDagHistoryEditStatus }[name];
      const result = await fn(idArg(id), owner);
      if (name !== 'status' && result && owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending()) {
        const change = { owner: getActiveDataOwnerPushStamp(), ids: [result.sessionId, ...result.removedSessionIds] };
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.webContents !== event.sender && isTrustedAppRendererWindow(win)) {
            try { win.webContents.send('dag-history:changed', change); } catch { /* window closed */ }
          }
        }
      }
      return result;
    });
  }
}
