/**
 * Agent 事件流类型。
 *
 * 设计原则：让 UI 能通用消费两个 vendor 的事件。
 * - 通用字段 (text/tool_use/tool_result/done/error) 必须语义对齐
 * - vendor 不识别的 SDK message: translator 走 logger.warn 静默丢弃 (UI default case
 *   也只是 return state, 走 IPC 是浪费; 诊断信息靠 logger 落终端 / 文件 grep)
 *
 * 与现有 ccAgent.types StreamEvent 接近，但精简了未启用字段。
 */

import type { WorkflowProgressEntry } from '@cindy/maker-shared/agent-task';

export type AgentEventType =
  | 'text'                  // 流式文本输出（增量或完整）
  | 'thinking'              // reasoning 输出（增量或完整）
  | 'tool_use'              // 工具调用开始
  | 'tool_result'           // 工具调用结果（精简，UI 内嵌显示）
  | 'tool_result_full'      // 工具调用结果（完整，UI 详情面板用）
  | 'agent_task_update'     // 子 agent / task 状态更新（Claude Code task_* + Codex collab agent）
  | 'image'                 // 模型查看 / 生成的图片 (codex 独有, claude SDK 不会发)
  | 'account_usage'         // vendor-specific 账号级用量 (codex rateLimits 等); data shape 由 emit 端自定, renderer 按 source/字段嗅探
  | 'interaction_request'   // 需要用户决策(permission / ask_user_question / plan_review)
  | 'interaction_dismissed' // pending interaction 被自动 resolve(如 setPermissionMode 切换)
  | 'plan_mode_changed'     // agent 自行切换计划模式(典型: 计划批准后自动退出), data: { enabled: boolean }; host 据此回写持久化 + 广播 UI
  | 'status'                // 状态变化（idle / running / waiting + UsageSnapshot 内联在 data 里）
  | 'compact_boundary'      // auto-compact 边界
  | 'session_id'            // SDK session id 回填
  | 'done'                  // 一轮 turn 完成
  | 'error';                // 错误（是否结束 turn 由 error data 的 isTerminal 显式表达）

export interface AgentErrorEventData {
  message: string;
  /**
   * true 表示当前 turn 已经终止，消费方可以释放 running/keepalive 状态。
   * false 表示 producer 仍可能继续 retry（例如 Codex auth retry-loop），UI 可以
   * 展示错误提示，但不能把它当作底层 agent 已经 idle。
   *
   * 消费方判断优先级：先看 isTerminal；没有 isTerminal 但有 willRetry 时，
   * 用 `!willRetry` 兜底；两个字段都没有的老事件按终止型 error 处理，
   * 避免异常路径永久挂住。
   */
  isTerminal?: boolean;
  /** Vendor 原始 retry 标记；isTerminal 缺失时也作为兼容 fallback。 */
  willRetry?: boolean;
  sdkError?: string;
  reason?: string;
  [key: string]: unknown;
}

export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface AgentTaskUpdateEventData {
  provider: 'claude-code' | 'codex' | 'pi';
  /** Provider task id when available; falls back to the parent tool call id. */
  taskId: string;
  /** The tool_use id that launched or controls this subagent task. */
  parentToolUseId?: string;
  status: AgentTaskStatus;
  /** Short user-facing subject if the provider supplies one. */
  title?: string;
  /** Longer prompt / description used to start or update the task. */
  description?: string;
  /** Provider summary or final subagent answer. */
  summary?: string;
  outputFile?: string;
  usage?: AgentTaskUsage;
  lastToolName?: string;
  taskType?: string;
  workflowName?: string;
  /**
   * 实际模型名；`null` 是子代理多 receiver 观测冲突/显式清除的合法值，
   * 用于让下游清掉旧模型徽标，而不是回退到未经证明的旧值。
   */
  model?: string | null;
  reasoningEffort?: string;
  receiverThreadIds?: string[];
  /**
   * workflow 逐 agent 进度树(taskType=local_workflow 时 task_progress 事件携带,
   * 经 `@cindy/maker-shared/agent-task` 的 normalizeWorkflowProgressEntries 收窄截断)。
   * CLI 对纯心跳帧节流省略本字段(undefined = 沿用上一帧),下游 merge 不得清空。
   */
  workflowProgress?: WorkflowProgressEntry[];
  raw?: unknown;
}

/**
 * 一次 send 的发起来源标记(产品层 turn origin)。
 *
 * 与 agentMeta(vendor SDK 元信息)正交:agentMeta 描述"模型/SDK 产出了什么",
 * origin 描述"这一轮是谁发起的"。共享 session(心跳 + 远程控制同一 maker
 * session)里靠它区分某一 turn 是自动任务还是用户发起 —— session 行的
 * source 是会话级的,做不到 per-turn 区分。
 */
export interface SendOrigin {
  kind: 'user' | 'scheduler' | 'goal';
  /** scheduler 来源时的任务标识(供 IM 转播时显示"哪个自动任务")。 */
  scheduleId?: string;
  scheduleName?: string;
  /** scheduler 来源时的单次执行标识，用于持久化关联该轮消息与 run。 */
  runId?: string;
  /**
   * goal 来源时的目标会话标识(= 该 goal 所属 session id)。GoalController 发起的
   * 续跑 turn 用 origin={kind:'goal'} 打标,使"用户打断"守卫能靠 event.turnOrigin.kind
   * 区分 goal 自动续跑 vs 用户手动发起的 turn(见 goal-host/controller.ts)。
   * 纯产品层标记,translator / vendor SDK 不消费。
   */
  goalSessionId?: string;
}

export interface AgentEvent {
  type: AgentEventType;
  data: unknown;
  /** 事件来源标识，便于调试 */
  source?: 'claude-code' | 'codex' | 'pi';
  /**
   * 本事件所属 turn 的发起来源,由 Session 在事件 fan-out 前打标(见 session.ts
   * 的 currentTurnOrigin)。turn 结束(isTerminalTurnEvent)后清空,不污染下一轮。
   * translator 不产生此字段;消费方(IM 转播等)按需读取,默认忽略。
   */
  turnOrigin?: SendOrigin;
  /** Host-owned per-turn correlation for lifecycle bookkeeping; never comes from vendor metadata. */
  turnAttemptToken?: number;
  /**
   * Provider-owned claim attached synchronously to a `done` boundary when that
   * boundary has an automatic continuation. Consumers pass it back to the
   * session lifecycle API; unlike a live task-map sample it cannot race later
   * task notifications or a fast result-only continuation turn.
   */
  turnContinuationId?: number;
  /**
   * Vendor-specific 元数据透传 (claude-code 的 SDK uuid / parentUuid / sdkSessionId /
   * model / stopReason / requestId / usage 等)。host 落库时塞进 messages.agent_meta 列,
   * rewind / fork 反向找 prior assistant 时按 uuid 锚定。
   *
   * 形状不约束 — Claude 用 CcMeta-like shape, Codex 未来可定义自己的。null 表示该事件
   * 没有可关联的 vendor meta (比如 status / interaction_dismissed / done 等系统事件)。
   */
  agentMeta?: Record<string, unknown>;
}

export function isTerminalAgentErrorEvent(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  const data = event.data;
  if (!isRecord(data)) return true;
  const errorData = data as Partial<AgentErrorEventData>;
  if (typeof errorData.isTerminal === 'boolean') return errorData.isTerminal;
  if (typeof errorData.willRetry === 'boolean') return !errorData.willRetry;
  return true;
}

export function isTerminalTurnEvent(event: AgentEvent): boolean {
  if (event.type === 'done') return true;
  if (event.type === 'status') {
    const data = event.data as { isRunning?: unknown } | undefined;
    return data?.isRunning === false;
  }
  return isTerminalAgentErrorEvent(event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 用户交互请求 —— agent 暂停等待用户决策的统一抽象。
 *
 * 三种 kind 对应 Claude SDK canUseTool 拦截的三种场景:
 * - permission:  普通工具审批(Bash/Write/Edit/...)
 * - ask_user_question: 模型主动调 AskUserQuestion 工具问问题
 * - plan_review: 模型在 plan permissionMode 下调 ExitPlanMode 提交计划
 *
 * 每个 kind 的 payload + decision 字段不同, 但走同一条 dispatch 通道。
 */

/** 单道问题(用于 ask_user_question kind) */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type InteractionRequest =
  | {
      kind: 'permission';
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      title?: string;
      displayName?: string;
      description?: string;
      suggestions?: unknown[];
      metadata?: Record<string, unknown>;
    }
  | {
      kind: 'ask_user_question';
      requestId: string;
      questions: AskUserQuestionItem[];
    }
  | {
      kind: 'plan_review';
      requestId: string;
      plan: string;
      planFilePath?: string;
    };

export type InteractionDecision =
  | {
      kind: 'permission';
      behavior: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      reason?: string;
      /**
       * Vendor-specific permission scope updates to apply alongside this
       * decision. Currently consumed by claude-code agent only — passed
       * straight to the SDK's `canUseTool` return as `permissionUpdates`.
       *
       * Typical use ("allow always for this session"):
       *   permissionUpdates: [{
       *     type: 'addRules',
       *     rules: [{ toolName: req.toolName }],
       *     behavior: 'allow',
       *     destination: 'session',
       *   }]
       *
       * Shape intentionally `unknown[]` here — host should construct the
       * vendor-shaped objects (claude-code: `PermissionUpdate` from
       * @anthropic-ai/claude-agent-sdk). Codex treats a non-empty array as
       * a request for session-scoped approval when that approval path supports it.
       */
      // BaseAgent supplies helpers for session-scoped updates; adapters translate
      // these vendor-shaped values to their own SDK/app-server protocols.
      permissionUpdates?: unknown[];
    }
  | {
      kind: 'ask_user_question';
      /** 用户对每道问题的回答, key=question(或 header), value=用户回答 */
      answers: Record<string, string>;
    }
  | {
      kind: 'plan_review';
      behavior: 'allow' | 'deny';
      /** approve 时可附编辑后的计划 */
      editedPlan?: string;
      reason?: string;
      /**
       * true = 系统性 dismissal(会话 abort/close、resolver 缺失/抛错等自动 deny),
       * reason 是系统代码而非用户反馈。Codex 的 plan 修订循环据此**不**把 reason
       * 当用户反馈发起修订 turn(否则 abort 会自动发一条 "session_aborted" 消息)。
       * 用户主动"要求修订"的 deny 不设此标记。
       */
      dismissed?: boolean;
    };

export type InteractionResolver = (req: InteractionRequest) => Promise<InteractionDecision>;

/**
 * pending interaction 被自动 resolve 时, agent emit 此事件让 UI 关闭对话框。
 * resolvedAs 反映 agent 替用户做出的临时决定(如 mode 切换到 bypass 时自动 allow)。
 */
export interface InteractionDismissedEvent {
  requestId: string;
  reason: string;
  resolvedAs?: 'allow' | 'deny';
}

/**
 * Usage / cost / context 快照 —— 与 status event payload 1:1 扁平,
 * translator 在 push status event 时直接展开此对象。
 *
 * 字段对标老 agentManager (apps/desktop/src/main/agentManager.ts:2370-2407,2635-2643):
 * - tokenUsage:    单 turn 累计 (input + output), 跨多个 API call 累加, turn end reset
 * - contextTokens: 最后一次 API call 的 context 占用 (input + cacheRead + cacheCreate),
 *                  反映 auto-compact 后的真实占用而非 turn 累计
 * - contextWindow: SDK result.modelUsage[model].contextWindow, 0 表示未知
 *                  (renderer 端有 model prefix → 200K/1M 兜底)
 * - costUsd:       跨 turn 累计的 total_cost_usd
 *
 * 注: isRunning / status text 不属于 usage, 由 translator 在 emit status event 时单独拼。
 */
export interface UsageSnapshot {
  tokenUsage: number;
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
}

/**
 * 'image' event 的 data 形状 — codex 独有 (claude-code SDK 没有图像生成能力)。
 *
 * 两种 kind:
 *  - 'view':       模型读了一张图 (codex ImageView item, 只有 path)
 *  - 'generation': 模型生成了一张图 (codex ImageGeneration item)
 *
 * path / url 至少有一个 — view 一律走 path; generation 落盘了走 path, 否则 url
 * (codex 偶尔返 base64 data URL, renderer 自己识别协议头处理)。
 */
export interface ImageEventData {
  kind: 'view' | 'generation';
  /** ThreadItem id, 同一 item 的 started→completed 复用同一个 blockId 让 UI 合并。 */
  blockId: string;
  /** 本地绝对路径 (imageView 一定有, imageGeneration.savedPath 才有)。 */
  path?: string;
  /** 远程 url 或 data URL (imageGeneration.result 没落盘时)。 */
  url?: string;
  /** generation 才有: 模型实际用的 prompt (常被 OpenAI 改写过)。 */
  revisedPrompt?: string;
  /** generation 状态 (codex 不固定枚举, 透传字符串)。 */
  status?: string;
}

// ── Rewind / Fork ───────────────────────────────────────────────────────────
//
// Claude Code 的 RewindFilesResult / forkSession shape 在 maker-core 重新声明,
// 让 host 不必直接依赖 SDK 类型。Codex rewind 只裁剪对话 turn, 不提供文件 diff,
// 因此复用同一 result shape 并返回空文件列表。

export interface RewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export interface RewindCommitOptions {
  /**
   * Codex app-server 的 thread/rollback 只能按完整 turn 从尾部裁剪。
   * Claude 路径不消费此字段。
   */
  tailTurnsToDrop?: number;
}

export interface RewindCommitResult {
  /**
   * Rewind 后当前应持久化的 SDK session/thread id。Codex thread/rollback
   * 可能返回 replacement thread id，desktop 需同步写回以避免 resume 旧 thread。
   */
  sdkSessionId?: string;
}

export interface ForkSdkSessionOptions {
  /** 源 session 的 SDK sessionId (从 sessions.sdk_session_id 取)。 */
  sourceSdkSessionId: string;
  /**
   * 截断锚点 — 必须是 SDK assistant 消息的 uuid (调用方反查 + 跳 subagent)。
   * Claude 必填; Codex 协议无 message uuid, 此字段被 CodexAgent 忽略,
   * 调用方传 undefined 即可。
   */
  upToMessageId: string | undefined;
  /**
   * Fork 后从新 session 尾部移除多少个完整 turn。
   * Codex 精确 fork 使用 thread/rollback 实现；Claude 路径不消费此字段。
   */
  tailTurnsToDrop?: number;
  /** 新 session title (可选, 仅给 SDK 写入 jsonl 头)。 */
  title?: string;
  /** workingDir — 用于定位 Claude SDK project JSONL 并修复 fork 后的 uuid 引用。 */
  workingDir?: string;
  /** Codex only: fork from a rollout copy with reasoning response items removed. */
  stripEncryptedReasoning?: boolean;
}

export interface ForkSdkSessionResult {
  /** SDK 给新 jsonl 分配的新 sessionId。 */
  newSdkSessionId: string;
  /**
   * Fork 新 session 打开时可直接展示的 context 占用快照。
   * Claude 从 fork 后 JSONL 的最后一次 usage / compact_boundary 推导；未知时省略。
   */
  initialContextTokens?: number;
  /**
   * oldUuid → newUuid 映射 (SDK forkSession 会 remap 新 jsonl 里所有 uuid)。
   * 调用方拿来 remap agentMeta 列, 让从 fork 出来的会话再 fork (B → C) 时
   * upToMessageId 锚点能在新 jsonl 里查到。
   */
  uuidMap: Map<string, string>;
}
