import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import {
  dbAutoCleanupArchiveAgeForRetentionDays,
  dbAutoCleanupRetentionCutoffMs,
  readDbAutoCleanupSettings,
  type DbAutoCleanupSettings,
  type DbAutoCleanupSettingsLog,
} from '../db-auto-cleanup-settings';
import { createBetterSqliteDatabase } from './betterSqliteFactory';
import {
  dbSlimmingRequiredFreeBytes,
  dbVolumeFreeBytes,
  estimateDbFilesBytes,
} from './dbSlimmingMaintenance';
import type { DbSlimmingRequestRecord } from './maintenanceStore';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `messages` columns that count towards the estimated history size. They are
 * intersected with the live table because this probe runs before migrations, on
 * whatever schema the previous version left behind.
 */
const MESSAGE_BYTE_COLUMNS = [
  'id',
  'client_id',
  'role',
  'content',
  'tool_use_id',
  'agent_meta',
  'agent_kind',
] as const;

/** What an automatic run would purge, measured on the live database. */
export interface DbAutoCleanupCandidate {
  deletedTaskCount: number;
  messageCount: number;
  estimatedMessageBytes: number;
  databaseBytes: number;
  /** Matches `assertMaintenanceSpace` for a backup on the database volume. */
  requiredFreeBytes: number;
  databaseVolumeFreeBytes: number | null;
}

export type DbAutoCleanupSkipReason =
  'disabled' | 'no-targets' | 'below-threshold' | 'cooldown' | 'insufficient-space';

export type DbAutoCleanupGateDecision =
  | { run: false; reason: DbAutoCleanupSkipReason }
  | { run: true; candidate: DbAutoCleanupCandidate };

export type DbAutoCleanupPreparation =
  | { run: false; reason: DbAutoCleanupSkipReason; request: null }
  | { run: true; candidate: DbAutoCleanupCandidate; request: DbSlimmingRequestRecord };

function isDbAutoCleanupInCooldown(settings: DbAutoCleanupSettings, now: number): boolean {
  if (settings.lastAutoRunAt === null) return false;
  // A clock that moved backwards also counts as "inside the cooldown".
  return now - settings.lastAutoRunAt < settings.cooldownDays * DAY_MS;
}

/**
 * Pure debounce decision. Every branch is a reason to keep the startup fast:
 * the purge itself copies and VACUUMs the whole database behind the splash.
 */
export function evaluateDbAutoCleanupGate(options: {
  settings: DbAutoCleanupSettings;
  candidate: DbAutoCleanupCandidate | null;
  now: number;
}): DbAutoCleanupGateDecision {
  const { settings, candidate, now } = options;
  if (!settings.enabled) return { run: false, reason: 'disabled' };
  if (!candidate || candidate.deletedTaskCount <= 0 || candidate.messageCount <= 0) {
    return { run: false, reason: 'no-targets' };
  }
  if (
    candidate.messageCount < settings.minMessageCount &&
    candidate.estimatedMessageBytes < settings.minEstimatedMessageBytes
  ) {
    return { run: false, reason: 'below-threshold' };
  }
  if (isDbAutoCleanupInCooldown(settings, now)) return { run: false, reason: 'cooldown' };
  if (
    candidate.databaseVolumeFreeBytes === null ||
    candidate.databaseVolumeFreeBytes < candidate.requiredFreeBytes
  ) {
    // Silent skip: a full splash followed by an "out of space" toast is worse
    // than not cleaning this time.
    return { run: false, reason: 'insufficient-space' };
  }
  return { run: true, candidate };
}

/**
 * Reads the settings and, unless the run is obviously pointless, measures the
 * live database. A database that cannot be probed counts as "nothing to do".
 */
export function prepareDbAutoCleanupRequest(options: {
  userDataDir: string;
  dbFilePath: string;
  ownerId: string;
  now: number;
  log: DbAutoCleanupSettingsLog;
}): DbAutoCleanupPreparation {
  const settings = readDbAutoCleanupSettings(options.userDataDir, options.log);
  if (!settings.enabled) return { run: false, reason: 'disabled', request: null };
  // Skip the probe entirely: it saves an SQLite open on every startup inside
  // the cooldown, which is the normal case right after a run.
  if (isDbAutoCleanupInCooldown(settings, options.now)) {
    return { run: false, reason: 'cooldown', request: null };
  }
  const candidate = scanDbAutoCleanupCandidates({
    dbFilePath: options.dbFilePath,
    cutoffMs: dbAutoCleanupRetentionCutoffMs(options.now, settings.retentionDays),
  });
  const decision = evaluateDbAutoCleanupGate({ settings, candidate, now: options.now });
  if (!decision.run) return { ...decision, request: null };
  return {
    run: true,
    candidate: decision.candidate,
    request: createAutoCleanupRequest({
      ownerId: options.ownerId,
      now: options.now,
      settings,
      candidate: decision.candidate,
    }),
  };
}

/**
 * Runs before the normal connection opens, like the maintenance it feeds, so it
 * uses the same synchronous factory instead of `DbClient`. The connection is
 * closed before the caller starts the worker.
 */
export function scanDbAutoCleanupCandidates(options: {
  dbFilePath: string;
  cutoffMs: number;
}): DbAutoCleanupCandidate | null {
  if (!fs.existsSync(options.dbFilePath)) return null;
  const databaseBytes = estimateDbFilesBytes(options.dbFilePath);
  let db: ReturnType<typeof createBetterSqliteDatabase> | null = null;
  try {
    db = createBetterSqliteDatabase(options.dbFilePath, { fileMustExist: true });
    const messageColumns = new Set(
      (db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const byteExpression =
      MESSAGE_BYTE_COLUMNS.filter((column) => messageColumns.has(column))
        .map((column) => `COALESCE(length(CAST(message.${column} AS BLOB)), 0)`)
        .join(' + ') || '0';
    const row = db
      .prepare(
        `WITH target_sessions AS (
           SELECT id
             FROM sessions
            WHERE status = 'deleted'
              AND updated_at <= ?
              AND EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id)
         )
         SELECT
           (SELECT COUNT(*) FROM target_sessions) AS deletedTaskCount,
           (SELECT COUNT(*)
              FROM messages message
              JOIN target_sessions target ON target.id = message.session_id) AS messageCount,
           (SELECT COALESCE(SUM(${byteExpression}), 0)
              FROM messages message
              JOIN target_sessions target ON target.id = message.session_id) AS estimatedMessageBytes`,
      )
      .get(options.cutoffMs) as
      | {
          deletedTaskCount: number | null;
          messageCount: number | null;
          estimatedMessageBytes: number | null;
        }
      | undefined;
    return {
      deletedTaskCount: row?.deletedTaskCount ?? 0,
      messageCount: row?.messageCount ?? 0,
      estimatedMessageBytes: row?.estimatedMessageBytes ?? 0,
      databaseBytes,
      requiredFreeBytes: dbSlimmingRequiredFreeBytes(databaseBytes, true),
      databaseVolumeFreeBytes: dbVolumeFreeBytes(options.dbFilePath),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Automatic runs are scoped to `deleted` only: archived tasks stay visible in the
 * sidebar, so a retention window must never take their history. The backup is
 * always on because nobody confirms this run.
 */
export function createAutoCleanupRequest(options: {
  ownerId: string;
  now: number;
  settings: DbAutoCleanupSettings;
  candidate: DbAutoCleanupCandidate;
}): DbSlimmingRequestRecord {
  const { candidate, now, settings } = options;
  return {
    version: 1,
    id: randomUUID(),
    ownerId: options.ownerId,
    createdAt: now,
    scannedAt: now,
    archivedBeforeMs: dbAutoCleanupRetentionCutoffMs(now, settings.retentionDays),
    archiveAgeMonths: dbAutoCleanupArchiveAgeForRetentionDays(settings.retentionDays),
    includeActiveTasks: false,
    targetStatuses: ['deleted'],
    activeTaskCount: 0,
    deletedTaskCount: candidate.deletedTaskCount,
    archivedTaskCount: 0,
    messageCount: candidate.messageCount,
    estimatedMessageBytes: candidate.estimatedMessageBytes,
    beforeBytes: candidate.databaseBytes,
    backupEnabled: true,
    phase: 'scheduled',
  };
}
