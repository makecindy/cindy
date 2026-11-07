/**
 * One-time upgrade of every teammate on this computer from V1 to V2 (a teammate = a project).
 *
 * Runs at startup once the scheduler is ready. Per teammate, in order, each step safe to rerun:
 *   1. project mode on: workspace becomes a named, versioned project with the memories and skills;
 *   2. its own routines become ordinary automations of that project (same schedule, check script,
 *      model and paused/running state), then the routines are removed;
 *   3. unfinished V1-only state (open todos, workbench, working ledger) goes into one project file;
 *   4. the V1-only state files move to `v1-archive/` in the teammate's folder — kept, not deleted.
 * A receipt is written only after all steps succeed; a failure retries on the next start.
 * Copies whose main computer is another one are skipped: that computer upgrades them.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import { inArray } from 'drizzle-orm';

import { readBotProjectMode } from '../../shared/botProjectMode.js';
import { companionHomes } from '../companion-cloud/homes.js';
import { t } from '../i18n.js';
import { getDbClient } from '../localDb/client/current.js';
import { readBotSettingsProfile, updateBotProfile } from '../localDb/ipc/bots.js';
import { botProfiles } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { readEffectiveBotModelChain } from '../maker-host/bot-model-chain-settings-store.js';
import { routineTools } from '../routines/service.js';
import { getProjectAutomationLoader, getScheduler } from '../scheduler-host/index.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { botProfileDir, ensureBotWorkspaceDir } from './botProfileFolder.js';
import { ensureBotProjectAutomations, prepareBotProjectWorkspace } from './botProjectMode.js';
import {
  BOT_V2_CARRYOVER_FILE,
  buildCarryover,
  carryoverPointer,
  convertRoutine,
  type CarryoverLabel,
} from './botV2Carryover.js';
import { todoCheckRoutineId } from '../bot-autonomy/todoCheckRoutine.js';

const log = createLogger('maker-ipc:bot-v2-migration');

const RECEIPT_FILE = 'v2-migration.json';
const ARCHIVE_DIR = 'v1-archive';
/** V1-only state no V2 code reads; moved aside after the carryover is written. */
const V1_STATE = ['todos.v1.json', 'workbench.json', 'working-memory.json', 'nightly-learning.json', 'learning-history'];

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return null; }
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, () => false);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

/** Pause the project automation saved from `configId` (project files carry no paused flag). */
async function pauseProjectAutomation(workingDir: string, configId: string): Promise<void> {
  const scheduler = getScheduler();
  const target = (await scheduler.list()).find((schedule) => schedule.source === 'project'
    && schedule.projectConfigId === configId && path.resolve(schedule.workingDir ?? '') === path.resolve(workingDir));
  if (target && target.status !== 'paused') await scheduler.pause(target.id);
}

async function migrateRoutines(botId: string, workingDir: string, archiveDir: string, config: Record<string, unknown>,
  assertCurrent: () => void): Promise<string[]> {
  const routines = (await routineTools.list(botId))
    .filter((routine) => !routine.builtin && routine.id !== todoCheckRoutineId(botId));
  assertCurrent();
  if (routines.length === 0) return [];
  // Keep the exact definitions before anything is removed; a rerun after a partial run adds to them.
  await fs.mkdir(archiveDir, { recursive: true });
  const archiveFile = path.join(archiveDir, 'routines.json');
  const archived = (await readJson<Array<{ id?: unknown }>>(archiveFile)) ?? [];
  const kept = new Set(routines.map((routine) => routine.id));
  await writeAtomic(archiveFile, JSON.stringify([...archived.filter((item) => !kept.has(String(item?.id))), ...routines], null, 2));
  const [route] = await readEffectiveBotModelChain(config).catch(() => []);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const loader = getProjectAutomationLoader();
  const notes: string[] = [];
  for (const routine of routines) {
    assertCurrent();
    const converted = convertRoutine(routine, route ?? null, { now: Date.now(), timezone });
    for (const automation of converted.automations) {
      await loader.upsertSchedule(workingDir, automation.config);
      if (!automation.enabled) await pauseProjectAutomation(workingDir, automation.config.id);
    }
    if (converted.note) notes.push(converted.note);
    await routineTools.remove(botId, routine.id);
  }
  return notes;
}

async function writeCarryover(home: string, workingDir: string, routineNotes: string[]): Promise<boolean> {
  const target = path.join(workingDir, BOT_V2_CARRYOVER_FILE);
  if (await exists(target)) return true;
  const [todos, workbench, workingMemory] = await Promise.all([
    readJson<never>(path.join(home, 'todos.v1.json')),
    readJson<never>(path.join(home, 'workbench.json')),
    readJson<never>(path.join(home, 'working-memory.json')),
  ]);
  const content = buildCarryover({ todos, workbench, workingMemory, routineNotes },
    (key: CarryoverLabel) => t(`bots.homeFolder.projectMode.carryover.${key}`));
  if (!content) return false;
  await writeAtomic(target, content);
  const rules = path.join(workingDir, 'AGENTS.md');
  const current = await fs.readFile(rules, 'utf8').catch(() => null);
  if (current !== null && !current.includes(BOT_V2_CARRYOVER_FILE)) {
    await writeAtomic(rules, `${current.replace(/\s*$/, '')}\n${carryoverPointer()}\n`);
  }
  return true;
}

async function archiveV1State(home: string, archiveDir: string): Promise<void> {
  await fs.mkdir(archiveDir, { recursive: true });
  for (const name of V1_STATE) {
    const source = path.join(home, name);
    if (!await exists(source)) continue;
    const target = path.join(archiveDir, name);
    if (await exists(target)) continue;
    await fs.rename(source, target);
  }
}

export async function migrateTeammateToV2(botId: string, ownerRoot: string,
  assertCurrent: () => void = () => {}): Promise<'migrated' | 'already'> {
  const home = botProfileDir(ownerRoot, botId);
  const receiptPath = path.join(home, RECEIPT_FILE);
  if (await exists(receiptPath)) return 'already';
  const profile = await readBotSettingsProfile(botId);
  const capabilities = profile.capabilities as unknown as Record<string, unknown>;
  const displayName = profile.name;
  const legacyUserDataDir = app.getPath('userData');
  if (!readBotProjectMode(capabilities)) {
    // The ordinary save path: prepares the project and adds its memory-review automation.
    await updateBotProfile({ id: botId, capabilities: { ...capabilities, projectMode: true } });
  } else {
    // Already V2: rerun the idempotent preparation (fills anything an earlier version missed).
    const prepared = await prepareBotProjectWorkspace({ botId, displayName, ownerRoot, legacyUserDataDir });
    const [route] = await readEffectiveBotModelChain(capabilities).catch(() => []);
    await ensureBotProjectAutomations({ botId, displayName, workingDir: prepared.workingDir, route });
  }
  assertCurrent();
  const workingDir = await ensureBotWorkspaceDir(ownerRoot, botId, legacyUserDataDir);
  const archiveDir = path.join(home, ARCHIVE_DIR);
  const routineNotes = await migrateRoutines(botId, workingDir, archiveDir, capabilities, assertCurrent);
  assertCurrent();
  const carried = await writeCarryover(home, workingDir, routineNotes);
  assertCurrent();
  await archiveV1State(home, archiveDir);
  assertCurrent();
  await writeAtomic(receiptPath, JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), carried }, null, 2));
  return 'migrated';
}

let running: Promise<void> | null = null;

/** Startup entry. Never throws; each teammate is independent and retries on the next start. */
export function migrateTeammatesToV2(): Promise<void> {
  running ??= (async () => {
    const scope = activeOwnerScopeKey();
    const ownerRoot = ownerScopedUserDataPath();
    const rows = await getDbClient().drizzle.select({ id: botProfiles.id }).from(botProfiles)
      .where(inArray(botProfiles.status, ['active', 'paused']));
    const elsewhere = new Set(companionHomes.snapshot().demotedBotIds);
    for (const { id } of rows) {
      if (activeOwnerScopeKey() !== scope) return;
      if (elsewhere.has(id)) continue;
      try {
        const result = await migrateTeammateToV2(id, ownerRoot, () => {
          if (activeOwnerScopeKey() !== scope) throw new Error('OWNER_CHANGED');
        });
        if (result === 'migrated') log.info('teammate upgraded to V2', { botId: id });
      } catch (error) {
        log.warn('teammate V2 upgrade failed; retries on next start', { botId: id, error: String(error) });
      }
    }
  })().catch((error) => log.warn('teammate V2 upgrade skipped', { error: String(error) }))
    .finally(() => { running = null; });
  return running;
}
