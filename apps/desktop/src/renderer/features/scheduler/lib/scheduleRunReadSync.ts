/**
 * scheduleRunReadSync — 「标记 run 已读」动作与未读派生态的 renderer 本地同步总线。
 * ---------------------------------------------------------------------------
 * 背景(2026-07 双实例红点卡死):schedule 未读红点的消费方(sidebar 会话索引 /
 * 未读计数 / run 历史)都只靠 main 广播的 scheduler 事件刷新;而 main 的
 * markRunRead / markAllRunsRead 在"DB 里已是已读"时 no-op 且**不广播**(避免
 * 无效 refetch)。单实例下没问题——已读一定是本实例自己标的,广播早就发过;
 * 但 dev / release 双实例共库时,另一个实例把 run 标已读(或静默 run 生而已读)
 * 不会产生本实例的事件,本实例 renderer 的未读快照就此过期,且此后所有消红点
 * 入口(点开会话 / 全部标已读)全部命中 no-op 短路,永远等不到那条 'read' 事件
 * ——红点变成不可自愈的僵尸。
 *
 * 解法:标记已读的**动作发起方**在 IPC settle 后无条件通知本地订阅者刷新,
 * 不依赖 main 的广播判断。no-op 时多刷一次是幂等小查询;换来的不变量是
 * "用户做了消红点手势 → 本 renderer 的未读态必与 DB 对齐"。
 * main 侧广播语义保持不变(仍只在真实更新时发,其他窗口/消费方照旧)。
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** 订阅"刚发生了一次标记已读动作"。返回退订函数。 */
export function subscribeScheduleRunReadSync(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export interface MarkScheduleRunsReadResult {
  processed: string[];
  failed: string[];
  firstError?: string;
}

/**
 * 批量标记 run 已读,settle 后无条件触发本地刷新。
 * 单条失败不阻塞其余(allSettled);IPC 全挂时也照样 emit——刷新只是重查 DB,
 * 让 UI 至少回到与 DB 一致的状态。
 * 返回实际成功 / 失败的 runId,调用方按真实结果出 toast,不要用请求数当成功数。
 */
export async function markScheduleRunsReadAndSync(
  runIds: readonly string[],
): Promise<MarkScheduleRunsReadResult> {
  const processed: string[] = [];
  const failed: string[] = [];
  let firstError: string | undefined;
  if (runIds.length > 0) {
    const results = await Promise.allSettled(
      runIds.map((runId) => window.electronAPI.maker.schedule.markRunRead(runId)),
    );
    results.forEach((result, index) => {
      const runId = runIds[index];
      if (runId === undefined) return;
      if (result.status === 'fulfilled') {
        processed.push(runId);
        return;
      }
      failed.push(runId);
      if (firstError === undefined) {
        firstError = result.reason instanceof Error ? result.reason.message : String(result.reason);
      }
    });
  }
  emit();
  return firstError === undefined ? { processed, failed } : { processed, failed, firstError };
}

/** 单条版本(run 历史卡片用)。 */
export async function markScheduleRunReadAndSync(runId: string): Promise<void> {
  await markScheduleRunsReadAndSync([runId]);
}

/**
 * 「全部标为已读」,settle 后无条件触发本地刷新。
 * 返回 main 报告的实际更新行数(0 = 全是 no-op,但本地照样刷新);
 * IPC 失败时抛给调用方(沿用原有 toast 错误路径),刷新仍然执行。
 */
export async function markAllScheduleRunsReadAndSync(): Promise<number> {
  try {
    return await window.electronAPI.maker.schedule.markAllRunsRead();
  } finally {
    emit();
  }
}
