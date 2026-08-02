/**
 * lizi_xdtHelperMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server exposing xdt-maker 的基础设施自省 + session handoff 能力。
 *
 * 设计:
 *  - server name = `cindy_helper`,essential(常开,不可被用户关闭)
 *  - 所有工具走 `list_tools` / `call_tool` 两个入口,渐进式发现,分五类:
 *    - 'cindy'   : 只读自省 (get_capabilities / get_current_session_id)
 *    - 'history' : 只读查询本地数据库聊天历史 (list_workdirs / list_sessions /
 *                  get_chat_history / search_chat_history)
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
  registerGetChatHistoryTool,
  registerSearchChatHistoryTool,
  registerSubmitGithubIssueTool,
} from './xdt-helper/index.js';
import type { SubmitGithubIssueDeps } from './xdt-helper/submit_github_issue.js';
import type { SetCurrentSessionTitleDeps } from './xdt-helper/set_current_session_title.js';
import type { RenameSessionsDeps } from './xdt-helper/rename_sessions.js';
import type { ArchiveSessionsDeps } from './xdt-helper/archive_sessions.js';
import type { SendToSessionCallback } from './xdt-helper/send_to_session.js';
import type { XdtHelperHistoryDeps } from './xdt-helper/_history_types.js';
import type { LiziMcpLogger } from './types.js';
import { resolveLiziMcpSessionContext } from './session-context.js';
import { logToolResultErrorCode } from './tool-error-telemetry.js';

// ── Re-exports (backward compat for consumers that imported from here) ────

export type {
  ControlOkResult,
  ControlErrResult,
  ControlResult,
  ControlWorkerAgent,
} from './types.js';

// ── Entry-tool descriptions ─────────────────────────────────────────────────

const D_LIST_TOOLS =
  '探索 cindy_helper 可用工具(渐进式发现入口)。不传 category → 返回所有类目+每个类目工具数量。' +
  `传 category=cindy → ${BRAND_NAME} 自省类只读工具(get_capabilities / get_current_session_id);` +
  '传 category=control → 对话控制工具(set_current_session_title / rename_sessions);' +
  '传 category=history → 只读查询本地数据库聊天历史' +
  '(list_workdirs / list_sessions / get_chat_history 按元数据捞, search_chat_history 按内容语义找),' +
  '用于让用户基于自己的对话历史组织 memory / 知识库;' +
  `传 category=feedback → 用户要给 ${BRAND_NAME} 官方提 bug / 反馈 / 功能建议时用` +
  '(submit_github_issue,先与用户对话澄清细节,提交前会弹系统确认卡片);' +
  '传 category=handoff → 把消息投递到一个【已知 session】, 或为外部业务对象(issue / jira / pr)新建专属 session' +
  '(send_to_session, 供 skill 绑定业务对象路由用)。' +
  '⚠️ 开协同 / 多 agent / 派 worker 干活 / 拉 agent review, 请用 cindy_orca 的 start_team / create_worker, 不要用 handoff(它不组队、不进协同分组)。' +
  '获取工具名后用 call_tool({name, args}) 执行。' +
  '(协同 team 工具 start_team / create_worker 等在 cindy_orca server 直接顶层注册, 不在本入口下。)';

const D_CALL_TOOL =
  '调用 cindy_helper 中的某个具体工具(如 get_capabilities / get_current_session_id / ' +
  'set_current_session_title / rename_sessions / send_to_session / list_workdirs / list_sessions / get_chat_history / search_chat_history / submit_github_issue)。' +
  '先用 list_tools 拿工具名 + 简介。' +
  '错误码:`UNKNOWN_TOOL` = 工具名不存在;`INVALID_ARGS` = 参数 schema 校验失败(返回 schema 自纠);' +
  'tool 自身的业务错(如 NO_SESSION_CONTEXT / INVALID_FILTER / HOST_NOT_READY / INTERNAL)' +
  '在返回 payload 的 errorCode 字段, 附 data.hint 引导自纠。' +
  'history 类工具返回 hasMore=true 时用响应里的 nextCursor 再次调用本工具拿下一页, 不会丢信息。';

// list_tools 入口类目: cindy(自省) / control(会话标题控制) / history(聊天历史) / feedback(官方反馈提交) / handoff(session 间 handoff)。
// 协同 team 工具已拆到独立 cindy_orca server(插件开关 gate)。
const CATEGORY_ENUM = ['cindy', 'control', 'history', 'feedback', 'handoff'] as const;

// ── Entry tool registration ──────────────────────────────────────────────────

function registerListToolsEntry(
  server: McpServer,
  registry: XdtHelperToolRegistry,
): void {
  server.tool(
    'list_tools',
    D_LIST_TOOLS,
    {
      category: z
        .enum(CATEGORY_ENUM)
        .optional()
        .describe('工具类目。不传时返回所有类目概览。'),
    },
    async ({ category }) => {
      if (category) {
        const tools = registry.list(category);
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
                })),
                hint: '调用具体工具用 call_tool({name, args})。',
              }),
            },
          ],
        };
      }
      const counts: Record<string, number> = {};
      for (const t of registry.list()) {
        counts[t.category] = (counts[t.category] ?? 0) + 1;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              categories: registry.listCategories().map((c) => ({
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
      const result = await registry.call(name, args);
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
  /**
   * 历史聊天数据查询的回调集合(读本地 SQLite 的 sessions / messages 表)。host
   * 注入后, history 类工具(list_workdirs / list_sessions / get_chat_history /
   * search_chat_history) 会被注册; 不注入则这四个工具不出现在 list_tools 里。
   */
  history?: XdtHelperHistoryDeps;
  /**
   * Session handoff 回调。host 注入后, send_to_session 工具注册到 handoff 类目(走
   * call_tool);不注入则工具不出现。此工具是 skill(如 maker-github-issue)做跨会话
   * 路由的原语, 放在 essential 的 cindy_helper 下常开保证 skill 永不断。
   */
  sendToSession?: SendToSessionCallback;
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
    registerListWorkdirsTool(registry, { history: deps.history });
    registerListSessionsTool(registry, { history: deps.history });
    registerGetChatHistoryTool(registry, { history: deps.history });
    registerSearchChatHistoryTool(registry, { history: deps.history });
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

  registerListToolsEntry(server, registry);
  registerCallToolEntry(server, registry, {
    logger: deps.logger,
    // per-call 解析:codex HTTP bridge 的 server factory 阶段 ctx 是空的,
    // tool-call 阶段由 AsyncLocalStorage 恢复,所以 sessionId 必须调用时再取。
    getSessionId: () => resolveLiziMcpSessionContext(sessionCtx).sessionId,
  });

  return server;
}
