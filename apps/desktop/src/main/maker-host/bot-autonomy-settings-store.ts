/**
 * 「自动跟进所有任务」（总调度伙伴）账号级设置。
 *
 * 配置层级：常规设置（伙伴设置页开关），账号内唯一。按 configuration-and-overrides：
 * - 默认值不落盘：未自定义时关闭，显式选择过的用户保留原选择；
 * - 只存 override：`schedulerBotId` 为字符串 = 交给该伙伴，为 null = 主人关掉了总调度；
 * - 恢复默认 = 删除 override 文件，重新跟随派生默认。
 *
 * 文件：<owner userData>/bot-autonomy-settings.json，只有 `{ "schedulerBotId": ... }` 一个键。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import type { BotAutonomySettings } from '../../shared/botAutonomy.js';
import { activeOwnerScopeKey, getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile, type OverrideSettingsState } from './override-settings-file.js';

const log = desktopMakerLogger.child('bot-autonomy-settings-store');

/** 伙伴 id 的长度上限，与伙伴 IPC 校验一致。 */
const MAX_BOT_ID_LENGTH = 128;
const MAX_FILE_BYTES = 4096;
const FILE_NAME = 'bot-autonomy-settings.json';

function normalize(raw: unknown): BotAutonomySettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).schedulerBotId
    : null;
  return {
    schedulerBotId: typeof value === 'string' && value.trim() && value.length <= MAX_BOT_ID_LENGTH ? value : null,
  };
}

const stores = new Map<string, ReturnType<typeof createOverrideSettingsFile<BotAutonomySettings>>>();

function ownerRootFor(rootPath?: string): string | null {
  return rootPath ?? (getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath() : null);
}

function settingsFilePath(ownerRoot: string | null): string {
  return path.join(ownerRoot ?? app.getPath('userData'), FILE_NAME);
}

function currentStore(rootPath?: string) {
  const ownerRoot = ownerRootFor(rootPath);
  const key = ownerRoot ?? '<global>';
  let store = stores.get(key);
  if (!store) {
    store = createOverrideSettingsFile<BotAutonomySettings>({
      filePath: () => settingsFilePath(ownerRoot),
      // 默认关闭；null override 另表示用户明确拒绝过，不再展示首次邀请。
      defaults: { schedulerBotId: null },
      normalize,
      log,
      label: 'bot-autonomy',
      scopeKey: rootPath ? () => `root:${rootPath}` : activeOwnerScopeKey,
      maxBytes: MAX_FILE_BYTES,
      preserveUnreadableFile: true,
    });
    stores.set(key, store);
  }
  return store;
}

export interface BotAutonomySettingsOverride {
  /** 主人是否显式选过（含显式关掉）。 */
  customized: boolean;
  schedulerBotId: string | null;
}

/**
 * 文件存在却读不出（坏 JSON、超限、根不是对象、无权限）。只在通用层报「未自定义」时复查：
 * 坏文件视为已经做过选择，避免重复邀请；有效跟进者仍失败关闭。
 */
function existingFileUnreadable(file: string): boolean {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT';
  }
  try {
    if (size > MAX_FILE_BYTES) return true;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return !parsed || typeof parsed !== 'object' || Array.isArray(parsed);
  } catch {
    return true;
  }
}

let warnedUnreadableFile: string | null = null;

/** 只读 override；有效值（含默认派生）由观察层结合伙伴列表计算。 */
export function readBotAutonomySettingsOverride(options?: { rootPath?: string }): BotAutonomySettingsOverride {
  const store = currentStore(options?.rootPath);
  // 支持直接改文件即生效（Agent 按主人要求改本地配置）。
  store.invalidateIfChanged();
  const state: OverrideSettingsState<BotAutonomySettings> = store.readState();
  const customized = state.customizedKeys.includes('schedulerBotId');
  if (!customized) {
    const file = settingsFilePath(ownerRootFor(options?.rootPath));
    // 失败关闭：override 文件在但读不出 → 当作主人关掉了总调度，也不展示首次邀请。
    // 文件不存在才是「未自定义」。主人「恢复默认」会删掉坏文件。
    if (existingFileUnreadable(file)) {
      if (warnedUnreadableFile !== file) {
        warnedUnreadableFile = file;
        log.warn('bot autonomy settings unreadable; scheduler treated as off until reset');
      }
      return { customized: true, schedulerBotId: null };
    }
  }
  if (warnedUnreadableFile !== null) warnedUnreadableFile = null;
  return { customized, schedulerBotId: state.value.schedulerBotId };
}

/** 写 override：null 也落盘（表示主人关掉了总调度），与「未自定义」区分。 */
export async function writeBotAutonomySchedulerBotId(
  schedulerBotId: string | null,
  options?: { rootPath?: string },
): Promise<BotAutonomySettingsOverride> {
  const value = normalize({ schedulerBotId }).schedulerBotId;
  if (schedulerBotId !== null && value === null) throw new Error('Invalid teammate id');
  await currentStore(options?.rootPath).writePatchAtomic({ schedulerBotId: value }, { preserveDefaults: true });
  log.info('bot autonomy scheduler setting written', { customized: true, enabled: value !== null });
  return readBotAutonomySettingsOverride(options);
}

/** 恢复默认：删除 override，重新跟随派生默认。 */
export async function resetBotAutonomySettings(options?: { rootPath?: string }): Promise<BotAutonomySettingsOverride> {
  await currentStore(options?.rootPath).resetAtomic();
  return readBotAutonomySettingsOverride(options);
}
