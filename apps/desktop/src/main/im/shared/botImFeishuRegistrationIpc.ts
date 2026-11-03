/**
 * 伙伴自有飞书连接的扫码授权 IPC。
 *
 * 凭证只在 main 内流转: device-code 成功后直接 addBotImConnection, renderer 只拿
 * 验证链接 / 授权码 / 轮次与最终状态。取消发生在建连过程中时会回滚刚建好的连接。
 */
import { BrowserWindow, ipcMain } from 'electron';
import { pollFeishuAppRegistration, requestFeishuAppRegistration } from '@cindy/im';

import { createLogger } from '../../logger';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { throwIpcError } from '../../utils/ipcValidate';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState';
import type {
  BotImFeishuRegistrationBeginResult,
  BotImFeishuRegistrationStatus,
} from '../../../shared/botImConnection';
import { postForm } from '../host';
import {
  addBotImConnection,
  readBotProfileStatus,
  removeBotImConnection,
} from './botImConnectionRuntime';
import {
  cancelFeishuConnectionRegistration,
  startFeishuConnectionRegistration,
} from './botImFeishuRegistration';

const log = createLogger('im:bot-connections');

let registered = false;

export function registerBotImFeishuRegistrationIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('botImConnection:feishu-registration-begin', (event, payload) => {
    assertTrustedAppRendererEvent(event);
    return beginBotImFeishuRegistration(payload);
  });
  ipcMain.handle('botImConnection:feishu-registration-cancel', (event) => {
    assertTrustedAppRendererEvent(event);
    cancelFeishuConnectionRegistration();
    return { ok: true };
  });
}

async function beginBotImFeishuRegistration(
  payload: unknown,
): Promise<BotImFeishuRegistrationBeginResult> {
  const p = payload as { botId?: unknown; service?: unknown } | null;
  const botId = typeof p?.botId === 'string' ? p.botId.trim() : '';
  if (!botId) throwIpcError('INVALID_PARAMS', 'botId is required');
  if (p?.service !== 'feishu' && p?.service !== 'lark') {
    throwIpcError('INVALID_PARAMS', 'service is required');
  }
  const service = p.service;

  const status = await readBotProfileStatus(botId);
  if (status === null) throwIpcError('NOT_FOUND', 'BOT_NOT_FOUND');
  if (status !== 'active') throwIpcError('PRECONDITION_FAILED', 'BOT_INACTIVE: ' + status);

  const ownerKey = activeOwnerScopeKey();
  const stillOwner = () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === ownerKey;

  return startFeishuConnectionRegistration({
    service,
    request: (brand) => requestFeishuAppRegistration(postForm, brand),
    poll: (brand, deviceCode, interval) =>
      pollFeishuAppRegistration(postForm, brand, deviceCode, interval),
    isCurrent: stillOwner,
    onStatus: broadcastStatus,
    commit: async (success, isCurrent) => {
      const { connection } = await addBotImConnection(
        {
          botId,
          channel: 'feishu',
          appId: success.clientId,
          appSecret: success.clientSecret,
          service: success.tenantBrand ?? service,
        },
        {
          ...(success.ownerOpenId ? { ownerUserId: success.ownerOpenId } : {}),
          shouldProceed: isCurrent,
        },
      );
      if (isCurrent()) return;
      // 取消发生在建连过程中: 不能留下这条已经生效的连接。
      await removeBotImConnection(connection.id).catch((error: unknown) => {
        log.warn('rollback cancelled bot connection failed: ' + String(error));
      });
      throw new Error('CANCELLED');
    },
  });
}

function broadcastStatus(status: BotImFeishuRegistrationStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('botImConnection:feishu-registration-status', status);
    }
  }
}
