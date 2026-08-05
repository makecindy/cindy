/**
 * contacts-settings-store —— 智能通讯录开关的 main 端持久化 source of truth。
 *
 * 落盘文件: <userData>/contacts-settings.json
 *   { "enabled": false }
 *
 * 默认 false —— 通讯录是个人数据采集类功能, 必须用户主动开启(开 = 允许 agent
 * 自动采集人物信息, 单开关语义, 无独立"自动采集"子开关)。开关只 gate agent 侧
 * (cindy_contacts MCP server 注册 + 工具级拦截); 设置页管理 UI 不受 gate —
 * 关着也能浏览/清理已有数据。
 *
 * 形态与 chat-embedding-settings-store 完全一致(createOverrideSettingsFile:
 * 同步 R/W + .tmp 原子写 + 内存 cache + 坏文件回退默认值)。
 */

import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('contacts-settings-store');

export interface ContactsSettings {
  enabled: boolean;
}

const DEFAULTS: ContactsSettings = {
  enabled: false,
};

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? ownerScopedUserDataPath(), 'contacts-settings.json');
}

function normalize(raw: unknown): ContactsSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<ContactsSettings>>>();

function currentStore() {
  const ownerRoot = getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null;
  const key = ownerRoot ?? '<no-session>';
  let store = stores.get(key);
  if (!store) {
    store = createOverrideSettingsFile<ContactsSettings>({
      filePath: () => settingsFilePath(ownerRoot ?? undefined),
      defaults: DEFAULTS,
      normalize,
      log,
      label: 'contacts',
    });
    stores.set(key, store);
  }
  return store;
}

/** 同步读 —— 第一次从磁盘, 后续走内存 cache。 */
export function readContactsSettings(): ContactsSettings {
  return currentStore().read();
}

export function readContactsSettingsState(): OverrideSettingsState<ContactsSettings> {
  return currentStore().readState();
}

/** 同步写 enabled + 更新 cache; 失败抛错让 IPC handler 反馈给 UI。 */
export function writeContactsEnabled(enabled: boolean): void {
  currentStore().writePatch({ enabled });
  log.info('contacts setting written', { enabled });
}

export function resetContactsSettings(): ContactsSettings {
  return currentStore().reset();
}
