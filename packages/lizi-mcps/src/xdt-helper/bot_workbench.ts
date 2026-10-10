import { z } from 'zod';
import type { TodoPatch } from '@cindy/maker-shared/teammate-todo';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 伙伴工作台:主人把本机项目交给伙伴后,伙伴先读懂项目里的任务,再按主人的意思继续。
 *
 * 权限只来自主人的那次「交给伙伴」(工作台里点选,或主人本人那一轮让伙伴用 add_workbench_project
 * 记下):宿主从 callerSessionId 反查伙伴
 * (只认本机、在用的伙伴主任务),目标必须落在该伙伴已接手的项目里——Cindy 任务要是
 * 普通本机任务、未归档删除、不是任何伙伴自己的隐藏任务;本机 Claude Code / Codex / Pi 会话的
 * 工作目录要在已接手项目内;PR / issue 要属于已接手项目的 GitHub 远端;参考链接只认 https
 * 或项目内路径。工具层不接受 botId,越权一律由宿主确定性拒绝。
 */

export type WorkbenchTaskStateWire =
  | 'running'
  | 'waiting'
  | 'queued'
  | 'stopped'
  | 'automation'
  | 'done';

export type WorkbenchVerdictWire = 'unfinished' | 'idea' | 'done';

export interface WorkbenchBriefGithubItemWire {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  url: string;
}

/** 宿主现算的项目素材:有界、只看近期、带缓存。 */
export interface WorkbenchProjectBriefWire {
  /** 顶层与 docs/ 下两级以内的 Markdown 路径,重要的在前(只给路径,要看再用文件工具读)。 */
  docs: string[];
  /** 不是 git 仓库时最近 14 天改过的文件(最多 20 个)。 */
  recent: Array<{ path: string; modifiedAt: string }>;
  git: {
    branch: string | null;
    changes: number | null;
    commits: Array<{ sha: string; date: string; author: string; subject: string }>;
    branches: Array<{ name: string; date: string }>;
    /** 查 PR / issue 用的 GitHub 仓库(fork 工作流优先 upstream)。 */
    remote: string | null;
    /** upstream 与 origin 里的 GitHub 仓库;pr: / issue: 条目可以用其中任意一个。 */
    remotes: string[];
  } | null;
  github:
    | { repo: string; pullRequests: WorkbenchBriefGithubItemWire[]; issues: WorkbenchBriefGithubItemWire[] }
    | { unavailable: 'no-credential' | 'not-github' | 'error' };
}

export interface WorkbenchProjectWire {
  name: string;
  path: string;
  exists: boolean;
  brief: WorkbenchProjectBriefWire | null;
}

export interface WorkbenchJudgmentWire {
  title: string;
  verdict: WorkbenchVerdictWire;
  next: string | null;
  ref?: string | null;
  updatedAt: string;
}

/** 会话的起始目的与最近几条;宿主只读头尾,不读全文。 */
export interface WorkbenchDigestWire {
  purpose: string | null;
  recent: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface WorkbenchTaskWire {
  /** Cindy 任务是 session id;还没接过来的本机会话是 `claude:<id>` / `codex:<id>` / `pi:<id>`。 */
  taskId: string;
  source: 'cindy' | 'claude-code' | 'codex' | 'pi';
  /** 已经是 Cindy 里的任务(本机会话被继续过之后也会变成 true)。 */
  imported: boolean;
  /** 清洗过的原始标题。 */
  title: string;
  project: string;
  /** 只有 Cindy 任务有运行状态;本机会话为 null。 */
  state: WorkbenchTaskStateWire | null;
  /** delegated = 你开的后台任务。 */
  kind: 'existing' | 'delegated';
  lastActiveAt: string | null;
  messageCount: number | null;
  digest: WorkbenchDigestWire | null;
  /** 你之前写下的判断;还没读过为 null。 */
  judgment: WorkbenchJudgmentWire | null;
}

/** 你写下的 PR / issue / 建议条目。 */
export interface WorkbenchItemWire {
  taskId: string;
  project: string;
  judgment: WorkbenchJudgmentWire;
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
  items: WorkbenchItemWire[];
  automations: WorkbenchAutomationWire[];
  counts: Record<WorkbenchVerdictWire | 'unjudged', number>;
  /** 候选多于返回条数时为 true;totalTasks 是实际总数。 */
  truncated: boolean;
  totalTasks: number;
  /** 超过 30 天没动、没有列出的会话数。 */
  olderCount: number;
}

export interface WorkbenchJudgmentInputWire {
  taskId: string;
  title: string;
  verdict: WorkbenchVerdictWire;
  next?: string | null;
  ref?: string | null;
  project?: string | null;
}

export interface WorkbenchTranscriptWire {
  items: Array<{ role: 'user' | 'assistant'; text: string; at: number }>;
  truncated: boolean;
}

export interface BotWorkbenchCallbacks {
  todos?: (
    callerSessionId: string,
    operation: 'list' | 'update' | 'preflight' | 'ingest',
    input?: unknown,
  ) => Promise<ControlResult<Record<string, unknown>, string>>;

  get(params: { callerSessionId: string }): Promise<ControlResult<{ workbench: BotWorkbenchSnapshotWire }, string>>;
  read(params: {
    callerSessionId: string;
    taskId: string;
  }): Promise<ControlResult<{ taskId: string; transcript: WorkbenchTranscriptWire }, string>>;
  set(
    params: { callerSessionId: string } & WorkbenchJudgmentInputWire,
  ): Promise<ControlResult<{ taskId: string; judgment: WorkbenchJudgmentWire }, string>>;
  setMany(params: {
    callerSessionId: string;
    items: WorkbenchJudgmentInputWire[];
  }): Promise<
    ControlResult<
      {
        saved: number;
        results: Array<{ taskId: string; ok: true } | { taskId: string; ok: false; errorCode: string; message: string }>;
      },
      string
    >
  >;
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
        importedFrom?: string;
        startedFrom?: string;
      },
      string
    >
  >;
  /** 主人在这一轮亲口交代时,把一个本机项目目录交给伙伴(与工作台里「交给伙伴」同一份记录)。 */
  addProject(params: {
    callerSessionId: string;
    path: string;
  }): Promise<ControlResult<{ project: { name: string; path: string }; projectCount: number }, string>>;
  /** 主人让伙伴别再管某个项目时,从工作台移除它;项目里的任务与文件都不动。 */
  removeProject(params: {
    callerSessionId: string;
    path: string;
  }): Promise<ControlResult<{ path: string; removed: boolean }, string>>;
}

export interface BotWorkbenchToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  callbacks: BotWorkbenchCallbacks;
}

export const WORKBENCH_MESSAGE_MAX_CHARS = 4_000;
export const WORKBENCH_BATCH_MAX = 30;

function missingSession() {
  return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴主任务。');
}

const TASK_ID = z
  .string()
  .min(1)
  .max(256)
  .describe('get_workbench 返回的 taskId;或你新写的 pr:<owner>/<repo>#<n>、issue:<owner>/<repo>#<n>、idea:<slug>');

const JUDGMENT_FIELDS = {
  task_id: TASK_ID,
  title: z.string().min(1).max(40).describe('人话标题'),
  verdict: z.enum(['unfinished', 'idea', 'done']).describe('unfinished 承诺未完成;idea 尚未接下的建议;done 有依据完成(当前界面隐藏)'),
  next: z.string().max(120).optional().describe('一句当前进展与下一步;done 时记录完成依据,无专门的完成依据字段'),
  ref: z
    .string()
    .max(2000)
    .optional()
    .describe('可选参考:https 链接,或已接手项目内的文件绝对路径(例如 docs/design.md)'),
  project: z.string().max(1024).optional().describe('idea 条目归属的项目路径;只交了一个项目时可省略'),
};

function judgmentInput(item: {
  task_id: string;
  title: string;
  verdict: WorkbenchVerdictWire;
  next?: string;
  ref?: string;
  project?: string;
}): WorkbenchJudgmentInputWire {
  return {
    taskId: item.task_id,
    title: item.title,
    verdict: item.verdict,
    next: item.next ?? null,
    ...(item.ref ? { ref: item.ref } : {}),
    ...(item.project ? { project: item.project } : {}),
  };
}

export function registerBotWorkbenchTools(
  registry: XdtHelperToolRegistry,
  deps: BotWorkbenchToolDeps,
): void {
  const callerSessionId = () => deps.getSessionContext().sessionId ?? null;
  if (deps.callbacks.todos) registerTodoTools(registry, callerSessionId, deps.callbacks.todos);

  registry.register({
    name: 'get_workbench',
    category: 'bots',
    description:
      '读取已接手项目内的普通任务、项目素材和旧工作台判断。普通任务保留自己的生命周期。' +
      '伙伴事务清单请用 list_teammate_todos / update_teammate_todo，可没有项目；不要逐个复制任务。' +
      '会话限近期30天/30条，连外部会话最多40条；会话判断不返回ref，不能据此覆盖未知旧引用。' +
      '旧判断有200条上限、done优先淘汰，不是新Todo历史。项目过滤仅影响此项目视图。',
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
      '只读一件候选会话最近的内容(用户与助手的文字,去掉工具结果与系统提示,最多约 4000 字,保留最近的)。'
      + 'digest 不够判断时才用。本机 Claude Code / Codex / Pi 会话只读转录文件头尾,不会导入。PR / issue / 建议条目没有对话记录,看 ref。只能读主人交给你的项目里的会话。',
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
      '维护一件已接手项目内的事务判断。按 task_id 整条替换,多件变化用 set_workbench_tasks;保留仍有效的 ref/project。get_workbench 的会话判断没有 ref,无法从 updatedAt 与当前判断一致的已确认回执找回旧 ref 时不要覆盖。写后检查结果并尝试读回;成功回执已确认保存,近期/数量过滤导致列表不可见不等于失败,不重复写。当前不支持无项目 Todo 或独立的可选任务/PR 关联。' +
      'task_id:get_workbench 返回的会话 taskId,或你新写的 pr:<owner>/<repo>#<n>、issue:<owner>/<repo>#<n>(须是已接手项目的 GitHub 仓库)、idea:<slug>(小写字母数字与连字符,3–40 位)。' +
      '同一承诺沿用原 id,重复执行不重复建条目。title:当前人话标题,不超过 40 字,不用状态前缀;verdict:unfinished(约定未完成)/ idea(尚未接下的建议)/ done(有依据完成,当前界面隐藏)。无关内容不新建;记录不自动开工。' +
      'next:当前进展与下一步,不超过 120 字,unfinished / idea 必填;done 时写完成依据,ref 放支持依据的 https 链接或项目内文件路径。没有专门完成依据字段。停止或合并仍待验收则保持 unfinished;事实未知写待核实。只写有依据的判断,不要编造。',
    inputShape: JUDGMENT_FIELDS,
    handler: async (args) => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.set({ callerSessionId: sessionId, ...judgmentInput(args) });
      return result.ok
        ? okPayload({ task_id: result.taskId, judgment: result.judgment })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'set_workbench_tasks',
    category: 'bots',
    description:
      `批量写下判断(1–${WORKBENCH_BATCH_MAX} 条),字段与 set_workbench_task 相同。逐条校验,一条不合格不影响其它条;返回每条的结果。` +
      '对话承诺、任务回传、用户纠正或已授权跟进发现相关变化后才写,同一承诺沿用 id;没有变化不造条目。与单条一样保留旧引用,会话 ref 无法确认时不覆盖。检查每条结果,部分失败不代表全部成功,再尝试 get_workbench 读回;成功项可能因会话近期/数量限制不可见,不误报失败或重复写。当前只支持项目内记录。',
    inputShape: {
      items: z.array(z.object(JUDGMENT_FIELDS)).min(1).max(WORKBENCH_BATCH_MAX).describe('判断列表'),
    },
    handler: async ({ items }) => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.setMany({
        callerSessionId: sessionId,
        items: items.map((item) => judgmentInput(item)),
      });
      return result.ok
        ? okPayload({ saved: result.saved, results: result.results })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'continue_workbench_task',
    category: 'bots',
    description:
      '主人点头后(包括主人在工作台上点「跟进」),让工作台上的一件任务接着做:给它发一句话,消息以你的名义投递,任务正忙时排到当前一轮之后。'
      + '如果它还是没接过来的本机 Claude Code / Codex 会话,宿主先只导入这一条,再投递;返回里的 task_id 是导入后的新任务 id,之后用它。'
      + 'Pi 会话、导入不了的会话,以及 PR / issue / 建议条目:宿主在该项目目录里开一条你的后台任务(与 start_session_task 同一条路径),'
      + '目标是条目标题 + 你的 message + 参考与摘要;返回 started_from 为原条目,task_id 是新后台任务,之后用 message_session_task 跟进。'
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
            ...(result.startedFrom ? { started_from: result.startedFrom } : {}),
          })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'add_workbench_project',
    category: 'bots',
    description:
      '把主人这台电脑上的一个项目目录交给你跟进,工作台立刻多出这个项目;之后它就在你的负责范围里,主人事先安排的那几轮也能处理它里面的任务。'
      + '只在主人本人这一轮明确说要交给你(例如「这个项目以后你盯着」「把 ~/code/foo 交给你」)时用;不要因为聊到某个项目就自己加。'
      + 'path 填绝对路径;主人只说了项目名时先用 list_projects 找到它的路径。不能交整个磁盘根目录或主目录。'
      + '加完先 get_workbench 接手,再用几句话告诉主人你看到了什么。',
    inputShape: {
      path: z.string().min(1).max(4096).describe('项目目录的绝对路径'),
    },
    handler: async ({ path }) => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.addProject({ callerSessionId: sessionId, path });
      return result.ok
        ? okPayload({ project: result.project, project_count: result.projectCount })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'remove_workbench_project',
    category: 'bots',
    description:
      '主人本人这一轮说不用你再管某个项目时,把它从你的工作台移除。项目里的任务、文件和你写过的判断都不会被删,只是不再归你跟进。'
      + 'path 用 get_workbench 里该项目的 path（也可以写 ~/ 开头）。工作台里没有这个项目时返回 PROJECT_NOT_IN_WORKBENCH，什么都没移除，照实告诉主人。',
    inputShape: {
      path: z.string().min(1).max(4096).describe('要移除的项目路径'),
    },
    handler: async ({ path }) => {
      const sessionId = callerSessionId();
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.removeProject({ callerSessionId: sessionId, path });
      return result.ok
        ? okPayload({ path: result.path, removed: result.removed })
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
      '新建或部分更新同一事务。key跨来源标识同一问题；已存在时用id+expectedRevision，冲突先读再合并，省略字段保留旧值。发现可入单但不自动授权执行/发送。完成必须携带可核验summary/ref；停止/合并未必满足outcome。删除/静音保留抑制记录，只有用户恢复可解除。无项目可用；项目型伙伴只发现职责范围。到期保留来源/时区，模糊日期用candidate，用户覆盖不被新来源改掉；稍后不修改期限。',
    inputShape: { patch: todoPatch },
    handler: ({ patch }) => run('update', patch satisfies TodoPatch),
  });
  registry.register({
    name: 'preflight_teammate_todo_events',
    category: 'bots',
    description:
      '现有已授权事件流的便宜增量预检：按职责范围、来源游标、稳定问题key及忽略/完成记录过滤，只有review事件需要取相关正文/模型判断。本工具不连接、扫描或新建定时器；无新事件不调用。',
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
