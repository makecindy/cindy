import path from 'node:path';

import type { DbSlimmingArchiveAge } from '../shared/localDbMaintenance';
import {
  createOverrideSettingsFile,
} from './maker-host/override-settings-file.js';

export const DB_AUTO_CLEANUP_SETTINGS_FILE_NAME = 'db-auto-cleanup-settings.json';

/**
 * Retention presets, in days. They are mapped onto the shared archive-age enum
 * because `DbSlimmingRequestRecord.archiveAgeMonths` is validated against
 * `DB_SLIMMING_ARCHIVE_AGE_OPTIONS`; persisting a raw `30` would make the marker
 * unreadable on the next startup. The purge cutoff always comes from
 * `retentionDays`; the enum value only labels the request and its result.
 */
export const DB_AUTO_CLEANUP_RETENTION_DAYS_OPTIONS = [7, 30, 90, 180] as const;
export type DbAutoCleanupRetentionDays = (typeof DB_AUTO_CLEANUP_RETENTION_DAYS_OPTIONS)[number];

const RETENTION_DAYS_TO_ARCHIVE_AGE: Record<DbAutoCleanupRetentionDays, DbSlimmingArchiveAge> = {
  7: '7-days',
  30: 1,
  90: 3,
  180: 6,
};

export const DB_AUTO_CLEANUP_DEFAULT_RETENTION_DAYS: DbAutoCleanupRetentionDays = 30;
export const DB_AUTO_CLEANUP_DEFAULT_MIN_MESSAGE_COUNT = 1_000;
export const DB_AUTO_CLEANUP_DEFAULT_MIN_ESTIMATED_MESSAGE_BYTES = 20 * 1024 * 1024;
export const DB_AUTO_CLEANUP_DEFAULT_COOLDOWN_DAYS = 7;
const MIN_MESSAGE_COUNT = 1;
const MAX_MESSAGE_COUNT = 10_000_000;
const MIN_ESTIMATED_MESSAGE_BYTES = 1;
const MAX_ESTIMATED_MESSAGE_BYTES = 64 * 1024 * 1024 * 1024;
const MIN_COOLDOWN_DAYS = 1;
const MAX_COOLDOWN_DAYS = 365;
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface DbAutoCleanupSettings {
  enabled: boolean;
  retentionDays: DbAutoCleanupRetentionDays;
  /** Debounce: purge only when the pending history is large enough to be worth a restart. */
  minMessageCount: number;
  minEstimatedMessageBytes: number;
  cooldownDays: number;
  /** Epoch ms of the last automatic run; `null` means it never ran. */
  lastAutoRunAt: number | null;
}

export interface DbAutoCleanupSettingsLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const DEFAULTS: DbAutoCleanupSettings = {
  // Shipped off. Automatic runs delete user history without a confirmation step,
  // so they must not start before the Settings card can turn them off again.
  // The card lands in the follow-up PR; that PR flips this to `true` together
  // with the visible switch. Until then the mechanism is reachable only by
  // writing this file, which is exactly the intended rollout order.
  enabled: false,
  retentionDays: DB_AUTO_CLEANUP_DEFAULT_RETENTION_DAYS,
  minMessageCount: DB_AUTO_CLEANUP_DEFAULT_MIN_MESSAGE_COUNT,
  minEstimatedMessageBytes: DB_AUTO_CLEANUP_DEFAULT_MIN_ESTIMATED_MESSAGE_BYTES,
  cooldownDays: DB_AUTO_CLEANUP_DEFAULT_COOLDOWN_DAYS,
  lastAutoRunAt: null,
};

/**
 * The cooldown timestamp lives here and not in `db-slimming-result.json`: the
 * renderer's `getLastResult()` reads that file and then deletes it, so a
 * cooldown derived from it would reset on every cold start.
 */
export function dbAutoCleanupArchiveAgeForRetentionDays(
  retentionDays: DbAutoCleanupRetentionDays,
): DbSlimmingArchiveAge {
  return RETENTION_DAYS_TO_ARCHIVE_AGE[retentionDays];
}

export function dbAutoCleanupRetentionCutoffMs(now: number, retentionDays: number): number {
  return now - retentionDays * 24 * 60 * 60 * 1000;
}

function isRetentionDays(value: unknown): value is DbAutoCleanupRetentionDays {
  return DB_AUTO_CLEANUP_RETENTION_DAYS_OPTIONS.includes(value as DbAutoCleanupRetentionDays);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function normalize(raw: unknown): DbAutoCleanupSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const value = raw as Record<string, unknown>;
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled,
    retentionDays: isRetentionDays(value.retentionDays)
      ? value.retentionDays
      : DEFAULTS.retentionDays,
    minMessageCount: isIntegerInRange(value.minMessageCount, MIN_MESSAGE_COUNT, MAX_MESSAGE_COUNT)
      ? value.minMessageCount
      : DEFAULTS.minMessageCount,
    minEstimatedMessageBytes: isFiniteInRange(
      value.minEstimatedMessageBytes,
      MIN_ESTIMATED_MESSAGE_BYTES,
      MAX_ESTIMATED_MESSAGE_BYTES,
    )
      ? value.minEstimatedMessageBytes
      : DEFAULTS.minEstimatedMessageBytes,
    cooldownDays: isIntegerInRange(value.cooldownDays, MIN_COOLDOWN_DAYS, MAX_COOLDOWN_DAYS)
      ? value.cooldownDays
      : DEFAULTS.cooldownDays,
    lastAutoRunAt: isFiniteInRange(value.lastAutoRunAt, 1, Number.MAX_SAFE_INTEGER)
      ? value.lastAutoRunAt
      : null,
  };
}

/**
 * The file is read at most twice per startup, so a fresh store per call is
 * cheaper than keeping a per-directory cache and it always sees a hand-edited
 * file. `userDataDir` is passed in (instead of reading `app.getPath`) so the
 * pre-open startup path stays free of Electron imports.
 */
function createStore(userDataDir: string, log: DbAutoCleanupSettingsLog) {
  return createOverrideSettingsFile<DbAutoCleanupSettings>({
    filePath: () => path.join(userDataDir, DB_AUTO_CLEANUP_SETTINGS_FILE_NAME),
    defaults: DEFAULTS,
    normalize,
    log,
    label: 'db-auto-cleanup',
    maxBytes: MAX_SETTINGS_BYTES,
    preserveUnreadableFile: true,
  });
}

export function readDbAutoCleanupSettings(
  userDataDir: string,
  log: DbAutoCleanupSettingsLog,
): DbAutoCleanupSettings {
  return createStore(userDataDir, log).read();
}

/**
 * Best-effort cooldown stamp. It is written synchronously on purpose: the caller
 * already holds this database's exclusive startup writer lease, nothing else
 * writes the file yet, and startup must not wait on a cross-process lock. Losing
 * the stamp only delays the next automatic run — the volume threshold and the
 * empty target set still keep it from repeating.
 */
export function recordDbAutoCleanupRun(
  userDataDir: string,
  at: number,
  log: DbAutoCleanupSettingsLog,
): void {
  try {
    createStore(userDataDir, log).writePatch({ lastAutoRunAt: at });
  } catch (error) {
    log.warn('database auto cleanup cooldown could not be recorded', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const __testing = {
  DEFAULTS,
  normalize,
  MIN_MESSAGE_COUNT,
  MAX_MESSAGE_COUNT,
  MIN_COOLDOWN_DAYS,
  MAX_COOLDOWN_DAYS,
};
