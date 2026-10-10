/**
 * useBackgroundSessionTasks —— 会话内「仍在运行、且可逐个精确停止」的后台任务
 * 的响应式列表 + 一键全停,以及给状态栏用的分类计数。
 *
 * 覆盖范围:
 * - claude-code 的 `local_bash`(run_in_background 的 Bash):不调模型,点不亮
 *   useSessionBackgroundActivity 的 loopback proxy 活动信号,必须由本 hook 从
 *   taskUpdates(agent_task_update 事件流)折算;
 * - pi 的 `local_bash`(Cindy 覆盖的 bash + background:true)与 `pi_subagent`
 *   (async durable run):两者都能经 maker:agent-task:stop 精确停止;PI 没有
 *   proxy 活动信号,子代理的后台存在感也由本 hook 提供。
 *
 * 与 useSessionBackgroundActivity 互补:那边的信号源是「CC 子进程仍在调模型」,
 * 语义是「关常驻子进程止损」;本 hook 的 stopAll 是逐个停任务,不碰会话进程。
 *
 * 快照水合:挂载 / 历史重载后用 main 的 listSessionBackgroundTasks 补回
 * 「订阅前已启动 / reloadMessages 清空」的存量任务(store 侧只补未见过的条目,
 * 不会复活已终态任务),同一份快照兼做 claude-code stale running 对账。
 *
 * 注意:这里的折算是纯 UI 信号,不参与 makerChatStore 的 running 语义(local_bash
 * 不折算 running 的既有决策不变 —— dev server 不能把会话 spinner 永转)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { makerChatStore } from '@/lib/makerChatStore';
import type { AgentTaskUpdate } from '@/lib/makerChatStore';
import { isRemoteSession, isRemoteSessionSticky } from '@/lib/makerTransport';

export interface RunningBackgroundTask {
  taskId: string;
  title?: string;
  /** 'bash' = 后台命令(local_bash);'subagent' = PI durable subagent。 */
  kind: 'bash' | 'subagent';
}

/**
 * 统计「上一轮停不下来、且现在还在运行集里」的条数(纯函数,供单测)。
 *
 * 取交集是刻意的:失败项稍后真的停了(重试成功 / 进程自然退出)时,状态栏的提示必须
 * 自动消失,而不是一直挂到下一次点击。
 */
export function countUnconfirmedRunningTasks(
  failedIds: ReadonlySet<string>,
  tasks: readonly { taskId: string }[],
): number {
  if (failedIds.size === 0 || tasks.length === 0) return 0;
  let count = 0;
  for (const task of tasks) {
    if (failedIds.has(task.taskId)) count += 1;
  }
  return count;
}

/**
 * 从 `Promise.allSettled` 的结果里挑出**停不下来**的 taskId(纯函数,供单测)。
 *
 * 只有当 host 在 SIGKILL 之后仍未确认退出时才 reject,所以这里的失败项就是
 * 「点了停止、但进程可能还在跑」—— 状态栏必须把它显示出来,不能当作全部成功。
 */
export function selectFailedStopTaskIds(
  targets: readonly { taskId: string }[],
  results: readonly PromiseSettledResult<unknown>[],
): Set<string> {
  const failed = new Set<string>();
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    const taskId = targets[index]?.taskId;
    if (taskId) failed.add(taskId);
  });
  return failed;
}

/**
 * 从 taskUpdates 折算「仍在运行、且可逐个精确停止」的后台任务(纯函数,供单测)。
 * Map 里同一任务按 taskId / parentToolUseId 存成别名键(同值),此处按 taskId 收敛成一条。
 *
 * 刻意不收:codex(没有 stopTask 通道,列出来也停不掉)、claude-code 的后台子代理
 * (由 proxy 活动信号 + 会话级止损承载,本 hook 只做逐任务停止)。
 */
export function listRunningBackgroundTasks(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
): RunningBackgroundTask[] {
  if (!taskUpdates || taskUpdates.size === 0) return [];
  const out = new Map<string, RunningBackgroundTask>();
  for (const update of taskUpdates.values()) {
    if (update.status !== 'running') continue;
    let kind: RunningBackgroundTask['kind'] | undefined;
    if (update.provider === 'claude-code' && update.taskType === 'local_bash') {
      kind = 'bash';
    } else if (
      update.provider === 'pi'
      && (update.taskType === 'local_bash' || update.taskType === 'pi_subagent')
    ) {
      kind = update.taskType === 'local_bash' ? 'bash' : 'subagent';
    }
    if (!kind || out.has(update.taskId)) continue;
    out.set(update.taskId, {
      taskId: update.taskId,
      kind,
      ...(update.title ? { title: update.title } : {}),
    });
  }
  return [...out.values()];
}

export function useBackgroundSessionTasks(
  sessionId: string | undefined,
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  /** historyLoaded 翻 true 时重新水合(reloadMessages 会清空 taskUpdates 再重载)。 */
  historyLoaded?: boolean,
): {
  tasks: RunningBackgroundTask[];
  /** 后台命令数量(状态栏「N 个后台命令运行中」文案用)。 */
  bashCount: number;
  /**
   * 上一轮「全部停止」里 host 未能确认停掉的 taskId 集合。
   * host 只在 SIGKILL 之后仍未确认退出时才让单条 stop 失败 —— 空集才代表全部停掉。
   */
  stopFailedIds: ReadonlySet<string>;
  /**
   * 上一条与**当前运行集**的交集大小(状态栏提示用):任务稍后真停了就自动归零。
   */
  stopUnconfirmedCount: number;
  /** PI durable subagent 数量(仅用于状态栏守卫;文案用通用「后台任务运行中」)。 */
  subagentCount: number;
  stopping: boolean;
  stopAll: () => Promise<void>;
} {
  const [stopping, setStopping] = useState(false);

  // device-link 镜像会话:session 活在被控端,本地 main 拿不到 handle(快照返回
  // 空、stop 假成功),且镜像事件有设计内丢失窗口 —— 与「远程会话豁免 running
  // 折算」同口径,整个信号在控制端关闭,由被控端自己的 UI 承载。
  const remoteMirror = Boolean(sessionId) && isRemoteSession(sessionId as string);

  // 快照水合:挂载 / 切会话 / 历史重载完成后拉一次存量。maker 未 init 等瞬态失败
  // 保持现状 —— 实时事件流仍会自然补上。
  // 同一次快照兼做 stale running 对账:候选集必须在**发起请求前**捕获(时序论证
  // 见 store 的 reconcileStaleRunningTasks),空表 + 非空候选正是「全部已收口」
  // 的信号,不得 early-return。对账 gating 用**粘滞版**远程判定(与
  // BackgroundTasksBody、Stop gating 同口径):relay 瞬断窗口 remoteMirror
  // (非粘滞)会把远程会话误判成本机,本机空快照会把镜像里真实在跑的任务错误
  // 收口 —— 粘滞判定命中远程时只 seed 不对账。
  useEffect(() => {
    if (!sessionId || remoteMirror) return;
    const api = window.electronAPI?.maker;
    if (!api?.listSessionBackgroundTasks) return;
    let disposed = false;
    const staleRunningCandidates = isRemoteSessionSticky(sessionId)
      ? undefined
      : makerChatStore.captureReconcilableRunningTaskIds(sessionId);
    void api
      .listSessionBackgroundTasks(sessionId)
      .then(({ tasks }) => {
        if (disposed || !Array.isArray(tasks)) return;
        // 响应落地前复查粘滞判定:请求在飞期间远程注册表才完成会话水合的话,
        // 本机 main「查无此会话」的空表不可再套用(候选集是按本机误判捕获的,
        // 套用会误收镜像里真实在跑的任务)。本 hook 不服务远程会话,整体丢弃。
        if (isRemoteSessionSticky(sessionId)) return;
        if (tasks.length === 0 && !(staleRunningCandidates && staleRunningCandidates.size > 0)) {
          return;
        }
        makerChatStore.seedBackgroundTaskSnapshots(
          sessionId,
          tasks,
          staleRunningCandidates ? { staleRunningCandidates } : undefined,
        );
      })
      .catch(() => {
        // 静默:与 useSessionBackgroundActivity 的快照失败同口径(失败不对账)。
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, remoteMirror, historyLoaded]);

  const tasks = useMemo(
    () => (remoteMirror ? [] : listRunningBackgroundTasks(taskUpdates)),
    [remoteMirror, taskUpdates],
  );
  const bashCount = useMemo(() => tasks.filter((task) => task.kind === 'bash').length, [tasks]);
  const subagentCount = tasks.length - bashCount;

  // 上一轮「全部停止」里停不下来的 taskId(空集 = 全部确认停掉)。下一轮点击开始时重置。
  const [stopFailedIds, setStopFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  // 切会话必须清:同一组件实例上 sessionId 只是 prop,状态会跨会话留下 —— 上个会话的
  // 「未确认 N 个」会挂到新会话的状态栏上,而在飞的 stopAll 落账时还可能写错会话。
  useEffect(() => {
    setStopFailedIds(new Set());
    setStopping(false);
  }, [sessionId]);
  // stopAll 读 ref 而非闭包列表:按钮点击时以最新运行集为准,避免陈旧闭包重复停。
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // 在飞 stopAll 的会话代际:上面那个重置 effect 只能清「切换时刻」的状态,拦不住
  // await 期间切会话后旧结果落账(会把上个会话的失败集/stopping 写进新会话)。
  const stopAllSessionRef = useRef(sessionId);
  stopAllSessionRef.current = sessionId;

  const stopAll = useCallback(async () => {
    const api = window.electronAPI?.maker;
    if (!sessionId || !api?.stopAgentTask) return;
    const targets = tasksRef.current;
    if (targets.length === 0) return;
    const requestedSessionId = sessionId;
    setStopFailedIds(new Set());
    setStopping(true);
    try {
      // 逐个停,单个失败不拦其余;成功与否都交给 task_notification / durable status
      // 事件流收口,这里不改本地状态(单一事实源)。
      const results = await Promise.allSettled(
        targets.map((t) => api.stopAgentTask(sessionId, t.taskId)),
      );
      // 失败(host 只在 SIGKILL 之后仍未确认退出时让 stop 失败)不能吞:否则用户以为
      // 「全部停止」生效了,而那条进程还在跑。失败的 taskId 交给状态栏提示,成功的
      // 部分照样触发一次自愈对账(其中可能有 main 侧其实已不在的僵尸行)。
      const failed = selectFailedStopTaskIds(targets, results);
      // 期间切了会话就整个丢弃:这些 taskId 属于上一个会话,落账会污染新会话的提示。
      if (stopAllSessionRef.current !== requestedSessionId) return;
      setStopFailedIds(failed);
      // 无论成功几条都对一次账:全失败时同样是「僵尸行 + 顽固进程」混杂、最需要快照
      // 仲裁的情形(对账只收口快照里已经没有的行,对仍在跑的行是无害确认)。
      makerChatStore.requestBackgroundTaskReconcile(requestedSessionId);
    } finally {
      if (stopAllSessionRef.current === requestedSessionId) setStopping(false);
    }
  }, [sessionId]);

  // 只报「还在当前运行集里、且上一轮停不下来」的条数:失败项稍后真的停了(重试成功 /
  // 自然退出)时提示自动消失,不必等下一次点击。
  const stopUnconfirmedCount = useMemo(
    () => countUnconfirmedRunningTasks(stopFailedIds, tasks),
    [stopFailedIds, tasks],
  );

  return {
    tasks,
    bashCount,
    subagentCount,
    stopping,
    stopAll,
    stopFailedIds,
    stopUnconfirmedCount,
  };
}
