/**
 * useRemoteSessionBackgroundTasks —— device-link 远程会话的后台任务状态(状态栏后台模式)。
 *
 * 本机会话由 useSessionBackgroundActivity(push)与 useBackgroundBashTasks(事件流)承载,
 * 两者对远程会话都关着:镜像事件有设计内丢失窗口,靠事件流点亮的提示会因终态丢失永远
 * 亮着。这里改读被控端的权威快照(后台活动 + 仍在运行的后台任务),不依赖镜像事件:
 *  - 进入任务 / 前台 turn 结束 / 设备重连 / 窗口重新可见时立即读一次,之后每 POLL_MS
 *    复查。后台活动信号要在 turn 结束后的宽限期之后才可能亮起,单次读取必然错过;
 *    任务结束后提示至多晚一个周期熄灭。
 *  - 只在「远程 + 在线 + 窗口可见 + 无前台 turn」时读取并输出;其余情况输出空状态
 *    (前台 turn 期间状态栏走运行态;断连时无法确认,宁可不显示过时提示)。
 * 读取失败(含老被控端)一律按无后台任务降级,与后台任务面板水合同口径。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useRemoteDevices } from '@/features/device-link/remoteProjectsStore';
import { reportBackgroundTaskStopFailure } from '@/lib/backgroundTaskStopFailure';
import {
  canManageBackgroundTasks,
  stopAllBackgroundTasks,
  stopBackgroundTask,
} from '@/lib/backgroundTaskStop';
import { listSessionBackgroundTasksFor, sessionBackgroundActivityFor } from '@/lib/makerTransport';

import { useDocumentVisible } from './useWindowVisible';

/**
 * 被控端快照里的后台 Bash 任务。本机那条 hook 已合并成 useBackgroundSessionTasks
 * (同时覆盖 local_bash 与 pi_subagent),但远程挑选用的是**上游口径**:只认非 PI 的
 * local_bash —— PI 任务的控制面在别处,不在这张表里。因此这里自带同形类型,不去引用
 * 本机 hook 的类型(那会带着 kind 字段,含义不同)。
 */
export interface RemoteRunningBashTask {
  taskId: string;
  title?: string;
}

const POLL_MS = 15_000;

interface RemoteBackgroundState {
  active: boolean;
  tasks: RemoteRunningBashTask[];
}

const EMPTY_STATE: RemoteBackgroundState = { active: false, tasks: [] };

/**
 * 从被控端任务快照挑出后台 Bash 任务(纯函数,供单测)。与本机
 * listRunningClaudeBashTasks 同口径:只认 local_bash,PI 任务另有控制面。
 */
export function pickRemoteBashTasks(
  tasks: ReadonlyArray<{ taskId: string; taskType?: string; title?: string; provider?: string }>,
): RemoteRunningBashTask[] {
  const out = new Map<string, RemoteRunningBashTask>();
  for (const task of tasks) {
    if (task.taskType !== 'local_bash' || task.provider === 'pi') continue;
    if (out.has(task.taskId)) continue;
    out.set(task.taskId, { taskId: task.taskId, ...(task.title ? { title: task.title } : {}) });
  }
  return [...out.values()];
}

function sameState(a: RemoteBackgroundState, b: RemoteBackgroundState): boolean {
  return (
    a.active === b.active &&
    a.tasks.length === b.tasks.length &&
    a.tasks.every((task, i) => task.taskId === b.tasks[i].taskId && task.title === b.tasks[i].title)
  );
}

export function useRemoteSessionBackgroundTasks(
  sessionId: string | undefined,
  /** 粘滞归属的被控设备;本机会话传 undefined,hook 不做任何事。 */
  deviceId: string | undefined,
  foregroundRunning: boolean,
): RemoteBackgroundState & { stopping: boolean; stopAll: () => Promise<void> } {
  const { t } = useTranslation();
  const remoteDevices = useRemoteDevices();
  const connected =
    Boolean(deviceId) && remoteDevices.some((d) => d.deviceId === deviceId && d.connected);
  const visible = useDocumentVisible(Boolean(deviceId));
  // 共享任务访客没有后台任务管理权:不读取、不显示,保持与改动前一致。
  const enabled =
    Boolean(sessionId && canManageBackgroundTasks(sessionId)) &&
    connected &&
    visible &&
    !foregroundRunning;

  // 视图标识 = 归属设备 + 会话:快照归属、在途读取、停止回执、「停止中」标记共用这一个
  // 判据。切会话或同一会话的归属设备变化后,旧标识下的一切结果都不得作用于当前视图。
  const viewKey = sessionId && deviceId ? `${deviceId}\u0000${sessionId}` : null;
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;

  const [snapshot, setSnapshot] = useState<RemoteBackgroundState & { viewKey?: string }>(
    EMPTY_STATE,
  );
  const [stoppingViewKey, setStoppingViewKey] = useState<string | null>(null);
  // 读取序号:定时器不等上一轮返回,慢的旧读取只能被更新的结果取代,不能反过来覆盖;
  // 停止成功时把已发出的读取整体作废,避免在途旧快照重新点亮已熄灭的提示。
  const issuedSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !sessionId || !viewKey) {
      // 停读即清空:重新启用(turn 结束 / 重连)时不先闪出停读前的过时状态。
      setSnapshot(EMPTY_STATE);
      return;
    }
    let disposed = false;
    const read = () => {
      const seq = ++issuedSeqRef.current;
      void Promise.all([
        sessionBackgroundActivityFor(sessionId),
        listSessionBackgroundTasksFor(sessionId),
      ]).then(([activity, list]) => {
        if (disposed || seq <= appliedSeqRef.current) return;
        appliedSeqRef.current = seq;
        const next = {
          active: activity?.active === true,
          tasks: pickRemoteBashTasks(Array.isArray(list?.tasks) ? list.tasks : []),
        };
        setSnapshot((prev) =>
          prev.viewKey === viewKey && sameState(prev, next) ? prev : { ...next, viewKey },
        );
      });
    };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [enabled, sessionId, viewKey]);

  const current = enabled && viewKey && snapshot.viewKey === viewKey ? snapshot : EMPTY_STATE;
  // stopAll 读 ref:按钮点击时以最新快照为准,避免陈旧闭包。
  const currentRef = useRef(current);
  currentRef.current = current;

  const stopAll = useCallback(async () => {
    if (!sessionId || !viewKey) return;
    const { active, tasks } = currentRef.current;
    if (!active && tasks.length === 0) return;
    setStoppingViewKey(viewKey);
    try {
      // 与本机同语义:有模型活动 → 关闭被控端会话进程(后台命令随之终止);
      // 只有后台命令 → 逐个精确停止,不关会话进程。
      if (active) {
        await stopAllBackgroundTasks(sessionId);
      } else {
        const results = await Promise.allSettled(
          tasks.map((task) => stopBackgroundTask(sessionId, task.taskId)),
        );
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) throw failed.reason;
      }
      // 成功后立即熄灭并作废在途读取(仅当视图标识未变);仍有残留的话下一次复查会重新点亮。
      if (viewKeyRef.current === viewKey) {
        appliedSeqRef.current = issuedSeqRef.current;
        setSnapshot({ ...EMPTY_STATE, viewKey });
      }
    } catch (error) {
      reportBackgroundTaskStopFailure(error, t);
    } finally {
      setStoppingViewKey((prev) => (prev === viewKey ? null : prev));
    }
  }, [sessionId, viewKey, t]);

  return {
    active: current.active,
    tasks: current.tasks,
    stopping: viewKey !== null && stoppingViewKey === viewKey,
    stopAll,
  };
}
