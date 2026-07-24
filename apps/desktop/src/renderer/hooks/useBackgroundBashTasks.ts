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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { makerChatStore } from '@/lib/makerChatStore';
import type { AgentTaskUpdate } from '@/lib/makerChatStore';
import { isRemoteSession } from '@/lib/makerTransport';

export interface RunningBashTask {
  taskId: string;
  title?: string;
}

/**
 * 从 taskUpdates 折算「仍在运行的后台 Bash 任务」列表(纯函数,供单测)。
 * Map 里同一任务按 taskId / parentToolUseId 双 key 存两份 —— 按 taskId 去重。
 * 只认 claude-code:codex 会话没有对应的 stopTask 通道,列出来也停不掉。
 */
export function listRunningClaudeBashTasks(
  taskUpdates: ReadonlyMap<string, AgentTaskUpdate> | undefined,
): RunningBashTask[] {
  if (!taskUpdates || taskUpdates.size === 0) return [];
  const out = new Map<string, RunningBashTask>();
  for (const update of taskUpdates.values()) {
    if (update.provider !== 'claude-code') continue;
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

  // device-link 镜像会话:session 活在被控端,本地 main 拿不到 handle(快照返回
  // 空、stop 假成功),且镜像事件有设计内丢失窗口 —— 与「远程会话豁免 running
  // 折算」同口径,整个信号在控制端关闭,由被控端自己的 UI 承载。
  const remoteMirror = Boolean(sessionId) && isRemoteSession(sessionId as string);

  // 快照水合:挂载 / 切会话 / 历史重载完成后拉一次存量。maker 未 init 等瞬态失败
  // 保持现状 —— 实时事件流仍会自然补上。
  useEffect(() => {
    if (!sessionId || remoteMirror) return;
    const api = window.electronAPI?.maker;
    if (!api?.listSessionBackgroundTasks) return;
    let disposed = false;
    void api
      .listSessionBackgroundTasks(sessionId)
      .then(({ tasks }) => {
        if (disposed || !Array.isArray(tasks) || tasks.length === 0) return;
        makerChatStore.seedBackgroundTaskSnapshots(sessionId, tasks);
      })
      .catch(() => {
        // 静默:与 useSessionBackgroundActivity 的快照失败同口径。
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, remoteMirror, historyLoaded]);

  const tasks = useMemo(
    () => (remoteMirror ? [] : listRunningClaudeBashTasks(taskUpdates)),
    [remoteMirror, taskUpdates],
  );

  // stopAll 读 ref 而非闭包列表:按钮点击时以最新运行集为准,避免陈旧闭包重复停。
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const stopAll = useCallback(async () => {
    const api = window.electronAPI?.maker;
    if (!sessionId || !api?.stopAgentTask) return;
    const targets = tasksRef.current;
    if (targets.length === 0) return;
    setStopping(true);
    try {
      // 逐个停,单个失败不拦其余;成功与否都交给 task_notification 事件流收口,
      // 这里不改本地状态(单一事实源)。
      await Promise.allSettled(targets.map((t) => api.stopAgentTask(sessionId, t.taskId)));
    } finally {
      setStopping(false);
    }
  }, [sessionId]);

  return { tasks, stopping, stopAll };
}
