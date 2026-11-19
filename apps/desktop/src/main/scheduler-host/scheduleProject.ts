import { workingDirEquals } from '../../shared/workingDir.js';
import type { Schedule } from '@cindy/maker-scheduler';
import type { projectForNewTask } from '../mcp-integrations/projectManagementCore.js';

export type ScheduleProjectLookup = typeof projectForNewTask;

/** Resolve the original project or checkout before using a per-run execution directory. */
export async function projectForScheduledTask(schedule: Schedule, lookup?: ScheduleProjectLookup) {
  if (!lookup) return { workspaceKind: 'dialogue' as const, projectDir: null };
  if (schedule.inheritedProjectDir) {
    const inherited = await lookup(schedule.inheritedProjectDir);
    if (workingDirEquals(inherited.projectDir, schedule.inheritedProjectDir)) return inherited;
  }
  return lookup(schedule.workingDir);
}
