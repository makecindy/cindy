/**
 * orca/server.ts
 * ---------------------------------------------------------------------------
 * In-process MCP server (`cindy_orca`) 暴露多 worker 协同(Orca team)控制工具。
 *
 * 暴露 13 个 team 工具(直接 server.tool() 注册到顶层,不走 list_tools/call_tool 入口):
 *   start_team / create_worker / create_workers / send_to_worker / list_worker_queue /
 *   update_queued_message / cancel_queued_message / list_workers / switch_focus /
 *   idle_worker / end_team / archive_worker / list_available_models
 *
 * 为什么直接注册而非走入口:协同工具藏在 list_tools/call_tool 后面时, 模型在用户
 * 说"开协同 / 派 worker"时往往发现不了 start_team, 反而误抓直接可见的
 * send_to_session(产独立 session、吞掉 worker 的 agent/model 诉求)。把协同工具
 * 提到顶层直接可见后,"开协同 → start_team" 的路由才确定。代价是这些工具 schema
 * 进系统提示前缀(固定成本、缓存稳定),换路由可靠性。
 *
 * 为什么独立成 server(从 cindy_helper 拆出): 让协同能力成为用户可关的插件
 * ("协同模式"开关 gate 整个 cindy_orca server), 而 cindy_helper 是 essential 的
 * 自省 + send_to_session handoff 基础设施, 不可关。整个 server 仅在 host 注入
 * deps(且插件开关开启)时注册; 未绑定具体 xdt-maker session 的调用会让
 * start_team 等控制工具按 LEAD_NOT_SUPPORTED 返回。
 *
 * Per-session ctx 由 toClaudeSdkConfig(ctx) 闭包注入 (sessionId / vendorOptions);
 * Codex HTTP bridge 会在 tool-call 时通过 AsyncLocalStorage 恢复真实 ctx。
 * start_team / end_team 需读 vendorOptions.orcaRole 判断是否允许调用。
 *
 * 契约锚点：全局可见 + handler 拒绝语义见 docs/dev-rules/orca-team-architecture.md「MCP 与 IPC 控制面」。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';

import {
  XdtHelperToolRegistry,
  type XdtHelperToolCategory,
  type XdtHelperToolHandler,
} from '../lizi_xdtHelperToolRegistry.js';
// 13 个 team 工具的注册函数留在 xdt-helper/ 目录(register 是 registry-agnostic,
// 物理搬迁收益低)。本 server 通过 DirectToolSink 把它们直接注册到 McpServer。
import {
  registerStartTeamTool,
  registerCreateWorkerTool,
  registerCreateWorkersTool,
  registerListWorkersTool,
  registerSwitchFocusTool,
  registerSendToWorkerTool,
  registerListWorkerQueueTool,
  registerUpdateQueuedMessageTool,
  registerCancelQueuedMessageTool,
  registerIdleWorkerTool,
  registerEndTeamTool,
  registerArchiveWorkerTool,
  registerListAvailableModelsTool,
  type QueuedMessageControlErrorCode,
  type WorkerQueuedMessageEntry,
  type WorkerSummary,
} from '../xdt-helper/index.js';
import type { ControlResult, ControlWorkerAgent } from '../types.js';
import { resolveLiziMcpSessionContext } from '../session-context.js';
import { errorPayload, okPayload } from '../xdt-helper/_payload.js';

// ── Host deps ──────────────────────────────────────────────────────────────

/**
 * 协同(team)控制类工具的 host 回调集合。注入即注册 cindy_orca 的 13 个 team 工具
 * (per-session 闭包绑定 ctx)。
 *
 * 回调返 Result 而非抛 Promise<T>: 让 host 能用 `HOST_NOT_READY` errorCode 表达
 * "主进程协同服务尚未 ready"(典型: app 启动过渡窗口), tool handler 收到 Result
 * 后用业务错误码透传给 LLM, 而不是抛 raw Error 落到 INTERNAL。
 *
 * (从原 lizi_xdtHelperMcpServer.ts 拆出, 随 team 工具一起独立成 cindy_orca server。)
 */
export interface OrcaMcpDeps {
  logger?: import('../types.js').LiziMcpLogger;
  /** 启动 multi-worker workflow (只建 team, 不含 worker / initial_task)。 */
  startTeam: (params: { leadSessionId: string }) => Promise<
    ControlResult<{ teamId: string }>
  >;
  /** 在 workflow 内创建新 worker session。 */
  createWorker: (params: {
    leadSessionId: string;
    role: string;
    agent: ControlWorkerAgent;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    fast?: boolean;
    label: string;
    initialTask?: string;
  }) => Promise<
    ControlResult<
      { workerId: string; workerSessionId: string; softLimitExceeded?: boolean; dispatched?: boolean; dispatchOutcome?: import('../lizi_xdtHelperMcpServer.js').ControlDispatchOutcome; queuedMessageId?: string },
      'INVALID_PARAMS' | 'NOT_FOUND' | 'WORKER_LIMIT_HARD_EXCEEDED' | 'DUPLICATE_LABEL' | 'WORKER_CREATION_IN_PROGRESS' | 'BUDGET_MODEL_REQUIRES_API_MODE' | 'NO_PROVIDER_FOR_AGENT' | 'PROVIDER_ROUTE_UNAVAILABLE'
    >
  >;
  /** 列出当前 workflow 所有 worker。 */
  listWorkers: (params: { leadSessionId: string }) => Promise<
    ControlResult<{ workers: WorkerSummary[] }>
  >;
  /** 切换 focused worker。 */
  switchFocus: (params: {
    leadSessionId: string;
    workerIdOrLabel: string;
  }) => Promise<
    ControlResult<{ workerId: string }, 'WORKER_NOT_FOUND'>
  >;
  /** Lead → Worker 消息投递 (永远 jump 到既有 worker session, 绝不 create)。 */
  sendToWorker: (params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
  }) => Promise<
    ControlResult<
      {
        agentKind: ControlWorkerAgent;
        wakeKind: 'resumed' | 'already-active' | 'queued';
        targetTitle: string | null;
        targetLastUserSendAt: string | null;
        queuedMessageId?: string;
      },
      'NOT_FOUND' | 'ARCHIVED' | 'DELETED' | 'BUSY' | 'AGENT_NOT_READY' | 'INVALID_ARGS'
    >
  >;
  /** 列出 worker 输入队列中排队的消息(lead 自己的条目含正文)。 */
  listWorkerQueuedMessages: (params: {
    callerLeadSessionId: string;
    workerRef: string;
  }) => Promise<
    ControlResult<
      {
        workerId: string;
        workerSessionId: string;
        messages: WorkerQueuedMessageEntry[];
      },
      'WORKER_NOT_FOUND'
    >
  >;
  /** 修改一条尚未被消费的 lead 排队消息(整条正文替换)。 */
  updateWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
    message: string;
  }) => Promise<
    ControlResult<{ workerId: string; queuedMessageId: string }, QueuedMessageControlErrorCode>
  >;
  /** 撤回一条尚未被消费的 lead 排队消息。 */
  cancelWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
  }) => Promise<
    ControlResult<{ workerId: string; queuedMessageId: string }, QueuedMessageControlErrorCode>
  >;
  /** 主动将 worker 设为 idle。 */
  idleWorker: (params: { callerLeadSessionId: string; workerId: string }) => Promise<
    ControlResult<{ workerId: string }, 'WORKER_NOT_FOUND' | 'ALREADY_IDLE'>
  >;
  /** 结束整个 workflow, 归档所有 worker。 */
  endTeam: (params: { leadSessionId: string }) => Promise<ControlResult>;
  /** 归档单个 worker。 */
  archiveWorker: (params: { callerLeadSessionId: string; workerId: string }) => Promise<
    ControlResult<{ workerId: string }, 'WORKER_NOT_FOUND'>
  >;
  /** 列出 agent 可用 model 清单。 */
  listAvailableModels: (params: { agent?: ControlWorkerAgent }) => Promise<
    ControlResult<{
      codex?: Array<{ id: string; label: string }>;
      claude_code?: Array<{ id: string; label: string }>;
      pi?: Array<{ id: string; label: string }>;
    }>
  >;
  /** 只读诊断：列出当前 Orca workflow 与 worker sessions。 */
  getWorkspaceInfo: (params: { leadSessionId: string }) => Promise<
    ControlResult<OrcaWorkspaceInfo, 'LEAD_NOT_SUPPORTED'>
  >;
  /** 只读诊断：读取 worker 当前状态。 */
  getWorkerStatus: (params: { leadSessionId: string; workerId: string }) => Promise<
    ControlResult<OrcaWorkerDiagnosticStatus, 'WORKER_NOT_FOUND' | 'LEAD_NOT_SUPPORTED'>
  >;
  /** 只读诊断：读取 worker 最近输出。 */
  readWorker: (params: { leadSessionId: string; workerId: string }) => Promise<
    ControlResult<OrcaWorkerDiagnosticOutput, 'WORKER_NOT_FOUND' | 'LEAD_NOT_SUPPORTED'>
  >;
}

export interface OrcaWorkspaceInfo {
  workflow: {
    workflow_id: string;
    lead_session_id: string;
    status: string;
  } | null;
  ui_capacity: number;
  worker_count: number;
  workers: Array<{
    worker_id: string;
    session_id: string;
    status: string;
    session_status: string;
    idle_ms: number | null;
    restored_from_storage: boolean;
    label: string | null;
    role: string;
    agent_kind: ControlWorkerAgent;
    model: string;
    effort: string | null;
    focused: boolean;
    working_dir: string;
  }>;
}

export interface OrcaWorkerDiagnosticStatus {
  worker_id: string;
  session_id: string;
  status: string;
  session_status: string;
  idle_ms: number | null;
  restored_from_storage: boolean;
}

export interface OrcaWorkerDiagnosticOutput extends OrcaWorkerDiagnosticStatus {
  result: string;
}

/**
 * Per-session ctx 绑定参数。MCP server 实例在 toClaudeSdkConfig(ctx) 时按 ctx
 * 字段惰性创建, 工具 handler 闭包捕获这些值。control 工具只用到 sessionId /
 * vendorOptions; agentKind / workingDir 保留以对齐 provider 注入的 ctx 形状。
 */
export interface OrcaMcpSessionCtx {
  agentKind: ControlWorkerAgent;
  workingDir: string;
  sessionId?: string;
  /** start_team / end_team 读 vendorOptions.orcaRole 决定是否允许调用
   *  (worker session 不能再开 team)。 */
  vendorOptions?: Record<string, unknown>;
}

/**
 * DirectToolSink —— 把 team 工具直接 server.tool() 注册的适配器。
 *
 * 复用既有 register*Tool(registry, deps) 的签名: 本类继承 XdtHelperToolRegistry 但
 * override register() —— 不入内部 Map, 而是转调 server.tool()。这样 13 个工具文件
 * 一行不改即可顶层直接注册。direct 注册下 category 字段无意义(忽略); list()/
 * call() 等继承方法不会被用到(cindy_orca 不暴露 list_tools/call_tool 入口)。
 */
class DirectToolSink extends XdtHelperToolRegistry {
  constructor(private readonly mcp: McpServer) {
    super();
  }

  override register<T extends ZodRawShape>(def: {
    name: string;
    category: XdtHelperToolCategory;
    description: string;
    inputShape: T;
    handler: XdtHelperToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    // McpServer.tool 是多重载函数, 传入泛型 handler 时 TS 选不中
    // (name, description, paramsSchema, cb) 那条重载(且 SDK 的 zod-compat 类型
    // 与本包 zod 可能版本漂移)。bind 住 this 后收窄成单签名转发, 运行时行为与
    // 直接 server.tool(name, desc, shape, cb) 完全一致。
    const directTool = this.mcp.tool.bind(this.mcp) as unknown as (
      name: string,
      description: string,
      paramsSchema: z.ZodRawShape,
      cb: XdtHelperToolHandler,
    ) => void;
    directTool(
      def.name,
      def.description,
      def.inputShape,
      def.handler as unknown as XdtHelperToolHandler,
    );
  }
}

function controlErrorPayload(result: { errorCode: string; message: string }) {
  if (result.errorCode === 'HOST_NOT_READY') {
    return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
  }
  return errorPayload(result.errorCode, result.message);
}

function resolveLeadSessionContext(getSessionContext: () => OrcaMcpSessionCtx): { sessionId: string } | null {
  const ctx = getSessionContext();
  return typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0
    ? { sessionId: ctx.sessionId }
    : null;
}

function registerOrcaDiagnosticTools(
  sink: DirectToolSink,
  deps: OrcaMcpDeps,
  getSessionContext: () => OrcaMcpSessionCtx,
): void {
  sink.register({
    name: 'get_workspace_info',
    category: 'control',
    description: 'List the current Orca workflow and worker sessions.',
    inputShape: {},
    handler: async () => {
      const ctx = resolveLeadSessionContext(getSessionContext);
      if (!ctx) return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      const result = await deps.getWorkspaceInfo({ leadSessionId: ctx.sessionId });
      if (!result.ok) return controlErrorPayload(result);
      return okPayload({
        workflow: result.workflow,
        ui_capacity: result.ui_capacity,
        worker_count: result.worker_count,
        workers: result.workers,
      });
    },
  });

  sink.register({
    name: 'worker_status',
    category: 'control',
    description: 'EMERGENCY DIAGNOSTIC ONLY — do NOT use for normal polling. The worker will automatically notify you when done. If you call this to check "is it done yet," you are doing it wrong. Get worker run status and idle duration.',
    inputShape: {
      worker_id: z.string().min(1).describe('目标 worker 的 worker_id 或 session_id 任一'),
    },
    handler: async ({ worker_id }) => {
      const ctx = resolveLeadSessionContext(getSessionContext);
      if (!ctx) return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      const result = await deps.getWorkerStatus({ leadSessionId: ctx.sessionId, workerId: worker_id });
      if (!result.ok) return controlErrorPayload(result);
      return okPayload({
        worker_id: result.worker_id,
        session_id: result.session_id,
        status: result.status,
        session_status: result.session_status,
        idle_ms: result.idle_ms,
        restored_from_storage: result.restored_from_storage,
      });
    },
  });

  sink.register({
    name: 'read_worker',
    category: 'control',
    description: 'EMERGENCY DIAGNOSTIC ONLY — do NOT use for normal polling. The worker will automatically send its output when done. If you call this to check "is it done yet," you are doing it wrong. Get captured final assistant output from a worker session. Returns the latest captured assistant output; if the worker was just re-dispatched and has not produced new output yet, this may be the previous task\'s result — check status / session_status / idle_ms to judge freshness.',
    inputShape: {
      worker_id: z.string().min(1).describe('目标 worker 的 worker_id 或 session_id 任一'),
    },
    handler: async ({ worker_id }) => {
      const ctx = resolveLeadSessionContext(getSessionContext);
      if (!ctx) return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      const result = await deps.readWorker({ leadSessionId: ctx.sessionId, workerId: worker_id });
      if (!result.ok) return controlErrorPayload(result);
      return okPayload({
        worker_id: result.worker_id,
        session_id: result.session_id,
        status: result.status,
        session_status: result.session_status,
        idle_ms: result.idle_ms,
        restored_from_storage: result.restored_from_storage,
        result: result.result,
      });
    },
  });
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createOrcaMcpServer(
  deps: OrcaMcpDeps,
  ctx: OrcaMcpSessionCtx,
): McpServer {
  const server = new McpServer({
    name: 'cindy_orca',
    version: '1.0.0',
  });

  // 13 个 team 工具经 DirectToolSink 直接注册到顶层。handler 闭包绑定 ctx
  // (sessionId / vendorOptions), 调用时把请求路由回 host。
  const sink = new DirectToolSink(server);
  const getSessionContext = () => resolveLiziMcpSessionContext(ctx);
  registerStartTeamTool(sink, {
    sessionId: ctx.sessionId,
    vendorOptions: ctx.vendorOptions,
    getSessionContext,
    startTeam: deps.startTeam,
  });
  registerCreateWorkerTool(sink, {
    sessionId: ctx.sessionId,
    getSessionContext,
    createWorker: deps.createWorker,
  });
  registerCreateWorkersTool(sink, {
    sessionId: ctx.sessionId,
    getSessionContext,
    createWorker: deps.createWorker,
  });
  registerListWorkersTool(sink, {
    sessionId: ctx.sessionId,
    getSessionContext,
    listWorkers: deps.listWorkers,
  });
  registerSwitchFocusTool(sink, {
    sessionId: ctx.sessionId,
    getSessionContext,
    switchFocus: deps.switchFocus,
  });
  registerSendToWorkerTool(sink, {
    getSessionContext,
    sendToWorker: deps.sendToWorker,
  });
  registerListWorkerQueueTool(sink, {
    getSessionContext,
    listWorkerQueuedMessages: deps.listWorkerQueuedMessages,
  });
  registerUpdateQueuedMessageTool(sink, {
    getSessionContext,
    updateWorkerQueuedMessage: deps.updateWorkerQueuedMessage,
  });
  registerCancelQueuedMessageTool(sink, {
    getSessionContext,
    cancelWorkerQueuedMessage: deps.cancelWorkerQueuedMessage,
  });
  registerIdleWorkerTool(sink, {
    getSessionContext,
    idleWorker: deps.idleWorker,
  });
  registerEndTeamTool(sink, {
    sessionId: ctx.sessionId,
    vendorOptions: ctx.vendorOptions,
    getSessionContext,
    endTeam: deps.endTeam,
  });
  registerArchiveWorkerTool(sink, {
    getSessionContext,
    archiveWorker: deps.archiveWorker,
  });
  registerListAvailableModelsTool(sink, {
    listAvailableModels: deps.listAvailableModels,
  });
  registerOrcaDiagnosticTools(sink, deps, getSessionContext);

  return server;
}
