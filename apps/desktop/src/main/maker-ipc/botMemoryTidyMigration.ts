/**
 * One-time retirement of legacy per-teammate `teammate-memory-review` automations.
 *
 * Earlier V2 builds installed one `teammate-memory-review` project automation (running daily at
 * 03:30 with `persistentSession: true`) into every teammate's workspace. That produced N daily
 * schedules, N `.memory-review-check-v1.cjs` scripts, lingering review sessions in the sidebar,
 * and empty `Buddy <name>` project folders in `recentWorkdirs`.
 *
 * Replaced by the single host-managed, cadence-controlled Global Memory & Skill Tidy service
 * (`globalMemoryTidy.ts`). This migration safely cleans up only untouched bundled reviews:
 *  - removes `teammate-memory-review` from `workspace/.cindy/automations/schedules.json` and DB;
 *  - deletes untouched `.memory-review-check-v1.cjs` and `.memory-review-state-v1.json`;
 *  - archives pure automated review sessions (never touching canonical/thread/group/channel
 *    sessions or sessions with human user messages);
 *  - removes redundant empty teammate workspace entries from `recentWorkdirs` when no active
 *    project tasks remain there (leaving all workspace files, memories, skills and Git intact).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isTeammateProjectPath } from '@cindy/maker-shared/teammate-project';

import {
  isBundledMemoryReviewCheckScript,
  LEGACY_MEMORY_REVIEW_HOOK_COMMAND,
  MEMORY_REVIEW_CHECK_FILENAME,
  MEMORY_REVIEW_HOOK_COMMAND,
  MEMORY_REVIEW_STATE_FILENAME,
} from './botProjectMemoryReview.js';
import type { ProjectScheduleConfig } from '../scheduler-host/project-automation-loader.js';

export const LEGACY_REVIEW_RETIREMENT_RECEIPT = 'memory-tidy-v3-cleanup.json';
const LEGACY_REVIEW_CONFIG_ID = 'teammate-memory-review';
const BUNDLED_REVIEW_CRON = '30 3 * * *';
const BUNDLED_REVIEW_INSTRUCTIONS = `. Keep only durable, useful knowledge in this project's memory and reusable, proven procedures in its skills. Search existing files first: update a related record or skill instead of adding a duplicate. Review related existing material for duplication, contradictions, obsolete status and unnecessary detail; keep concise facts and actionable steps, not conversation logs or one-off task progress. Preserve the owner's rules and intent. Before merging or removing content, verify the evidence and keep a recoverable copy or a targeted Git commit; leave uncertain items intact. Read .cindy/memory/README.md before memory maintenance. Skills live in .agents/skills; keep SKILL.md focused and move detailed examples to on-demand references when useful. Do not invent a skill just because a review ran. If no meaningful improvement is justified, finish quietly.`;
const EARLIEST_REVIEW_SUFFIX = `'s conversations from the last day (teammate id `;
const EARLIEST_REVIEW_TAIL = `) and keep what is worth remembering in this project's memory and skills. If nothing new is worth keeping, finish quietly.`;

function isBundledMemoryReviewPrompt(prompt: string | undefined): boolean {
  if (typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  if (
    trimmed.startsWith('Review ')
    && trimmed.endsWith(BUNDLED_REVIEW_INSTRUCTIONS)
    && (trimmed.includes(`'s conversations since the last completed review (teammate id `)
      || trimmed.includes(`'s conversations from the last day (teammate id `))
  ) {
    return true;
  }
  if (
    trimmed.startsWith('Look back at ')
    && trimmed.includes(EARLIEST_REVIEW_SUFFIX)
    && trimmed.endsWith(EARLIEST_REVIEW_TAIL)
  ) {
    return true;
  }
  return false;
}

/** True ONLY when a `teammate-memory-review` config is still Cindy's untouched supplied review. */
export function isUntouchedBundledMemoryReview(
  config: Partial<ProjectScheduleConfig> & { id: string },
  checkScriptContent: string | null,
): boolean {
  if (config.id !== LEGACY_REVIEW_CONFIG_ID) return false;
  // Any custom schedule timing, explicit model/engine/provider override, or prompt edit => preserve.
  if (config.cronExpr !== undefined && config.cronExpr !== BUNDLED_REVIEW_CRON) return false;
  if (config.intervalMs !== undefined && config.intervalMs !== null) return false;
  if (
    config.model
    || config.agentKind
    || config.modelAgentKind
    || config.modelAgentDeviceId
    || config.providerId
    || config.agentDeviceId
    || config.effort
    || config.fastMode
    || config.modelGroup
    || config.followTeammateModel === false
  ) {
    return false;
  }
  if (!isBundledMemoryReviewPrompt(config.prompt)) return false;

  const cmd = config.preRunHook?.command?.trim();
  if (cmd) {
    const bundledCommand = cmd === MEMORY_REVIEW_HOOK_COMMAND || cmd === LEGACY_MEMORY_REVIEW_HOOK_COMMAND;
    if (!bundledCommand) return false;
    // Missing script or exact untouched bundled script => safe to retire. Owner-edited script => preserve.
    if (checkScriptContent !== null && !isBundledMemoryReviewCheckScript(checkScriptContent)) return false;
    return true;
  }
  // No preRunHook (earliest bundled version before hook existed): check script must not be owner-customized.
  if (checkScriptContent !== null && !isBundledMemoryReviewCheckScript(checkScriptContent)) return false;
  return true;
}

export interface LegacyReviewScheduleRow {
  id: string;
  workingDir: string | null;
  targetSessionId: string | null;
  projectConfigId: string | null;
}

export interface LegacyReviewRetirementDeps {
  ownerRoot: string;
  assertCurrent: () => void;
  /** Every local-home teammate workspace directory (demoted copies excluded). */
  listLocalTeammateWorkspaces(): Promise<string[]>;
  loadProjectSchedules(workingDir: string): Promise<ProjectScheduleConfig[] | null>;
  removeProjectSchedule(workingDir: string, configId: string): Promise<void>;
  listLegacyReviewSchedules(): Promise<LegacyReviewScheduleRow[]>;
  listRunSessionIds(scheduleId: string): Promise<string[]>;
  deleteSchedule(scheduleId: string): Promise<void>;
  /** Returns true only when the session is a pure automated review session safe to archive. */
  isSafeAutoReviewSession(sessionId: string): Promise<boolean>;
  archiveSession(sessionId: string): Promise<boolean>;
  /** Returns true when the workspace still has at least one active non-bot project session. */
  hasActiveProjectTasks(workingDir: string): Promise<boolean>;
  removeRecentWorkdir(workingDir: string): Promise<boolean>;
  notifyRecentWorkdirsChanged?(workingDir: string): void;
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface LegacyReviewRetirementSummary {
  skipped: boolean;
  schedulesRemoved: number;
  sessionsArchived: number;
  checkFilesRemoved: number;
  recentWorkdirsRemoved: number;
  preservedCustom: number;
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameDir(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function retireLegacyTeammateMemoryReviews(
  deps: LegacyReviewRetirementDeps,
): Promise<LegacyReviewRetirementSummary> {
  const receiptPath = path.join(deps.ownerRoot, LEGACY_REVIEW_RETIREMENT_RECEIPT);
  if (await fs.lstat(receiptPath).then(() => true, () => false)) {
    return { skipped: true, schedulesRemoved: 0, sessionsArchived: 0, checkFilesRemoved: 0, recentWorkdirsRemoved: 0, preservedCustom: 0 };
  }
  deps.assertCurrent();

  const summary: LegacyReviewRetirementSummary = {
    skipped: false,
    schedulesRemoved: 0,
    sessionsArchived: 0,
    checkFilesRemoved: 0,
    recentWorkdirsRemoved: 0,
    preservedCustom: 0,
  };

  const workspaces = await deps.listLocalTeammateWorkspaces();
  deps.assertCurrent();
  const dbSchedules = await deps.listLegacyReviewSchedules();
  deps.assertCurrent();

  // Union of all local teammate workspaces plus any teammate workspace referenced by a DB schedule row.
  const allWorkspaces = new Map<string, string>();
  for (const dir of workspaces) {
    const resolved = path.resolve(dir);
    allWorkspaces.set(process.platform === 'win32' ? resolved.toLowerCase() : resolved, resolved);
  }
  for (const row of dbSchedules) {
    if (!row.workingDir || !isTeammateProjectPath(row.workingDir)) continue;
    const resolved = path.resolve(row.workingDir);
    allWorkspaces.set(process.platform === 'win32' ? resolved.toLowerCase() : resolved, resolved);
  }

  const archivedSessions = new Set<string>();
  let hadFailure = false;

  for (const workingDir of allWorkspaces.values()) {
    deps.assertCurrent();
    const checkFile = path.join(workingDir, '..', MEMORY_REVIEW_CHECK_FILENAME);
    const stateFile = path.join(workingDir, '..', MEMORY_REVIEW_STATE_FILENAME);
    let checkContent: string | null = null;
    try {
      checkContent = await readTextIfExists(checkFile);
    } catch (error) {
      hadFailure = true;
      deps.log?.warn('failed to read legacy review check script; retrying next start', { workingDir, error: String(error) });
      continue;
    }
    let configs: ProjectScheduleConfig[] | null = null;
    try {
      configs = await deps.loadProjectSchedules(workingDir);
    } catch (error) {
      hadFailure = true;
      deps.log?.warn('failed to load project schedules during legacy review cleanup; retrying next start', { workingDir, error: String(error) });
      continue;
    }
    const projectReview = configs?.find((c) => c.id === LEGACY_REVIEW_CONFIG_ID);
    const matchingDbRows = dbSchedules.filter((row) => sameDir(row.workingDir, workingDir));

    // Decide whether this teammate has an untouched bundled review (or leftover orphaned check/DB row).
    let customPreserved = false;
    if (projectReview) {
      if (!isUntouchedBundledMemoryReview(projectReview, checkContent)) {
        customPreserved = true;
        summary.preservedCustom += 1;
      }
    } else if (checkContent !== null && !isBundledMemoryReviewCheckScript(checkContent)) {
      customPreserved = true;
      summary.preservedCustom += 1;
    }

    if (!customPreserved) {
      // 1. Archive pure automated sessions created by the legacy review schedules.
      const candidateSessionIds = new Set<string>();
      for (const row of matchingDbRows) {
        if (row.targetSessionId) candidateSessionIds.add(row.targetSessionId);
        try {
          const runSessions = await deps.listRunSessionIds(row.id);
          for (const sid of runSessions) candidateSessionIds.add(sid);
        } catch (error) {
          hadFailure = true;
          deps.log?.warn('failed to list legacy review run sessions', { scheduleId: row.id, error: String(error) });
        }
      }
      for (const sessionId of candidateSessionIds) {
        deps.assertCurrent();
        if (archivedSessions.has(sessionId)) continue;
        try {
          const safe = await deps.isSafeAutoReviewSession(sessionId);
          if (!safe) continue;
          if (await deps.archiveSession(sessionId)) {
            archivedSessions.add(sessionId);
            summary.sessionsArchived += 1;
          }
        } catch (error) {
          hadFailure = true;
          deps.log?.warn('failed to archive legacy review session', { sessionId, error: String(error) });
        }
      }

      // 2. Remove schedule from workspace/.cindy/automations/schedules.json and scheduler DB.
      if (projectReview) {
        try {
          await deps.removeProjectSchedule(workingDir, LEGACY_REVIEW_CONFIG_ID);
          summary.schedulesRemoved += 1;
        } catch (error) {
          hadFailure = true;
          deps.log?.warn('failed to remove project legacy review schedule', { workingDir, error: String(error) });
        }
      }
      for (const row of matchingDbRows) {
        deps.assertCurrent();
        try {
          await deps.deleteSchedule(row.id);
          if (!projectReview) summary.schedulesRemoved += 1;
        } catch (error) {
          hadFailure = true;
          deps.log?.warn('failed to delete DB legacy review schedule', { scheduleId: row.id, error: String(error) });
        }
      }

      // 3. Remove untouched bundled check script and its state file.
      if (checkContent !== null && isBundledMemoryReviewCheckScript(checkContent)) {
        try {
          await fs.rm(checkFile, { force: true });
          summary.checkFilesRemoved += 1;
        } catch (error) {
          hadFailure = true;
          deps.log?.warn('failed to remove legacy review check script', { checkFile, error: String(error) });
        }
      }
      if (await fs.lstat(stateFile).then((s) => s.isFile() && !s.isSymbolicLink(), () => false)) {
        try {
          await fs.rm(stateFile, { force: true });
        } catch (error) {
          hadFailure = true;
          deps.log?.warn('failed to remove legacy review state file', { stateFile, error: String(error) });
        }
      }
    }

    // 4. Clean up redundant empty teammate workspace entries from recentWorkdirs.
    let hasTasks = true;
    try {
      hasTasks = await deps.hasActiveProjectTasks(workingDir);
    } catch (error) {
      hadFailure = true;
      deps.log?.warn('failed to check active project tasks', { workingDir, error: String(error) });
    }
    if (!hasTasks) {
      deps.assertCurrent();
      try {
        if (await deps.removeRecentWorkdir(workingDir)) {
          summary.recentWorkdirsRemoved += 1;
          deps.notifyRecentWorkdirsChanged?.(workingDir);
        }
      } catch (error) {
        hadFailure = true;
        deps.log?.warn('failed to remove empty teammate recentWorkdir', { workingDir, error: String(error) });
      }
    }
  }

  deps.assertCurrent();
  if (!hadFailure) {
    await fs.mkdir(deps.ownerRoot, { recursive: true });
    const tmp = `${receiptPath}.${process.pid}.tmp`;
    await fs.writeFile(
      tmp,
      `${JSON.stringify({ version: 1, completedAt: new Date().toISOString(), ...summary }, null, 2)}\n`,
      'utf8',
    );
    await fs.rename(tmp, receiptPath);
    deps.log?.info('retired legacy per-teammate memory reviews', { ...summary });
  } else {
    deps.log?.warn('legacy memory review cleanup had transient failures; deferring receipt to retry next start', { ...summary });
  }
  return summary;
}
