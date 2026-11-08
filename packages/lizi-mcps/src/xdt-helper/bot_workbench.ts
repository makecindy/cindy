import { z } from 'zod';

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

  if (deps.callbacks.setResponsibility) {
    const change = deps.callbacks.setResponsibility;
    registry.register({
      name: 'set_workbench_task_responsibility',
      category: 'bots',
      description: 'Explicitly take or release responsibility for one Cindy task on this computer. Taking needs the owner\'s request in this turn; you may release on your own. Tasks you start yourself are recorded by the host. Release only changes your responsibility; it does not stop, move, archive or delete the task. Taking responsibility alone does not start execution; the host then wakes you when the task gets stuck, waits, errors or finishes.',
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
