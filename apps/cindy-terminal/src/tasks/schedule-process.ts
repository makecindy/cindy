import { executePreRunHook } from '@cindy/app-runtime/schedulePreRunHook';
import type { FireContext, Schedule } from '@cindy/maker-scheduler';
export async function preRun(schedule: Schedule, ctx: FireContext, cwd: string) {
  if (!schedule.preRunHook?.command?.trim()) return null;
  ctx.signal.throwIfAborted();
  if (ctx.canDispatch?.() === false) throw new Error('SCHEDULE_OWNER_CHANGED');
  return executePreRunHook({ command: schedule.preRunHook.command, timeoutMs: schedule.preRunHook.timeoutMs,
    cwd, signal: ctx.signal, stdinPayload: { event: 'schedule-pre-run', scheduleId: schedule.id,
      scheduleName: schedule.name, runId: ctx.runId, firedAt: ctx.firedAt, workingDir: cwd,
      lastFinishedAt: schedule.lastFinishedAt } });
}
