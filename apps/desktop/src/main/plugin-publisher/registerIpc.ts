import { ipcMain } from 'electron';

import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { PluginPublisherApiError } from './api.js';
import {
  currentPublisherIdentity,
  createPluginPublisherApi,
  getPluginPublisherConfirmBridge,
  getPluginPublisherOrchestrator,
  trackPublisherConfirmRequester,
} from './host.js';

let registered = false;

function mapListError(error: unknown): never {
  if (error instanceof PluginPublisherApiError) {
    if (error.status === 403 && error.code === 'FORBIDDEN') {
      throwIpcError('PERMISSION_DENIED', '本企业未开启成员发布，请联系管理员');
    }
    throwIpcError('INTERNAL', error.message || '发布列表加载失败');
  }
  throwIpcError('INTERNAL', '发布列表加载失败');
}

export function registerPluginPublisherIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('plugin-publisher:start', (event) => {
    assertTrustedAppRendererEvent(event);
    // 临时 fail closed:Renderer 自报绝对路径不构成用户授权(XSS 可伪造)。下期重新
    // 开放“我的发布”前，必须先由 Main 文件选择器签发一次性 grant，再由 start 消费；
    // 在 grant 落地前这个 IPC 入口不得恢复。
    throwIpcError('INVALID_PARAMS', 'Renderer file path publishing is disabled');
  });

  ipcMain.handle('plugin-publisher:status', (event, transferId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(transferId, 'transferId');
    if (isAppSessionBoundaryPending()) return { progress: null };
    return {
      progress: getPluginPublisherOrchestrator().snapshotForOwner(
        id,
        getActiveAppSession(),
      ),
    };
  });

  ipcMain.handle('plugin-publisher:cancel', (event, transferId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(transferId, 'transferId');
    if (isAppSessionBoundaryPending()) return { cancelled: false };
    return getPluginPublisherOrchestrator().cancelForOwner(
      id,
      getActiveAppSession(),
    );
  });

  ipcMain.handle('plugin-publisher:list-mine', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!currentPublisherIdentity()) {
      throwIpcError('PERMISSION_DENIED', '需要组织身份才能查看发布');
    }
    const cursor =
      raw && typeof raw === 'object' && typeof (raw as { cursor?: unknown }).cursor === 'string'
        ? (raw as { cursor: string }).cursor
        : undefined;
    try {
      return await createPluginPublisherApi().listMine(cursor);
    } catch (error) {
      mapListError(error);
    }
  });

  ipcMain.handle('plugin-publisher:resolve-confirm', (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    trackPublisherConfirmRequester(event.sender);
    const payload = requireObject(raw);
    const requestId = requireString(payload.requestId, 'requestId');
    if (requestId.length > 128) throwIpcError('INVALID_PARAMS', 'requestId is too long');
    return {
      handled: getPluginPublisherConfirmBridge().resolve(
        event.sender.id,
        requestId,
        payload.confirmed,
      ),
    };
  });
}
