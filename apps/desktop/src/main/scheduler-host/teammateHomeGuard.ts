/**
 * Only a teammate's main computer runs it (cloud-companions.md §2.1). Its project and that
 * project's automations stay on a computer it was handed away from: there they are skipped, not
 * run and not deleted, until the teammate comes back (its local copy is no longer demoted).
 * A paused or deleted teammate does not run its project's automations either.
 */
import type { ScheduleRunner } from '@cindy/maker-scheduler';
import { teammateFolderName, teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';

import type { TeammateProjectState } from './ownTeammateProject.js';

/** The teammate whose project `workingDir` is runs on another computer now. */
export function isTeammateProjectElsewhere(workingDir: string | null | undefined, demotedBotIds: readonly string[]): boolean {
  const folder = teammateFolderOfProjectPath(workingDir);
  return !!folder && demotedBotIds.some(botId => teammateFolderName(botId) === folder);
}

/** Every scheduled run (agent or script) in such a project is recorded as skipped. */
export function withTeammateHomeGuard(runner: ScheduleRunner, demotedBotIds: () => readonly string[],
  teammateState: (workingDir: string | null | undefined) => Promise<TeammateProjectState | null> = async () => null): ScheduleRunner {
  const skip = (resultText: string) => ({ sessionId: '', skipped: true, resultText });
  return {
    fire: async (schedule, ctx) => {
      if (isTeammateProjectElsewhere(schedule.workingDir, demotedBotIds())) {
        return skip('Skipped: this buddy runs on another computer now');
      }
      const state = teammateFolderOfProjectPath(schedule.workingDir) ? await teammateState(schedule.workingDir) : null;
      if (state === 'stopped') return skip('Skipped: this buddy is paused');
      if (state === 'deleted') return skip('Skipped: this buddy was deleted');
      return runner.fire(schedule, ctx);
    },
  };
}
