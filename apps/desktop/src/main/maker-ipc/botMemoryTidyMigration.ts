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
const BUNDLED_HOOK_TIMEOUT_MS = 10_000;
const BUNDLED_REVIEW_TITLE_SUFFIXES = [
  'Review memory', // en
  '整理记忆', // zh-CN
  '整理記憶', // zh-TW
  '理记', // zh-Hans-x-lzh
  '理記', // zh-Hant-x-lzh
  '記憶を整理', // ja
  '기억 정리', // ko
  'Erinnerungen ordnen', // de
  'Ordenar memoria', // es
  'Ranger la mémoire', // fr
  'Organizar memória', // pt-BR, pt-PT
] as const;
const KNOWN_PROJECT_SCHEDULE_KEYS = new Set([
  'id',
  'name',
  'prompt',
  'cronExpr',
  'timezone',
  'recurring',
  'manual',
  'intervalMs',
  'expireAt',
  'agentKind',
  'modelAgentKind',
  'modelAgentDeviceId',
  'followTeammateModel',
  'model',
  'providerId',
  'agentDeviceId',
  'effort',
  'modelGroup',
  'fastMode',
  'useWorktree',
  'persistentSession',
  'silentWhenIdle',
  'preRunHook',
  'notify',
]);
const KNOWN_NOTIFY_KEYS = new Set(['desktop', 'feishu', 'wecomGroup']);
const KNOWN_PRERUN_HOOK_KEYS = new Set(['command', 'timeoutMs']);
const BUNDLED_REVIEW_INSTRUCTIONS = `. Keep only durable, useful knowledge in this project's memory and reusable, proven procedures in its skills. Search existing files first: update a related record or skill instead of adding a duplicate. Review related existing material for duplication, contradictions, obsolete status and unnecessary detail; keep concise facts and actionable steps, not conversation logs or one-off task progress. Preserve the owner's rules and intent. Before merging or removing content, verify the evidence and keep a recoverable copy or a targeted Git commit; leave uncertain items intact. Read .cindy/memory/README.md before memory maintenance. Skills live in .agents/skills; keep SKILL.md focused and move detailed examples to on-demand references when useful. Do not invent a skill just because a review ran. If no meaningful improvement is justified, finish quietly.`;
const EARLIEST_REVIEW_SUFFIX = `'s conversations from the last day (teammate id `;
const EARLIEST_REVIEW_TAIL = `) and keep what is worth remembering in this project's memory and skills. If nothing new is worth keeping, finish quietly.`;

function extractBundledMemoryReviewPromptName(prompt: string | undefined): string | null {
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  if (trimmed.startsWith('Review ') && trimmed.endsWith(BUNDLED_REVIEW_INSTRUCTIONS)) {
    const sinceMarker = `'s conversations since the last completed review (teammate id `;
    const sinceIdx = trimmed.indexOf(sinceMarker);
    if (sinceIdx > 'Review '.length) return trimmed.slice('Review '.length, sinceIdx);
    const lastDayMarker = `'s conversations from the last day (teammate id `;
    const lastDayIdx = trimmed.indexOf(lastDayMarker);
    if (lastDayIdx > 'Review '.length) return trimmed.slice('Review '.length, lastDayIdx);
  }
  if (trimmed.startsWith('Look back at ') && trimmed.endsWith(EARLIEST_REVIEW_TAIL)) {
    const idx = trimmed.indexOf(EARLIEST_REVIEW_SUFFIX);
    if (idx > 'Look back at '.length) return trimmed.slice('Look back at '.length, idx);
  }
  return null;
}

function isBundledMemoryReviewTitle(
  name: string | undefined,
  promptName: string,
  expectedNames?: readonly string[],
): boolean {
  if (typeof name !== 'string') return false;
  if (expectedNames?.includes(name)) return true;
  return BUNDLED_REVIEW_TITLE_SUFFIXES.some((suffix) => name === `${promptName} · ${suffix}`);
}

export interface UntouchedBundledReviewOptions {
  /** Machine local IANA timezone used when bundled schedules were created (defaults to host timezone). */
  localTimezone?: string;
  /** Optional explicit expected localized title(s) in addition to the 12 bundled locale templates. */
  expectedNames?: readonly string[];
}

/**
 * True ONLY when a `teammate-memory-review` config is still Cindy's untouched supplied review.
 *
 * Uses closed-set validation across every `ProjectScheduleConfig` field so any owner customization
 * made via `ScheduleFormDialog` or direct JSON edit (title, timezone, manual/recurring/expireAt,
 * worktree/session/silent flags, notify channels, model/engine routing, prompt, hook command or
 * timeout, or unknown future fields) causes the review to be preserved intact.
 */
export function isUntouchedBundledMemoryReview(
  config: Partial<ProjectScheduleConfig> & { id: string },
  checkScriptContent: string | null,
  options?: UntouchedBundledReviewOptions,
): boolean {
  if (config.id !== LEGACY_REVIEW_CONFIG_ID) return false;

  // Reject any unknown defined property so future user-editable fields are conservatively preserved.
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (value !== undefined && !KNOWN_PROJECT_SCHEDULE_KEYS.has(key)) return false;
  }

  // Prompt and title must match Cindy's bundled template (using the same teammate name).
  const promptName = extractBundledMemoryReviewPromptName(config.prompt);
  if (!promptName) return false;
  if (!isBundledMemoryReviewTitle(config.name, promptName, options?.expectedNames)) return false;

  // Schedule timing, timezone, recurrence, expiry, and manual mode must remain untouched.
  if (config.cronExpr !== BUNDLED_REVIEW_CRON) return false;
  const localTimezone = options?.localTimezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  if (config.timezone !== undefined && config.timezone !== localTimezone) return false;
  if (config.intervalMs !== undefined && config.intervalMs !== null) return false;
  if (config.expireAt !== undefined && config.expireAt !== null) return false;
  if (config.manual === true) return false;
  if (config.recurring === false) return false;

  // Execution flags and notifications must remain at bundled defaults.
  if (config.useWorktree === true) return false;
  if (config.persistentSession === false) return false;
  if (config.silentWhenIdle === false) return false;
  if (config.notify !== undefined && config.notify !== null) {
    if (typeof config.notify !== 'object') return false;
    for (const [key, value] of Object.entries(config.notify as Record<string, unknown>)) {
      if (value !== undefined && !KNOWN_NOTIFY_KEYS.has(key)) return false;
    }
    if (config.notify.desktop || config.notify.feishu || config.notify.wecomGroup) return false;
  }

  // Any explicit model/engine/provider/device override or opt-out of followTeammateModel => preserve.
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

  if (config.preRunHook !== undefined && config.preRunHook !== null) {
    if (typeof config.preRunHook !== 'object') return false;
    for (const [key, value] of Object.entries(config.preRunHook as Record<string, unknown>)) {
      if (value !== undefined && !KNOWN_PRERUN_HOOK_KEYS.has(key)) return false;
    }
    if (config.preRunHook.timeoutMs !== undefined && config.preRunHook.timeoutMs !== BUNDLED_HOOK_TIMEOUT_MS) {
      return false;
    }
    const cmd = typeof config.preRunHook.command === 'string' ? config.preRunHook.command.trim() : '';
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
  /** Optional local IANA timezone override (primarily for deterministic tests). */
  localTimezone?: string;
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
      if (!isUntouchedBundledMemoryReview(projectReview, checkContent, { localTimezone: deps.localTimezone })) {
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
