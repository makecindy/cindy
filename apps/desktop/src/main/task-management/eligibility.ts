import {
  TASK_ARCHIVE_DAY_MS as DAY_MS,
  type TaskArchiveKeepReason,
} from '../../shared/taskManagement.js';

export interface ArchiveCandidateRow {
  id: string;
  status: string;
  updatedAt: number;
  lastActivityAt: number;
  pinnedAt: number | null;
  hiddenAt: number | null;
  source: string;
  worktreePath: string | null;
  remoteHostId: string | null;
  agentDeviceId: string | null;
  orcaRole: string | null;
  orcaRemoteLead: string | null;
  activeTurnStartedAt: number | null;
  lastTurnEndedAt: number | null;
  automation: number;
  goal: number;
  shared: number;
  queued: number;
  attached: number;
  remoteRestoredAt?: number | null;
}
export interface ArchiveProtection {
  ready: boolean;
  viewed: ReadonlySet<string>;
  drafts: ReadonlySet<string>;
  /** A controller with unknown draft state cannot prove a task is idle. */
  remoteUnknown: boolean;
}
export function taskArchiveKeepReason(
  row: ArchiveCandidateRow,
  options: {
    now: number;
    days: number;
    restoredAt?: number;
    protection: ArchiveProtection;
    busy: boolean;
    waiting?: boolean;
  },
): TaskArchiveKeepReason | null {
  const { now, days, restoredAt, protection, busy } = options;
  if (row.status !== 'active' || !Number.isFinite(row.lastActivityAt)) return 'unknown';
  if (row.pinnedAt != null) return 'pinned';
  if (protection.viewed.has(row.id)) return 'viewed';
  if (protection.drafts.has(row.id)) return 'draft';
  if (options.waiting || row.queued) return 'pending';
  if (busy || (row.activeTurnStartedAt ?? 0) > (row.lastTurnEndedAt ?? 0)) return 'running';
  if (row.automation) return 'automation';
  if (row.goal) return 'goal';
  if (
    row.hiddenAt != null ||
    row.orcaRole ||
    row.orcaRemoteLead ||
    !['desktop', 'scheduler', 'plugin', 'shared'].includes(row.source)
  )
    return 'managed';
  if (row.shared) return 'shared';
  if (row.worktreePath) return 'worktree';
  if (
    !protection.ready ||
    protection.remoteUnknown ||
    row.remoteHostId ||
    row.agentDeviceId ||
    row.attached
  )
    return 'unknown';
  const latestRestore = Math.max(restoredAt ?? 0, row.remoteRestoredAt ?? 0);
  if (latestRestore && now - latestRestore < days * DAY_MS) return 'restored';
  return now - row.lastActivityAt < days * DAY_MS ? 'recent' : null;
}

/** Shared by preview and the final transaction guard; only metadata is read. */
const ARCHIVE_CANDIDATE_COLUMNS = `s.id, s.status, s.updated_at AS updatedAt,
  COALESCE(s.last_activity_at, s.user_send_at, s.updated_at, s.created_at) AS lastActivityAt,
  s.pinned_at AS pinnedAt, s.hidden_at AS hiddenAt, s.source, s.worktree_path AS worktreePath,
  s.remote_host_id AS remoteHostId, s.agent_device_id AS agentDeviceId, s.orca_role AS orcaRole,
  s.orca_remote_lead AS orcaRemoteLead, s.active_turn_started_at AS activeTurnStartedAt,
  s.last_turn_ended_at AS lastTurnEndedAt,
  EXISTS(SELECT 1 FROM schedules a WHERE a.target_session_id = s.id AND a.status = 'active') AS automation,
  EXISTS(SELECT 1 FROM session_goals g WHERE g.session_id = s.id AND g.status != 'complete') AS goal,
  EXISTS(SELECT 1 FROM shared_task_events t WHERE t.session_id = s.id AND t.kind = 'authority' AND t.terminal = 0
    AND NOT EXISTS(SELECT 1 FROM shared_task_events newer WHERE newer.shared_task_id = t.shared_task_id
      AND ((newer.kind = 'authority' AND newer.revision > t.revision) OR (newer.kind = 'local-close' AND newer.terminal = 1)))) AS shared,
  EXISTS(SELECT 1 FROM agent_input_queue_snapshots q WHERE q.session_id = s.id AND q.payload != '[]') AS queued,
  EXISTS(SELECT 1 FROM im_bindings b WHERE b.target_session_id = s.id) AS attached`;

export const ARCHIVE_CANDIDATE_SELECT = `SELECT ${ARCHIVE_CANDIDATE_COLUMNS} FROM sessions s`;
export const ARCHIVE_CANDIDATE_WITH_RESTORE_SELECT = `SELECT ${ARCHIVE_CANDIDATE_COLUMNS},
  s.remote_restored_at AS remoteRestoredAt FROM sessions s`;

const ARCHIVE_SAFETY_CONDITIONS = `pinnedAt IS NULL AND hiddenAt IS NULL
    AND worktreePath IS NULL AND remoteHostId IS NULL AND agentDeviceId IS NULL
    AND orcaRole IS NULL AND orcaRemoteLead IS NULL
    AND COALESCE(activeTurnStartedAt, 0) <= COALESCE(lastTurnEndedAt, 0)
    AND automation = 0 AND goal = 0 AND shared = 0 AND queued = 0 AND attached = 0`;

/** Rechecked in the same transaction as the ordinary archive write. */
export const IDLE_ARCHIVE_GUARD_SQL = `SELECT id FROM (${ARCHIVE_CANDIDATE_SELECT})
  WHERE id = ? AND status = 'active' AND lastActivityAt <= ?
    AND source IN ('desktop', 'scheduler', 'plugin', 'shared') AND ${ARCHIVE_SAFETY_CONDITIONS}`;

/** Explicit remote actions share the idle/resource checks without applying the scheduler's cutoff. */
export const REMOTE_ARCHIVE_GUARD_SQL = `SELECT id FROM (${ARCHIVE_CANDIDATE_SELECT}) candidate
  WHERE id = ? AND status = ? AND source = 'desktop' AND ${ARCHIVE_SAFETY_CONDITIONS}
    AND EXISTS (SELECT 1 FROM sessions exact WHERE exact.id = candidate.id
      AND exact.archive_instance = ? AND exact.archive_revision = ? AND exact.working_dir IS ?)
    AND NOT EXISTS (SELECT 1 FROM bot_session_links b WHERE b.session_id = candidate.id)
    AND NOT EXISTS (SELECT 1 FROM orca_workers w WHERE w.session_id = candidate.id)
    AND NOT EXISTS (SELECT 1 FROM orca_teams t WHERE t.lead_session_id = candidate.id AND t.status = 'active')`;
