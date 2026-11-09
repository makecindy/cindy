/**
 * One-time upgrade of every teammate on this computer from V1 to V2 (a teammate = a project).
 *
 * Runs at startup once the scheduler is ready. Per teammate, in order, each step safe to rerun:
 *   1. project mode on: workspace becomes a named, versioned project with the memories and skills;
 *   2. its own routines become ordinary automations of that project (same schedule, check script,
 *      model and paused/running state), then the routines are removed; retired built-in ones
 *      (follow-up, nightly learning, daily todo check) are removed without becoming automations;
 *   3. unfinished V1-only state (open todos, workbench, working ledger) goes into one project file;
 *   4. the V1-only state files move to `v1-archive/` in the teammate's folder — kept, not deleted.
 * A receipt is written only after all steps succeed; a failure retries on the next start.
 * A teammate upgraded before its project memory lived inside the project gets that one move here.
 * Copies whose main computer is another one are skipped: that computer upgrades them.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import { inArray } from 'drizzle-orm';
import type { Routine } from '@cindy/maker-scheduler';

import { readBotProjectMode } from '../../shared/botProjectMode.js';
import { companionHomes } from '../companion-cloud/homes.js';
import { t } from '../i18n.js';
import { getDbClient } from '../localDb/client/current.js';
import { readBotSettingsProfile, setNewTeammateSetup, updateBotProfile } from '../localDb/ipc/bots.js';
import { botProfiles } from '../localDb/schema.js';
import { createLogger } from '../logger.js';
import { readEffectiveBotModelChain } from '../maker-host/bot-model-chain-settings-store.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { botProfileDir, ensureBotWorkspaceDir } from './botProfileFolder.js';
import { ensureBotProjectAutomations, moveTeammateMemoryIntoProject, prepareBotProjectWorkspace } from './botProjectMode.js';
import { TEAMMATE_V2_RECEIPT_FILE, teammateWorkspaceDir } from './botProjectMemory.js';
import { writeRoutineAutomations } from './botRoutineAutomations.js';
import { readV1Routines, removeV1Routine } from './botV1Routines.js';
import {
  BOT_V2_CARRYOVER_FILE,
  buildCarryover,
  carryoverPointer,
  type CarryoverLabel,
} from './botV2Carryover.js';
import { todoCheckRoutineId } from '../bot-autonomy/todoCheckRoutine.js';

const log = createLogger('maker-ipc:bot-v2-migration');

const RECEIPT_FILE = TEAMMATE_V2_RECEIPT_FILE;
const ARCHIVE_DIR = 'v1-archive';
/** V1-only state no V2 code reads; moved aside after the carryover is written. */
const V1_STATE = ['todos.v1.json', 'working-memory.json', 'nightly-learning.json', 'learning-history'];
/** Still read by V2 (its directories are the linked projects): archived as a copy, left in place. */
const V1_COPIED_STATE = ['workbench.json'];

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

/**
 * Routines of an imported teammate that must start paused: a takeover not finished (its source
 * still runs), a job with open issues, or one relying on its source's script, command or monitor,
 * which the removed import runtime ran and a project automation cannot. null: all of them (the
 * private import data cannot be read, so none may start unattended).
 */
async function importedRoutinesToPause(ownerRoot: string, botId: string,
  assertCurrent: () => void): Promise<Map<string, string | null> | null> {
  const [{ companionEnvironmentStore }, { importedRuntimeRequired }] = await Promise.all([
    import('../bot-import/runtime.js'), import('../bot-import/sourceAutomations.js')]);
  const environment = await companionEnvironmentStore.read(ownerRoot, botId, assertCurrent).catch(() => null);
  if (environment === null) return null;
  const paused = new Map<string, string | null>();
  for (const [id, binding] of Object.entries(environment?.automations ?? {})) {
    if (importedRuntimeRequired(binding.kind, binding.original)) paused.set(id, 'needs the script, command or monitor it ran at its source; created paused');
    else if (binding.issues?.length || binding.handover !== 'ready') paused.set(id, null);
  }
  return paused;
}

async function migrateRoutines(botId: string, ownerRoot: string, workingDir: string, archiveDir: string,
  config: Record<string, unknown>, assertCurrent: () => void): Promise<string[]> {
  const all = await readV1Routines(ownerRoot, botId);
  assertCurrent();
  // Retired built-ins have no V2 counterpart (the project's own memory review replaced nightly
  // learning); only their leftover definitions and backing schedules go.
  const retired = (routine: Routine) => routine.builtin === 'nightly-learning' || routine.builtin === 'follow-up'
    || routine.id === todoCheckRoutineId(botId);
  const notesFile = path.join(archiveDir, 'routine-notes.json');
  const savedNotes = ((await readJson<unknown[]>(notesFile)) ?? []).filter((note): note is string => typeof note === 'string');
  if (all.length === 0) return savedNotes;
  // Keep the exact definitions before anything is removed; a rerun after a partial run adds to them.
  await fs.mkdir(archiveDir, { recursive: true });
  const archiveFile = path.join(archiveDir, 'routines.json');
  const archived = (await readJson<Array<{ id?: unknown }>>(archiveFile)) ?? [];
  const kept = new Set(all.map((routine) => routine.id));
  await writeAtomic(archiveFile, JSON.stringify([...archived.filter((item) => !kept.has(String(item?.id))), ...all], null, 2));
  const [route] = await readEffectiveBotModelChain(config).catch(() => []);
  const imported = botId.startsWith('import_') ? await importedRoutinesToPause(ownerRoot, botId, assertCurrent) : new Map<string, string | null>();
  const notes: string[] = [];
  for (const routine of all) {
    assertCurrent();
    if (!retired(routine)) {
      const hold = imported === null || imported.has(routine.id);
      const written = await writeRoutineAutomations(workingDir, routine, { route: route ?? null, paused: hold });
      const reason = imported?.get(routine.id);
      const note = !reason || !routine.enabled ? written.note
        : written.note ? `${written.note}; ${reason}` : `${routine.name}: ${reason}`;
      if (note) {
        // Kept on disk before the routine is removed, so a rerun after a partial run still lists it.
        notes.push(note);
        await writeAtomic(notesFile, JSON.stringify([...new Set([...savedNotes, ...notes])], null, 2));
      }
    }
    await removeV1Routine(ownerRoot, routine.id);
  }
  return [...new Set([...savedNotes, ...notes])];
}

async function pointRulesToCarryover(workingDir: string): Promise<void> {
  const rules = path.join(workingDir, 'AGENTS.md');
  const current = await fs.readFile(rules, 'utf8').catch(() => null);
  if (current !== null && !current.includes(BOT_V2_CARRYOVER_FILE)) {
    await writeAtomic(rules, `${current.replace(/\s*$/, '')}\n${carryoverPointer()}\n`);
  }
}

/**
 * Todos a computer still on V1 uploaded, arriving here: the open ones join the project's
 * `CARRYOVER.md` once (the teammate becomes a project first), as a local upgrade carries them.
 */
export async function carryLegacyTodos(botId: string, ownerRoot: string, items: unknown[],
  assertCurrent: () => void = () => {}): Promise<void> {
  const content = buildCarryover({ todos: { items } as never, routineNotes: [] },
    (key: CarryoverLabel) => t(`bots.homeFolder.projectMode.carryover.${key}`));
  if (!content) return;
  await migrateTeammateToV2(botId, ownerRoot, assertCurrent);
  assertCurrent();
  const workingDir = await ensureBotWorkspaceDir(ownerRoot, botId, app.getPath('userData'));
  const target = path.join(workingDir, BOT_V2_CARRYOVER_FILE);
  const current = await fs.readFile(target, 'utf8').catch(() => null);
  if (current?.includes(content.trim())) return;
  assertCurrent();
  await writeAtomic(target, current ? `${current.replace(/\s*$/, '')}\n\n${content}` : content);
  await pointRulesToCarryover(workingDir);
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
  await pointRulesToCarryover(workingDir);
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
  for (const name of V1_COPIED_STATE) {
    const source = path.join(home, name);
    const target = path.join(archiveDir, name);
    if (await exists(source) && !await exists(target)) await fs.copyFile(source, target);
  }
}

/** One upgrade per teammate at a time: import and cloud arrival also ask for it (botRoutineAutomations.ts). */
const upgrading = new Map<string, Promise<unknown>>();

export function migrateTeammateToV2(botId: string, ownerRoot: string,
  assertCurrent: () => void = () => {}): Promise<'migrated' | 'already'> {
  const key = `${ownerRoot}\n${botId}`;
  const next = (upgrading.get(key) ?? Promise.resolve()).catch(() => undefined)
    .then(() => migrateTeammateOnce(botId, ownerRoot, assertCurrent));
  upgrading.set(key, next);
  return next.finally(() => { if (upgrading.get(key) === next) upgrading.delete(key); });
}

async function migrateTeammateOnce(botId: string, ownerRoot: string,
  assertCurrent: () => void): Promise<'migrated' | 'already'> {
  const home = botProfileDir(ownerRoot, botId);
  const receiptPath = path.join(home, RECEIPT_FILE);
  if (await exists(receiptPath)) {
    // Upgraded before its project memory moved into the project folder: move it once (idempotent).
    const workspace = teammateWorkspaceDir(ownerRoot, botId);
    if (await exists(workspace)) await moveTeammateMemoryIntoProject({ botId, ownerRoot, workspace });
    // A build that still had the switch may have turned it off after the upgrade: V1 is gone.
    const upgraded = await readBotSettingsProfile(botId);
    if (!readBotProjectMode(upgraded.capabilities as unknown as Record<string, unknown>)) {
      await updateBotProfile({ id: botId, capabilities: { projectMode: true } });
    }
    return 'already';
  }
  const profile = await readBotSettingsProfile(botId);
  const capabilities = profile.capabilities as unknown as Record<string, unknown>;
  const displayName = profile.name;
  const legacyUserDataDir = app.getPath('userData');
  // The project (with copies of the memories and skills) before the flag: from the flag on, the
  // teammate's memories and skills are read from the project, also by the cloud upload, so they
  // must already be there. Idempotent; a failure retries next start.
  const prepared = await prepareBotProjectWorkspace({ botId, displayName, ownerRoot, legacyUserDataDir });
  assertCurrent();
  // Only the flag: the rest of the stored configuration (model, permissions, …) stays as it is.
  if (!readBotProjectMode(capabilities)) await updateBotProfile({ id: botId, capabilities: { projectMode: true } });
  const [route] = await readEffectiveBotModelChain(capabilities).catch(() => []);
  await ensureBotProjectAutomations({ botId, displayName, workingDir: prepared.workingDir, route });
  assertCurrent();
  const workingDir = await ensureBotWorkspaceDir(ownerRoot, botId, legacyUserDataDir);
  const archiveDir = path.join(home, ARCHIVE_DIR);
  const routineNotes = await migrateRoutines(botId, ownerRoot, workingDir, archiveDir, capabilities, assertCurrent);
  assertCurrent();
  const carried = await writeCarryover(home, workingDir, routineNotes);
  assertCurrent();
  await archiveV1State(home, archiveDir);
  assertCurrent();
  await writeAtomic(receiptPath, JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), carried }, null, 2));
  return 'migrated';
}

// A teammate created from now on is a project from the start (bots.ts calls this once it is saved).
setNewTeammateSetup(migrateTeammateToV2);

let running: { scope: string; promise: Promise<void> } | null = null;

/** Startup entry. Never throws; each teammate is independent and retries on the next start. */
export function migrateTeammatesToV2(): Promise<void> {
  const scope = activeOwnerScopeKey();
  if (running?.scope === scope) return running.promise;
  const promise = (async () => {
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
    .finally(() => { if (running?.promise === promise) running = null; });
  running = { scope, promise };
  return promise;
}
