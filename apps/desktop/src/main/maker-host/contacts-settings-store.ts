/**
 * contacts-settings-store —— 智能通讯录开关的 main 端持久化 source of truth。
 *
 * 落盘文件: <userData>/contacts-settings.json
 *   { "enabled": false, "deviceSyncEnabled": false }
 *
 * 默认 false —— 通讯录是个人数据采集类功能, 必须用户主动开启(开 = 允许 agent
 * 自动采集人物信息, 单开关语义, 无独立"自动采集"子开关)。开关只 gate agent 侧
 * (cindy_contacts MCP server 注册 + 工具级拦截); 设置页管理 UI 不受 gate —
 * 关着也能浏览/清理已有数据。
 *
 * 形态基于 createOverrideSettingsFile：同步读 + 跨进程锁内原子 patch + 内存 cache
 * + 坏文件回退默认值。共享 userData 的多个实例修改不同开关时不会互相覆盖。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

const log = desktopMakerLogger.child('contacts-settings-store');
const DEVICE_SYNC_INTENT_FILE_NAME = 'contacts-device-sync-setting-intent.v1.json';

export interface ContactsSettings {
  enabled: boolean;
  /** 在本账号的 Desktop 设备之间自动同步；与 agent 是否可访问通讯录相互独立。 */
  deviceSyncEnabled: boolean;
}

const DEFAULTS: ContactsSettings = {
  enabled: false,
  deviceSyncEnabled: false,
};

function settingsFilePath(rootPath?: string): string {
  return path.join(rootPath ?? ownerScopedUserDataPath(), 'contacts-settings.json');
}

function deviceSyncIntentFilePath(): string {
  return ownerScopedUserDataPath(DEVICE_SYNC_INTENT_FILE_NAME);
}

function normalize(raw: unknown): ContactsSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
    deviceSyncEnabled:
      typeof r.deviceSyncEnabled === 'boolean' ? r.deviceSyncEnabled : DEFAULTS.deviceSyncEnabled,
  };
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<ContactsSettings>>>();
const settingsWriteChains = new Map<string, Promise<unknown>>();

/** 捕获调用时的 owner store，并让同进程写入保持用户操作顺序。 */
function enqueueSettingsWrite<T>(scopeKey: string, task: () => Promise<T>): Promise<T> {
  const previous = settingsWriteChains.get(scopeKey) ?? Promise.resolve();
  const run = () => {
    if (activeOwnerScopeKey() !== scopeKey) {
      throw new Error('contacts settings scope changed before queued write');
    }
    return task();
  };
  const next = previous.then(run, run);
  settingsWriteChains.set(
    scopeKey,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export interface ContactsDeviceSyncSettingIntent {
  token: string;
  enabled: boolean;
}

/** 跨进程可见的开关意图；长耗时 enable 在提交前用 token 判断是否已被后发操作取代。 */
export async function writeContactsDeviceSyncSettingIntent(
  enabled: boolean,
): Promise<ContactsDeviceSyncSettingIntent> {
  const file = deviceSyncIntentFilePath();
  const scopeKey = activeOwnerScopeKey();
  const intent = { token: randomUUID(), enabled };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await withCrossProcessLock(
    `${file}.lock`,
    { label: 'contacts-device-sync-intent', waitMs: 12_000 },
    async (status) => {
      if (!status.held) throw new Error(`contacts device sync intent lock ${status.reason}`);
      if (activeOwnerScopeKey() !== scopeKey || deviceSyncIntentFilePath() !== file) {
        throw new Error('contacts device sync intent scope changed while waiting');
      }
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(temp, JSON.stringify(intent), { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(temp, file);
      } finally {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
      }
    },
  );
  return intent;
}

/**
 * 持 intent 锁复核 token 后再写 durable setting。新 intent 无法插进“复核→落盘”窗口，
 * 因而多个实例的相反操作会按这把锁的提交顺序收敛。
 */
export async function commitContactsDeviceSyncSettingIntent(
  intent: ContactsDeviceSyncSettingIntent,
): Promise<boolean> {
  const file = deviceSyncIntentFilePath();
  const scopeKey = activeOwnerScopeKey();
  const store = currentStore();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  return withCrossProcessLock(
    `${file}.lock`,
    { label: 'contacts-device-sync-intent', waitMs: 12_000 },
    async (status) => {
      if (!status.held) throw new Error(`contacts device sync intent lock ${status.reason}`);
      if (activeOwnerScopeKey() !== scopeKey || deviceSyncIntentFilePath() !== file) {
        throw new Error('contacts device sync intent scope changed while committing');
      }
      const currentIntent = readDeviceSyncIntentFile(file);
      if (!sameDeviceSyncIntent(currentIntent, intent)) {
        // 关闭是隐私方向：锁内确认没有一个可读的新意图时仍提交 durable false。
        // 开启必须精确匹配 token；读坏/缺失一律 fail closed。
        if (intent.enabled || currentIntent !== null) return false;
      }
      await enqueueSettingsWrite(scopeKey, () =>
        store.writePatchAtomic({ deviceSyncEnabled: intent.enabled }),
      );
      log.info('contacts device sync setting written', { deviceSyncEnabled: intent.enabled });
      return true;
    },
  );
}

export function readContactsDeviceSyncSettingIntent(): ContactsDeviceSyncSettingIntent | null {
  if (!getActiveAppSession().dataOwnerId) return null;
  return readDeviceSyncIntentFile(deviceSyncIntentFilePath());
}

function readDeviceSyncIntentFile(file: string): ContactsDeviceSyncSettingIntent | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const token = (value as { token?: unknown }).token;
    const enabled = (value as { enabled?: unknown }).enabled;
    return typeof token === 'string' &&
      token.length > 0 &&
      token.length <= 64 &&
      typeof enabled === 'boolean'
      ? { token, enabled }
      : null;
  } catch {
    return null;
  }
}

function sameDeviceSyncIntent(
  current: ContactsDeviceSyncSettingIntent | null,
  expected: ContactsDeviceSyncSettingIntent,
): boolean {
  return current?.token === expected.token && current.enabled === expected.enabled;
}

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
      scopeKey: activeOwnerScopeKey,
    });
    stores.set(key, store);
  }
  return store;
}

/** 同步读 —— 第一次从磁盘, 后续走内存 cache。 */
export function readContactsSettings(): ContactsSettings {
  const store = currentStore();
  store.invalidateIfChanged();
  return store.read();
}

export function readContactsSettingsState(): OverrideSettingsState<ContactsSettings> {
  const store = currentStore();
  store.invalidateIfChanged();
  return store.readState();
}

/** 同步写 enabled + 更新 cache; 失败抛错让 IPC handler 反馈给 UI。 */
export async function writeContactsEnabled(enabled: boolean): Promise<void> {
  const scopeKey = activeOwnerScopeKey();
  const store = currentStore();
  await enqueueSettingsWrite(scopeKey, async () => {
    await store.writePatchAtomic({ enabled });
    log.info('contacts setting written', { enabled });
  });
}

export async function writeContactsDeviceSyncEnabled(deviceSyncEnabled: boolean): Promise<void> {
  const scopeKey = activeOwnerScopeKey();
  const store = currentStore();
  await enqueueSettingsWrite(scopeKey, async () => {
    await store.writePatchAtomic({ deviceSyncEnabled });
    log.info('contacts device sync setting written', { deviceSyncEnabled });
  });
}

export function resetContactsSettings(): Promise<ContactsSettings> {
  const scopeKey = activeOwnerScopeKey();
  const store = currentStore();
  return enqueueSettingsWrite(scopeKey, () => store.resetAtomic());
}
