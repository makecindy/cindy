import type { ScheduleRun } from '@cindy/maker-scheduler';

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
