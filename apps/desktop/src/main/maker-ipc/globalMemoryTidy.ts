/**
 * Unified, restrained Global Memory & Skill Tidy coordinator.
 *
 * Replaces N per-teammate daily `teammate-memory-review` automations with ONE host-managed,
 * user-controllable maintenance pass per computer (default cadence: weekly, NOT daily):
 *
 *  - Only evaluates teammates whose main computer (home) is THIS computer (skips demoted copies).
 *  - Strictly respects each teammate's `memory` switch (`memoryEnabled === false` never scans
 *    or writes its memory or conversations).
 *  - Deterministic host pre-check gates every automatic run: zero backlog => zero LLM call,
 *    zero session created.
 *  - Caps each run to the top 4 teammates by backlog urgency so token spend stays bounded.
 *  - Pre-feeds a compact global reference (other buddies' MEMORY.md outlines + global/personal
 *    skills) so the pass can spot cross-buddy duplication or redundant rules overlapping built-in
 *    or global skills.
 *  - Runs in a stateless one-shot maintenance session that is auto-archived on completion,
 *    leaving no lingering task in the active sidebar.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CORE_MEMORY_INDEX_MAX_BYTES, readProjectCoreMemoryIndex } from '@cindy/maker-core';
import { teammateProjectMemoryDir } from './botProjectMemory.js';

export const MEMORY_TIDY_CADENCES = ['weekly', 'biweekly', 'monthly', 'off'] as const;
export type MemoryTidyCadence = (typeof MEMORY_TIDY_CADENCES)[number];
export const DEFAULT_MEMORY_TIDY_CADENCE: MemoryTidyCadence = 'weekly';

export const GLOBAL_MEMORY_TIDY_STATE_FILE = 'global-memory-tidy-state.json';

const DAY_MS = 24 * 60 * 60 * 1000;
export const TIDY_MIN_HUMAN_MESSAGES = 30;
export const TIDY_FILE_CHANGE_MIN_AGE_MS = 14 * DAY_MS;
export const TIDY_CORE_INDEX_SOFT_BYTES = 2048;
export const TIDY_MAX_BOTS_PER_RUN = 4;
export const TIDY_ERROR_RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000;
const WALK_ENTRY_BUDGET = 1500;
const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv']);
const NON_RECORD_MEMORY_FILES = new Set(['README.md', 'USER.md']);

export function isMemoryTidyCadence(value: unknown): value is MemoryTidyCadence {
  return typeof value === 'string' && (MEMORY_TIDY_CADENCES as readonly string[]).includes(value);
}

export function cadenceIntervalMs(cadence: MemoryTidyCadence): number {
  switch (cadence) {
    case 'weekly': return 7 * DAY_MS;
    case 'biweekly': return 14 * DAY_MS;
    case 'monthly': return 30 * DAY_MS;
    case 'off': return Number.POSITIVE_INFINITY;
  }
}

export interface GlobalTidyBotWatermark {
  reviewedAt: number;
  filesSince: number;
}

export interface GlobalMemoryTidyState {
  version: 1;
  /**
   * Explicit user cadence override only. Omitted when the user has not customized cadence,
   * so uncustomized users automatically follow `DEFAULT_MEMORY_TIDY_CADENCE` across upgrades.
   */
  cadenceOverride?: MemoryTidyCadence;
  /** Stable starting timestamp for buddies that have never been tidied yet (never slides forward on skips). */
  baselineAt: number;
  lastRunAt: number;
  /** Timestamp of the most recent failed tidy run (cleared on success); gates short backoff retries without shifting cadence. */
  lastErrorAt: number;
  lastOutcome: 'idle' | 'updated' | 'skipped' | 'error' | null;
  lastSummary: string;
  lastTouchedBots: string[];
  bots: Record<string, GlobalTidyBotWatermark>;
  globalSkillsReviewedAt: number;
}

export function resolveEffectiveCadence(state: Pick<GlobalMemoryTidyState, 'cadenceOverride'>): MemoryTidyCadence {
  return state.cadenceOverride ?? DEFAULT_MEMORY_TIDY_CADENCE;
}

export interface GlobalMemoryTidyStatus {
  cadence: MemoryTidyCadence;
  isCustomCadence: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastOutcome: GlobalMemoryTidyState['lastOutcome'];
  lastSummary: string;
  lastTouchedBots: string[];
  nextEligibleAt: number | null;
}

export interface TidyTeammateInput {
  botId: string;
  displayName: string;
  workspace: string;
  memoryEnabled: boolean;
}

export interface TidyTeammateCandidate {
  botId: string;
  displayName: string;
  workspace: string;
  memoryEnabled: boolean;
  humanMessages: number;
  messagesSince: number;
  changedMemoryFiles: string[];
  changedSkillFiles: string[];
  coreIndexBytes: number;
  coreIndexPreview: string;
  urgencyScore: number;
}

export interface GlobalMemoryTidyPlan {
  shouldRun: boolean;
  reason: 'backlog' | 'manual' | 'no-backlog' | 'no-teammates';
  candidates: TidyTeammateCandidate[];
  omittedCount: number;
  globalSkillsDir: string;
  changedGlobalSkills: string[];
  allCoreOutlines: Array<{ botId: string; displayName: string; corePreview: string }>;
  installedGlobalSkills: Array<{ name: string; description: string }>;
}

export function defaultTidyState(): GlobalMemoryTidyState {
  return {
    version: 1,
    baselineAt: 0,
    lastRunAt: 0,
    lastErrorAt: 0,
    lastOutcome: null,
    lastSummary: '',
    lastTouchedBots: [],
    bots: {},
    globalSkillsReviewedAt: 0,
  };
}

export async function readGlobalMemoryTidyState(ownerRoot: string): Promise<GlobalMemoryTidyState> {
  const file = path.join(ownerRoot, GLOBAL_MEMORY_TIDY_STATE_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<GlobalMemoryTidyState> & { cadence?: unknown };
    // Backward compatibility: older state files persisted `cadence`; only treat non-default
    // legacy values as an explicit override so default users keep following future defaults.
    const cadenceOverride = isMemoryTidyCadence(parsed.cadenceOverride)
      ? parsed.cadenceOverride
      : (isMemoryTidyCadence(parsed.cadence) && parsed.cadence !== DEFAULT_MEMORY_TIDY_CADENCE
        ? parsed.cadence
        : undefined);
    return {
      version: 1,
      ...(cadenceOverride !== undefined ? { cadenceOverride } : {}),
      baselineAt: typeof parsed.baselineAt === 'number' && Number.isFinite(parsed.baselineAt) ? parsed.baselineAt : 0,
      lastRunAt: typeof parsed.lastRunAt === 'number' && Number.isFinite(parsed.lastRunAt) ? parsed.lastRunAt : 0,
      lastErrorAt: typeof parsed.lastErrorAt === 'number' && Number.isFinite(parsed.lastErrorAt) ? parsed.lastErrorAt : 0,
      lastOutcome:
        parsed.lastOutcome === 'idle' || parsed.lastOutcome === 'updated'
        || parsed.lastOutcome === 'skipped' || parsed.lastOutcome === 'error'
          ? parsed.lastOutcome
          : null,
      lastSummary: typeof parsed.lastSummary === 'string' ? parsed.lastSummary.slice(0, 1000) : '',
      lastTouchedBots: Array.isArray(parsed.lastTouchedBots)
        ? parsed.lastTouchedBots.filter((v): v is string => typeof v === 'string').slice(0, 32)
        : [],
      bots: parsed.bots && typeof parsed.bots === 'object' && !Array.isArray(parsed.bots)
        ? parsed.bots
        : {},
      globalSkillsReviewedAt:
        typeof parsed.globalSkillsReviewedAt === 'number' && Number.isFinite(parsed.globalSkillsReviewedAt)
          ? parsed.globalSkillsReviewedAt
          : 0,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof SyntaxError) {
      return defaultTidyState();
    }
    throw error;
  }
}

export async function writeGlobalMemoryTidyState(
  ownerRoot: string,
  state: GlobalMemoryTidyState,
): Promise<void> {
  await fs.mkdir(ownerRoot, { recursive: true });
  const file = path.join(ownerRoot, GLOBAL_MEMORY_TIDY_STATE_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const persisted: GlobalMemoryTidyState = {
    version: 1,
    ...(state.cadenceOverride !== undefined ? { cadenceOverride: state.cadenceOverride } : {}),
    baselineAt: state.baselineAt,
    lastRunAt: state.lastRunAt,
    lastErrorAt: state.lastErrorAt,
    lastOutcome: state.lastOutcome,
    lastSummary: state.lastSummary,
    lastTouchedBots: state.lastTouchedBots,
    bots: state.bots,
    globalSkillsReviewedAt: state.globalSkillsReviewedAt,
  };
  await fs.writeFile(tmp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/** Bounded breadth-first walk collecting changed files after `baselineMs`. */
async function collectChangedFiles(
  root: string,
  relativePrefix: string,
  baselineMs: number,
  memoryOnly: boolean,
): Promise<string[]> {
  const changed: string[] = [];
  const queue: Array<[string, string]> = [[root, relativePrefix]];
  let visited = 0;
  for (let i = 0; i < queue.length && visited < WALK_ENTRY_BUDGET; i += 1) {
    const [dir, rel] = queue[i];
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
      throw error;
    });
    for (const entry of entries) {
      if (++visited > WALK_ENTRY_BUDGET) break;
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name) || entry.name.endsWith('.pyc')) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const name = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!memoryOnly) queue.push([full, name]);
        continue;
      }
      if (!entry.isFile()) continue;
      if (memoryOnly && (!entry.name.endsWith('.md') || NON_RECORD_MEMORY_FILES.has(entry.name))) continue;
      const st = await fs.lstat(full).catch(() => null);
      if (st && st.isFile() && !st.isSymbolicLink() && st.mtimeMs > baselineMs) {
        changed.push(name);
      }
    }
  }
  return changed.sort();
}

async function listGlobalSkillsOutline(globalSkillsDir: string): Promise<Array<{ name: string; description: string }>> {
  const entries = await fs.readdir(globalSkillsDir, { withFileTypes: true }).catch(() => []);
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const skillFile = path.join(globalSkillsDir, entry.name, 'SKILL.md');
    const raw = await fs.readFile(skillFile, 'utf8').catch(() => null);
    if (!raw) continue;
    const descMatch = /^description\s*:\s*(.+)$/m.exec(raw);
    const description = descMatch?.[1]?.trim().replace(/^["']|["']$/g, '').slice(0, 140) ?? '';
    out.push({ name: entry.name, description });
    if (out.length >= 40) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface EvaluateTidyPlanInput {
  teammates: readonly TidyTeammateInput[];
  state: GlobalMemoryTidyState;
  now: number;
  manual?: boolean;
  globalSkillsDir?: string;
  countHumanMessages(botId: string, sinceMs: number, untilMs: number): Promise<number>;
}

/**
 * Deterministic host pre-check. Zero LLM calls. Returns `shouldRun: false` on automatic ticks
 * whenever no teammate has substantive backlog.
 */
export async function evaluateGlobalMemoryTidyPlan(
  input: EvaluateTidyPlanInput,
): Promise<GlobalMemoryTidyPlan> {
  const globalSkillsDir = input.globalSkillsDir?.trim() ?? '';
  if (input.teammates.length === 0) {
    return {
      shouldRun: false,
      reason: 'no-teammates',
      candidates: [],
      omittedCount: 0,
      globalSkillsDir,
      changedGlobalSkills: [],
      allCoreOutlines: [],
      installedGlobalSkills: [],
    };
  }

  const eligible: TidyTeammateCandidate[] = [];
  const allCoreOutlines: Array<{ botId: string; displayName: string; corePreview: string }> = [];

  const fallbackBaseline = input.state.baselineAt > 0 && input.state.baselineAt < input.now
    ? input.state.baselineAt
    : Math.max(0, input.now - 14 * DAY_MS);

  for (const bot of input.teammates) {
    const wm = input.state.bots[bot.botId] ?? { reviewedAt: 0, filesSince: 0 };
    const baseline = Math.max(wm.reviewedAt, wm.filesSince);
    const messagesSince = wm.reviewedAt > 0 && wm.reviewedAt < input.now
      ? wm.reviewedAt
      : fallbackBaseline;

    const memoryDir = teammateProjectMemoryDir(bot.workspace);
    const coreIndex = bot.memoryEnabled
      ? await readProjectCoreMemoryIndex(memoryDir, CORE_MEMORY_INDEX_MAX_BYTES)
      : '';
    const coreIndexBytes = Buffer.byteLength(coreIndex, 'utf8');
    if (coreIndex) {
      allCoreOutlines.push({
        botId: bot.botId,
        displayName: bot.displayName,
        corePreview: coreIndex.slice(0, 400),
      });
    }

    const humanMessages = bot.memoryEnabled
      ? await input.countHumanMessages(bot.botId, messagesSince, input.now).catch(() => 0)
      : 0;
    const changedMemoryFiles = bot.memoryEnabled
      ? await collectChangedFiles(memoryDir, '.cindy/memory', baseline, true).catch(() => [])
      : [];
    const changedSkillFiles = await collectChangedFiles(
      path.join(bot.workspace, '.agents', 'skills'),
      '.agents/skills',
      baseline,
      false,
    ).catch(() => []);

    const ageSinceLastTidy = wm.reviewedAt > 0 ? input.now - wm.reviewedAt : Number.POSITIVE_INFINITY;
    const memoryBacklog = bot.memoryEnabled && (
      humanMessages >= TIDY_MIN_HUMAN_MESSAGES
      || (changedMemoryFiles.length > 0 && (coreIndexBytes > TIDY_CORE_INDEX_SOFT_BYTES || ageSinceLastTidy >= TIDY_FILE_CHANGE_MIN_AGE_MS))
      || coreIndexBytes > TIDY_CORE_INDEX_SOFT_BYTES
    );
    const skillBacklog = changedSkillFiles.length > 0 && ageSinceLastTidy >= TIDY_FILE_CHANGE_MIN_AGE_MS;

    if (input.manual || memoryBacklog || skillBacklog) {
      const urgencyScore =
        humanMessages * 2
        + changedMemoryFiles.length * 5
        + changedSkillFiles.length * 4
        + (coreIndexBytes > TIDY_CORE_INDEX_SOFT_BYTES ? 40 : 0);
      eligible.push({
        botId: bot.botId,
        displayName: bot.displayName,
        workspace: bot.workspace,
        memoryEnabled: bot.memoryEnabled,
        humanMessages,
        messagesSince,
        changedMemoryFiles: changedMemoryFiles.slice(0, 30),
        changedSkillFiles: changedSkillFiles.slice(0, 30),
        coreIndexBytes,
        coreIndexPreview: coreIndex.slice(0, 600),
        urgencyScore,
      });
    }
  }

  const changedGlobalSkills = globalSkillsDir
    ? await collectChangedFiles(
        globalSkillsDir,
        'global-skills',
        input.state.globalSkillsReviewedAt,
        false,
      ).catch(() => [])
    : [];
  const installedGlobalSkills = globalSkillsDir ? await listGlobalSkillsOutline(globalSkillsDir) : [];

  eligible.sort((a, b) => b.urgencyScore - a.urgencyScore || a.displayName.localeCompare(b.displayName));
  const selected = eligible.slice(0, TIDY_MAX_BOTS_PER_RUN);
  const omittedCount = Math.max(0, eligible.length - selected.length);

  // Automatic runs only fire when at least one teammate actually has real memory/skill backlog.
  // Global skills serve as read-only cross-reference context and never trigger an empty run alone.
  if (selected.length === 0) {
    return {
      shouldRun: false,
      reason: 'no-backlog',
      candidates: [],
      omittedCount: 0,
      globalSkillsDir,
      changedGlobalSkills: [],
      allCoreOutlines,
      installedGlobalSkills,
    };
  }

  return {
    shouldRun: true,
    reason: input.manual ? 'manual' : 'backlog',
    candidates: selected,
    omittedCount,
    globalSkillsDir,
    changedGlobalSkills: changedGlobalSkills.slice(0, 20),
    allCoreOutlines,
    installedGlobalSkills,
  };
}

/** Build a compact, bounded prompt with global visibility and strict restraint rules. */
export function buildGlobalMemoryTidyPrompt(plan: GlobalMemoryTidyPlan): string {
  const lines: string[] = [
    '# Unified Memory & Skill Tidy (Restrained Maintenance Pass)',
    '',
    'You are performing a lightweight, restrained maintenance pass across the local teammates listed below (and global skills where relevant).',
    '',
    '## Rules (strict)',
    '- Only touch teammates listed under "Candidates" below. Never touch teammates whose memory switch is off (for them, only inspect skills if listed).',
    '- For each teammate with memory enabled:',
    '  1. Review recent conversations since its timestamp (only if new human messages > 0) and changed memory files; save only high-confidence, durable preferences, hard corrections, or active long-term decisions. Never save transcripts or one-off task logs.',
    '  2. Merge obvious duplicates and remove clearly expired temporary facts in `.cindy/memory/`.',
    '  3. Keep `.cindy/memory/MEMORY.md` concise (strictly under ~2 KB): core preferences, hard corrections/do-nots, and brief pointers to topic `.md` files. Leave detailed notes in separate `.md` files beside it.',
    '- For skills (`.agents/skills/` and global skills):',
    '  - Remove or trim only obvious duplicates of Cindy built-in capabilities or already-installed global skills.',
    '  - **Do NOT invent new skills** just because this pass ran.',
    '  - **Do NOT silently rewrite `AGENTS.md`, `USER.md`, or delete uncertain custom skills.** Instead, list cross-buddy promotions or uncertain cleanups as brief proposals in your final summary.',
    '- Keep edits surgical and minimal. If nothing meaningful needs changing, output `NO_CHANGES` and stop.',
    '- Otherwise finish with a 2–5 line summary: which teammates were updated, what was tidied, and any optional proposals for the user.',
    '',
    '## Candidates',
  ];

  for (const bot of plan.candidates) {
    lines.push(
      `### ${bot.displayName} (botId: ${bot.botId})`,
      `- workspace: ${JSON.stringify(bot.workspace)}`,
      `- memory_enabled: ${bot.memoryEnabled}`,
      ...(bot.memoryEnabled
        ? [
            `- human_messages_since_${new Date(bot.messagesSince).toISOString()}: ${bot.humanMessages}`,
            `- core_memory_bytes: ${bot.coreIndexBytes} (soft target <= ${TIDY_CORE_INDEX_SOFT_BYTES})`,
            ...(bot.changedMemoryFiles.length ? [`- changed_memory_files: ${bot.changedMemoryFiles.join(', ')}`] : []),
          ]
        : []),
      ...(bot.changedSkillFiles.length ? [`- changed_skill_files: ${bot.changedSkillFiles.join(', ')}`] : []),
      '',
    );
  }

  if (plan.omittedCount > 0) {
    lines.push(`_(${plan.omittedCount} additional teammate(s) deferred to the next pass to keep this run lightweight.)_`, '');
  }

  if (plan.allCoreOutlines.length > 0) {
    lines.push('## Global reference · local teammates MEMORY.md outlines (spot cross-buddy duplicates)');
    for (const item of plan.allCoreOutlines) {
      lines.push(`- **${item.displayName}** (${item.botId}): ${item.corePreview.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
    lines.push('');
  }

  if (plan.installedGlobalSkills.length > 0 || plan.changedGlobalSkills.length > 0) {
    lines.push(`## Global personal skills (${JSON.stringify(plan.globalSkillsDir)})`);
    if (plan.changedGlobalSkills.length > 0) {
      lines.push(`- changed_since_last_pass: ${plan.changedGlobalSkills.join(', ')}`);
    }
    for (const skill of plan.installedGlobalSkills.slice(0, 25)) {
      lines.push(`- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface GlobalMemoryTidyExecutionResult {
  ok: boolean;
  output: string;
  /** Temporary maintenance session id (if created) so coordinator ensures it is archived. */
  sessionId?: string | null;
}

export interface GlobalMemoryTidyCoordinatorDeps {
  readOwnerRoot(): string | null;
  assertCurrent(ownerRoot: string): void;
  listLocalTeammates(): Promise<TidyTeammateInput[]>;
  countHumanMessages(botId: string, sinceMs: number, untilMs: number): Promise<number>;
  executeTidyPrompt(input: {
    prompt: string;
    workingDir: string;
    extraDirs: string[];
    writableDirs: string[];
  }): Promise<GlobalMemoryTidyExecutionResult>;
  archiveSession?(sessionId: string): Promise<void>;
  snapshotTeammate?(botId: string, workspace: string, label: string): Promise<void>;
  /**
   * Returns true if another task of this teammate had message activity while the tidy ran.
   * When true (or when this check fails), `filesSince` stays at `startedAt` so concurrent edits
   * are not swallowed by the tidy's finish timestamp.
   */
  hasConcurrentActivity?(
    botId: string,
    workspace: string,
    startedAt: number,
    finishedAt: number,
    tidySessionId?: string | null,
  ): Promise<boolean>;
  globalSkillsDir?: string;
  now?: () => number;
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

const STARTUP_CHECK_DELAY_MS = 5 * 60 * 1000;
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createGlobalMemoryTidyCoordinator(deps: GlobalMemoryTidyCoordinatorDeps) {
  const now = deps.now ?? (() => Date.now());
  let running = false;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let periodicTimer: ReturnType<typeof setInterval> | null = null;
  let stateWriteChain: Promise<unknown> = Promise.resolve();

  /** Serializes all state read-modify-write mutations so setCadence() and run() never clobber each other. */
  function mutateState<T>(ownerRoot: string, fn: (state: GlobalMemoryTidyState) => Promise<T> | T): Promise<T> {
    const next = stateWriteChain.catch(() => undefined).then(async () => {
      deps.assertCurrent(ownerRoot);
      const latest = await readGlobalMemoryTidyState(ownerRoot);
      const result = await fn(latest);
      deps.assertCurrent(ownerRoot);
      await writeGlobalMemoryTidyState(ownerRoot, latest);
      return result;
    });
    stateWriteChain = next.catch(() => undefined);
    return next;
  }

  async function getStatus(): Promise<GlobalMemoryTidyStatus> {
    const ownerRoot = deps.readOwnerRoot();
    const state = ownerRoot ? await readGlobalMemoryTidyState(ownerRoot) : defaultTidyState();
    const cadence = resolveEffectiveCadence(state);
    const interval = cadenceIntervalMs(cadence);
    const cadenceNextAt = Number.isFinite(interval)
      ? (state.lastRunAt > 0 ? state.lastRunAt + interval : now())
      : null;
    const errorRetryAt = state.lastErrorAt > 0 ? state.lastErrorAt + TIDY_ERROR_RETRY_BACKOFF_MS : 0;
    const nextEligibleAt = cadenceNextAt !== null ? Math.max(cadenceNextAt, errorRetryAt) : null;
    return {
      cadence,
      isCustomCadence: state.cadenceOverride !== undefined,
      running,
      lastRunAt: state.lastRunAt > 0 ? state.lastRunAt : null,
      lastOutcome: state.lastOutcome,
      lastSummary: state.lastSummary,
      lastTouchedBots: state.lastTouchedBots,
      nextEligibleAt,
    };
  }

  async function setCadence(cadence: MemoryTidyCadence | null): Promise<GlobalMemoryTidyStatus> {
    if (cadence !== null && !isMemoryTidyCadence(cadence)) {
      throw new Error(`Invalid tidy cadence: ${String(cadence)}`);
    }
    const ownerRoot = deps.readOwnerRoot();
    if (!ownerRoot) throw new Error('Account not ready');
    await mutateState(ownerRoot, (latest) => {
      if (cadence === null) {
        delete latest.cadenceOverride;
      } else {
        latest.cadenceOverride = cadence;
      }
    });
    return getStatus();
  }

  async function run(opts: { manual?: boolean } = {}): Promise<{
    outcome: 'idle' | 'updated' | 'skipped' | 'error';
    summary: string;
    touchedBots: string[];
  }> {
    if (running) {
      return { outcome: 'skipped', summary: 'already-running', touchedBots: [] };
    }
    const ownerRoot = deps.readOwnerRoot();
    if (!ownerRoot) {
      return { outcome: 'skipped', summary: 'owner-unavailable', touchedBots: [] };
    }
    running = true;
    try {
      deps.assertCurrent(ownerRoot);
      const startedAt = now();
      let state = await readGlobalMemoryTidyState(ownerRoot);
      // Persist a stable first-seen baseline once so low-frequency buddies accumulate messages
      // across skipped cycles instead of facing a sliding 14-day window forever.
      if (state.baselineAt <= 0) {
        const stableBaseline = Math.max(0, startedAt - 14 * DAY_MS);
        state = await mutateState(ownerRoot, (latest) => {
          if (latest.baselineAt <= 0) latest.baselineAt = stableBaseline;
          return { ...latest, bots: { ...latest.bots } };
        });
      }
      if (!opts.manual) {
        const interval = cadenceIntervalMs(resolveEffectiveCadence(state));
        if (!Number.isFinite(interval)) {
          return { outcome: 'skipped', summary: 'cadence-off', touchedBots: [] };
        }
        if (state.lastRunAt > 0 && startedAt - state.lastRunAt < interval) {
          return { outcome: 'skipped', summary: 'cadence-not-due', touchedBots: [] };
        }
        if (state.lastErrorAt > 0 && startedAt - state.lastErrorAt < TIDY_ERROR_RETRY_BACKOFF_MS) {
          return { outcome: 'skipped', summary: 'error-backoff', touchedBots: [] };
        }
      }

      const teammates = await deps.listLocalTeammates();
      deps.assertCurrent(ownerRoot);
      const plan = await evaluateGlobalMemoryTidyPlan({
        teammates,
        state,
        now: startedAt,
        manual: opts.manual,
        globalSkillsDir: deps.globalSkillsDir,
        countHumanMessages: deps.countHumanMessages,
      });
      deps.assertCurrent(ownerRoot);

      if (!plan.shouldRun) {
        return { outcome: 'skipped', summary: plan.reason, touchedBots: [] };
      }

      const workingDir = plan.candidates[0]?.workspace ?? teammates[0]?.workspace;
      if (!workingDir) {
        return { outcome: 'skipped', summary: 'no-workspace', touchedBots: [] };
      }
      const workspaces = [...new Set(plan.candidates.map((c) => c.workspace))];
      const extraDirs = [...new Set(plan.globalSkillsDir ? [...workspaces, plan.globalSkillsDir] : workspaces)];
      const writableDirs = [...workspaces];
      const prompt = buildGlobalMemoryTidyPrompt(plan);

      const result = await deps.executeTidyPrompt({
        prompt,
        workingDir,
        extraDirs,
        writableDirs,
      });

      // Always auto-archive the temporary maintenance session so it never clutters the sidebar.
      if (result.sessionId && deps.archiveSession) {
        await deps.archiveSession(result.sessionId).catch((error) => {
          deps.log?.warn('failed to auto-archive global tidy session', { sessionId: result.sessionId, error: String(error) });
        });
      }

      deps.assertCurrent(ownerRoot);
      const finishedAt = now();

      if (!result.ok) {
        const errSummary = result.output.trim().slice(0, 500) || 'Tidy run failed';
        await mutateState(ownerRoot, (latest) => {
          // Do not advance `lastRunAt` on error so transient failures retry after the
          // short error backoff instead of stalling for a full cadence interval (e.g. 7 days).
          latest.lastErrorAt = finishedAt;
          latest.lastOutcome = 'error';
          latest.lastSummary = errSummary;
        });
        return { outcome: 'error', summary: errSummary, touchedBots: [] };
      }

      const output = result.output.trim();
      const noChanges = !output || /^NO_CHANGES\b/i.test(output);
      const touchedBots: string[] = [];

      if (!noChanges) {
        for (const bot of plan.candidates) {
          touchedBots.push(bot.displayName);
          if (deps.snapshotTeammate) {
            await deps.snapshotTeammate(bot.botId, bot.workspace, 'Tidy teammate memory and skills').catch((error) => {
              deps.log?.warn('global tidy snapshot failed (non-fatal)', { botId: bot.botId, error: String(error) });
            });
          }
        }
      }

      // Preserve concurrent file edits made by other tasks of a teammate while this tidy ran:
      // only advance `filesSince` to `finishedAt` when no concurrent activity occurred.
      const nextBotWatermarks = new Map<string, GlobalTidyBotWatermark>();
      for (const bot of plan.candidates) {
        let concurrent = true;
        if (deps.hasConcurrentActivity) {
          concurrent = await deps
            .hasConcurrentActivity(bot.botId, bot.workspace, startedAt, finishedAt, result.sessionId)
            .catch(() => true);
        } else if (noChanges) {
          concurrent = false;
        }
        nextBotWatermarks.set(bot.botId, {
          reviewedAt: startedAt,
          filesSince: concurrent ? startedAt : finishedAt,
        });
      }

      const nextOutcome: 'idle' | 'updated' = noChanges ? 'idle' : 'updated';
      const nextSummary = noChanges ? '' : output.slice(0, 1000);
      await mutateState(ownerRoot, (latest) => {
        for (const [botId, wm] of nextBotWatermarks) {
          const prev = latest.bots[botId];
          latest.bots[botId] = {
            reviewedAt: Math.max(prev?.reviewedAt ?? 0, wm.reviewedAt),
            filesSince: Math.max(prev?.filesSince ?? 0, wm.filesSince),
          };
        }
        if (plan.changedGlobalSkills.length > 0 || opts.manual) {
          latest.globalSkillsReviewedAt = Math.max(latest.globalSkillsReviewedAt, finishedAt);
        }
        latest.lastRunAt = finishedAt;
        latest.lastErrorAt = 0;
        latest.lastOutcome = nextOutcome;
        latest.lastSummary = nextSummary;
        latest.lastTouchedBots = touchedBots;
      });

      return {
        outcome: nextOutcome,
        summary: nextSummary,
        touchedBots,
      };
    } catch (error) {
      deps.log?.warn('global memory tidy failed', { error: String(error) });
      return { outcome: 'error', summary: error instanceof Error ? error.message : String(error), touchedBots: [] };
    } finally {
      running = false;
    }
  }

  function start(): void {
    stop();
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void run({ manual: false }).catch(() => {});
    }, STARTUP_CHECK_DELAY_MS);
    startupTimer.unref?.();
    periodicTimer = setInterval(() => {
      void run({ manual: false }).catch(() => {});
    }, PERIODIC_CHECK_INTERVAL_MS);
    periodicTimer.unref?.();
  }

  function stop(): void {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  return { getStatus, setCadence, run, start, stop };
}

export type GlobalMemoryTidyCoordinator = ReturnType<typeof createGlobalMemoryTidyCoordinator>;
