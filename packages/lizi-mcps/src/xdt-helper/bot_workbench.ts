import { z } from 'zod';
import type { TodoPatch } from '@cindy/maker-shared/teammate-todo';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 伙伴工作台(2026-10-17 放弃「项目」):工作台是「一眼」——等你 / 在做两块加一行页脚,
 * 数据来自宿主的程序级观察层(不碰 AI)。伙伴跟进的范围不再按目录授予:
 *  - 总调度伙伴(主人设置里「自动跟进所有任务」的那个)可读本机全部任务与在线电脑上的任务;别的伙伴开的
 *    任务默认只看不跟,除非宿主已把跟进交给它(TASK_FOLLOWED_BY_OTHER_BOT);
 *  - 其它伙伴只碰自己开的(后台任务)或明确接手(set_workbench_task_responsibility)的任务。
 * 宿主从 callerSessionId 反查伙伴(只认本机、在用的伙伴主任务),工具层不接受 botId,
 * 越权一律由宿主确定性拒绝。
 */

export type GlanceKindWire = 'waiting' | 'working';

/** 宿主「一眼」投影的一行(与 Desktop shared/botAutonomy.ts 的 GlanceRow 同形)。 */
export interface GlanceRowWire {
  sessionId: string;
  deviceId: string | null;
  deviceName: string | null;
  online: boolean;
  title: string;
  kind: GlanceKindWire;
  /** 状态表 phase(running / usage-limit / waiting-* / errored);旧宿主可能缺省。 */
  phase?: string;
  minutes: number;
  question: string | null;
  waitingFor: 'permission' | 'answer' | 'error' | null;
  followerBotId: string | null;
}

/** 宿主「一眼」投影(与 Desktop shared/botAutonomy.ts 的 BotGlance 同形)。 */
export interface BotGlanceWire {
  botId: string;
  scope: 'all' | 'own';
  waiting: GlanceRowWire[];
  working: GlanceRowWire[];
  lastSweepAt: number;
  doneToday: number;
  offlineDevices: string[];
}

export interface WorkbenchTranscriptWire {
  items: Array<{ role: 'user' | 'assistant'; text: string; at: number }>;
  truncated: boolean;
}

export interface BotWorkbenchCallbacks {
  projects?: (params: { callerSessionId: string; projectId?: string; linked?: boolean; includeAvailable?: boolean }) => Promise<ControlResult<{ projects: Array<Record<string, unknown>> }, string>>;
  setResponsibility?: (params: { callerSessionId: string; taskId: string; responsible: boolean }) => Promise<ControlResult<{ taskId: string; responsible: boolean }, string>>;
  todos?: (
    callerSessionId: string,
    operation: 'list' | 'update' | 'preflight' | 'ingest',
    input?: unknown,
  ) => Promise<ControlResult<Record<string, unknown>, string>>;

  get(params: { callerSessionId: string }): Promise<ControlResult<{ workbench: BotGlanceWire }, string>>;
  read(params: {
    callerSessionId: string;
    taskId: string;
  }): Promise<ControlResult<{ taskId: string; transcript: WorkbenchTranscriptWire }, string>>;
  continueTask(params: {
    callerSessionId: string;
    taskId: string;
    message: string;
  }): Promise<
    ControlResult<
      {
        taskId: string;
        delivery: 'started' | 'queued';
        queuedMessageId?: string;
      },
      string
    >
  >;
}

export interface BotWorkbenchToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  callbacks: BotWorkbenchCallbacks;
}

export const WORKBENCH_MESSAGE_MAX_CHARS = 4_000;

function missingSession() {
  return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴主任务。');
}

const TASK_ID = z
  .string()
  .min(1)
  .max(512)
  .describe('任务 id:本机任务直接写 id;另一台电脑上的任务写 deviceId::sessionId(get_workbench 返回的 task_id 原样用)');

const iso = (ms: number) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/** 给模型看的「一眼」:只留判断要用的字段,task_id 可直接交给 get_task_digest。 */
export function glanceForModel(glance: BotGlanceWire): Record<string, unknown> {
  const row = (item: GlanceRowWire) => ({
    task_id: item.sessionId,
    title: item.title,
    ...(item.phase ? { phase: item.phase } : {}),
    minutes: item.minutes,
    ...(item.deviceName ? { device: item.deviceName } : {}),
    ...(item.online ? {} : { online: false }),
    ...(item.kind === 'waiting' && item.waitingFor ? { waiting_for: item.waitingFor } : {}),
    ...(item.question ? { question: item.question } : {}),
    ...(item.followerBotId && item.followerBotId !== glance.botId ? { followed_by: item.followerBotId } : {}),
  });
  return {
    scope: glance.scope,
    waiting: glance.waiting.map(row),
    working: glance.working.map(row),
    done_today: glance.doneToday,
    last_sweep_at: iso(glance.lastSweepAt),
    ...(glance.offlineDevices.length ? { offline_devices: glance.offlineDevices } : {}),
  };
}

export function registerBotWorkbenchTools(
  registry: XdtHelperToolRegistry,
  deps: BotWorkbenchToolDeps,
): void {
  const callerSessionId = () => deps.getSessionContext().sessionId ?? null;
  if (deps.callbacks.projects) {
    const projects = deps.callbacks.projects;
    registry.register({
      name: 'list_teammate_projects', category: 'bots',
      description: 'List your linked projects with their computer, directory and availability. Read relevant project instructions and materials on demand with your file tools; keep project knowledge in its existing location, not your personal memory. Foreign-computer paths must not be read locally. include_available also lists local registered projects you can link. This does not read project contents, assign tasks, authorize repository changes or start background work.',
      inputShape: { include_available: z.boolean().optional() },
      handler: async ({ include_available }) => {
        const id = callerSessionId(); if (!id) return missingSession();
        const result = await projects({ callerSessionId: id, includeAvailable: include_available });
        return result.ok ? okPayload({ projects: result.projects }) : errorPayload(result.errorCode, result.message);
      },
    });
    registry.register({
      name: 'set_teammate_project', category: 'bots',
      description: 'Link or unlink one project in your own teammate settings when the owner requests it. Use the project_id from list_teammate_projects(include_available=true). Unlinking preserves files, project registration, memory and task responsibility. Linking is context only, not authorization to edit a repository, contact tasks or scan in the background.',
      inputShape: { project_id: z.string().regex(/^[a-f0-9]{64}$/), linked: z.boolean() },
      handler: async ({ project_id, linked }) => {
        const id = callerSessionId(); if (!id) return missingSession();
        const result = await projects({ callerSessionId: id, projectId: project_id, linked });
        return result.ok ? okPayload({ projects: result.projects }) : errorPayload(result.errorCode, result.message);
      },
    });
  }
  if (deps.callbacks.todos) registerTodoTools(registry, callerSessionId, deps.callbacks.todos);

  if (deps.callbacks.setResponsibility) {
    const change = deps.callbacks.setResponsibility;
    registry.register({
      name: 'set_workbench_task_responsibility',
      category: 'bots',
      description: 'Explicitly take or release responsibility for one Cindy task on this computer. Taking needs the owner\'s request in this turn; you may release on your own. Tasks you start yourself are recorded by the host. Release only changes your responsibility; it does not stop, move, archive or delete the task, and does not affect Todo. Taking responsibility alone does not start execution; the host then wakes you when the task gets stuck, waits, errors or finishes.',
      inputShape: { task_id: z.string().min(1).max(256), responsible: z.boolean() },
      handler: async ({ task_id, responsible }) => {
        const id = callerSessionId();
        if (!id) return missingSession();
        const result = await change({ callerSessionId: id, taskId: task_id, responsible });
        return result.ok ? okPayload({ task_id: result.taskId, responsible: result.responsible }) : errorPayload(result.errorCode, result.message);
      },
    });
  }

  registry.register({
    name: 'get_workbench',
    category: 'bots',
    description:
      '读取你的工作台「一眼」:waiting 是在等主人的任务(等权限 / 等回答 / 出错),working 是正在做的任务,'
      + '另有今天做完几件与上次扫描时间。总调度伙伴(scope=all)看到本机与在线电脑上的全部任务;其它伙伴(scope=own)只看自己开的或明确接手的任务。'
      + '每行带 phase(working 里 usage-limit 表示撞上用量上限)。定时兜底叫醒时逐件看 waiting,以及 working 里 usage-limit 或久无进展的任务:'
      + '先 get_task_digest 读摘要再决定。只读,不改任何任务。',
    inputShape: {},
    handler: async () => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.get({ callerSessionId: sessionId });
      return result.ok
        ? okPayload({ workbench: glanceForModel(result.workbench) })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'read_workbench_task',
    category: 'bots',
    description:
      '只读一件任务最近的内容(用户与助手的文字,去掉工具结果与系统提示,最多约 4000 字,保留最近的)。'
      + '先用 get_task_digest;摘要不够判断时才用。总调度伙伴可读任意任务(另一台电脑上的需在线);其它伙伴只能读自己开的或接手的任务。',
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
    name: 'continue_workbench_task',
    category: 'bots',
    description:
      '让一件任务接着做:给它发一句话,消息标明由你发出,任务正忙时排到当前一轮之后。'
      + '主人这一轮开口时按主人的意思发；自主唤醒（跟进、例行任务）时只用来让交给你跟进的任务按原目标接着做，不借它追加新要求、改目标或停止任务，那些要等主人开口。'
      + '总调度伙伴可继续没有伙伴开的任务(含在线电脑上的)、自己开的任务,以及已交给它跟进的任务;别的伙伴开的任务默认由那位伙伴跟进,'
      + '会返回 TASK_FOLLOWED_BY_OTHER_BOT,只能读不能继续,需要接手时告诉主人可在那位伙伴的设置里打开「它开的任务也交给你跟进」。'
      + '其它伙伴只能继续自己接手的任务,你自己开的后台任务继续用 message_session_task。'
      + '发之前先 get_task_digest 确认它还需要这句话;把 message 写成那件任务收到就能直接做的一句指令,不要重复它已经做完的外部操作。'
      + '返回 DELIVERY_UNKNOWN 时消息可能已送达,先读摘要确认再决定是否重发。',
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
          })
        : errorPayload(result.errorCode, result.message);
    },
  });
}

const deadline = z.object({
  kind: z.enum(['date', 'instant']),
  date: z.string().max(10),
  timeZone: z.string().max(100),
  at: z.string().max(80).optional(),
  sourceId: z.string().max(512).optional(),
  sourceVersion: z.number().int().nonnegative().optional(),
  quote: z.string().max(2000).optional(),
  observedAt: z.string().max(80).optional(),
});
const todoPatch = z.object({
  id: z.string().max(128).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  key: z.string().min(1).max(512).optional(),
  origin: z.enum(['assigned', 'discovered']).optional(),
  title: z.string().min(1).max(300).optional(),
  progress: z.string().max(4000).optional(),
  outcome: z.string().min(1).max(4000).optional(),
  value: z.string().max(4000).optional(),
  next: z
    .object({
      label: z.string().min(1).max(100),
      instruction: z.string().min(1).max(4000),
      kind: z.enum(['advance', 'view', 'decide']),
    })
    .nullable()
    .optional(),
  sources: z
    .array(
      z.object({
        kind: z.enum(['conversation', 'mail', 'feishu', 'github', 'community', 'task']),
        id: z.string().min(1).max(512),
        label: z.string().min(1).max(300),
        ref: z.string().max(2000).optional(),
        project: z.string().max(4096).optional(),
        version: z.number().int().nonnegative().optional(),
        observedAt: z.string().max(80).optional(),
      }),
    )
    .max(100)
    .optional(),
  associations: z
    .array(
      z.object({
        kind: z.enum(['task', 'pr']),
        id: z.string().max(512),
        label: z.string().max(300),
      }),
    )
    .max(100)
    .optional(),
  sourceDeadline: deadline.nullable().optional(),
  deadlineOverride: z.object({ value: deadline.nullable() }).optional(),
  deadlineCandidate: z
    .object({ value: deadline, reason: z.string().max(2000) })
    .nullable()
    .optional(),
  suggestedDate: z.string().max(10).nullable().optional(),
  resolvedActionRequestId: z.string().min(1).max(128).optional(),
  operation: z
    .enum(['complete', 'reopen', 'delete', 'mute', 'later', 'restore', 'confirm-deadline'])
    .optional(),
  until: z.string().max(80).optional(),
  completion: z
    .object({
      summary: z.string().min(1).max(4000),
      ref: z.string().max(2000).optional(),
    })
    .optional(),
});
function registerTodoTools(
  registry: XdtHelperToolRegistry,
  caller: () => string | null,
  callback: NonNullable<BotWorkbenchCallbacks['todos']>,
) {
  const run = async (op: 'list' | 'update' | 'preflight' | 'ingest', input?: unknown) => {
    const id = caller();
    if (!id) return missingSession();
    const result = await callback(id, op, input);
    return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
  };
  registry.register({
    name: 'list_teammate_todos',
    category: 'bots',
    description:
      '按id/key读取同一事务（含完成/忽略记录），或分页搜索自己的清单，每页25条并返回总数。独立于项目/任务。维护优先精确读；无变化不扫描信息源。',
    inputShape: {
      id: z.string().max(128).optional(),
      key: z.string().max(512).optional(),
      query: z.string().max(300).optional(),
      view: z.enum(['open', 'done', 'hidden']).optional(),
      origin: z.enum(['all', 'assigned', 'discovered']).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    handler: (input) => run('list', input),
  });
  registry.register({
    name: 'update_teammate_todo',
    category: 'bots',
    description:
      '新建或部分更新同一事务。新建必须带key、title、outcome（预期结果或完成标准）；key跨来源标识同一问题；已存在时用id+expectedRevision，冲突先读再合并，省略字段保留旧值。发现可入单但不自动授权执行/发送。完成必须携带可核验summary/ref；停止/合并未必满足outcome。删除/静音保留抑制记录，只有用户恢复可解除。来源可指向任务（kind=task，id 为本机任务 id 或 deviceId::sessionId），不需要项目。跟进处理完一件事后更新或完成对应事务。到期保留来源/时区，模糊日期用candidate，用户覆盖不被新来源改掉；稍后不修改期限。',
    inputShape: { patch: todoPatch },
    handler: ({ patch }) => run('update', patch satisfies TodoPatch),
  });
  registry.register({
    name: 'preflight_teammate_todo_events',
    category: 'bots',
    description:
      '现有已授权事件流的便宜增量预检：按来源游标、稳定问题key及忽略/完成记录过滤（project 只作原样回传，不再裁剪范围），只有review事件需要取相关正文/模型判断。本工具不连接、扫描或新建定时器；无新事件不调用。',
    inputShape: {
      events: z
        .array(
          z.object({
            source: z.string().max(512),
            sequence: z.number().int().nonnegative(),
            key: z.string().max(512),
            project: z.string().max(4096).optional(),
          }),
        )
        .max(100),
    },
    handler: ({ events }) => run('preflight', events),
  });
  registry.register({
    name: 'record_teammate_todo_event',
    category: 'bots',
    description:
      '原子保存一条成功处理的增量事件与Todo更新或no-action结果。source+sequence幂等，按来源顺序逐条提交，不跳过失败事件；失败不会推进游标。重复、已完成、已忽略的同一key不会重建。不同来源同一反馈沿用key/id，不能擅自绕过用户拒绝。',
    inputShape: {
      source: z.string().max(512),
      sequence: z.number().int().nonnegative(),
      patch: todoPatch.optional(),
      skip: z.enum(['duplicate', 'suppressed', 'outside-scope', 'no-action']).optional(),
    },
    handler: (input) => run('ingest', input),
  });
}
