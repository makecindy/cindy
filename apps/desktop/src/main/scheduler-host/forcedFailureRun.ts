import type { Logger, Notifier, Schedule, ScheduleRun } from '@cindy/maker-scheduler';

/**
 * 把「卡死守卫强制收口」这件事翻译成一条**终态** run,供通知渠道渲染。
 *
 * 为什么不能直接把库里读回的行透传给 notifier:这条补发出口最要紧的调用场景恰恰是
 * 「终态落库失败 / updateRun 返回 null」——此时库里那行还停在 `running`、也没有
 * `errorMsg`。透传的话飞书会把一次卡死渲染成「运行中」、移动端拿不到任何卡死详情,
 * 补发通知等于白发(review #944 第十八轮 P1)。
 *
 * 规则:行已是终态就原样用(内容与运行历史一致);非终态或行根本不存在时,复用行里的
 * 事实字段(firedAt / sessionId / 计费快照),只把状态与错误按本次强制收口的真实结果覆盖。
 */
export function buildForcedFailureRun(input: {
  scheduleId: string;
  runId: string;
  errorMsg: string;
  /** 从存储读回的 run 行;查不到传 undefined。 */
  run: ScheduleRun | undefined;
  now: number;
}): ScheduleRun {
  const { scheduleId, runId, errorMsg, run, now } = input;
  if (run !== undefined && run.status !== 'running') return run;
  return {
    ...(run ?? { id: runId, scheduleId, firedAt: now }),
    status: 'failed',
    finishedAt: run?.finishedAt ?? now,
    errorMsg,
  };
}

/**
 * 所有非静默提醒与失败通知出口共用的单一收口：
 * 调度派发阶段不再提前写 userSendAt，因此每次实际通知用户或失败（finalizeRun /
 * notifyFailureSilent / notifyForcedFailure / notifyPluginStop）都经此在发通知前
 * 补记任务活动时间，确保稍后处理中的绑定任务被唤回且写入失败不阻塞通知投递。
 */
export async function deliverScheduleRunNotification(input: {
  schedule: Schedule;
  run: ScheduleRun;
  now?: number;
  notifier: Notifier;
  touchUserSendInDb?: (sessionId: string, atMs?: number) => Promise<void>;
  logger?: Logger;
  logTag?: string;
  swallowNotifyError?: boolean;
}): Promise<ScheduleRun> {
  const targetSessionId = input.run.sessionId || input.schedule.targetSessionId;
  if (targetSessionId && input.touchUserSendInDb) {
    const activityAt = Math.max(input.run.firedAt, input.run.finishedAt ?? input.now ?? 0);
    try {
      await input.touchUserSendInDb(targetSessionId, activityAt);
    } catch (err) {
      input.logger?.warn?.(input.logTag ?? '[scheduler-host] touchUserSend before notify failed', {
        scheduleId: input.schedule.id,
        runId: input.run.id,
        sessionId: targetSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (input.swallowNotifyError) {
    try {
      await input.notifier.notify(input.schedule, input.run);
    } catch (err) {
      input.logger?.warn?.('notifier.notify threw (should not happen)', err);
    }
  } else {
    await input.notifier.notify(input.schedule, input.run);
  }
  return input.run;
}

/**
 * 卡死守卫强制收口绕过 runner，但与 finalizeRun 共享「非静默/失败才推进任务时间」的不变量：
 * 派发阶段不再提前写 userSendAt，因此这里在发失败通知前补记活动时间，确保稍后处理中的任务被唤回。
 */
export async function deliverForcedFailureNotification(input: {
  schedule: Schedule;
  runId: string;
  errorMsg: string;
  run: ScheduleRun | undefined;
  now: number;
  notifier: Notifier;
  touchUserSendInDb?: (sessionId: string, atMs?: number) => Promise<void>;
  logger?: Logger;
}): Promise<ScheduleRun> {
  const forcedRun = buildForcedFailureRun({
    scheduleId: input.schedule.id,
    runId: input.runId,
    errorMsg: input.errorMsg,
    run: input.run,
    now: input.now,
  });
  return deliverScheduleRunNotification({
    schedule: input.schedule,
    run: forcedRun,
    now: input.now,
    notifier: input.notifier,
    touchUserSendInDb: input.touchUserSendInDb,
    logger: input.logger,
    logTag: '[scheduler-host] touchUserSend on forced failure failed',
  });
}
