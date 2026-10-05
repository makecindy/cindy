/**
 * Codex 重置自动使用的本地存储，按 Cindy 账号隔离：
 *
 *   <userData>/codex-reset-credit-auto-use/<owner>/settings.json
 *     只记录用户显式拨过的开关（providerId → boolean）；没记录的账号跟随默认值（关）。
 *     「恢复默认」删除该账号的记录。
 *   <userData>/codex-reset-credit-auto-use/<owner>/weekly-resets.json
 *     周配额用完时自动用掉的那一次：每个 ChatGPT 工作区一个周窗口最多一次，重启后不会
 *     再用第二次。工作区 id 只存哈希；周窗口结束后的记录在下次写入时清掉。
 *
 * <owner> 与 codex-accounts/ 用同一个 owner 目录名（owner id 的 sha256）。没有登录的
 * Cindy 账号时一律视为关闭，写入拒绝。
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { CodexResetCreditAutoUseState } from '../../shared/codexResetCreditAutoUse.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { codexAccountOwnerDir } from '../maker-host/codex-account-auth.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import type { WeeklyResetRecord } from './codexResetCreditAutoUse.js';

const log = desktopMakerLogger.child('codex-reset-credit-auto-use-store');

const STORE_DIR = 'codex-reset-credit-auto-use';
const PROVIDER_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;
const MAX_SETTINGS_BYTES = 64 * 1024;

/** 默认关闭：用掉重置不可撤回，必须由用户逐个账号明确开启。 */
export const CODEX_RESET_CREDIT_AUTO_USE_DEFAULT = false;

interface Settings {
  providers: Record<string, boolean>;
}

function ownerDir(): string | null {
  return codexAccountOwnerDir();
}

function storeDir(owner: string): string {
  return path.join(app.getPath('userData'), STORE_DIR, owner);
}

function normalizeSettings(raw: unknown): Settings {
  const providers: Record<string, boolean> = {};
  const source = (raw as { providers?: unknown } | null)?.providers;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [providerId, enabled] of Object.entries(source)) {
      if (PROVIDER_ID_PATTERN.test(providerId) && typeof enabled === 'boolean') {
        providers[providerId] = enabled;
      }
    }
  }
  return { providers };
}

const settingsFile = createOverrideSettingsFile<Settings>({
  filePath: () => path.join(storeDir(ownerDir() ?? 'none'), 'settings.json'),
  defaults: { providers: {} },
  normalize: normalizeSettings,
  mergeOverrides: ({ next }) =>
    Object.keys(next.providers).length > 0 ? { providers: next.providers } : {},
  log,
  label: 'codex-reset-credit-auto-use',
  scopeKey: activeOwnerScopeKey,
  maxBytes: MAX_SETTINGS_BYTES,
  preserveUnreadableFile: true,
});

function requireProviderId(providerId: string): void {
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error('Invalid OpenAI account provider id');
}

function readProviders(): Record<string, boolean> {
  if (!ownerDir()) return {};
  try {
    settingsFile.invalidateIfChanged();
    return settingsFile.read().providers;
  } catch (error) {
    log.warn('codex reset auto-use settings unreadable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export function readCodexResetCreditAutoUseState(providerId: string): CodexResetCreditAutoUseState {
  requireProviderId(providerId);
  const explicit = readProviders()[providerId];
  return {
    providerId,
    enabled: explicit ?? CODEX_RESET_CREDIT_AUTO_USE_DEFAULT,
    isCustomized: explicit !== undefined,
    defaultEnabled: CODEX_RESET_CREDIT_AUTO_USE_DEFAULT,
  };
}

export function isCodexResetCreditAutoUseEnabled(providerId: string): boolean {
  return PROVIDER_ID_PATTERN.test(providerId) && readCodexResetCreditAutoUseState(providerId).enabled;
}

/** 显式开启的账号；默认关闭，所以有效开启的只有它们。 */
export function listCodexResetCreditAutoUseProviderIds(): string[] {
  const providers = readProviders();
  return Object.keys(providers).filter((providerId) => providers[providerId]);
}

async function updateProviders(
  update: (providers: Record<string, boolean>) => void,
): Promise<void> {
  if (!ownerDir()) throw new Error('A Cindy account is required');
  await settingsFile.updateAtomic((current) => {
    const providers = { ...current.value.providers };
    update(providers);
    return { providers };
  });
}

export async function writeCodexResetCreditAutoUse(
  providerId: string,
  enabled: boolean,
): Promise<CodexResetCreditAutoUseState> {
  requireProviderId(providerId);
  await updateProviders((providers) => {
    providers[providerId] = enabled;
  });
  log.info('codex reset auto-use setting written', { providerId, enabled });
  return readCodexResetCreditAutoUseState(providerId);
}

export async function resetCodexResetCreditAutoUse(
  providerId: string,
): Promise<CodexResetCreditAutoUseState> {
  requireProviderId(providerId);
  await updateProviders((providers) => {
    delete providers[providerId];
  });
  log.info('codex reset auto-use setting reset', { providerId });
  return readCodexResetCreditAutoUseState(providerId);
}

// ── 周配额用完时自动用过的记录 ─────────────────────────────────────────────

type WeeklyResets = Record<string, WeeklyResetRecord>;

function weeklyResetsPath(owner: string): string {
  return path.join(storeDir(owner), 'weekly-resets.json');
}

function weeklyRecordKey(providerId: string, accountKey: string): string {
  const account = createHash('sha256').update(`codex-reset:${accountKey}`).digest('hex').slice(0, 16);
  return `${providerId}:${account}`;
}

function parseWeeklyResets(text: string | null): WeeklyResets {
  if (!text) return {};
  const raw = JSON.parse(text) as unknown;
  const out: WeeklyResets = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const record = value as { untilMs?: unknown; atMs?: unknown } | null;
    if (
      record &&
      typeof record.untilMs === 'number' &&
      Number.isFinite(record.untilMs) &&
      typeof record.atMs === 'number' &&
      Number.isFinite(record.atMs)
    ) {
      out[key] = { untilMs: record.untilMs, atMs: record.atMs };
    }
  }
  return out;
}

function readWeeklyResets(owner: string): WeeklyResets {
  try {
    return parseWeeklyResets(readAtomicFileSync(weeklyResetsPath(owner)));
  } catch (error) {
    log.warn('codex weekly reset records unreadable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export function readCodexWeeklyReset(providerId: string, accountKey: string): WeeklyResetRecord | null {
  const owner = ownerDir();
  if (!owner) return null;
  return readWeeklyResets(owner)[weeklyRecordKey(providerId, accountKey)] ?? null;
}

export function writeCodexWeeklyReset(
  providerId: string,
  accountKey: string,
  record: WeeklyResetRecord,
): void {
  const owner = ownerDir();
  if (!owner) return;
  const records = readWeeklyResets(owner);
  for (const [key, existing] of Object.entries(records)) {
    if (existing.untilMs <= record.atMs) delete records[key];
  }
  records[weeklyRecordKey(providerId, accountKey)] = record;
  try {
    atomicWriteFileSync(weeklyResetsPath(owner), `${JSON.stringify(records, null, 2)}\n`);
  } catch (error) {
    log.warn('codex weekly reset record not written', {
      providerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
