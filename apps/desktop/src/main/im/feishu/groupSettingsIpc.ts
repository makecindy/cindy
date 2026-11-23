/**
 * 设置页「群聊」的 IPC。只接受可信主界面：保存会改变之后群任务的项目、模型与权限，
 * 不进 device-link 远程白名单（与「新对话配置」一致，手机与远程控制不能改）。
 */

import { ipcMain } from 'electron';

import {
  isFeishuGroupChatId,
  parseFeishuGroupSettingsPatch,
  type FeishuGroupSettingsList,
  type FeishuGroupSettingsPatch,
  type FeishuGroupSettingsView,
} from '../../../shared/feishuGroupSettings.js';
import { activeOwnerScopeKey } from '../../appSessionState.js';
import { createLogger } from '../../logger.js';
import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { feishuIm } from '../host.js';
import { assertOwnerScopeSettledForWrite } from '../ownerScopedStorage.js';
import {
  FeishuGroupSettingsError,
  listFeishuGroupSettingsForUi,
  saveFeishuGroupSettings,
} from './groupSettingsService.js';

const log = createLogger('im/feishu/group-settings-ipc');
const MAX_NAME_LENGTH = 200;

function parseName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', 'group name must be a string');
  return value.trim().slice(0, MAX_NAME_LENGTH) || null;
}

export function registerFeishuGroupSettingsIpc(): void {
  ipcMain.handle(
    MAKER_INVOKE.FEISHU_GROUP_SETTINGS_LIST,
    async (event, rawRefresh: unknown): Promise<FeishuGroupSettingsList> => {
      assertTrustedAppRendererEvent(event);
      // 只有用户点「刷新」才跳过 30 秒内的群名单；其余值一律按普通读取。
      return listFeishuGroupSettingsForUi(feishuIm, { refresh: rawRefresh === true });
    },
  );
  ipcMain.handle(
    MAKER_INVOKE.FEISHU_GROUP_SETTINGS_SET,
    async (event, rawChatId: unknown, rawPatch: unknown, rawName: unknown): Promise<FeishuGroupSettingsView> => {
      assertTrustedAppRendererEvent(event);
      // 写入前复核账号没换(同「新对话配置」): 读项目清单跨 await, 期间切号不能写进新账号。
      const ownerScopeKey = activeOwnerScopeKey();
      if (!isFeishuGroupChatId(rawChatId)) throwIpcError('INVALID_PARAMS', 'invalid group id');
      let patch: FeishuGroupSettingsPatch;
      try {
        patch = parseFeishuGroupSettingsPatch(rawPatch);
      } catch {
        throwIpcError('INVALID_PARAMS', 'invalid group settings');
      }
      const name = parseName(rawName);
      try {
        return await saveFeishuGroupSettings(feishuIm, rawChatId, patch, name, () =>
          assertOwnerScopeSettledForWrite(ownerScopeKey),
        );
      } catch (err) {
        if (err instanceof FeishuGroupSettingsError) {
          throwIpcError(err.reason === 'not-configured' ? 'PRECONDITION_FAILED' : 'NOT_FOUND', err.message);
        }
        // 文件错误里带本机路径, 只记日志, 不回给界面。
        log.warn(`feishu group settings save failed: ${err instanceof Error ? err.message : String(err)}`);
        throwIpcError('INTERNAL', 'group settings not saved');
      }
    },
  );
}
