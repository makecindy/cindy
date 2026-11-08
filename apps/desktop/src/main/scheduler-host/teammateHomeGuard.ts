/**
 * Only a teammate's main computer runs it (cloud-companions.md §2.1). Its project and that
 * project's automations stay on a computer it was handed away from: there they are skipped, not
 * run and not deleted, until the teammate comes back (its local copy is no longer demoted).
 */
import type { ScheduleRunner } from '@cindy/maker-scheduler';
import { teammateFolderName, teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';

/** The teammate whose project `workingDir` is runs on another computer now. */
export function isTeammateProjectElsewhere(workingDir: string | null | undefined, demotedBotIds: readonly string[]): boolean {
  const folder = teammateFolderOfProjectPath(workingDir);
  return !!folder && demotedBotIds.some(botId => teammateFolderName(botId) === folder);
}

/** Every scheduled run (agent or script) in such a project is recorded as skipped. */
export function withTeammateHomeGuard(runner: ScheduleRunner, demotedBotIds: () => readonly string[]): ScheduleRunner {
  return {
    fire: (schedule, ctx) => isTeammateProjectElsewhere(schedule.workingDir, demotedBotIds())
      ? Promise.resolve({ sessionId: '', skipped: true, resultText: 'Skipped: this teammate runs on another computer now' })
      : runner.fire(schedule, ctx),
  };
}
