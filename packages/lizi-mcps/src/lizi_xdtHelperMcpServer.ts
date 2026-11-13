import { registerListAvailableModelsTool, type ListAvailableModelsDeps } from './xdt-helper/list_available_models.js';
import { registerPiRuntimeTools, type PiRuntimeCallbacks } from './xdt-helper/pi_runtime.js';
import { registerTerminalTools, type TerminalToolCallbacks } from './xdt-helper/terminal.js';
import { registerFileTools, type FileToolCallbacks } from './xdt-helper/files.js';
import { registerStorageTools, type StorageToolCallbacks } from './xdt-helper/storage.js';
import { registerHostServiceTools, type HostServicesToolCallbacks } from './xdt-helper/host_services.js';
import { createControlReader } from './xdt-helper/control-catalog.js';
import { registerAppModelsTools, type AppModelsCallbacks } from './xdt-helper/app_models.js';
import { registerAppSettingsTools, type AppSettingsCallbacks } from './xdt-helper/app_settings.js';
import { registerThemePackageTool, type ThemePackageCallbacks } from './xdt-helper/theme_packages.js';
import { registerGithubTools, type GithubToolCallbacks } from './xdt-helper/github.js';
import { registerMcpSetupTool, type McpSetupCallback } from './xdt-helper/mcp_setup.js';
import { registerSharedTaskTools, type SharedTaskToolCallback } from './xdt-helper/shared_task.js';
import { registerSessionTagTools, type SessionTagsCallback } from './xdt-helper/session_tags.js';
/**
 * lizi_xdtHelperMcpServer.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server exposing xdt-maker 的基础设施自省 + session handoff 能力。
 *
 * 设计:
 *  - server name = `cindy_helper`,essential(常开,不可被用户关闭)
 *  - 通用工具走 `list_tools` / `call_tool` 两个入口,渐进式发现:
 *    提问与代输入使用各自独立入口，以便 harness 验证根代理身份。
 *    - 'cindy'   : 只读自省 (get_capabilities / get_current_session_id)
 *    - 'auth'    : 独立代输入 request_input_handoff、MCP 设置表单与 Grok 设备码登录、状态及取消
 *    - 'history' : 只读查询本地数据库聊天历史与输入队列 (list_workdirs /
 *                  list_sessions / list_session_queue / get_chat_history /
 *                  search_chat_history / get_task_digest)
 *    - 'control' : 会话状态控制 (set_current_session_title / rename_sessions /
 *                  archive_sessions / unarchive_sessions)
 *    - 'feedback': 官方反馈提交 (submit_github_issue)
 *    - 'handoff' : session 间 handoff 原语 (send_to_session),供 skill 跨会话路由
 *    - 'skills'  : Cindy 宿主管理的 Skill 工作流
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
import type { HostToolMcpServer, HostToolRuntime } from './host-tool-runtime.js';
import { registerListTeammatesTool } from './xdt-helper/list_teammates.js';
import { registerReadSessionAttachmentTool } from './xdt-helper/read_session_attachment.js';
import { registerDeleteSessionTool, type DeleteSessionCallback } from './xdt-helper/delete_session.js';
import { registerSessionHistoryTools, type SessionHistoryCallback } from './xdt-helper/session_history_control.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { registerGrokLoginTools, type GrokLoginCallbacks } from './xdt-helper/grok_login.js';
import { INPUT_HANDOFF_TOOL_NAME, registerInputHandoffTool, type InputHandoffCallbacks } from './xdt-helper/input_handoff.js';
import { jsonObjectArg } from './json-object-arg.js';
import {
  registerAsyncQuestionTool,
  registerManageUserQuestionsTool,
  type ManageUserQuestionsCallback,
  supportsAsyncQuestionTool,
  type AskUserQuestionAsyncCallback,
} from './xdt-helper/ask_user_question_async.js';
import { stringArrayParam } from './xdt-helper/_array-param.js';

import { XdtHelperToolRegistry } from './lizi_xdtHelperToolRegistry.js';
import { registerCreateProjectTool, type CreateProjectCallback } from './xdt-helper/create_project.js';
import { registerMoveSessionTool, type MoveSessionCallback } from './xdt-helper/move_session.js';
import {
  registerCreateTaskWorktreeTool,
  type CreateTaskWorktreeCallback,
} from './xdt-helper/create_task_worktree.js';
import { registerProjectManagementTools, type ProjectManagementCallbacks } from './xdt-helper/project_management.js';
import {
  registerGetCapabilitiesTool,
  registerAppUpdateTools,
  registerGetCurrentSessionIdTool,
  registerSetCurrentSessionTitleTool,
  registerRenameSessionsTool,
  registerArchiveSessionsTool,
  registerUnarchiveSessionsTool,
  registerSendToSessionTool,
  registerListWorkdirsTool,
  registerHistoryDevicesTool,
  registerListSessionsTool,
  registerListSessionQueueTool,
  registerUpdateSessionQueuedMessageTool,
  registerSteerSessionQueuedMessageTool,
  registerMoveSessionQueuedMessageTool,
  registerCancelSessionQueuedMessageTool,
  registerSteerSessionTool,
  registerStopSessionTurnTool,
  registerGetSessionRuntimeTool,
  registerSetSessionRuntimeTool,
  registerGetChatHistoryTool,
  registerGetTaskDigestTool,
  registerSearchChatHistoryTool,
  registerSubmitGithubIssueTool,
  registerStartSkillLearningTool,
  registerSkillhubTools,
} from './xdt-helper/index.js';
import type { SubmitGithubIssueDeps } from './xdt-helper/submit_github_issue.js';
import type { AppUpdateCallbacks } from './xdt-helper/app_update.js';
import type { SkillhubAgentCallback } from './xdt-helper/skillhub.js';
import type { SetCurrentSessionTitleDeps } from './xdt-helper/set_current_session_title.js';
import type { RenameSessionsDeps } from './xdt-helper/rename_sessions.js';
import type { ArchiveSessionsDeps } from './xdt-helper/archive_sessions.js';
import { registerSessionImportTools, type SessionImportCallbacks } from './xdt-helper/session_import.js';
import { projectMembershipNote, type SendToRemoteSessionCallback, type SendToSessionCallback } from './xdt-helper/send_to_session.js';
import type {
  AuthorizeSkillLearningCallback,
  StartSkillLearningCallback,
} from './xdt-helper/start_skill_learning.js';
import {
  registerBotSkillTools,
  type BotSkillCallbacks,
} from './xdt-helper/bot_skills.js';
import {
  registerTeammateProjectTools,
  type TeammateProjectsCallback,
} from './xdt-helper/teammate_projects.js';
import { registerRemoteControlRequestTool, registerListMachinesTool, type ListMachinesCallbacks } from './xdt-helper/list_machines.js';
import { registerTeammateHomeTools, type TeammateHomeCallbacks } from './xdt-helper/teammate_home.js';
import {
  registerBotCapabilityTools,
  registerAppDefaultModelTools,
  withCindyGatedBotToolDescriptions,
  type BotCapabilityCallbacks,
} from './xdt-helper/bot_capabilities.js';
import { registerTeammateSkillReader } from './xdt-helper/teammate_skills.js';
import type { XdtHelperHistoryDeps } from './xdt-helper/_history_types.js';
import type { SessionQueueDeps } from './xdt-helper/list_session_queue.js';
import type { SessionControlDeps } from './xdt-helper/session_control.js';
import type { ControlResult, LiziMcpLogger } from './types.js';
import { resolveLiziMcpSessionContext } from './session-context.js';
import { logToolResultErrorCode } from './tool-error-telemetry.js';
import { withToolCallAuthority, type ToolCallAuthorizer } from './tool-call-authority.js';
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
  'Cindy 设置/控制入口：query 搜索壁纸、模型、伙伴、自动化、设备等；key 读单项说明；name 读已发现工具的参数。例：list_tools({query:"伙伴模型"})。' +
  `探索当前任务获准的 ${BRAND_NAME} 能力。登录、保密输入或扫码用 request_input_handoff；提问用各自的提问工具；连接 Grok 在 auth 类目，插件账号用 cindy 的 connect_account；` +
  'github 类目用于定时追踪 PR/CI/评审变化与管理任务 PR 关联，不替代 gh 等命令行；查询不会建立任务关联。其它先不传 category 查看用途与本机/跨电脑范围，再按类目发现工具，用 call_tool 执行。';

const D_CALL_TOOL =
  '调用 list_tools 或 get_capabilities 为当前任务返回的具体工具；args 为 JSON 对象。查设置可先 list_tools({query:需求})；不执行任意命令。';

const LIST_TOOLS_INPUT = {
  query: z.string().trim().min(1).max(200).optional().describe('自然语言查 Cindy 控制能力，直接返回下一步调用。'),
  key: z.string().min(1).max(160).optional().describe('搜索返回的能力 key，读取具体说明。'),
  name: z.string().min(1).max(160).optional().describe('已发现工具名，只读返回完整参数 schema。'),
  category: z.string().optional().describe('要查看的类目；不传则取当前任务的可用类目概览。'),
};
const CALL_TOOL_INPUT = {
  name: z.string().describe('工具名,从 list_tools 获取(如 get_capabilities)'),
  args: jsonObjectArg('工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈。'),
};

// list_tools 入口类目: cindy(自省) / control(会话控制面) / history(聊天历史) / feedback(官方反馈提交) / handoff(session 间 handoff)。
// 协同 team 工具已拆到独立 cindy_orca server(插件开关 gate)。
const CATEGORY_ENUM = ['cindy', 'auth', 'control', 'history', 'feedback', 'handoff', 'skills', 'app_update', 'bots', 'github', 'settings', 'terminal', 'files', 'storage', 'discovery'] as const;

/**
 * 类目概览里每个类目的一句话用途 + 作用范围(本机 / 可跨电脑)。只陈述事实:模型在概览
 * 阶段就要能判断「这件事有没有工具、管不管得到另一台电脑」,不能等点进某个工具的参数
 * 说明才发现。改工具的作用范围时同步改这里(测试按类目全集守护)。
 *
 * 一句一行再拼接:每个类目的说明 30 天里被改四十多次,写成一整行时,任意两个改同一类目的
 * PR 都会冲突。新增内容单独起一行,放在语义相关的句子旁边,不要接在已有句子后面。
 */
export const HELPER_CATEGORY_DESCRIPTIONS: Record<(typeof CATEGORY_ENUM)[number], string> = {
  cindy: [
    `${BRAND_NAME} 能力说明、界面操作帮助（get_capabilities scope=help）与当前任务信息；`,
    `get_capabilities({key:"self-management"}) 是管理自己的任务、定时任务、项目、伙伴的工具索引；`,
    `get_capabilities({key:"computer-use"}) 说明桌面操作没开时怎么引导用户开启。`,
    `本机。`,
  ].join(''),
  settings: [
    '管理 Cindy 的全局设置、默认模型与 API 供应商连接（添加、安全填写密钥、发现型号、测试连接），普通任务和伙伴共用。',
    '作用于运行任务的本机；',
    '先查询当前值和可选项，再修改或恢复默认。',
    '密钥通过电脑或手机的加密代输入卡交给宿主。',
    'SSH 主机编辑使用 cindy_ssh。',
  ].join(''),
  auth: [
    '本机窗口登录、保密输入与截图扫码（request_input_handoff）；',
    'MCP 设置表单（request_mcp_setup）；',
    'Grok 设备码登录、状态查询与取消（支持远程任务）。',
  ].join(''),
  control: [
    'list_projects(device) 可查询远程项目。',
    '管理任务与项目：当前任务的原生共享邀请/状态（create_shared_task_invitation / get_shared_task_state）在任务宿主执行，支持手机或同账号另一台电脑控制当前任务，不接受其他任务目标；',
    '归档/取消归档、删除（delete_session）、按消息分叉（fork_session）与检查点回退（rewind_session）支持本机与跨电脑（deviceId::sessionId），删除和回退逐次确认；',
    '改名、移动、标签、排队消息、插话、停止、运行设置（含权限档）、给当前任务新建托管 worktree（create_task_worktree，可指定基线分支）、项目增删改、从其他 AI 编程工具导入任务（scan_importable_sessions / import_sessions）仅本机。',
  ].join(''),
  github: [
    '读取 PR、CI、评审变化与详情，明确管理任务关联。',
    '本机与同账号跨电脑；',
    '查询不会关联任务或启动跟进。',
  ].join(''),
  history: [
    '按话题查找跨渠道聊天，支持伙伴归属（teammate_id）、最近活动时间与真实来源；',
    '不要默认限制当前工作目录或创建日期。',
    'list_teammates 枚举伙伴及已保存的任务关系（含隐藏与暂停），list_sessions 包含隐藏任务并返回 hiddenAt。',
    '查询任务、工作目录、聊天记录、任务摘要与输入队列；',
    '任务结果附带可直接引用的 sessionUrl，已知 id 要链接用 get_task_digest。',
    '伙伴目录、任务列表、搜索、读取聊天记录、任务摘要（get_task_digest）可跨电脑（device 参数 / deviceId::sessionId）；',
    '任务附件（read_session_attachment）仅支持已有宿主授权的本机媒体和交接引用，历史文件路径与跨电脑附件返回 UNSUPPORTED_CAPABILITY，只返回分块字节和引用，不返回宿主路径。',
    '搜索还能查到主力电脑离线的伙伴的云端对话；',
    '其余本机。',
  ].join(''),
  terminal: '启动、列举、输入、续读和停止当前调用方的宿主终端与后台作业。仅执行电脑本机，作业独立于读取连接；SSH 工作区不在本机代跑远程命令。',
  files: '通过同一宿主文件服务访问真实任务工作目录或用户亲选的插件目录；读、写、列举、删除与有界监听。',
  storage: '插件自身 KV、私有文件、作品库、媒体与交接文件的统一调用接口；跨插件快照分享每次经宿主确认，仅同账号本机和同一组织范围。',
  discovery: '只读发现执行宿主实际提供的服务与本插件的批准事实；仅本机，不安装、启停或撤销其他插件。',
  feedback: `向 ${BRAND_NAME} 官方提交反馈。`,
  handoff: [
    '给已有任务发消息或新建任务。',
    '新建可指定 title；',
    '本机省略 project_path 继承来源归属（来源不绑项目时按执行目录所在的已登记可见项目归属），传已有项目路径切换项目，传 null 创建不绑项目的任务。',
    '执行目录不隐式创建项目。',
    '发给已有任务可跨电脑（deviceId::sessionId）；',
    '新建用 device 指定任务和文件所在电脑，省略为本机；',
    'provider_device_id 单独选择模型供应商位置（兼容 agent_device_id）；',
    '项目和模型先用同一 device 查询。',
  ].join(''),
  skills: [
    'Skill 的搜索、发布与学习。',
    '本机与 SkillHub。',
  ].join(''),
  app_update: [
    `检查与安装本机的 ${BRAND_NAME} 更新。`,
    `本机。`,
  ].join(''),
  bots: [
    '伙伴：资料、能力、关联项目（list_teammate_projects / set_teammate_project，仅自身）、发现伙伴与主力电脑。',
    '发现伙伴（list_agents，返回伙伴主对话的 session_id，发消息用 handoff 类的 send_to_session）与主力电脑（get_teammate_home / move_teammate_home）可跨电脑；',
    '其余本机。',
  ].join(''),
};

interface BotMessagingCallbacks {
  sendToUser?(params: { callerSessionId: string; message: string; idempotencyKey: string }): Promise<
    { ok: true; messageId: string; targetSessionId: string; delivered: boolean }
    | { ok: false; errorCode: string; message: string }>;
  listAgents?(params: { callerSessionId: string;
  }): Promise<
    | { ok: true; agents: unknown[]; unavailableDevices: unknown[] }
    | { ok: false; errorCode: string; message: string }>;
}

// ── Entry tool registration ──────────────────────────────────────────────────

function cindyAvailableForSession(sessionCtx: XdtHelperMcpSessionCtx): boolean {
  const ctx = resolveLiziMcpSessionContext(sessionCtx);
  // Match helper / remoteBotOnly: cindy is missing only for remote Claude/Codex.
  // Remote Pi tunnels the in-process cindy gateway over the MCP bridge.
  return !ctx.remoteHostId || ctx.agentKind === 'pi';
}

interface HelperSurfaceAllow {
  /** null means every registered category. An empty set means none. */
  categories: ReadonlySet<string> | null;
  tools?: ReadonlySet<string>;
}

function toolAllowed(
  allow: HelperSurfaceAllow,
  tool: { name: string; category: string },
): boolean {
  if (!allow.categories) return true;
  return allow.categories.has(tool.category) || allow.tools?.has(tool.name) === true;
}

function registerListToolsEntry(
  server: McpServer,
  registry: XdtHelperToolRegistry,
  allowedSurface: () => Promise<HelperSurfaceAllow>,
  sessionCtx: XdtHelperMcpSessionCtx,
): void {
  server.tool(
    'list_tools',
    D_LIST_TOOLS,
    LIST_TOOLS_INPUT,
    async ({ category, query, key, name }) => {
      const allowed = await allowedSurface();
      if ([query, key, name, category].filter(value => value !== undefined).length > 1)
        return errorPayload('INVALID_ARGS', 'query、key、name、category 只能选一种查询。');
      if (query || key) {
        const tool = registry.get('get_capabilities');
        if (!tool || !toolAllowed(allowed, tool)) return errorPayload('CAPABILITY_NOT_AVAILABLE', '当前任务不可查询控制目录。');
        return registry.call('get_capabilities', { scope: 'control', ...(category ? { category } : {}), ...(query ? { toolQuery: query } : { key }) });
      }
      if (name) {
        const tool = registry.get(name);
        if (!tool || tool.hidden || !toolAllowed(allowed, tool)) return errorPayload('CAPABILITY_NOT_AVAILABLE', '工具未注册或不属于当前任务。');
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, tool: {
          name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(z.strictObject(tool.inputShape)),
        } }) }] };
      }
      if (category) {
        const tools = withCindyGatedBotToolDescriptions(
          registry
            .list(category as (typeof CATEGORY_ENUM)[number])
            .filter((tool) => toolAllowed(allowed, tool)),
          cindyAvailableForSession(sessionCtx),
        );
        if (tools.length === 0 && allowed.categories && !allowed.categories.has(category)) {
          return errorPayload('CAPABILITY_NOT_AVAILABLE', '这个类目不属于当前任务的能力面。');
        }
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
                  ...(t.category === 'settings' || t.category === 'bots' || t.category === 'skills' || t.category === 'auth' ? {
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
      const visibleTools = registry.list().filter((tool) => toolAllowed(allowed, tool));
      for (const t of visibleTools) {
        counts[t.category] = (counts[t.category] ?? 0) + 1;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              categories: registry.listCategories().filter((c) => (counts[c] ?? 0) > 0).map((c) => ({
                name: c,
                tool_count: counts[c] ?? 0,
                description: HELPER_CATEGORY_DESCRIPTIONS[c as (typeof CATEGORY_ENUM)[number]],
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
    getHostCaller: () => import('./types.js').LiziMcpSessionContext['hostCaller'];
    authorizeCall?: ToolCallAuthorizer;
  },
  allowedSurface: () => Promise<HelperSurfaceAllow>,
): HostToolRuntime['call'] {
  const call: HostToolRuntime['call'] = async (name, args, signal) => {
    const allowed = await allowedSurface();
    const definition = registry.get(name);
    if (definition && !toolAllowed(allowed, definition)) {
      return errorPayload(
        'CAPABILITY_NOT_AVAILABLE',
        '这个工具不属于当前任务的能力面；请重新调用 list_tools。',
      );
    }
    const result = definition
      ? await withToolCallAuthority(
        telemetry.authorizeCall,
        { sessionId: telemetry.getSessionId(), server: 'cindy_helper', tool: name, args,
          ...(telemetry.getHostCaller() ? { caller: telemetry.getHostCaller() } : {}) },
        () => registry.call(name, args, signal),
      )
      : errorPayload('UNKNOWN_TOOL', 'Unknown helper tool.', {
          available: registry.list().filter((tool) => toolAllowed(allowed, tool)).map((tool) => tool.name),
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
  };
  server.tool('call_tool', D_CALL_TOOL, CALL_TOOL_INPUT, ({ name, args }, extra) => call(name, args, extra?.signal));
  return call;
}

/** Teammate discovery and a group lane's private message to its owner. */
function registerBotMessagingEntries(
  registry: XdtHelperToolRegistry,
  deps: XdtHelperMcpDeps,
  sessionCtx: XdtHelperMcpSessionCtx,
): void {
  if (!deps.botMessaging) return;
  if (deps.botMessaging.sendToUser) registry.register({
    name: 'send_to_user', category: 'bots',
    description: 'From a group, send a private message to the account user in this same buddy’s main chat. Use when that user explicitly asks for a private reply. The host resolves the recipient; this does not call yourself, wake another model, or message an arbitrary group member. Other members’ group tool grants do not authorize this action. In the main private chat, reply normally. Reuse idempotency_key when retrying the same message. A saved receipt does not mean the user has read it.',
    inputShape: { message: z.string().trim().min(1).max(16000), idempotency_key: z.string().regex(/^[\w-]{8,100}$/) },
    handler: async ({ message, idempotency_key }) => {
      const callerSessionId = resolveLiziMcpSessionContext(sessionCtx).sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', '当前调用未绑定伙伴任务。');
      const result = await deps.botMessaging!.sendToUser!({ callerSessionId, message, idempotencyKey: idempotency_key });
      return result.ok ? okPayload({ action: 'send_to_user', message_id: result.messageId, session_id: result.targetSessionId,
        delivered: result.delivered, read: null }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.botMessaging.listAgents) registry.register({
    name: 'list_agents', category: 'bots',
    description: 'Discover buddies on this device and other authorized devices. To talk to one, pass its session_id (its main chat; deviceId::sessionId on another computer) to send_to_session. Device names distinguish namesakes; unavailableDevices explains incomplete discovery. Do not guess IDs or poll.',
    inputShape: {},
    handler: async () => {
      const callerSessionId = resolveLiziMcpSessionContext(sessionCtx).sessionId;
      if (!callerSessionId) return errorPayload('NOT_A_BOT_SESSION', 'An active Cindy task is required');
      const result = await deps.botMessaging!.listAgents!({ callerSessionId });
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
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
  terminal?: TerminalToolCallbacks;
  files?: FileToolCallbacks;
  storage?: StorageToolCallbacks;
  hostServices?: HostServicesToolCallbacks;
  github?: GithubToolCallbacks;
  getSessionProject?: import('./xdt-helper/get_current_session_id.js').GetCurrentSessionIdDeps['getSessionProject'];
  logger?: LiziMcpLogger;
  appUpdate?: AppUpdateCallbacks;
  grokLogin?: GrokLoginCallbacks;
  /** 代输入: hand an on-screen step to the owner; values stay on the host. */
  inputHandoff?: InputHandoffCallbacks;
  /**
   * Host-owned runtime classification. `bot-main` is a local Bot's main task: it sees
   * the ordinary task surface plus Bot tools, and every call is judged by `authorizeCall`.
   * Companions add self-management to the ordinary tool surface for their execution location.
   */
  resolveSurface?: (input: {
    sessionId: string;
  }) => Promise<'default' | 'bot' | 'bot-main' | 'restricted'>;
  /** Live caller/account check for all tasks; the tool list itself never changes mid-session. */
  authorizeCall?: ToolCallAuthorizer;
  runtimeCapabilities?: (
    context: import('./types.js').LiziMcpSessionContext,
    query: import('./xdt-helper/get_capabilities.js').RuntimeCapabilityQuery,
  ) => Promise<unknown>;
  /** 产品帮助文档(设置页帮助助手同一份),供 get_capabilities scope=help 读取;不注入则该 scope 返回 HELP_UNAVAILABLE。 */
  productHelpDocs?: readonly import('./xdt-helper/get_capabilities.js').ProductHelpDoc[];
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
  /** Read-only catalog shared with ordinary task creation; does not enable collaboration. */
  listAvailableModels?: ListAvailableModelsDeps['listAvailableModels'];
  /** 另一台电脑上的既有任务(send_to_session 的 deviceId::sessionId 目标)。 */
  sendToRemoteSession?: SendToRemoteSessionCallback;
  /** Cindy-managed Learn flow; registered in the skills category when supplied by the host. */
  skillLearning?: StartSkillLearningCallback;
  /** Search catalogs and publish the current user's Skills through the host's SkillHub service. */
  skillhub?: SkillhubAgentCallback;
  /** Host-owned, one-shot authorization for the current direct Learn invocation. */
  authorizeSkillLearning?: AuthorizeSkillLearningCallback;
  /** Register an existing local directory as a Cindy project without starting a task. */
  createProject?: CreateProjectCallback;
  moveSession?: MoveSessionCallback;
  /** Create a Cindy-managed worktree for the calling task and bind it, without moving the task. */
  createTaskWorktree?: CreateTaskWorktreeCallback;
  sessionTags?: SessionTagsCallback;
  projectManagement?: ProjectManagementCallbacks;
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
  /** The calling teammate's linked projects; the host resolves the teammate from the caller Session. */
  teammateProjects?: TeammateProjectsCallback;
  appSettings?: AppSettingsCallbacks;
  themePackages?: ThemePackageCallbacks;
  piRuntime?: PiRuntimeCallbacks;
  modelSettings?: AppModelsCallbacks;
  appModels?: Pick<BotCapabilityCallbacks, 'models' | 'setDefaultModel'>;
  botCapabilities?: BotCapabilityCallbacks;
  /** Which computer runs a teammate, and moving it to another (cloud companions). */
  teammateHome?: TeammateHomeCallbacks;
  /** What machines this account has and their live resources. */
  machines?: ListMachinesCallbacks;
  /**
   * 官方反馈 issue 提交回调(弹确认卡片 → 用户确认 → POST server)。host 注入后,
   * feedback 类工具 submit_github_issue 会被注册; 不注入则不出现在 list_tools 里。
   */
  githubIssue?: SubmitGithubIssueDeps['submit'];
  mcpSetup?: McpSetupCallback;
  sharedTask?: SharedTaskToolCallback;
  /**
   * 当前 session 标题更新回调。host 注入后, control 类工具
   * set_current_session_title 会被注册; 不注入则不出现在 list_tools 里。
   */
  setCurrentSessionTitle?: SetCurrentSessionTitleDeps['setCurrentSessionTitle'];
  askUserQuestionAsync?: AskUserQuestionAsyncCallback;
  manageUserQuestions?: ManageUserQuestionsCallback;
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
  deleteSession?: DeleteSessionCallback;
  sessionHistory?: SessionHistoryCallback;
  setRemoteSessionsStatus?: ArchiveSessionsDeps['setRemoteSessionsStatus'];
  /**
   * 任务导入（与设置 → 任务导入同一实现）。host 注入后, control 类工具
   * scan_importable_sessions / import_sessions / get_session_import_status 会被注册。
   */
  sessionImport?: SessionImportCallbacks;
}

/**
 * Per-session ctx 绑定参数。MCP server 实例在 toClaudeSdkConfig(ctx) 时按 ctx
 * 字段惰性创建, 工具 handler 闭包捕获这些值。
 */
export interface XdtHelperMcpSessionCtx {
  agentKind: 'claude-code' | 'codex' | 'pi';
  workingDir: string;
  remoteHostId?: string;
  getSessionContext?: () => import('./types.js').LiziMcpSessionContext | undefined;
  sessionId?: string;
  vendorOptions?: Record<string, unknown>;
  hostCaller?: import('./types.js').LiziMcpSessionContext['hostCaller'];
}

export function createXdtHelperMcpServer(
  deps: XdtHelperMcpDeps,
  sessionCtx: XdtHelperMcpSessionCtx,
): HostToolMcpServer {
  const server = new McpServer({
    name: 'cindy_helper',
    version: '1.0.0',
  });

  const registry = new XdtHelperToolRegistry();
  const none: HelperSurfaceAllow = { categories: new Set() };
  const allowedSurface = async (): Promise<HelperSurfaceAllow> => {
    const context = resolveLiziMcpSessionContext(sessionCtx);
    const sessionId = context.sessionId;
    const remoteBotOnly = !!context.remoteHostId && context.agentKind !== 'pi';
    const defaultCategories = new Set(CATEGORY_ENUM.filter((category) => category !== 'bots'));
    // Remote Pi retains the regular helper surface, but a remote task cannot
    // check the local desktop updater; keep that unavailable tool undiscoverable.
    if (context.remoteHostId) {
      defaultCategories.delete('app_update');
      defaultCategories.delete('settings');
    }
    const allow = (categories: ReadonlySet<string>): HelperSurfaceAllow => ({
      categories,
      ...(sessionId && !remoteBotOnly ? { tools: new Set(['list_agents']) } : {}),
    });
    if (!sessionId) return allow(remoteBotOnly ? new Set() : defaultCategories);
    if (!deps.resolveSurface) return allow(remoteBotOnly ? new Set(['auth', 'cindy']) : defaultCategories);
    const surface = await deps.resolveSurface({ sessionId }).catch(() => 'restricted' as const);
    if (surface === 'bot' || surface === 'bot-main') {
      // Companion identity adds self-management, not a narrower ordinary tool surface.
      const categories = remoteBotOnly ? new Set(['auth', 'cindy']) : defaultCategories;
      return allow(new Set([...categories, 'bots']));
    }
    if (surface === 'restricted') return none;
    return allow(remoteBotOnly ? new Set(['auth', 'cindy']) : defaultCategories);
  };

  if (deps.terminal) registerTerminalTools(registry, deps.terminal, () => resolveLiziMcpSessionContext(sessionCtx));
  if (deps.files) registerFileTools(registry, deps.files, () => resolveLiziMcpSessionContext(sessionCtx));
  if (deps.storage) registerStorageTools(registry, deps.storage, () => resolveLiziMcpSessionContext(sessionCtx));
  if (deps.hostServices) registerHostServiceTools(registry, deps.hostServices, () => resolveLiziMcpSessionContext(sessionCtx));
  if (deps.github) registerGithubTools(registry, deps.github, () => resolveLiziMcpSessionContext(sessionCtx).sessionId);

  // 'cindy' 类: 自省 (无 host 依赖, 始终注册)。
  registerGetCapabilitiesTool(registry, deps.runtimeCapabilities
    ? (query) => deps.runtimeCapabilities!(resolveLiziMcpSessionContext(sessionCtx), query)
    : undefined, deps.productHelpDocs, createControlReader({
      registry,
      allowedNames: async () => { const allow = await allowedSurface(); return new Set(registry.list().filter(tool => toolAllowed(allow, tool)).map(tool => tool.name)); },
      local: () => !resolveLiziMcpSessionContext(sessionCtx).remoteHostId,
      scopeKey: () => { const ctx = resolveLiziMcpSessionContext(sessionCtx); return `${ctx.sessionId ?? ''}:${ctx.getSessionContext?.()?.sessionInstanceId ?? ''}:${ctx.agentKind ?? ''}`; },
      readRuntime: deps.runtimeCapabilities ? query => deps.runtimeCapabilities!(resolveLiziMcpSessionContext(sessionCtx), query) : undefined,
    }));
  if (deps.appUpdate) {
    registerAppUpdateTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.appUpdate,
    });
  }
  if (deps.grokLogin)
    registerGrokLoginTools(registry, () => resolveLiziMcpSessionContext(sessionCtx), deps.grokLogin);
  if (deps.inputHandoff)
    registerInputHandoffTool(registry, () => resolveLiziMcpSessionContext(sessionCtx), deps.inputHandoff);
  registerGetCurrentSessionIdTool(registry, {
    getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
    getSessionProject: deps.getSessionProject,
  });

  if (deps.sessionTags)
    registerSessionTagTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      execute: deps.sessionTags,
    });
  if (deps.setCurrentSessionTitle) {
    registerSetCurrentSessionTitleTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      setCurrentSessionTitle: deps.setCurrentSessionTitle,
    });
  }
  if (deps.createProject) {
    registerCreateProjectTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      createProject: deps.createProject,
    });
  }
  if (deps.projectManagement) {
    registerProjectManagementTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.projectManagement,
    });
  }
  if (deps.moveSession) {
    registerMoveSessionTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      moveSession: deps.moveSession,
    });
  }
  if (deps.createTaskWorktree) {
    registerCreateTaskWorktreeTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      createTaskWorktree: deps.createTaskWorktree,
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
      setRemoteSessionsStatus: deps.setRemoteSessionsStatus,
    };
    registerArchiveSessionsTool(registry, archiveDeps);
    registerUnarchiveSessionsTool(registry, archiveDeps);
  }
  if (deps.deleteSession) registerDeleteSessionTool(registry, {
    getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx), deleteSession: deps.deleteSession,
  });
  if (deps.sessionHistory) registerSessionHistoryTools(registry, {
    getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx), call: deps.sessionHistory,
  });
  if (deps.sessionImport) {
    registerSessionImportTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.sessionImport,
    });
  }

  // History 类工具: 仅 host 注入了 history 回调时注册。
  if (deps.history) {
    registerReadSessionAttachmentTool(registry, { history: deps.history, getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx) });
    registerListTeammatesTool(registry, { history: deps.history, getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx) });
    const historyDeps = {
      history: deps.history,
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
    };
    registerHistoryDevicesTool(registry, historyDeps);
    registerListWorkdirsTool(registry, historyDeps);
    registerListSessionsTool(registry, {
      ...historyDeps,
      ...(deps.sessionQueue ? { sessionQueue: deps.sessionQueue } : {}),
    });
    registerGetChatHistoryTool(registry, historyDeps);
    registerSearchChatHistoryTool(registry, historyDeps);
    registerGetTaskDigestTool(registry, historyDeps);
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
    registerSteerSessionQueuedMessageTool(registry, controlDeps);
    registerMoveSessionQueuedMessageTool(registry, controlDeps);
    registerSteerSessionTool(registry, controlDeps);
    registerStopSessionTurnTool(registry, controlDeps);
    registerGetSessionRuntimeTool(registry, controlDeps);
    registerSetSessionRuntimeTool(registry, controlDeps);
  }

  if (deps.mcpSetup) registerMcpSetupTool(registry, () => resolveLiziMcpSessionContext(sessionCtx), deps.mcpSetup);
  if (deps.sharedTask) registerSharedTaskTools(registry, () => resolveLiziMcpSessionContext(sessionCtx), deps.sharedTask);

  // Feedback 类工具: 仅 host 注入了 githubIssue 回调时注册。
  if (deps.githubIssue) {
    registerSubmitGithubIssueTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      submit: deps.githubIssue,
    });
  }

  if (deps.listAvailableModels) registerListAvailableModelsTool(registry, {
    listAvailableModels: deps.listAvailableModels,
    getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
  });

  // send_to_session: 仅 host 注入了 sendToSession 回调时注册到 handoff 类目(走 call_tool)。
  if (deps.sendToSession) {
    registerSendToSessionTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      sendToSession: deps.sendToSession,
      ...(deps.sendToRemoteSession ? { sendToRemoteSession: deps.sendToRemoteSession } : {}),
    });
  }
  if (deps.skillLearning && deps.authorizeSkillLearning) {
    registerStartSkillLearningTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      authorizeSkillLearning: deps.authorizeSkillLearning,
      startSkillLearning: deps.skillLearning,
    });
  }
  if (deps.skillhub) {
    registerSkillhubTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      execute: deps.skillhub,
    });
  }
  // 伙伴消息与 Session 任务控制统一进入 bots 类目，由调用时的任务身份限制发现与执行。
  if (deps.botSkills) {
    registerBotSkillTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.botSkills,
    });
  }
  if (deps.teammateProjects) {
    registerTeammateProjectTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      projects: deps.teammateProjects,
    });
  }

  if (deps.teammateHome) {
    registerTeammateHomeTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.teammateHome,
    });
  }
  if (deps.modelSettings) registerAppModelsTools(registry, deps.modelSettings, () => resolveLiziMcpSessionContext(sessionCtx));
  if (deps.piRuntime) registerPiRuntimeTools(registry, deps.piRuntime, () => resolveLiziMcpSessionContext(sessionCtx));
  if (deps.appSettings) registerAppSettingsTools(registry, deps.appSettings, () => resolveLiziMcpSessionContext(sessionCtx));
  if (deps.themePackages) registerThemePackageTool(registry, deps.themePackages, () => resolveLiziMcpSessionContext(sessionCtx));
  if (deps.appModels && !sessionCtx.remoteHostId) registerAppDefaultModelTools(registry, {
    getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
    callbacks: deps.appModels, category: 'settings',
  });
  if (deps.botCapabilities) {
    registerBotCapabilityTools(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.appModels && !sessionCtx.remoteHostId ? { ...deps.botCapabilities, models: undefined, setDefaultModel: undefined } : deps.botCapabilities,
    });
    registerTeammateSkillReader(registry);
  }

  registerBotMessagingEntries(registry, deps, sessionCtx);
  if (deps.botProfiles) {
    registerCreateTeammateTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.botProfiles,
    });
  }
  registerListToolsEntry(server, registry, allowedSurface, sessionCtx);
  const call = registerCallToolEntry(server, registry, {
    logger: deps.logger,
    // per-call 解析:codex HTTP bridge 的 server factory 阶段 ctx 是空的,
    // tool-call 阶段由 AsyncLocalStorage 恢复,所以 sessionId 必须调用时再取。
    getSessionId: () => resolveLiziMcpSessionContext(sessionCtx).sessionId,
    getHostCaller: () => resolveLiziMcpSessionContext(sessionCtx).hostCaller,
    ...(deps.authorizeCall ? { authorizeCall: deps.authorizeCall } : {}),
  }, allowedSurface);

  // Input handoff is independently discoverable; it never replaces question tools.
  const handoffDefinition = registry.get(INPUT_HANDOFF_TOOL_NAME);
  const handoffAvailable = async () => !!handoffDefinition
    && toolAllowed(await allowedSurface(), handoffDefinition)
    && !resolveLiziMcpSessionContext(sessionCtx).remoteHostId;
  if (handoffDefinition) {
    server.registerTool(handoffDefinition.name, {
      description: handoffDefinition.description,
      inputSchema: z.strictObject(handoffDefinition.inputShape),
    }, async (args) => {
      if (!await handoffAvailable())
        return errorPayload('CAPABILITY_NOT_AVAILABLE', 'Input handoff is not available in this task.');
      return withToolCallAuthority(deps.authorizeCall, {
        sessionId: resolveLiziMcpSessionContext(sessionCtx).sessionId,
        server: 'cindy_helper', tool: handoffDefinition.name, args,
      }, () => registry.call(handoffDefinition.name, args));
    });
  }
  const handoffListing = async (): Promise<Tool[]> => await handoffAvailable() ? [{
    name: handoffDefinition!.name,
    description: handoffDefinition!.description,
    inputSchema: z.toJSONSchema(z.strictObject(handoffDefinition!.inputShape)) as Tool['inputSchema'],
  }] : [];

  // A dedicated identity preserves root-only provenance; no generic call_tool alias.
  const questions = new XdtHelperToolRegistry();
  if (deps.askUserQuestionAsync) {
    registerAsyncQuestionTool(questions, () => resolveLiziMcpSessionContext(sessionCtx),
      deps.askUserQuestionAsync, async () => (await allowedSurface()).categories);
    const definition = questions.get('ask_user_question_async')!;
    server.registerTool(definition.name, {
      description: definition.description, inputSchema: z.strictObject(definition.inputShape),
    }, async (args) => questions.call(definition.name, args));
  }
  if (deps.manageUserQuestions) {
    registerManageUserQuestionsTool(questions, () => resolveLiziMcpSessionContext(sessionCtx),
      deps.manageUserQuestions, async () => (await allowedSurface()).categories);
    const definition = questions.get('manage_user_questions')!;
    server.registerTool(definition.name, {
      description: definition.description, inputSchema: z.strictObject(definition.inputShape),
    }, async (args) => questions.call(definition.name, args));
  }
  const asyncQuestionListing = async (): Promise<Tool[]> => {
    const allowed = await allowedSurface();
    const context = resolveLiziMcpSessionContext(sessionCtx);
    if (allowed.categories && !allowed.categories.has('cindy')) return [];
    return ['ask_user_question_async', 'manage_user_questions'].flatMap((name) => {
      const definition = questions.get(name);
      if (!definition || (name === 'ask_user_question_async' ? !supportsAsyncQuestionTool(context)
        : !['codex', 'claude-code', 'pi'].includes(context.agentKind ?? ''))) return [];
      return [{ name, description: definition.description,
        inputSchema: z.toJSONSchema(z.strictObject(definition.inputShape)) as Tool['inputSchema'] }];
    });
  };

  // list_machines: the first step of any work across computers, so it is listed
  // directly. Behind list_tools an agent that does not think to look never finds it.
  const machineTools = new XdtHelperToolRegistry();
  if (deps.machines) {
    registerListMachinesTool(machineTools, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx),
      callbacks: deps.machines,
    });
    registerRemoteControlRequestTool(machineTools, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx), callbacks: deps.machines,
    });
    registerRemoteControlRequestTool(registry, {
      getSessionContext: () => resolveLiziMcpSessionContext(sessionCtx), callbacks: deps.machines,
    });
    for (const summary of machineTools.list('cindy')) {
      const definition = machineTools.get(summary.name)!;
      server.registerTool(definition.name, {
        description: definition.description, inputSchema: z.strictObject(definition.inputShape),
      }, async (args) => {
        const allowed = await allowedSurface();
        if (!allowed.categories?.has('cindy')) {
          return errorPayload('CAPABILITY_NOT_AVAILABLE', '这个工具不属于当前任务的能力面。');
        }
        return withToolCallAuthority(
          deps.authorizeCall,
          { sessionId: resolveLiziMcpSessionContext(sessionCtx).sessionId, server: 'cindy_helper', tool: definition.name, args },
          () => machineTools.call(definition.name, args),
        );
      });
    }
  }
  const machineListing = async (): Promise<Tool[]> => {
    if (!(await allowedSurface()).categories?.has('cindy')) return [];
    return machineTools.list('cindy').map(summary => {
      const definition = machineTools.get(summary.name)!;
      return { name: definition.name, description: definition.description, inputSchema: z.toJSONSchema(z.strictObject(definition.inputShape)) as Tool['inputSchema'] };
    });
  };

  // Pi already provides direct Bot tools through its native bridge. CC and Codex
  // consume MCP tools/list instead; expose the same registered definitions there.
  // Resolve identity per request: Codex's HTTP server is shared across sessions.
  if (sessionCtx.agentKind !== 'pi') {
    const directTools = registry.list('bots').map((summary) => registry.get(summary.name)!);
    for (const definition of directTools) {
      server.registerTool(definition.name, {
        description: definition.description, inputSchema: z.strictObject(definition.inputShape),
      }, async (args) => {
        const allowed = await allowedSurface();
        if (!allowed.categories?.has('bots') || !toolAllowed(allowed, definition)) {
          return errorPayload('CAPABILITY_NOT_AVAILABLE', '这个工具不属于当前任务的能力面。');
        }
        const sessionId = resolveLiziMcpSessionContext(sessionCtx).sessionId;
        const result = await withToolCallAuthority(
          deps.authorizeCall,
          { sessionId, server: 'cindy_helper', tool: definition.name, args },
          () => registry.call(definition.name, args),
        );
        logToolResultErrorCode({
          logger: deps.logger, server: 'cindy_helper', tool: definition.name, result,
          sessionId: resolveLiziMcpSessionContext(sessionCtx).sessionId,
        });
        return result;
      });
    }
    const schema = (shape: z.ZodRawShape): Tool['inputSchema'] =>
      z.toJSONSchema(z.strictObject(shape)) as Tool['inputSchema'];
    const entryTools: Tool[] = [
      { name: 'list_tools', description: D_LIST_TOOLS, inputSchema: schema(LIST_TOOLS_INPUT) },
      { name: 'call_tool', description: D_CALL_TOOL, inputSchema: schema(CALL_TOOL_INPUT) },
    ];
    const botTools: Tool[] = directTools.map((definition) => ({
      name: definition.name, description: definition.description, inputSchema: schema(definition.inputShape),
    }));
    // Codex/remote Claude share one helper factory; rewrite ghost guidance from
    // the request-time session, not the empty factory ctx.
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allowed = await allowedSurface();
      return { tools: [
        ...entryTools,
        ...(await asyncQuestionListing()),
        ...(await handoffListing()),
        ...(await machineListing()),
        ...(allowed.categories?.has('bots')
          ? withCindyGatedBotToolDescriptions(botTools, cindyAvailableForSession(sessionCtx)) : []),
      ] };
    });
  }
  return Object.assign(server, { hostTools: {
    list: () => registry.list().map(({ name, category }) => ({ name, category })),
    describe(name: string) {
      const tool = registry.get(name);
      return tool ? { name: tool.name, category: tool.category } : undefined;
    },
    call,
    close: () => server.close(),
  } });
}
