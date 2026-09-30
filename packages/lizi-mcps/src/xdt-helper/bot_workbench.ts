import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 伙伴工作台:主人把本机项目交给伙伴后,伙伴读取、继续、停止这些项目里的任务。
 *
 * 权限只来自主人在工作台里的那次「交给伙伴」:宿主从 callerSessionId 反查伙伴
 * (只认本机、在用的伙伴主任务),目标任务必须属于该伙伴已接手的项目、是普通本机任务、
 * 未归档删除、不是任何伙伴自己的隐藏任务。工具层不接受 botId 或项目参数,
 * 越权一律由宿主确定性拒绝。
 */

export type WorkbenchTaskStateWire =
  | 'running'
  | 'waiting'
  | 'queued'
  | 'stopped'
  | 'automation'
  | 'done';

export interface WorkbenchProjectWire {
  name: string;
  path: string;
  exists: boolean;
}

export interface WorkbenchTaskWire {
  id: string;
  title: string;
  project: string;
  state: WorkbenchTaskStateWire;
  /** existing = 主人原有任务;delegated = 你开的后台任务。 */
  kind: 'existing' | 'delegated';
  /** 最近一句话的有界摘要;没有时为 null。 */
  summary: string | null;
  lastActiveAt: string | null;
}

export interface WorkbenchAutomationWire {
  id: string;
  name: string;
  /** automation = 已接手项目里的自动化。 */
  kind: 'automation';
  state: WorkbenchTaskStateWire;
  project: string | null;
  nextRunAt: string | null;
  lastResult: string | null;
}

export interface BotWorkbenchSnapshotWire {
  projects: WorkbenchProjectWire[];
  tasks: WorkbenchTaskWire[];
  automations: WorkbenchAutomationWire[];
  counts: Record<WorkbenchTaskStateWire, number>;
  /** 项目里的任务多于返回条数时为 true;totalTasks 是实际总数。 */
  truncated: boolean;
  totalTasks: number;
}

export type WorkbenchStopStatusWire =
  | 'no-active-turn'
  | 'waiting-for-safe-point'
  | 'requested'
  | 'unconfirmed';

export interface BotWorkbenchCallbacks {
  get(params: { callerSessionId: string }): Promise<ControlResult<{ workbench: BotWorkbenchSnapshotWire }, string>>;
  continueTask(params: {
    callerSessionId: string;
    taskId: string;
    message: string;
  }): Promise<
    ControlResult<{ taskId: string; delivery: 'started' | 'queued'; queuedMessageId?: string }, string>
  >;
  stopTask(params: {
    callerSessionId: string;
    taskId: string;
  }): Promise<ControlResult<{ taskId: string; status: WorkbenchStopStatusWire }, string>>;
}

export interface BotWorkbenchToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  callbacks: BotWorkbenchCallbacks;
}

export const WORKBENCH_MESSAGE_MAX_CHARS = 4_000;

function missingSession() {
  return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴主任务。');
}

export function registerBotWorkbenchTools(
  registry: XdtHelperToolRegistry,
  deps: BotWorkbenchToolDeps,
): void {
  const callerSessionId = () => deps.getSessionContext().sessionId ?? null;

  registry.register({
    name: 'get_workbench',
    category: 'bots',
    description:
      '读取你的工作台:主人交给你的项目,以及这些项目里每件任务的 id、标题、状态、类型和最近一句摘要,还有项目里的自动化。'
      + '状态由宿主从真实运行信号给出:running 在做,waiting 在等主人回复,queued 排队,stopped 停着(上一轮被打断、出错或后台任务没做完),automation 自动化待命,done 做完。不要自己猜状态。'
      + '主人把项目交给你时,先调用它,再用几句话告诉主人现状:几个在做、几个等主人、几个停着、自动化情况。'
      + '停着且明显只差收尾的任务可以用 continue_workbench_task 接着做;拿不准的先问主人,不要擅自动手。'
      + '要在项目里开新任务时用 start_session_task,把 working_dir 设为该项目路径,新任务会出现在同一个工作台上。',
    inputShape: {},
    handler: async () => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.get({ callerSessionId: sessionId });
      return result.ok
        ? okPayload({ workbench: result.workbench })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'continue_workbench_task',
    category: 'bots',
    description:
      '给工作台上一件原有任务发一句话,让它接着做。消息以你的名义投递;任务正忙时排到当前一轮之后。'
      + '只能作用于 get_workbench 列出的、主人交给你的项目里的任务;你自己用 start_session_task 开的后台任务继续用 message_session_task。'
      + '把 message 写成那件任务收到就能直接开始做的一句指令,带上必要的背景;不要重复它已经做完的外部操作。',
    inputShape: {
      task_id: z.string().min(1).max(256).describe('get_workbench 返回的任务 id'),
      message: z
        .string()
        .min(1)
        .max(WORKBENCH_MESSAGE_MAX_CHARS)
        .describe('发给这件任务的一句话'),
    },
    handler: async ({ task_id, message }) => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      if (!message.trim()) return errorPayload('INVALID_ARGS', 'message 不能为空。');
      const result = await deps.callbacks.continueTask({
        callerSessionId: sessionId,
        taskId: task_id,
        message,
      });
      return result.ok
        ? okPayload({
            task_id: result.taskId,
            delivery: result.delivery,
            ...(result.queuedMessageId ? { queued_message_id: result.queuedMessageId } : {}),
          })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'stop_workbench_task',
    category: 'bots',
    description:
      '请求停止工作台上一件任务的当前一轮(优雅停止)。不删除任务,之后仍可用 continue_workbench_task 接着做。'
      + '只在主人要求,或任务明显走偏、在做重复无用的事时使用。status=requested / waiting-for-safe-point / unconfirmed 表示已请求但引擎可能还没停稳,不要说成已停止。'
      + '你自己开的后台任务用 stop_session_task。',
    inputShape: {
      task_id: z.string().min(1).max(256).describe('get_workbench 返回的任务 id'),
    },
    handler: async ({ task_id }) => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.stopTask({ callerSessionId: sessionId, taskId: task_id });
      return result.ok
        ? okPayload({ task_id: result.taskId, status: result.status })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
