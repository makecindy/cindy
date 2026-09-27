/** Owner-scoped, non-secret settings for the Feishu/Lark channel. */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { normalizeWorkingDirForStorage } from '../../../shared/workingDir';
import { createLogger, maskPath } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
const log = createLogger('im/feishu/channel-settings');
const SETTINGS_VERSION = 1;
export interface FeishuChannelSettingsState {
  version: typeof SETTINGS_VERSION;
  workingDir: string | null;
  workingDirAvailable: boolean;
}
const DEFAULTS = { version: SETTINGS_VERSION, workingDir: null } as const;
function settingsFilePath(rootPath?: string): string {
  return rootPath
    ? path.join(rootPath, 'feishu-channel.json')
    : ownerScopedImUserDataPath('feishu-channel.json');
}

export function readFeishuChannelSettings(rootPath?: string): FeishuChannelSettingsState {
  const file = settingsFilePath(rootPath);
  try {
    if (!fs.existsSync(file)) return { ...DEFAULTS, workingDirAvailable: true };
    const workingDir = normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
    return {
      version: SETTINGS_VERSION,
      workingDir,
      workingDirAvailable: workingDir === null || isAccessibleDirectory(workingDir),
    };
  } catch (error) {
    log.warn('failed to read Feishu channel settings; using defaults', {
      path: maskPath(file),
      errorCode: feishuChannelSettingsErrorCode(error),
    });
    return { ...DEFAULTS, workingDirAvailable: true };
  }
}

export function writeFeishuWorkingDir(
  selectedPath: string,
  rootPath?: string,
): FeishuChannelSettingsState {
  const workingDir = normalizeSelectedDirectory(selectedPath);
  const file = settingsFilePath(rootPath);
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ version: SETTINGS_VERSION, workingDir }, null, 2)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
      },
    );
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return readFeishuChannelSettings(rootPath);
}

export function resetFeishuWorkingDir(rootPath?: string): FeishuChannelSettingsState {
  fs.rmSync(settingsFilePath(rootPath), { force: true });
  return { ...DEFAULTS, workingDirAvailable: true };
}

export function resolveFeishuWorkingDir(fallback: () => string, rootPath?: string): string {
  const configured = readFeishuChannelSettings(rootPath);
  return configured.workingDir && configured.workingDirAvailable
    ? configured.workingDir
    : fallback();
}

function normalizeSelectedDirectory(selectedPath: string): string {
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) {
    throw new Error('FEISHU_WORKING_DIR_INVALID');
  }
  const realPath = fs.realpathSync.native(selectedPath);
  if (!fs.statSync(realPath).isDirectory()) throw new Error('FEISHU_WORKING_DIR_NOT_DIRECTORY');
  const normalized = normalizeWorkingDirForStorage(realPath);
  if (!normalized) throw new Error('FEISHU_WORKING_DIR_INVALID');
  return normalized;
}

function normalizeSettings(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>).workingDir;
  return typeof value === 'string' && path.isAbsolute(value)
    ? normalizeWorkingDirForStorage(value)
    : null;
}

function isAccessibleDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function feishuChannelSettingsErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? 'UNKNOWN')
    : 'UNKNOWN';
}
