import type { CreateScheduleInput, Schedule } from '@cindy/maker-scheduler';

export function scheduleToUserCreateInput(
  schedule: Schedule,
  overrides: Partial<CreateScheduleInput> = {},
): CreateScheduleInput {
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    kind: schedule.kind,
    cronExpr: schedule.cronExpr,
    timezone: schedule.timezone,
    recurring: schedule.recurring,
    manual: schedule.manual,
    intervalMs: schedule.intervalMs,
    agentKind: schedule.agentKind,
    model: schedule.model,
    effort: schedule.effort,
    workspaceKind: schedule.workspaceKind,
    workingDir: schedule.workingDir,
    useWorktree: schedule.useWorktree,
    persistentSession: schedule.persistentSession,
    sessionTitleTemplate: schedule.sessionTitleTemplate,
    notify: schedule.notify,
    ...overrides,
  };
}
