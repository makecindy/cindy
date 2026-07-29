/**
 * Owner-scoped, non-secret settings for the personal WeChat channel.
 *
 * A working directory can only enter this store after the user selected it in
 * a native directory picker. Missing/inaccessible saved directories fall back
 * to the channel-managed directory instead of breaking inbound messages.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';
import { createLogger, maskPath } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';

const log = createLogger('im/wechat/channel-settings');
const SETTINGS_VERSION = 1;

export interface WechatChannelSettings {
  version: typeof SETTINGS_VERSION;
  workingDir: string | null;
}

export interface WechatChannelSettingsState extends WechatChannelSettings {
  workingDirAvailable: boolean;
}

const DEFAULTS: WechatChannelSettings = {
  version: SETTINGS_VERSION,
  workingDir: null,
};

function settingsFilePath(rootPath?: string): string {
  return rootPath
    ? path.join(rootPath, 'wechat-channel.json')
    : ownerScopedImUserDataPath('wechat-channel.json');
}

export function readWechatChannelSettings(rootPath?: string): WechatChannelSettingsState {
  const file = settingsFilePath(rootPath);
  try {
    if (!fs.existsSync(file)) return { ...DEFAULTS, workingDirAvailable: true };
    const normalized = normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
    return {
      ...normalized,
      workingDirAvailable:
        normalized.workingDir === null || isAccessibleDirectory(normalized.workingDir),
    };
  } catch (error) {
    log.warn('failed to read WeChat channel settings; using defaults', {
      path: maskPath(file),
      errorCode: nodeErrorCode(error),
    });
    return { ...DEFAULTS, workingDirAvailable: true };
  }
}

export function writeWechatWorkingDir(
  selectedPath: string,
  rootPath?: string,
): WechatChannelSettingsState {
  const workingDir = normalizeSelectedDirectory(selectedPath);
  writeSettings({ ...DEFAULTS, workingDir }, rootPath);
  return readWechatChannelSettings(rootPath);
}

export function resetWechatWorkingDir(rootPath?: string): WechatChannelSettingsState {
  const file = settingsFilePath(rootPath);
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    log.warn('failed to reset WeChat channel settings', {
      path: maskPath(file),
      errorCode: nodeErrorCode(error),
    });
    throw error;
  }
  return { ...DEFAULTS, workingDirAvailable: true };
}

export function resolveWechatWorkingDir(botId: string, rootPath?: string): string {
  const configured = readWechatChannelSettings(rootPath);
  if (configured.workingDir && configured.workingDirAvailable) return configured.workingDir;

  const managedDirName = managedWorkingDirName(botId);
  const dir = rootPath
    ? path.join(rootPath, 'im-working-dir', managedDirName)
    : ownerScopedImUserDataPath('im-working-dir', managedDirName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function managedWorkingDirName(botId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return `wechat-${botId}`;
  const digest = createHash('sha256').update(botId).digest('hex').slice(0, 24);
  return `wechat-external-${digest}`;
}

function normalizeSelectedDirectory(selectedPath: string): string {
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) {
    throw new Error('WECHAT_WORKING_DIR_INVALID');
  }
  const realPath = fs.realpathSync.native(selectedPath);
  if (!fs.statSync(realPath).isDirectory()) throw new Error('WECHAT_WORKING_DIR_NOT_DIRECTORY');
  const normalized = normalizeWorkingDirForStorage(realPath);
  if (!normalized) throw new Error('WECHAT_WORKING_DIR_INVALID');
  return normalized;
}

function normalizeSettings(raw: unknown): WechatChannelSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS };
  const input = raw as Record<string, unknown>;
  const workingDir =
    typeof input.workingDir === 'string' && path.isAbsolute(input.workingDir)
      ? normalizeWorkingDirForStorage(input.workingDir)
      : null;
  return {
    version: SETTINGS_VERSION,
    workingDir,
  };
}

function isAccessibleDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function nodeErrorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}

function writeSettings(settings: WechatChannelSettings, rootPath?: string): void {
  const file = settingsFilePath(rootPath);
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export const __testing = {
  managedWorkingDirName,
  normalizeSettings,
  normalizeSelectedDirectory,
};
