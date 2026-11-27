/**
 * Routines that arrive with a companion from a computer still on V1 (`companion.routine.v1:*`,
 * `{ id, input, originDeviceId }`). Teammates' scheduled work is now their project's automations,
 * so each routine becomes automations of the teammate's project here (botRoutineAutomations.ts).
 */
import { parseRoutineInput, type RoutineInput } from '@cindy/maker-scheduler';

import {
  BUILTIN_FOLLOW_UP_ROUTINE_PREFIX,
  BUILTIN_NIGHTLY_LEARNING_ROUTINE_PREFIX,
  TODO_CHECK_ROUTINE_PREFIX,
} from '../../shared/botAutonomy.js';
import { findRoutineAutomations, prepareTeammateRoutineProject, writeRoutineAutomations } from '../maker-ipc/botRoutineAutomations.js';
import type { CompanionLog } from './types.js';

/** Built-ins are each computer's own; V2 has none (the daily todo check went with todos). */
const SKIPPED_PREFIXES = [BUILTIN_FOLLOW_UP_ROUTINE_PREFIX, BUILTIN_NIGHTLY_LEARNING_ROUTINE_PREFIX, TODO_CHECK_ROUTINE_PREFIX];

function readRow(value: unknown, log?: CompanionLog): { id: string; input: RoutineInput; originDeviceId: string | null } | null {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const id = row?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || SKIPPED_PREFIXES.some(prefix => id.startsWith(prefix))) return null;
  try {
    return { id, input: parseRoutineInput(row!.input), originDeviceId: typeof row!.originDeviceId === 'string' ? row!.originDeviceId : null };
  } catch {
    // One unreadable definition must not keep the whole companion from arriving.
    log?.warn('Companion routine skipped: unreadable definition');
    return null;
  }
}

/**
 * Once per routine id: automations already made from it stay as they are (the owner may have
 * edited them here). A check command saved on another computer may not exist here, so it arrives
 * paused; a plugin check and a passed one-time trigger are handled by the conversion itself.
 * Tombstones are not applied: the automations belong to this project now, not to the computer
 * that deleted the routine.
 */
export async function applyCompanionRoutines(input: {
  botId: string; ownerRoot: string; rows: unknown[]; selfDeviceId: string | null;
  assertCurrent: () => void; log?: CompanionLog;
}): Promise<void> {
  const routines = input.rows.flatMap(value => readRow(value, input.log) ?? []);
  if (!routines.length) return;
  // A teammate arriving from a V1 computer becomes a V2 project first (idempotent).
  const { workingDir, route } = await prepareTeammateRoutineProject(input.botId, input.ownerRoot, input.assertCurrent);
  const now = Date.now();
  for (const routine of routines) {
    input.assertCurrent();
    if ((await findRoutineAutomations(workingDir, routine.id)).length) continue;
    const foreignCheck = !!routine.input.preRunHook?.command?.trim() && routine.originDeviceId !== input.selfDeviceId;
    await writeRoutineAutomations(workingDir, { ...routine.input, id: routine.id, botId: input.botId, revision: 1, createdAt: now, updatedAt: now },
      { route, paused: foreignCheck });
  }
}
