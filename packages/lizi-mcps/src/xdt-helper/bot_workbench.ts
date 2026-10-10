import { z } from 'zod';

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

  registry.register({
    name: 'get_workbench',
    category: 'bots',
    description:
      '读取你的工作台:主人交给你的项目,每个项目的素材(brief:文档路径、git 分支与最近 14 天提交、我打开的 PR 与 issue;项目很多时只有最近交代的前 8 个带 brief,其余为 null,需要时用文件工具自己看),'
      + '项目里最近 30 天的会话(项目里的 Cindy 任务——包括主人自己开的——不管你判断过没有都在,最多 30 条;再补本机 Claude Code / Codex / Pi 会话,合计最多 40 条;更早的只给 olderCount),你写过的 PR / issue / 建议条目,你的例行任务与项目里的自动化。'
      + 'Todo 是你在对话中答应主人的事务,可早于项目或任务;当前工具只支持已接手项目内的记录,不支持无项目 Todo,不要创建伪项目或把日常事务塞成项目 idea。'
      + '主人提到这个项目、让你跟进或问进展,或对话/任务回传/已授权跟进中发现承诺变化时,读相关记录;只有实际变化才沿用 id 写回,纯进度查询也可只读。项目里的任务是上下文,不应逐条复制为 Todo。'
      + '每条会话带 digest:起始目的与最后几条对话,足够大多数判断,不用逐个读全文。会话 judgment 不返回 ref,不能把缺字段当成没有旧引用;找不到 updatedAt 与当前判断一致的已确认写入回执时不要覆盖该判断。'
      + '接手的做法:主人把项目交给你时,先调用它;再用你自己的文件工具读 brief.docs 里最前面的一两份(README / DESIGN / AGENTS 之类),弄清项目是做什么的、在往哪走;'
      + '然后看最近的提交(不是 git 仓库时看 brief.recent)和会话 digest,只对实际变化的相关事项用 set_workbench_tasks 批量写下判断;只有拿不准的几件才 read_workbench_task。'
      + '判断与下一步要体现你对项目的理解(它在项目里处于什么位置、和哪份文档或哪次提交有关),不要只复述会话。'
      + '项目文档(如 DESIGN.md)、最近的 PR 与 issue 同样是素材:值得做的写成 pr:<owner>/<repo>#<n>、issue:<owner>/<repo>#<n> 或 idea:<slug> 条目,带上 ref。'
      + '判断标准:已接下但约定结果未达成 → unfinished;尚未接下的建议 → idea;有可核实依据达到约定结果 → done。纯问答与无关内容不新建条目;停止、空闲、PR 合并不自动等于承诺完成,仍待验收时写明下一步。'
      + 'get_workbench 返回尚保留且仍在项目范围内的 PR/issue/idea done 条目;会话 done 判断还受前述近期窗口和数量过滤,不能保证查回所有已存完成记录。当前界面隐藏 done,最多 200 条且旧 done 优先淘汰;继续为后台任务时也可能移除原判断,不能当完整完成历史。'
      + '写后检查逐条结果并尝试读回确认。会话列表受近期窗口和数量上限约束,写入成功的旧会话可能不在返回中;成功回执确认保存,列表缺席不等于写失败,不能为此重复写。聊天简短区分已保存但列表不可见、已读回核对和未保存;记录建议不等于开工授权。已有同范围授权时继续跟进,不重复求许可;没有授权的建议不能自行开始。'
      + '主人在工作台上点「跟进」时会发来「跟进「<标题>」」(其它语言如 Follow up on “<标题>”):先调用本工具按标题找到那一条,'
      + '再 continue_workbench_task——会话条目发一句承接上文、收到就能接着做的指令;PR / issue / 建议条目会在项目目录开后台任务。'
      + '找不到同名条目就问主人是哪一件,不要猜;有几条同名时列出候选让主人选。'
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
      '维护一件已接手项目内的事务判断。按 task_id 整条替换,多件变化用 set_workbench_tasks;保留仍有效的 ref/project。get_workbench 的会话判断没有 ref,无法从 updatedAt 与当前判断一致的已确认回执找回旧 ref 时不要覆盖。写后检查结果并尝试读回;成功回执已确认保存,近期/数量过滤导致列表不可见不等于失败,不重复写。当前不支持无项目 Todo 或独立的可选任务/PR 关联。'
      + 'task_id:get_workbench 返回的会话 taskId,或你新写的 pr:<owner>/<repo>#<n>、issue:<owner>/<repo>#<n>(须是已接手项目的 GitHub 仓库)、idea:<slug>(小写字母数字与连字符,3–40 位)。'
      + '同一承诺沿用原 id,重复执行不重复建条目。title:当前人话标题,不超过 40 字,不用状态前缀;verdict:unfinished(约定未完成)/ idea(尚未接下的建议)/ done(有依据完成,当前界面隐藏)。无关内容不新建;记录不自动开工。'
      + 'next:当前进展与下一步,不超过 120 字,unfinished / idea 必填;done 时写完成依据,ref 放支持依据的 https 链接或项目内文件路径。没有专门完成依据字段。停止或合并仍待验收则保持 unfinished;事实未知写待核实。只写有依据的判断,不要编造。',
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
      `批量写下判断(1–${WORKBENCH_BATCH_MAX} 条),字段与 set_workbench_task 相同。逐条校验,一条不合格不影响其它条;返回每条的结果。`
      + '对话承诺、任务回传、用户纠正或已授权跟进发现相关变化后才写,同一承诺沿用 id;没有变化不造条目。与单条一样保留旧引用,会话 ref 无法确认时不覆盖。检查每条结果,部分失败不代表全部成功,再尝试 get_workbench 读回;成功项可能因会话近期/数量限制不可见,不误报失败或重复写。当前只支持项目内记录。',
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
