/**
 * The V1 routine engine's saved state, read and trimmed only by the V2 upgrade (botV2Migration.ts).
 *
 * The engine kept every teammate's routines of an account in one file,
 * `<account>/routines/routines.json` (a `RoutineState`), and ran each through a hidden `source: 'bot'`
 * schedule `routine-<id>`. The engine is gone; the upgrade turns each routine into project
 * automations, then removes it here together with its backing schedule.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Routine, RoutineState } from '@cindy/maker-scheduler';

import { createLogger } from '../logger.js';
import { getScheduler, getScheduleStorage } from '../scheduler-host/index.js';

const log = createLogger('maker-ipc:bot-v1-routines');

export function v1RoutinesFile(ownerRoot: string): string {
  return path.join(ownerRoot, 'routines', 'routines.json');
}

/** null: no file. An unparseable file is left untouched for manual recovery and reads as empty. */
async function readState(file: string): Promise<RoutineState | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const state = JSON.parse(raw) as Partial<RoutineState> | null;
    if (!state || typeof state !== 'object' || !Array.isArray(state.routines)) throw new Error('not a routine state');
    return state as RoutineState;
  } catch (error) {
    log.warn('V1 routines file unreadable; left as it is', { error: String(error) });
    return null;
  }
}

export async function readV1Routines(ownerRoot: string, botId: string): Promise<Routine[]> {
  const state = await readState(v1RoutinesFile(ownerRoot));
  return (state?.routines ?? []).filter((routine): routine is Routine => !!routine && typeof routine === 'object'
    && routine.botId === botId && typeof routine.id === 'string');
}

/** Rewrites of one file run one at a time in this process (several teammates may upgrade at once). */
const rewrites = new Map<string, Promise<void>>();

function serialized(file: string, run: () => Promise<void>): Promise<void> {
  const next = (rewrites.get(file) ?? Promise.resolve()).catch(() => undefined).then(run);
  rewrites.set(file, next);
  return next.finally(() => { if (rewrites.get(file) === next) rewrites.delete(file); });
}

/** Delete one routine: first its backing schedule, then the routine with its runs and timers. */
export async function removeV1Routine(ownerRoot: string, id: string): Promise<void> {
  const scheduleId = `routine-${id}`;
  // Hidden `source: 'bot'` schedules answer "not found" to ordinary callers.
  if (await getScheduleStorage().get(scheduleId)) await getScheduler().delete(scheduleId, { internalRoutine: true });
  const file = v1RoutinesFile(ownerRoot);
  await serialized(file, async () => {
    const state = await readState(file);
    if (!state?.routines.some((routine) => routine?.id === id)) return;
    const next: RoutineState = {
      ...state,
      routines: state.routines.filter((routine) => routine?.id !== id),
      runs: (state.runs ?? []).filter((run) => run?.routineId !== id),
      next: Object.fromEntries(Object.entries(state.next ?? {}).filter(([key]) => !key.startsWith(`${id}:`))),
    };
    // Same atomic write as the engine's store: private temp file, then rename over the original.
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}
