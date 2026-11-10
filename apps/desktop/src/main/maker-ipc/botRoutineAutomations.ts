/**
 * A V1 routine definition becomes ordinary automations of a teammate's project. Shared by the V2
 * upgrade (the teammate's own routines), agent import (Hermes / OpenClaw jobs and bundled packages)
 * and companion cloud (routines uploaded by a computer that still runs V1).
 *
 * The automations of one routine are found again by their stable config ids
 * (`migratedAutomationId`: `routine-<base>`, `routine-<base>-2`, …), so the callers stay idempotent
 * and can pause or resume them later.
 */
import path from 'node:path';

import { app } from 'electron';
import type { Routine, Schedule } from '@cindy/maker-scheduler';

import type { BotModelRoute } from '../../shared/botModelChain.js';
import { readBotSettingsProfile } from '../localDb/ipc/bots.js';
import { readEffectiveBotModelChain } from '../maker-host/bot-model-chain-settings-store.js';
import { ensureBotWorkspaceDir } from './botProfileFolder.js';
import { convertRoutine, migratedAutomationId } from './botV2Carryover.js';

// Loaded lazily: the scheduler host pulls in Electron-only services that import paths must not.
const schedulerHost = () => import('../scheduler-host/index.desktop.js');

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function sameDir(a: string | undefined, b: string): boolean {
  return !!a && path.resolve(a) === path.resolve(b);
}

/** Whether a project automation config id was written for this routine. */
export function isRoutineAutomationId(configId: string | undefined, routineId: string): boolean {
  if (!configId) return false;
  const base = migratedAutomationId(routineId, 0);
  return configId === base || (configId.startsWith(`${base}-`) && /^\d+$/.test(configId.slice(base.length + 1)));
}

/** The scheduled automations this routine became in the project at `workingDir`. */
export async function findRoutineAutomations(workingDir: string, routineId: string): Promise<Schedule[]> {
  return (await (await schedulerHost()).getScheduler().list()).filter((schedule) => schedule.source === 'project'
    && sameDir(schedule.workingDir, workingDir) && isRoutineAutomationId(schedule.projectConfigId, routineId));
}

/** Pause the project automation saved from `configId` (project files carry no paused flag). */
async function pauseProjectAutomation(workingDir: string, configId: string): Promise<void> {
  const scheduler = (await schedulerHost()).getScheduler();
  const target = (await scheduler.list()).find((schedule) => schedule.source === 'project'
    && schedule.projectConfigId === configId && sameDir(schedule.workingDir, workingDir));
  if (target && target.status === 'active') await scheduler.pause(target.id);
}

/**
 * Write one routine as automations of the project at `workingDir`. Those that must not run (the
 * routine was paused, lost a check it relied on, or `paused` is asked) are paused right away.
 */
export async function writeRoutineAutomations(workingDir: string, routine: Routine, options: {
  route: BotModelRoute | null; paused?: boolean; now?: number; timezone?: string;
  /** V1 timers (`<routine>:<trigger>` → when it was due next), keeping an interval's beat. */
  next?: Record<string, number>;
}): Promise<{ configIds: string[]; note: string | null }> {
  const converted = convertRoutine(routine, options.route,
    { now: options.now ?? Date.now(), timezone: options.timezone ?? localTimezone(), next: options.next });
  const loader = (await schedulerHost()).getProjectAutomationLoader();
  for (const automation of converted.automations) {
    await loader.upsertSchedule(workingDir, automation.config, { keepUnreadable: true });
    if (options.paused || !automation.enabled) await pauseProjectAutomation(workingDir, automation.config.id);
  }
  return { configIds: converted.automations.map((automation) => automation.config.id), note: converted.note };
}

/** Resume or pause every automation of one routine; returns those found (none: nothing changed). */
export async function setRoutineAutomationsRunning(workingDir: string, routineId: string, running: boolean): Promise<Schedule[]> {
  const scheduler = (await schedulerHost()).getScheduler();
  const found = await findRoutineAutomations(workingDir, routineId);
  for (const schedule of found) {
    if (running && schedule.status === 'paused') await scheduler.resume(schedule.id);
    else if (!running && schedule.status === 'active') await scheduler.pause(schedule.id);
  }
  return found;
}

/**
 * The teammate's project, ready for routine automations: a teammate not upgraded yet (created
 * since the last start, or arriving from another computer) becomes V2 first. The upgrade is
 * idempotent through its receipt and takes no teammate lock, so a caller may hold one.
 */
export async function prepareTeammateRoutineProject(botId: string, ownerRoot: string,
  assertCurrent: () => void = () => {}): Promise<{ workingDir: string; route: BotModelRoute | null }> {
  // Loaded lazily: the upgrade itself writes routines through this module.
  const { migrateTeammateToV2 } = await import('./botV2Migration.js');
  await migrateTeammateToV2(botId, ownerRoot, assertCurrent);
  assertCurrent();
  const workingDir = await ensureBotWorkspaceDir(ownerRoot, botId, app.getPath('userData'));
  const profile = await readBotSettingsProfile(botId);
  assertCurrent();
  const [route] = await readEffectiveBotModelChain(profile.capabilities as unknown as Record<string, unknown>).catch(() => []);
  return { workingDir, route: route ?? null };
}
