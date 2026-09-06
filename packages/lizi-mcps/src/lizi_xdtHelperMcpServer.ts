/**
 * lizi_xdtHelperMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server exposing xdt-maker 的基础设施自省 + session handoff 能力。
 *
 * 设计:
 *  - server name = `cindy_helper`,essential(常开,不可被用户关闭)
 *  - 所有工具走 `list_tools` / `call_tool` 两个入口,渐进式发现,分五类:
 *    - 'cindy'   : 只读自省 (get_capabilities / get_current_session_id)
 *    - 'history' : 只读查询本地数据库聊天历史与输入队列 (list_workdirs /
 *                  list_sessions / list_session_queue / get_chat_history /
 *                  search_chat_history)
 *    - 'control' : 会话状态控制 (set_current_session_title / rename_sessions /
 *                  archive_sessions / unarchive_sessions)
 *    - 'feedback': 官方反馈提交 (submit_github_issue)
 *    - 'handoff' : session 间 handoff 原语 (send_to_session),供 skill 跨会话路由
 *  - send_to_session 曾经直接顶层注册;现归入 handoff 类目走 call_tool,与改名工具
 *    隔离(不同 category),避免 LLM 在"改 session 名"意图下误选它(见 issue #287)。
 *  - 协同 team 工具(start_team / create_worker / …)已拆到独立的 `cindy_orca` server
 *    (对应"协同模式"可关插件),本 server 不再承载。
 *
 * 为什么只读类工具走 list_tools/call_tool 入口而不直接注册:
 *  - 直接注册时 tool name + description + inputSchema 全量进系统提示,前置成本固定
 *  - 走 list_tools/call_tool 入口后,真正的 get_capabilities 描述只在用户问到时
 *    才被拉取,前置成本低(只两条入口工具进系统提示)
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonObjectArg } from './json-object-arg.js';

import { XdtHelperToolRegistry } from './lizi_xdtHelperToolRegistry.js';
import {
  registerGetCapabilitiesTool,
  registerGetCurrentSessionIdTool,
  registerSetCurrentSessionTitleTool,
  registerRenameSessionsTool,
  registerArchiveSessionsTool,
  registerUnarchiveSessionsTool,
  registerSendToSessionTool,
  registerListWorkdirsTool,
  registerListSessionsTool,
  registerListSessionQueueTool,
  registerUpdateSessionQueuedMessageTool,
  registerCancelSessionQueuedMessageTool,
  registerSteerSessionTool,
  registerStopSessionTurnTool,
  registerGetSessionRuntimeTool,
  registerSetSessionRuntimeTool,
  registerGetChatHistoryTool,
  registerSearchChatHistoryTool,
  registerSubmitGithubIssueTool,
} from './xdt-helper/index.js';
import type { SubmitGithubIssueDeps } from './xdt-helper/submit_github_issue.js';
import type { SetCurrentSessionTitleDeps } from './xdt-helper/set_current_session_title.js';
import type { RenameSessionsDeps } from './xdt-helper/rename_sessions.js';
import type { ArchiveSessionsDeps } from './xdt-helper/archive_sessions.js';
import type { SendToSessionCallback } from './xdt-helper/send_to_session.js';
import {
  registerBotSkillTools,
  type BotSkillCallbacks,
} from './xdt-helper/bot_skills.js';
import type { XdtHelperHistoryDeps } from './xdt-helper/_history_types.js';
import type { SessionQueueDeps } from './xdt-helper/list_session_queue.js';
import type { SessionControlDeps } from './xdt-helper/session_control.js';
import type { ControlResult, LiziMcpLogger } from './types.js';
import { resolveLiziMcpSessionContext } from './session-context.js';
import { logToolResultErrorCode } from './tool-error-telemetry.js';
import { errorPayload, okPayload } from './xdt-helper/_payload.js';
import {
  registerCreateTeammateTool,
  type CreateTeammateCallbacks,
} from './xdt-helper/create_teammate.js';

// ── Re-exports (backward compat for consumers that imported from here) ────

export type {
  ControlOkResult,
  ControlErrResult,
  ControlResult,
  ControlWorkerAgent,
} from './types.js';

// ── Entry-tool descriptions ─────────────────────────────────────────────────

const D_LIST_TOOLS =
  `探索当前任务获准使用的 ${BRAND_NAME} 辅助能力。` +
  '不传 category 先取得可用类目；只在确有需要时查看一个类目，再用 call_tool 执行。';

const D_CALL_TOOL =
  '调用 list_tools 为当前任务返回的一个具体工具。不要猜工具名，也不要把它当成通用命令入口。';

// list_tools 入口类目: cindy(自省) / control(会话控制面) / history(聊天历史) / feedback(官方反馈提交) / handoff(session 间 handoff)。
// 协同 team 工具已拆到独立 cindy_orca server(插件开关 gate)。
const CATEGORY_ENUM = ['cindy', 'control', 'history', 'feedback', 'handoff', 'bots'] as const;

interface SessionTaskCallbacks {
  startSessionTask(params: {
    callerSessionId: string;
    objective: string;
    contextRefs?: string[];
    title?: string;
    workingDir?: string;
    timeoutMs?: number;
  }): Promise<ControlResult<Record<string, unknown>, string>>;
  messageSessionTask(params: {
    callerSessionId: string;
    taskId: string;
    reply:
      | { kind: 'approve' }
      | { kind: 'deny'; reason?: string }
      | { kind: 'answer'; answers: Record<string, string> }
      | { kind: 'message'; text: string; idempotencyKey?: string };
  }): Promise<ControlResult<Record<string, unknown>, string>>;
  getSessionTask(params: {
    callerSessionId: string;
    taskId: string;
  }): Promise<ControlResult<{ task: unknown }, string>>;
  stopSessionTask(params: {
    callerSessionId: string;
    taskId: string;
  }): Promise<ControlResult<Record<string, unknown>, string>>;
}

interface BotMessagingCallbacks {
  messageAgent(params: {
    callerSessionId: string;
    targetBotId: string;
    message: string;
  }): Promise<
    | {
        ok: true;
        targetBotId: string;
        targetBotName: string;
        targetSessionId: string;
        wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
      }
    | {
        ok: false;
        errorCode: string;
        message: string;
        availableBots?: Array<{ id: string; name: string }>;
      }
  >;
}

// ── Entry tool registration ──────────────────────────────────────────────────

function registerListToolsEntry(
  server: McpServer,
  registry: XdtHelperToolRegistry,
  allowedCategories: () => Promise<ReadonlySet<string> | null>,
): void {
  server.tool(
    'list_tools',
    D_LIST_TOOLS,
    {
      category: z.string().optional().describe('list_tools 上一步返回的类目；不传则先取类目概览。'),
    },
    async ({ category }) => {
      const allowed = await allowedCategories();
      if (category) {
        if (allowed && !allowed.has(category)) {
          return errorPayload('CAPABILITY_NOT_AVAILABLE', '这个类目不属于当前任务的能力面。');
        }
        const tools = registry.list(category as (typeof CATEGORY_ENUM)[number]);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                category,
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  ...(t.category === 'bots' ? {
                    inputSchema: z.toJSONSchema(z.strictObject(registry.get(t.name)!.inputShape)),
                  } : {}),
                })),
                hint: '调用具体工具用 call_tool({name, args})。',
              }),
            },
          ],
        };
      }
      const counts: Record<string, number> = {};
      const visibleTools = registry.list().filter((tool) => !allowed || allowed.has(tool.category));
      for (const t of visibleTools) {
        counts[t.category] = (counts[t.category] ?? 0) + 1;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              categories: registry.listCategories().filter((c) => !allowed || allowed.has(c)).map((c) => ({
                name: c,
                tool_count: counts[c] ?? 0,
              })),
              hint: '用 list_tools({category}) 查看某类目下的工具列表',
            }),
          },
        ],
      };
    },
  );
}

function registerCallToolEntry(
  server: McpServer,
  registry: XdtHelperToolRegistry,
  telemetry: {
    logger?: LiziMcpLogger;
    getSessionId: () => string | undefined;
  },
  allowedCategories: () => Promise<ReadonlySet<string> | null>,
): void {
  server.tool(
    'call_tool',
    D_CALL_TOOL,
    {
      name: z
        .string()
        .describe('工具名,从 list_tools 获取(如 get_capabilities)'),
      args: jsonObjectArg('工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈。'),
    },
    async ({ name, args }) => {
      const allowed = await allowedCategories();
      const definition = registry.get(name);
      if (allowed && definition && !allowed.has(definition.category)) {
        return errorPayload(
          'CAPABILITY_NOT_AVAILABLE',
          '这个工具不属于当前任务的能力面；请重新调用 list_tools。',
        );
      }
      const result = definition
        ? await registry.call(name, args)
        : errorPayload('UNKNOWN_TOOL', 'Unknown helper tool.', {
            available: registry.list().filter((tool) => !allowed || allowed.has(tool.category)).map((tool) => tool.name),
          });
      // errorCode 遥测:UNKNOWN_TOOL / INVALID_ARGS / 业务 errorCode 返回给模型自纠
      // 之前在这里落一条日志,否则 agent 犯错→自纠 的事件在日志里完全不存在。
      logToolResultErrorCode({
        logger: telemetry.logger,
        server: 'cindy_helper',
        tool: name,
        result,
        sessionId: telemetry.getSessionId(),
      });
      return result;
    },
  );
}

/**
 * Start a real Cindy Session task. This is deliberately a separate model-facing
 * tool from teammate messaging: a Bot named "Cindy" is still a teammate, not a
 * substitute for an independent task in the user's task list.
 */
function registerStartSessionTaskEntry(
  registry: XdtHelperToolRegistry,
  deps: XdtHelperMcpDeps,
  sessionCtx: XdtHelperMcpSessionCtx,
): void {
  if (!deps.sessionTasks) return;
  registry.register({
    name: 'start_session_task',
    category: 'bots',
    description: [
      'Start one real independent Cindy Session task in the background.',
      'Use this when the user explicitly asks to create/start a task, Session, or background task, and for development or deliverable work that should run independently with progress, cancellation, verification, and automatic result/artifact return.',
      "This never calls a Cindy Bot or any other teammate. Use send_to_agent for a bounded message to a named teammate.",
      "The task appears in the user's task list and returns its completion automatically. Start it once and use check_session_task, message_session_task, or stop_session_task only when there is a concrete reason.",
    ].join('\n'),
    inputShape: {
      instruction: z.string().min(1).max(12_000),
      title: z.string().min(1).max(120).optional(),
      working_dir: z.string().min(1).max(1_024).optional(),
      context_refs: z.array(z.string().max(512)).max(32).optional(),
      timeout_ms: z.number().int().min(1_000).max(86_400_000).optional(),
    },
    handler: async ({ instruction, title, working_dir, context_refs, timeout_ms }) => {
      const callerSessionId = resolveLiziMcpSessionContext(sessionCtx).sessionId;
      if (!callerSessionId) {
        return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定 Cindy 伙伴任务。');
      }
      const result = await deps.sessionTasks!.startSessionTask({
        callerSessionId,
        objective: instruction.trim(),
        contextRefs: context_refs,
        title,
        workingDir: working_dir,
        timeoutMs: timeout_ms,
      });
      return result.ok
        ? okPayload({
            action: 'start_session_task',
            task_id: result.delegationId,
            session_id: result.childSessionId,
            status: result.status,
            deadline_at: result.deadlineAt,
            expects_result: true,
            guidance:
              "The Session task is tracked and will return its result automatically. Do not start it again.",
          })
        : errorPayload(result.errorCode, result.message);
    },
  });
}

/** One bounded, asynchronous message between two persistent teammates. */
function registerSendToAgentEntry(
  registry: XdtHelperToolRegistry,
  deps: XdtHelperMcpDeps,
  sessionCtx: XdtHelperMcpSessionCtx,
): void {
  if (!deps.botMessaging) return;
  registry.register({
    name: 'send_to_agent',
    category: 'bots',
    description: [
      'Send one asynchronous message to a named Cindy Bot teammate.',
      'Use it for a brief question, discussion, or information transfer. It does not create a task, status, progress, cancellation, or a completion contract.',
      "The message remains visible in both teammates' timelines. The recipient may answer in a later turn. Do not poll or send acknowledgement-only replies.",
      'For independently tracked development or deliverable work, use start_session_task instead.',
      'When a structured @Bot reference is present, use its Bot ID directly. Do not list the roster first.',
    ].join('\n'),
    inputShape: {
      target_id: z.string().min(1).max(128),
      message: z.string().min(1).max(12_000),
    },
    handler: async ({ target_id, message }) => {
      const callerSessionId = resolveLiziMcpSessionContext(sessionCtx).sessionId;
      if (!callerSessionId) {
        return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定 Cindy 伙伴任务。');
      }
      const result = await deps.botMessaging!.messageAgent({
        callerSessionId,
        targetBotId: target_id,
        message: message.trim(),
      });
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message, {
          ...(result.availableBots
            ? { available_agents: result.availableBots }
            : {}),
        });
      }
      return okPayload({
        action: 'send_to_agent',
        delivered: true,
        target_id: result.targetBotId,
        target_name: result.targetBotName,
        wake_kind: result.wakeKind,
        guidance:
          'Delivery is confirmed. End this turn without polling; a useful reply may arrive in a later turn.',
      });
    },
  });
}

function registerSessionTaskControlEntries(
  registry: XdtHelperToolRegistry,
  deps: XdtHelperMcpDeps,
  sessionCtx: XdtHelperMcpSessionCtx,
): void {
  if (!deps.sessionTasks) return;
  const callerSessionId = () => resolveLiziMcpSessionContext(sessionCtx).sessionId;
  const requireCaller = () =>
    callerSessionId()
      ? null
      : errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定 Cindy 伙伴任务。');

  registry.register({
    name: 'check_session_task',
    category: 'bots',
    description: 'Read the current state and result of one Session task. Use only when the user asks for progress or the automatic completion return appears to be missing.',
    inputShape: { task_id: z.string().min(1).max(128) },
    handler: async ({ task_id }) => {
      const callerError = requireCaller();
      if (callerError) return callerError;
      const result = await deps.sessionTasks!.getSessionTask({
        callerSessionId: callerSessionId()!,
        taskId: task_id,
      });
      return result.ok
        ? okPayload({
            action: 'check_session_task',
            task_id,
            task: result.task,
          })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'message_session_task',
    category: 'bots',
    description: [
      'Send a follow-up to one Session task without starting another task.',
      'Use message to add or correct instructions. Use decision or answers only when the task is waiting for that exact response.',
      'A completed task resumes in a fresh execution of the same tracked task.',
    ].join('\n'),
    inputShape: {
      task_id: z.string().min(1).max(128),
      message: z.string().min(1).max(4_000).optional(),
      decision: z.enum(['approve', 'deny']).optional(),
      answers: z.record(z.string(), z.string()).optional(),
      reason: z.string().max(4_000).optional(),
      idempotency_key: z.string().min(1).max(128).optional(),
    },
    handler: async ({
      task_id,
      message,
      decision,
      answers,
      reason,
      idempotency_key,
    }) => {
      const callerError = requireCaller();
      if (callerError) return callerError;
      const choices =
        Number(Boolean(message?.trim())) +
        Number(Boolean(decision)) +
        Number(Boolean(answers));
      if (choices !== 1) {
        return errorPayload(
          'INVALID_ARGS',
          'Provide exactly one of message, decision, or answers.',
        );
      }
      const reply = message?.trim()
        ? {
            kind: 'message' as const,
            text: message.trim(),
            idempotencyKey: idempotency_key,
          }
        : decision === 'approve'
          ? { kind: 'approve' as const }
          : decision === 'deny'
            ? { kind: 'deny' as const, reason }
            : { kind: 'answer' as const, answers: answers! };
      const result = await deps.sessionTasks!.messageSessionTask({
        callerSessionId: callerSessionId()!,
        taskId: task_id,
        reply,
      });
      return result.ok
        ? okPayload({
            action: 'message_session_task',
            task_id,
            session_id: result.childSessionId,
            resumed: result.resumed,
            ...(result.queued === undefined ? {} : { queued: result.queued }),
          })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'stop_session_task',
    category: 'bots',
    description: 'Stop one running Session task and its child tasks. Use only when the user asks to stop it or continuing would be unsafe.',
    inputShape: { task_id: z.string().min(1).max(128) },
    handler: async ({ task_id }) => {
      const callerError = requireCaller();
      if (callerError) return callerError;
      const result = await deps.sessionTasks!.stopSessionTask({
        callerSessionId: callerSessionId()!,
        taskId: task_id,
      });
      return result.ok
        ? okPayload({
            action: 'stop_session_task',
            task_id,
            session_id: result.childSessionId,
          })
        : errorPayload(result.errorCode, result.message);
    },
  });
}

// ── Shared control dispatch types ─────────────────────────────────────────────

export type ControlDispatchOutcome =
  | {
      kind: 'session-dispatch';
      source: string;
      dispatched: true;
      wakeKind?: 'queued';
    }
  | {
      kind: 'session-dispatch';
      source: string;
      dispatched: false;
      reason: string;
      message: string;
      context: string;
    }
  | {
      kind: 'host-send';
      source: string;
      context: string;
      accepted: false;
      code: string;
      message: string;
    };

// ── Factory ────────────────────────────────────────────────────────────────

export interface XdtHelperMcpDeps {
  logger?: LiziMcpLogger;
  /** Host-owned runtime classification used to keep Bot tasks on a narrow surface. */
  resolveSurface?: (input: {
    sessionId: string;
  }) => Promise<'default' | 'bot' | 'restricted'>;
  /**
   * 历史聊天数据查询的回调集合(读本地 SQLite 的 sessions / messages 表)。host
   * 注入后, history 类工具(list_workdirs / list_sessions / get_chat_history /
   * search_chat_history) 会被注册; 不注入则这四个工具不出现在 list_tools 里。
   */
  history?: XdtHelperHistoryDeps;
  /**
   * 本机 session 输入队列的只读查询回调。host 注入后注册 list_session_queue，
   * 并让 list_sessions 为每条 session 附带 queuedCount。
   */
  sessionQueue?: SessionQueueDeps;
  /** 本机 session 的统一控制面；host 注入后注册队列编辑/撤回、插话、停止与运行探针。 */
  sessionControl?: Omit<SessionControlDeps, 'getSessionContext'>;
  /**
   * Session handoff 回调。host 注入后, send_to_session 工具注册到 handoff 类目(走
   * call_tool);不注入则工具不出现。此工具是 skill(如 maker-github-issue)做跨会话
   * 路由的原语, 放在 essential 的 cindy_helper 下常开保证 skill 永不断。
   */
  sendToSession?: SendToSessionCallback;
  /** Cindy Bot-only background Session-task controls. Host validates the caller Session. */
  sessionTasks?: SessionTaskCallbacks;
  /** Direct Bot-to-Bot messages over each partner's canonical Cindy Session. */
  botMessaging?: BotMessagingCallbacks;
  /** Direct lightweight Bot creation for a Bot-bound session. */
  botProfiles?: CreateTeammateCallbacks;
  /**
   * Cindy Bot-only skill shelf: the Bot turns a finished way of working into a
   * real Skill file that the next task mounts. Host resolves Bot ownership from
   * the caller Session.
   */
  botSkills?: BotSkillCallbacks;
  /**
   * 官方反馈 issue 提交回调(弹确认卡片 → 用户确认 → POST server)。host 注入后,
   * feedback 类工具 submit_github_issue 会被注册; 不注入则不出现在 list_tools 里。
   */
  githubIssue?: SubmitGithubIssueDeps['submit'];
  /**
   * 当前 session 标题更新回调。host 注入后, control 类工具
   * set_current_session_title 会被注册; 不注入则不出现在 list_tools 里。
   */
  setCurrentSessionTitle?: SetCurrentSessionTitleDeps['setCurrentSessionTitle'];
  /**
   * 批量 session 标题更新回调。host 注入后, control 类工具 rename_sessions 会被注册。
   * 工具层负责 dry-run token 护栏; host 负责读取当前标题、校验前置条件和写库。
   */
  renameSessions?: RenameSessionsDeps['renameSessions'];
  /**
   * 批量归档 / 取消归档 session 回调。host 注入后, control 类工具 archive_sessions /
   * unarchive_sessions 会被注册。host 负责存在性校验(全有才写)、写库并广播 sessions:patched。
   */
  setSessionsStatus?: ArchiveSessionsDeps['setSessionsStatus'];
}

/**
 * Per-session ctx 绑定参数。MCP server 实例在 toClaudeSdkConfig(ctx) 时按 ctx
 * 字段惰性创建, 工具 handler 闭包捕获这些值。
 */
export interface XdtHelperMcpSessionCtx {
  agentKind: 'claude-code' | 'codex' | 'pi';
  workingDir: string;
  getSessionContext?: () => import('./types.js').LiziMcpSessionContext | undefined;
  sessionId?: string;
  vendorOptions?: Record<string, unknown>;
}

export function createXdtHelperMcpServer(
  deps: XdtHelperMcpDeps,
  sessionCtx: XdtHelperMcpSessionCtx,
): McpServer {
  const server = new McpServer({
    name: 'cindy_helper',
    version: '1.0.0',
  });

  const registry = new XdtHelperToolRegistry();
  const allowedCategories = async (): Promise<ReadonlySet<string> | null> => {
    const sessionId = resolveLiziMcpSessionContext(sessionCtx).sessionId;
    const defaultCategories = new Set(CATEGORY_ENUM.filter((category) => category !== 'bots'));
    if (!sessionId || !deps.resolveSurface) return defaultCategories;
    const surface = await deps.resolveSurface({ sessionId }).catch(() => 'restricted' as const);
    // Bot-specific memory, Skills, messaging, delegation and durable notes all
    // live in this single category. Cindy-wide history/control/feedback/handoff
    // stay out of the Bot's discovery loop.
    if (surface === 'bot') return new Set(['bots']);
    return surface === 'restricted' ? new Set() : defaultCategories;
  };

  // 'cindy' 类: 自省 (无 host 依赖, 始终注册)。
  registerGetCapabilitiesTool(registry);
  registerGetCurrentSessionIdTool(registry, {
    getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
  });

  if (deps.setCurrentSessionTitle) {
    registerSetCurrentSessionTitleTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      setCurrentSessionTitle: deps.setCurrentSessionTitle,
    });
  }
  if (deps.renameSessions) {
    registerRenameSessionsTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      renameSessions: deps.renameSessions,
    });
  }
  if (deps.setSessionsStatus) {
    const archiveDeps = {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      setSessionsStatus: deps.setSessionsStatus,
    };
    registerArchiveSessionsTool(registry, archiveDeps);
    registerUnarchiveSessionsTool(registry, archiveDeps);
  }

  // History 类工具: 仅 host 注入了 history 回调时注册。
  if (deps.history) {
    const historyDeps = {
      history: deps.history,
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
    };
    registerListWorkdirsTool(registry, historyDeps);
    registerListSessionsTool(registry, {
      ...historyDeps,
      ...(deps.sessionQueue ? { sessionQueue: deps.sessionQueue } : {}),
    });
    registerGetChatHistoryTool(registry, historyDeps);
    registerSearchChatHistoryTool(registry, historyDeps);
  }
  if (deps.sessionQueue) {
    registerListSessionQueueTool(registry, deps.sessionQueue);
  }
  if (deps.sessionControl) {
    const controlDeps: SessionControlDeps = {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      ...deps.sessionControl,
    };
    registerUpdateSessionQueuedMessageTool(registry, controlDeps);
    registerCancelSessionQueuedMessageTool(registry, controlDeps);
    registerSteerSessionTool(registry, controlDeps);
    registerStopSessionTurnTool(registry, controlDeps);
    registerGetSessionRuntimeTool(registry, controlDeps);
    registerSetSessionRuntimeTool(registry, controlDeps);
  }

  // Feedback 类工具: 仅 host 注入了 githubIssue 回调时注册。
  if (deps.githubIssue) {
    registerSubmitGithubIssueTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      submit: deps.githubIssue,
    });
  }

  // send_to_session: 仅 host 注入了 sendToSession 回调时注册到 handoff 类目(走 call_tool)。
  if (deps.sendToSession) {
    registerSendToSessionTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      sendToSession: deps.sendToSession,
    });
  }
  // 伙伴消息与 Session 任务控制统一进入 bots 类目，由调用时的任务身份限制发现与执行。
  if (deps.botSkills) {
    registerBotSkillTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.botSkills,
    });
  }

  registerStartSessionTaskEntry(registry, deps, sessionCtx);
  registerSendToAgentEntry(registry, deps, sessionCtx);
  registerSessionTaskControlEntries(registry, deps, sessionCtx);
  if (deps.botProfiles) {
    registerCreateTeammateTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.botProfiles,
    });
  }
  registerListToolsEntry(server, registry, allowedCategories);
  registerCallToolEntry(server, registry, {
    logger: deps.logger,
    // per-call 解析:codex HTTP bridge 的 server factory 阶段 ctx 是空的,
    // tool-call 阶段由 AsyncLocalStorage 恢复,所以 sessionId 必须调用时再取。
    getSessionId: () => resolveLiziMcpSessionContext(sessionCtx).sessionId,
  }, allowedCategories);

  return server;
}
