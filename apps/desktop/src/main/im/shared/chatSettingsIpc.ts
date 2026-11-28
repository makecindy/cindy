/**
 * 设置页「群聊」总表的 IPC。只接受可信主界面：保存会改变之后群任务的项目、模型、权限与谁能提问，
 * 不进 device-link 远程白名单（与「新对话配置」一致，手机与远程控制不能改）。
 */

import { ipcMain } from 'electron';

import {
  isImChatId,
  isImChatSettingsChannel,
  parseImChatSettingsPatch,
  type ImChatSettingsChannel,
  type ImChatSettingsList,
  type ImChatSettingsPatch,
  type ImChatSettingsView,
} from '../../../shared/imChatSettings.js';
import { activeOwnerScopeKey } from '../../appSessionState.js';
import { createLogger } from '../../logger.js';
import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { assertOwnerScopeSettledForWrite } from '../ownerScopedStorage.js';
import {
  ImChatSettingsError,
  listImChatSettingsForUi,
  resumeImChatMembers,
  saveImChatSettings,
} from './chatSettingsService.js';

const log = createLogger('im/chat-settings-ipc');
const MAX_NAME_LENGTH = 200;

function parseName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', 'chat name must be a string');
  return value.trim().slice(0, MAX_NAME_LENGTH) || null;
}

function parseChannel(value: unknown): ImChatSettingsChannel {
  if (!isImChatSettingsChannel(value)) throwIpcError('INVALID_PARAMS', 'invalid channel');
  return value;
}

function parseChatId(channel: ImChatSettingsChannel, value: unknown): string {
  if (!isImChatId(channel, value)) throwIpcError('INVALID_PARAMS', 'invalid chat id');
  return value;
}

function rethrow(err: unknown): never {
  if (err instanceof ImChatSettingsError) {
    throwIpcError(err.reason === 'not-configured' ? 'PRECONDITION_FAILED' : 'NOT_FOUND', err.message);
  }
  // 文件错误里带本机路径, 只记日志, 不回给界面。
  log.warn(`chat settings save failed: ${err instanceof Error ? err.message : String(err)}`);
  throwIpcError('INTERNAL', 'chat settings not saved');
}

export function registerImChatSettingsIpc(): void {
  ipcMain.handle(
    MAKER_INVOKE.IM_CHAT_SETTINGS_LIST,
    async (event, rawChannel: unknown, rawOptions: unknown): Promise<ImChatSettingsList> => {
      assertTrustedAppRendererEvent(event);
      const channel = parseChannel(rawChannel);
      // 只有用户点「刷新」才跳过 30 秒内的群名单、只有收起时的概要才跳过项目模型。
      const options = rawOptions !== null && typeof rawOptions === 'object' ? (rawOptions as Record<string, unknown>) : {};
      return listImChatSettingsForUi(channel, { refresh: options.refresh === true, summary: options.summary === true });
    },
  );
  ipcMain.handle(
    MAKER_INVOKE.IM_CHAT_SETTINGS_SET,
    async (event, rawChannel: unknown, rawChatId: unknown, rawPatch: unknown, rawName: unknown): Promise<ImChatSettingsView> => {
      assertTrustedAppRendererEvent(event);
      // 写入前复核账号没换(同「新对话配置」): 读项目清单跨 await, 期间切号不能写进新账号。
      const ownerScopeKey = activeOwnerScopeKey();
      const channel = parseChannel(rawChannel);
      const chatId = parseChatId(channel, rawChatId);
      let patch: ImChatSettingsPatch;
      try {
        patch = parseImChatSettingsPatch(rawPatch);
      } catch {
        throwIpcError('INVALID_PARAMS', 'invalid chat settings');
      }
      const name = parseName(rawName);
      try {
        return await saveImChatSettings(channel, chatId, patch, name, () => assertOwnerScopeSettledForWrite(ownerScopeKey));
      } catch (err) {
        rethrow(err);
      }
    },
  );
  ipcMain.handle(
    MAKER_INVOKE.IM_CHAT_SETTINGS_RESUME_MEMBERS,
    async (event, rawChannel: unknown, rawChatId: unknown, rawName: unknown): Promise<ImChatSettingsView> => {
      assertTrustedAppRendererEvent(event);
      const ownerScopeKey = activeOwnerScopeKey();
      const channel = parseChannel(rawChannel);
      const chatId = parseChatId(channel, rawChatId);
      const name = parseName(rawName);
      try {
        return await resumeImChatMembers(channel, chatId, name, () => assertOwnerScopeSettledForWrite(ownerScopeKey));
      } catch (err) {
        rethrow(err);
      }
    },
  );
}
