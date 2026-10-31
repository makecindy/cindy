import type { FireContext, FireResult, PreRunPluginConfig, Schedule } from '@cindy/maker-scheduler';
import type { GhostControlPointResult, GhostScheduleRunPointData } from '../../shared/ghost.js';

/** 伙伴例行任务的承载任务按例行任务自己的设置在更早处询问，这里不重复问。 */
function isRoutineBackingSchedule(schedule: Schedule): boolean {
  return schedule.source === 'bot' && schedule.id.startsWith('routine-');
}

/**
 * 插件前置检查：放行返回 null；跳过返回跳过结果；停止时先发失败通知再抛错，
 * 用户配置的失败提醒与检查脚本拦下时一致。
 */
export async function screenScheduleRun(
  screen: (
    point: 'will-schedule-run',
    data: GhostScheduleRunPointData,
    target: PreRunPluginConfig,
  ) => Promise<GhostControlPointResult>,
  schedule: Schedule,
  ctx: FireContext,
  notifyStopped: (errorMsg: string) => Promise<void>,
): Promise<FireResult | null> {
  const target = schedule.preRunPlugin;
  if (!target || ctx.resumeSessionId || isRoutineBackingSchedule(schedule)) return null;
  const gate = await screen('will-schedule-run', {
    scheduleId: schedule.id,
    runId: ctx.runId,
    name: schedule.name,
    prompt: schedule.executionMode === 'script' ? '' : schedule.prompt,
    executionMode: schedule.executionMode === 'script' ? 'script' : 'agent',
    trigger: schedule.manual ? 'manual' : schedule.intervalMs ? 'interval' : schedule.recurring === false ? 'once' : 'cron',
    firedAt: ctx.firedAt,
  }, target);
  if (ctx.signal.aborted) throw new DOMException('aborted', 'AbortError');
  if (gate.action === 'allow') return null;
  const who = gate.failure
    ? `Plugin "${gate.ghostName}" was unavailable or did not answer; handled by this task's failure setting`
    : gate.reason ? `Stopped by plugin "${gate.ghostName}": ${gate.reason}` : `Stopped by plugin "${gate.ghostName}"`;
  if (gate.action === 'skip') return { sessionId: '', skipped: true, resultText: who };
  await notifyStopped(who);
  throw new Error(who);
}
