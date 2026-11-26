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

/** True when a `teammate-memory-review` config is still Cindy's untouched supplied review. */
export function isUntouchedBundledMemoryReview(
  config: Pick<ProjectScheduleConfig, 'id' | 'prompt' | 'preRunHook'>,
  checkScriptContent: string | null,
): boolean {
  if (config.id !== LEGACY_REVIEW_CONFIG_ID) return false;
  const cmd = config.preRunHook?.command?.trim();
  const bundledCommand = cmd === MEMORY_REVIEW_HOOK_COMMAND || cmd === LEGACY_MEMORY_REVIEW_HOOK_COMMAND;
  if (bundledCommand) {
    // Missing script or untouched bundled script => safe to retire. Owner-edited script => preserve.
    if (checkScriptContent === null) return true;
    return isBundledMemoryReviewCheckScript(checkScriptContent);
  }
  if (!cmd && typeof config.prompt === 'string') {
    const prompt = config.prompt.trim();
    if (
      (prompt.startsWith('Look back at ') || prompt.startsWith('Review '))
      && prompt.includes('(teammate id ')
      && prompt.includes('finish quietly.')
    ) {
      return true;
    }
  }
  return false;
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

  for (const workingDir of allWorkspaces.values()) {
    deps.assertCurrent();
    const checkFile = path.join(workingDir, '..', MEMORY_REVIEW_CHECK_FILENAME);
    const stateFile = path.join(workingDir, '..', MEMORY_REVIEW_STATE_FILENAME);
    const checkContent = await readTextIfExists(checkFile).catch(() => null);
    const configs = await deps.loadProjectSchedules(workingDir).catch(() => null);
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
        const runSessions = await deps.listRunSessionIds(row.id).catch(() => []);
        for (const sid of runSessions) candidateSessionIds.add(sid);
      }
      for (const sessionId of candidateSessionIds) {
        deps.assertCurrent();
        if (archivedSessions.has(sessionId)) continue;
        const safe = await deps.isSafeAutoReviewSession(sessionId).catch(() => false);
        if (!safe) continue;
        if (await deps.archiveSession(sessionId).catch(() => false)) {
          archivedSessions.add(sessionId);
          summary.sessionsArchived += 1;
        }
      }

      // 2. Remove schedule from workspace/.cindy/automations/schedules.json and scheduler DB.
      if (projectReview) {
        await deps.removeProjectSchedule(workingDir, LEGACY_REVIEW_CONFIG_ID);
        summary.schedulesRemoved += 1;
      }
      for (const row of matchingDbRows) {
        deps.assertCurrent();
        await deps.deleteSchedule(row.id).catch(() => {});
        if (!projectReview) summary.schedulesRemoved += 1;
      }

      // 3. Remove untouched bundled check script and its state file.
      if (checkContent !== null && isBundledMemoryReviewCheckScript(checkContent)) {
        await fs.rm(checkFile, { force: true }).catch(() => {});
        summary.checkFilesRemoved += 1;
      }
      if (await fs.lstat(stateFile).then((s) => s.isFile() && !s.isSymbolicLink(), () => false)) {
        await fs.rm(stateFile, { force: true }).catch(() => {});
      }
    }

    // 4. Clean up redundant empty teammate workspace entries from recentWorkdirs.
    const hasTasks = await deps.hasActiveProjectTasks(workingDir).catch(() => true);
    if (!hasTasks) {
      deps.assertCurrent();
      if (await deps.removeRecentWorkdir(workingDir).catch(() => false)) {
        summary.recentWorkdirsRemoved += 1;
        deps.notifyRecentWorkdirsChanged?.(workingDir);
      }
    }
  }

  deps.assertCurrent();
  await fs.mkdir(deps.ownerRoot, { recursive: true });
  const tmp = `${receiptPath}.${process.pid}.tmp`;
  await fs.writeFile(
    tmp,
    `${JSON.stringify({ version: 1, completedAt: new Date().toISOString(), ...summary }, null, 2)}\n`,
    'utf8',
  );
  await fs.rename(tmp, receiptPath);
  deps.log?.info('retired legacy per-teammate memory reviews', { ...summary });
  return summary;
}
