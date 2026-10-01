import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 伙伴工作台:主人把本机项目交给伙伴后,伙伴先读懂项目里的任务,再按主人的意思继续。
 *
 * 权限只来自主人在工作台里的那次「交给伙伴」:宿主从 callerSessionId 反查伙伴
 * (只认本机、在用的伙伴主任务),目标必须落在该伙伴已接手的项目里——Cindy 任务要是
 * 普通本机任务、未归档删除、不是任何伙伴自己的隐藏任务;本机 Claude Code / Codex 会话的
 * 工作目录要在已接手项目内。工具层不接受 botId 或项目参数,越权一律由宿主确定性拒绝。
 */

export type WorkbenchTaskStateWire =
  | 'running'
  | 'waiting'
  | 'queued'
  | 'stopped'
  | 'automation'
  | 'done';

export type WorkbenchVerdictWire = 'unfinished' | 'idea' | 'done';

export interface WorkbenchProjectWire {
  name: string;
  path: string;
  exists: boolean;
}

export interface WorkbenchJudgmentWire {
  title: string;
  verdict: WorkbenchVerdictWire;
  next: string | null;
  updatedAt: string;
}

export interface WorkbenchTaskWire {
  /** Cindy 任务是 session id;还没接过来的本机会话是 `claude:<id>` / `codex:<id>`。 */
  taskId: string;
  source: 'cindy' | 'claude-code' | 'codex';
  /** 已经是 Cindy 里的任务(本机会话被继续过之后也会变成 true)。 */
  imported: boolean;
  /** 清洗过的原始标题。 */
  title: string;
  project: string;
  /** 只有 Cindy 任务有运行状态;本机会话为 null。 */
  state: WorkbenchTaskStateWire | null;
  /** delegated = 你开的后台任务。 */
  kind: 'existing' | 'delegated';
  summary: string | null;
  lastActiveAt: string | null;
  messageCount: number | null;
  /** 你之前写下的判断;还没读过为 null。 */
  judgment: WorkbenchJudgmentWire | null;
}

export interface WorkbenchAutomationWire {
  id: string;
  name: string;
  /** routine = 你自己的例行任务;automation = 已接手项目里的自动化。 */
  kind: 'routine' | 'automation';
  state: WorkbenchTaskStateWire;
  project: string | null;
  nextRunAt: string | null;
  lastResult: string | null;
}

export interface BotWorkbenchSnapshotWire {
  projects: WorkbenchProjectWire[];
  tasks: WorkbenchTaskWire[];
  automations: WorkbenchAutomationWire[];
  counts: Record<WorkbenchVerdictWire | 'unjudged', number>;
  /** 候选多于返回条数时为 true;totalTasks 是实际总数。 */
  truncated: boolean;
  totalTasks: number;
}

export interface WorkbenchTranscriptWire {
  items: Array<{ role: 'user' | 'assistant'; text: string; at: number }>;
  truncated: boolean;
}

export type WorkbenchStopStatusWire =
  | 'no-active-turn'
  | 'waiting-for-safe-point'
  | 'requested'
  | 'unconfirmed';

export interface BotWorkbenchCallbacks {
  get(params: { callerSessionId: string }): Promise<ControlResult<{ workbench: BotWorkbenchSnapshotWire }, string>>;
  read(params: {
    callerSessionId: string;
    taskId: string;
  }): Promise<ControlResult<{ taskId: string; transcript: WorkbenchTranscriptWire }, string>>;
  set(params: {
    callerSessionId: string;
    taskId: string;
    title: string;
    verdict: WorkbenchVerdictWire;
    next?: string | null;
  }): Promise<ControlResult<{ taskId: string; judgment: WorkbenchJudgmentWire }, string>>;
  continueTask(params: {
    callerSessionId: string;
    taskId: string;
    message: string;
  }): Promise<
    ControlResult<
      { taskId: string; delivery: 'started' | 'queued'; queuedMessageId?: string; importedFrom?: string },
      string
    >
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

const TASK_ID = z.string().min(1).max(256).describe('get_workbench 返回的 taskId');

export function registerBotWorkbenchTools(
  registry: XdtHelperToolRegistry,
  deps: BotWorkbenchToolDeps,
): void {
  const callerSessionId = () => deps.getSessionContext().sessionId ?? null;

  registry.register({
    name: 'get_workbench',
    category: 'bots',
    description:
      '读取你的工作台:主人交给你的项目,项目里的候选任务(Cindy 里的任务,以及还没接过来的本机 Claude Code / Codex 会话),你的例行任务与项目里的自动化。'
      + '候选按最近活动倒序,最多 30 条;每条有 taskId、来源、清洗过的原始标题、最近活动时间、消息条数、运行状态(只有 Cindy 任务有)和你之前写过的判断。'
      + '接手的做法:主人把项目交给你时,先调用它;再对还没判断的候选逐个 read_workbench_task(最近的先读,最多读 20 件),每读完一件立刻 set_workbench_task 写下判断,主人的工作台会随之更新。'
      + '判断标准:最后一条是没被执行的要求、报错中断、明确留下的待办 → unfinished;讨论过方案或想法但之后没人动 → idea;已交付、纯问答、与项目无关 → done。'
      + '全部读完后在聊天里用几句话告诉主人:没做完的几件各一句下一步,聊过没下文的几件各一句建议,问主人要接着做哪件。不要自作主张开始做;只有主人点头的那件才 continue_workbench_task。'
      + '要在项目里开全新的任务时用 start_session_task,把 working_dir 设为该项目路径。',
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
    name: 'read_workbench_task',
    category: 'bots',
    description:
      '只读一件候选任务最近的内容(用户与助手的文字,去掉工具结果与系统提示,最多约 4000 字,保留最近的)。'
      + '本机 Claude Code / Codex 会话只读转录文件尾部,不会导入。只能读主人交给你的项目里的任务。',
    inputShape: { task_id: TASK_ID },
    handler: async ({ task_id }) => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.read({ callerSessionId: sessionId, taskId: task_id });
      return result.ok
        ? okPayload({ task_id: result.taskId, transcript: result.transcript })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'set_workbench_task',
    category: 'bots',
    description:
      '写下你对一件候选任务的理解,主人的工作台立刻显示。整条替换之前的判断。'
      + 'title:人话标题,不超过 40 字,说清这件事是什么;verdict:unfinished(没做完、可以接着做)/ idea(聊过但没下文,建议往下做)/ done(做完或与项目无关,工作台不显示);'
      + 'next:一句下一步,不超过 120 字,unfinished / idea 必填。只写读到有依据的判断,不要编造。',
    inputShape: {
      task_id: TASK_ID,
      title: z.string().min(1).max(40).describe('人话标题'),
      verdict: z.enum(['unfinished', 'idea', 'done']).describe('你的判断'),
      next: z.string().max(120).optional().describe('一句下一步;done 可省略'),
    },
    handler: async ({ task_id, title, verdict, next }) => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.set({
        callerSessionId: sessionId,
        taskId: task_id,
        title,
        verdict,
        next: next ?? null,
      });
      return result.ok
        ? okPayload({ task_id: result.taskId, judgment: result.judgment })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'continue_workbench_task',
    category: 'bots',
    description:
      '主人点头后,让工作台上的一件任务接着做:给它发一句话,消息以你的名义投递,任务正忙时排到当前一轮之后。'
      + '如果它还是没接过来的本机 Claude Code / Codex 会话,宿主先只导入这一条,再投递;返回里的 task_id 是导入后的新任务 id,之后用它。'
      + '只能作用于主人交给你的项目里的任务;你自己用 start_session_task 开的后台任务继续用 message_session_task。'
      + '把 message 写成那件任务收到就能直接开始做的一句指令,带上必要的背景;不要重复它已经做完的外部操作。',
    inputShape: {
      task_id: TASK_ID,
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
            ...(result.importedFrom ? { imported_from: result.importedFrom } : {}),
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
    inputShape: { task_id: TASK_ID },
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
