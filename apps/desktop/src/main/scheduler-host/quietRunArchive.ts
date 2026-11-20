/**
 * A quiet round (skipped by its pre-run check or silenced by the agent) leaves nothing for
 * the user, so it must not leave an open task behind:
 * - a bound target that was archived and only restored for this round goes back to archived;
 * - an automation that creates a new task per round archives that new task.
 * Notified, failed, deferred and aborted rounds keep their task, and so does any user
 * activity in it meanwhile. Rules: docs/product-rules/archive-pauses-automations.md.
 */
import type { ScheduleRunner } from '@cindy/maker-scheduler';

export interface QuietRunArchiveDeps {
  /** Status of the target before the round restores it; null when it cannot be read. */
  targetStatus(sessionId: string): Promise<string | null>;
  isRunSilenced(runId: string): boolean;
  /** Archive again unless the user touched the task since `sinceMs` (rechecked under the route lock). */
  archiveIfUntouched(sessionId: string, sinceMs: number): Promise<void>;
  warn(message: string, meta: Record<string, unknown>): void;
}

export function withQuietRunArchive(runner: ScheduleRunner, deps: QuietRunArchiveDeps): ScheduleRunner {
  return {
    fire: async (schedule, ctx) => {
      const target = ctx.resumeSessionId ? undefined : schedule.targetSessionId;
      const wasArchived = target
        ? (await deps.targetStatus(target).catch(() => null)) === 'archived'
        : false;
      const result = await runner.fire(schedule, ctx);
      if (result.deferred || ctx.signal.aborted) return result;
      if (!result.skipped && !deps.isRunSilenced(ctx.runId)) return result;
      // Per-round task: created by this round of an unbound, non-persistent automation.
      const perRoundTask = !schedule.targetSessionId && !schedule.persistentSession && !ctx.resumeSessionId
        ? result.sessionId || undefined
        : undefined;
      const quietTask = target && wasArchived ? target : perRoundTask;
      if (!quietTask) return result;
      try {
        await deps.archiveIfUntouched(quietTask, ctx.firedAt);
      } catch (error) {
        deps.warn('[scheduler-host] re-archive after quiet run failed (non-fatal)', {
          scheduleId: schedule.id,
          runId: ctx.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return result;
    },
  };
}
