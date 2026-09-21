/**
 * useBackgroundBashTasks —— 会话内仍在运行的后台 Bash 任务(taskType=local_bash,
 * 即 run_in_background 的 Bash 工具)的响应式列表 + 一键全停。
 *
 * 与 useSessionBackgroundActivity 互补:那边的信号源是「CC 子进程仍在调模型」
 * (loopback proxy 活动),只覆盖后台 subagent;后台 Bash 不调模型,永远点不亮那个
 * 信号。本 hook 直接从 makerChatStore 的 taskUpdates(agent_task_update 事件流)
 * 折算,并在挂载 / 历史重载后用 main 的 listSessionBackgroundTasks 快照补回
 * 「订阅前已启动 / reloadMessages 清空」的存量任务(store 侧只补未见过的条目,
 * 不会复活已终态任务)。
 *
 * 注意:这里的折算是纯 UI 信号,不参与 makerChatStore 的 running 语义(local_bash
 * 不折算 running 的既有决策不变 —— dev server 不能把会话 spinner 永转)。
 *
 * device-link 远程会话:任务真身在被控端,快照必须隧道读(控制端 main 无该会话
 * handle,本机读必空)—— 与后台任务面板同款走 readSessionBackgroundTasks。
 * 老被控端无此 channel / 隧道失败 / 归属不可解析但已确认镜像来源时降级(source:
 * null),控制端退化为「看不到运行中」而不误报;停止同样逐任务隧道(见下),
 * 被控端停不掉时 UI 会给「停止未确认」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { makerChatStore } from '@/lib/makerChatStore';
import type { AgentTaskUpdate } from '@/lib/makerChatStore';
import {
  isRemoteSessionSticky,
  readSessionBackgroundTasks,
  stopAgentTaskFor,
} from '@/lib/makerTransport';

export interface RunningBashTask {
  taskId: string;
  title?: string;
}

/**
 * 从 taskUpdates 折算「仍在运行的后台 Bash 任务」列表(纯函数,供单测)。
 * Map 里同一任务按 taskId / parentToolUseId 双 key 存两份 —— 按 taskId 去重。
 * 默认只认 claude-code:本机会话里 codex / PI 的后台命令没有本地 stopTask 通道,
 * 列出来也停不掉。includePiTasks 给 device-link 远程镜像会话用 ——
 * 任务真身在被控端,能不能停由**被控端的 channel** 决定(PI 后台命令自 #4700
 * 起可停),控制端不该按 provider 预筛;停不掉时由「停止未确认」就地反馈。
 * codex 两端口径一致地不列(它连被控端也没有 stopTask 通道,列出来是假入口)。
 */
export function listRunningBashTasks(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  options?: { includePiTasks?: boolean },
): RunningBashTask[] {
  if (!taskUpdates || taskUpdates.size === 0) return [];
  const out = new Map<string, RunningBashTask>();
  for (const update of taskUpdates.values()) {
    const providerEligible =
      update.provider === 'claude-code' ||
      (options?.includePiTasks === true && update.provider === 'pi');
    if (!providerEligible) continue;
    if (update.taskType !== 'local_bash') continue;
    if (update.status !== 'running') continue;
    if (out.has(update.taskId)) continue;
    out.set(update.taskId, {
      taskId: update.taskId,
      ...(update.title ? { title: update.title } : {}),
    });
  }
  return [...out.values()];
}

export function useBackgroundBashTasks(
  sessionId: string | undefined,
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  /** historyLoaded 翻 true 时重新水合(reloadMessages 会清空 taskUpdates 再重载)。 */
  historyLoaded?: boolean,
): {
  tasks: RunningBashTask[];
  stopping: boolean;
  stopAll: () => Promise<void>;
} {
  const [stopping, setStopping] = useState(false);
  // 快照重拉信号:远程镜像会话的终态事件可能丢包(镜像事件流有设计内丢失窗口),
  // 停止动作完成后用一次快照把「已不在跑」的对账回来 —— 本机会话走事件流即可,
  // 这里只是多一次幂等 seed(seed 仅补缺,不复活已终态任务)。
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0);

  // device-link 镜像会话:快照/停止都按粘滞归属隧道到被控端。粘滞判定(而非瞬时
  // 归属)保证 relay 瞬断窗口内不把远程会话误判成本机 —— 那条路径上本机快照必空、
  // 本地 stop 会假成功。
  const remoteSticky = Boolean(sessionId) && isRemoteSessionSticky(sessionId as string);

  // 快照水合:挂载 / 切会话 / 历史重载完成后拉一次存量(远程走隧道,见
  // readSessionBackgroundTasks)。maker 未 init 等瞬态失败保持现状 ——
  // 实时事件流仍会自然补上。
  // 同一次快照兼做 stale running 对账:候选集必须在**发起请求前**捕获(时序论证
  // 见 store 的 reconcileStaleRunningTasks),空表 + 非空候选正是「全部已收口」
  // 的信号,不得 early-return。对账 gating 用**粘滞版**远程判定(与
  // BackgroundTasksBody、Stop gating 同口径):relay 瞬断窗口 remoteSticky
  // (非粘滞)会把远程会话误判成本机,本机空快照会把镜像里真实在跑的任务错误
  // 收口 —— 粘滞判定命中远程时只 seed 不对账;老被控端无此 channel 降级空表时
  // 同理不可当权威。
  useEffect(() => {
    if (!sessionId) return;
    if (!window.electronAPI?.maker?.listSessionBackgroundTasks) return;
    let disposed = false;
    // 候选集必须在**发起请求前**捕获(时序论证见 store 的 reconcileStaleRunningTasks)。
    // 远程会话额外带上 hook 当前运行集里的条目:store 的 capture 只覆盖
    // claude-code,而被控端自 #4700 起也能停 PI 后台命令 —— 不收进候选集,
    // 「停止后重拉快照」就永远收口不掉这些行(会一直误报运行中)。tasksRef 是
    // 本次渲染的列表,晚于它启动的任务不会被误收。
    const staleRunningCandidates = new Set(
      makerChatStore.captureRunningClaudeTaskIds(sessionId),
    );
    if (isRemoteSessionSticky(sessionId)) {
      for (const task of tasksRef.current) staleRunningCandidates.add(task.taskId);
    }
    void readSessionBackgroundTasks(sessionId)
      .then(({ tasks, source }) => {
        if (disposed || !Array.isArray(tasks)) return;
        // 来源与当下归属必须一致:归属在请求在飞期间才完成水合时,本机 main 的
        // 「查无此会话」空表(或撞 id 数据)对远程会话无意义 → 整体丢弃,
        // 等下一次水合(历史重载 / 停止动作)重试。
        if ((source === 'remote') !== isRemoteSessionSticky(sessionId)) return;
        // 只有权威快照能收口 stale running:降级空表(老被控端无 channel /
        // 隧道失败)与「确实没有任务」不可区分。
        const candidates =
          source === null || staleRunningCandidates.size === 0
            ? undefined
            : staleRunningCandidates;
        if (tasks.length === 0 && !candidates) return;
        makerChatStore.seedBackgroundTaskSnapshots(
          sessionId,
          tasks,
          candidates ? { staleRunningCandidates: candidates } : undefined,
        );
      })
      .catch(() => {
        // 静默:与 useSessionBackgroundActivity 的快照失败同口径(失败不对账)。
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, historyLoaded, snapshotRefreshNonce]);

  const tasks = useMemo(
    () => listRunningBashTasks(taskUpdates, { includePiTasks: remoteSticky }),
    [remoteSticky, taskUpdates],
  );

  // stopAll 读 ref 而非闭包列表:按钮点击时以最新运行集为准,避免陈旧闭包重复停。
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const stopAll = useCallback(async () => {
    if (!sessionId) return;
    const targets = tasksRef.current;
    if (targets.length === 0) return;
    setStopping(true);
    try {
      // 逐个停,单个失败不拦其余;成功与否都交给 task_notification 事件流收口,
      // 这里不改本地状态(单一事实源)。走 stopAgentTaskFor:本机会话直连本地
      // main,远程镜像会话逐任务隧道到被控端(ID 感知,归属不可解析时拒绝本地
      // 回退 —— 那会假成功并让任务在被控端继续跑)。
      await Promise.allSettled(targets.map((t) => stopAgentTaskFor(sessionId, t.taskId)));
    } finally {
      setStopping(false);
      // 停完重拉一次快照:被控端已收口的任务不能在控制端继续显示 running。
      setSnapshotRefreshNonce((n) => n + 1);
    }
  }, [sessionId]);

  return { tasks, stopping, stopAll };
}
