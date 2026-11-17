/**
 * Local side of a V2 teammate's project for cloud companions (project.ts): where its memories are,
 * its rules file, its automations in the scheduler, and the upgrade on arrival.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Schedule } from '@cindy/maker-scheduler';

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createSnapshotDetailed } from '../git-snapshot/gitSnapshotService.js';
import { botProfileMemoryDir } from '../maker-ipc/botProfileFolder.js';
import {
  hasTeammateMemoryMoved,
  legacyTeammateProjectMemoryDir,
  teammateProjectMemoryDir,
  unlinkedTeammateProjectMemoryDir,
  teammateWorkspaceDir as teammateWorkspace,
} from '../maker-ipc/botProjectMemory.js';
import { BOT_V2_CARRYOVER_FILE } from '../maker-ipc/botV2Carryover.js';
import { readTeammateProjectMode } from '../maker-ipc/botWorkspaceRuntime.js';
import type { ProjectScheduleConfig } from '../scheduler-host/project-automation-loader.js';
import { PROJECT_AUTOMATION_REL_SEGMENTS } from '../../shared/projectAutomationPaths.js';
import type { CompanionProjectIo } from './project.js';

const RULES_FILE = 'AGENTS.md';

/** Loaded on use: the scheduler host pulls in services the companion host does not otherwise need. */
const schedulerHost = () => import('../scheduler-host/index.desktop.js');

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/**
 * What the memory service holds for the teammate, first folder winning: the folder it writes to
 * now (a V2 teammate's project memory) and, until the one-time move into the project finished, the
 * place the store still copies records from on first use.
 */
export async function teammateStoreMemoryDirs(ownerRoot: string, botId: string): Promise<string[]> {
  if (!await readTeammateProjectMode(botId)) return [botProfileMemoryDir(ownerRoot, botId)];
  const workspace = teammateWorkspace(ownerRoot, botId);
  return await hasTeammateMemoryMoved(ownerRoot, botId)
    ? [unlinkedTeammateProjectMemoryDir(workspace)]
    : [unlinkedTeammateProjectMemoryDir(workspace), await legacyTeammateProjectMemoryDir(ownerRoot, workspace)];
}

/** Before a take-over replaces it: the project's memories, skills and rules (its other files stay as they are). */
export async function backupTeammateProject(ownerRoot: string, botId: string, target: string): Promise<void> {
  if (!await readTeammateProjectMode(botId)) return;
  const workspace = teammateWorkspace(ownerRoot, botId);
  const copies: Array<[string, string]> = [
    [teammateProjectMemoryDir(workspace), 'project-memories'],
    [path.join(workspace, '.agents', 'skills'), 'project-skills'],
    [path.join(workspace, RULES_FILE), `project-${RULES_FILE}`],
  ];
  for (const [source, name] of copies) {
    await fs.cp(source, path.join(target, name), { recursive: true }).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}

function sameDir(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function projectSchedules(workingDir: string): Promise<Schedule[]> {
  return (await (await schedulerHost()).getScheduler().list())
    .filter(schedule => schedule.source === 'project' && sameDir(schedule.workingDir, workingDir));
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

export function companionProjectIo(): CompanionProjectIo {
  return {
    projectDir: async (botId) => (await readTeammateProjectMode(botId)) ? teammateWorkspace(ownerScopedUserDataPath(), botId) : null,
    prepareProject: async (botId, assertCurrent) => {
      // The teammate becomes a project here first (idempotent): the same path routines take.
      const { prepareTeammateRoutineProject } = await import('../maker-ipc/botRoutineAutomations.js');
      return (await prepareTeammateRoutineProject(botId, ownerScopedUserDataPath(), assertCurrent)).workingDir;
    },
    readRules: (workingDir) => fs.readFile(path.join(workingDir, RULES_FILE), 'utf8')
      .catch((error: unknown) => { if (missing(error)) return null; throw error; }),
    writeRules: (workingDir, content) => writeAtomic(path.join(workingDir, RULES_FILE), content),
    readCarryover: (workingDir) => fs.readFile(path.join(workingDir, BOT_V2_CARRYOVER_FILE), 'utf8')
      .catch((error: unknown) => { if (missing(error)) return null; throw error; }),
    writeCarryover: (workingDir, content) => writeAtomic(path.join(workingDir, BOT_V2_CARRYOVER_FILE), content),
    snapshot: async (workingDir, label) => {
      await createSnapshotDetailed(workingDir, { label, meta: { sessionId: 'bot-project', kind: 'manual' } });
    },
    automations: async (workingDir) => {
      // No file is no automations; a file that cannot be read must not look like none.
      try { await fs.stat(path.join(workingDir, ...PROJECT_AUTOMATION_REL_SEGMENTS)); } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      const host = await schedulerHost();
      const configs = await host.getProjectAutomationLoader().loadProjectSchedules(workingDir);
      if (!configs) throw new Error('AUTOMATIONS_UNREADABLE');
      const schedules = await projectSchedules(workingDir);
      return configs.map(config => ({ config: config as unknown as { id: string } & Record<string, unknown>,
        paused: schedules.find(schedule => schedule.projectConfigId === config.id)?.status === 'paused' }));
    },
    upsertAutomation: async (workingDir, config) => {
      await (await schedulerHost()).getProjectAutomationLoader().upsertSchedule(workingDir, config as unknown as ProjectScheduleConfig, { keepUnreadable: true });
    },
    removeAutomation: async (workingDir, configId) => {
      await (await schedulerHost()).getProjectAutomationLoader().removeSchedule(workingDir, configId);
    },
    setAutomationPaused: async (workingDir, configId, paused) => {
      const scheduler = (await schedulerHost()).getScheduler();
      const target = (await projectSchedules(workingDir)).find(schedule => schedule.projectConfigId === configId);
      if (!target) return;
      if (paused && target.status === 'active') await scheduler.pause(target.id);
      else if (!paused && target.status === 'paused') await scheduler.resume(target.id);
    },
  };
}

/** The teammate arrived here: it becomes a V2 teammate now (idempotent through its receipt). */
export async function upgradeArrivedTeammate(botId: string): Promise<void> {
  const scope = activeOwnerScopeKey();
  const { migrateTeammateToV2 } = await import('../maker-ipc/botV2Migration.js');
  await migrateTeammateToV2(botId, ownerScopedUserDataPath(), () => {
    if (activeOwnerScopeKey() !== scope) throw new Error('OWNER_CHANGED');
  });
}
