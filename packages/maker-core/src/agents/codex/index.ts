/**
 * CodexAgent — 路线 A 完整版 (Phase 1+2+3+4 全打通)。
 *
 * Transport: 自家 AppServerHost (shared codex app-server 子进程 + JSON-RPC NDJSON),
 * 完全取代 @openai/codex-sdk。
 *
 * 能力清单 (vs Phase 1):
 *  - ✅ 基础对话: thread/start + turn/start + turn/interrupt + 7 类 notification 翻译
 *  - ✅ Resume:    thread/resume (Phase 3) — archive→unarchive 真续聊, 不开新 thread
 *  - ✅ Approval:  setRequestHandler 接 commandExecution / fileChange RequestApproval
 *                  → dispatchInteraction (复用 Claude 那条 PermissionPrompt 通道)
 *  - ✅ 运行时切:  setModel / setEffort / setPermissionMode 都生效, 下一 turn 自动透传
 *  - ✅ Fork:      thread/fork + optional thread/rollback → 新 thread_id
 *  - ✅ oneShot:   走 host 临时 thread (起标题), Phase 4 删 SDK dep 后唯一通路
 *
 * 输出契约:
 *  - AgentSessionHandle 只暴露 provider-neutral 的可选能力，不泄漏 Codex
 *    thread / app-server 协议类型
 *  - 事件流只 emit 已存在的 AgentEvent type union 成员
 *  - renderer 不感知 thread_id / app-server 任何概念
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  BaseAgent,
  OneShotError,
  AgentNotAuthenticatedError,
  TurnPermissionPolicyUnsupportedError,
  type AgentSessionHandle,
  type AgentDeps,
  type StartSessionOptions,
  type OneShotOptions,
  type RefreshLocalModelsOptions,
  type SendOptions,
  type TurnPermissionPolicy,
} from '../base-agent.js';
import type { AgentCredentialMode } from '../../interfaces/auth-adapter.js';
import type {
  Capabilities,
  EffortDescriptor,
  PermissionModeDescriptor,
} from '../../types/capabilities.js';
import type {
  AgentEvent,
  ForkSdkSessionOptions,
  ForkSdkSessionResult,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
import type { AuthState, Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type {
  AgentBuiltinCommand,
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from '../../types/palette.js';
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import type {
  MemoryStatus,
  MemorySetResult,
  MemoryResetResult,
} from '../../types/memory.js';
import type {
  AccountRateLimitsResponse,
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
} from '../../types/account-rate-limits.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { UsageTracker } from '../shared/usage-tracker.js';
import { getDefaultImageResizer } from '../shared/image-resizer.js';
import { pickTurnStartStatus, type OneShotState } from '../shared/turn-start-phrases.js';
import {
  OVERLOAD_RETRY_MAX_ATTEMPTS,
  overloadRetryDelayMs,
  parseOverloadError,
} from '../shared/overload-error.js';
import { buildCodexEnv } from './env-builder.js';
import { scanCodexCustomizations } from './customization-scanner.js';
import { commandExecutionDisplayInput } from './command-display.js';
import {
  newCodexRuntimeState,
  isAuthRelatedErrorMessage,
  translateErrorNotification,
  translateItemNotification,
  translateReasoningSummaryTextDelta,
  translateReasoningSummaryPartAdded,
  translateReasoningTextDelta,
  translateAccountRateLimitsUpdated,
  translatePlanUpdatedNotification,
  extractRolloutUpdatePlanFunctionCallEvent,
  type CodexRuntimeState,
} from './translator.js';
import {
  TurnRetryTracker,
  buildBackendUnreachableMessage,
  type OutboundPathFact,
} from './retry-escalation.js';
import { extractNonSecretErrorSignals } from '@cindy/maker-shared/error-redaction';
import { AppServerHost, type ThreadEventHandlers, type ThreadSubscription } from './app-server/host.js';
import { AppServerRequestTimeoutError } from './app-server/client.js';
import { createStdioTransport } from './app-server/stdioTransport.js';
import { CodexInteractionBroker } from './interaction-broker.js';
import { SYSTEM_PROMPT_APPEND as MAKER_CODEX_SYSTEM_PROMPT_APPEND } from './system-prompt-append.js';
import { MAKER_MEMORY_RULES } from '../../memory/system-prompt.js';
import { MemoryFlushController } from '../../memory/flush-controller.js';
import { buildMemoryScopeKey } from '../../memory/storage.js';
import { CODEX_AGENT_COMMANDS } from './commands.js';
import {
  canReuseCodexHostForCredentialMode,
  resolveAgentCredentialMode,
  resolveEffectiveCredentialModeFromAuthSource,
} from '../credential-mode.js';
import {
  Method,
  codexErrorInfoTag,
  type AskForApproval,
  type ApprovalsReviewer,
  type ApprovalDecision,
  type ItemGuardianApprovalReviewCompletedNotification,
  type ItemGuardianApprovalReviewStartedNotification,
  type GuardianWarningNotification,
  type CodexModelListResponse,
  type CommandExecutionRequestApprovalParams,
  type CommandExecutionRequestApprovalResponse,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type DynamicToolSpec,
  type FileChangeRequestApprovalParams,
  type FileChangeRequestApprovalResponse,
  type McpServerElicitationRequestParams,
  type CollaborationModeParam,
  type McpServerElicitationRequestResponse,
  type PermissionsRequestApprovalParams,
  type PermissionsRequestApprovalResponse,
  type ServerRequestResolvedNotification,
  type SandboxMode,
  type SandboxPolicy,
  type ServiceTier,
  type SkillMetadata,
  type SkillsListResponse,
  type ThreadForkParams,
  type ThreadForkResponse,
  type ThreadRollbackParams,
  type ThreadRollbackResponse,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type ThreadSettingsUpdateParams,
  type ThreadSettingsUpdateResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputQuestion,
  type ToolRequestUserInputResponse,
  type TokenUsageBreakdown,
  type TurnPlanUpdatedNotification,
  type TurnStartParams,
  type TurnStartResponse,
  type UserInput,
} from './app-server/protocol.js';

type CodexEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

const CODEX_MINIMAL_EFFORT_MODELS = new Set([
  'bytedance-seed/seed-2.1-pro',
  'z-ai/glm-5.2',
]);

/**
 * item.type → chip status 文案 (对齐 claude-code 6 类). null = 该 item 不触发 chip 切换
 * (imageView/plan/userMessage/hookPrompt 等是 completed-only 或 UI 不暴露的 item)。
 */
function statusTextForItem(item: { type?: string; command?: string; tool?: string }): string | null {
  switch (item.type) {
    case 'reasoning':            return 'Thinking...';
    case 'agentMessage':         return 'Generating...';
    case 'commandExecution': {
      // command 首词在 Windows 下可能是 `"C:\\...\\powershell.exe"` 完整路径带引号 —
      // 直接拿会刷出超长 chip。剥引号 → 取 basename → 去 .exe 后缀, 显示 `powershell running...`。
      const firstToken = (item.command ?? '').trim().split(/\s+/)[0] ?? '';
      const unquoted = firstToken.replace(/^["']|["']$/g, '');
      const basename = unquoted.split(/[\\/]/).pop() || '';
      const head = basename.replace(/\.exe$/i, '') || 'shell';
      return `${head} running...`;
    }
    case 'fileChange':           return 'Editing files...';
    case 'mcpToolCall':          return `${item.tool ?? 'mcp'} running...`;
    case 'dynamicToolCall':      return `${item.tool ?? 'tool'} running...`;
    case 'collabAgentToolCall':  return `${item.tool ?? 'agent'} running...`;
    case 'webSearch':            return 'Searching web...';
    case 'imageGeneration':      return 'Generating image...';
    case 'contextCompaction':    return 'Compacting...';
    default:                     return null;
  }
}

/**
 * maker Effort → Codex app-server 可透传档。
 *
 * Seed 2.1 Pro 与 GLM-5.2 的官方档位包含 minimal，原样下发；其他模型继续
 * 把 minimal 收敛到 low。max / ultra 直接透传，不再静默降级为 xhigh(issue #352)。
 * 某模型是否真支持某档位由目录 efforts 与 UI/reconcile 门控保证。
 */
function clampEffortForCodex(model: string, e: Effort): CodexEffort {
  if (e === 'minimal' && !CODEX_MINIMAL_EFFORT_MODELS.has(model)) return 'low';
  return e;
}

function normalizeTailTurnsToDrop(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function prefixId(value: string | undefined): string | undefined {
  return value ? value.slice(0, 8) : undefined;
}

function isRemoteLikePath(p: string): boolean {
  return p.startsWith('/') && process.platform === 'win32';
}

function isReasoningPayload(payload: unknown): boolean {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).type === 'reasoning',
  );
}

function isImageGenerationPayloadWithoutId(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string') return false;
  if (!type.startsWith('image_generation') && !type.startsWith('imageGeneration')) return false;
  const id = record.id;
  return typeof id !== 'string' || id.trim().length === 0;
}

function hasUnsafeForkRolloutPayload(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const payload = (parsed as Record<string, unknown>).payload;
    return isReasoningPayload(payload) || isImageGenerationPayloadWithoutId(payload);
  } catch {
    return false;
  }
}

function buildCodexDeveloperInstructions(parts: {
  makerMemoryRules?: string;
  runtimeSystemPrompt?: string;
  makerMemoryIndex?: string;
  userPrompt?: string;
}): string {
  return [
    MAKER_CODEX_SYSTEM_PROMPT_APPEND,
    parts.makerMemoryRules,
    parts.runtimeSystemPrompt,
    parts.makerMemoryIndex,
    parts.userPrompt,
  ]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join('\n\n');
}

/**
 * Build the host-map key for a (potentially remote) session.
 *
 * The CodexAgent keeps one `AppServerHost` per "target" — local spawn vs
 * each distinct remote ssh host. Reusing a host across sessions in the same
 * target is load-bearing: the codex app-server caches initialize state +
 * keeps a single thread namespace per process, so two sessions on the same
 * remoteHostId MUST land on the same host instance.
 *
 * Empty / undefined / null / falsy remoteHostId → 'local' (a missing remote
 * id is always interpreted as "run on this machine", never as a sentinel
 * remote alias).
 *
 * Exported as a module-level pure function so the routing rule has unit
 * coverage independent of the CodexAgent class (which is otherwise hard to
 * instantiate without full host deps).
 */
export function hostKey(remoteHostId?: string | null): string {
  return remoteHostId ? `remote:${remoteHostId}` : 'local';
}

const LOCAL_CONTROL_PLANE_HOST_PREFIX = 'local-control:';
const CODEX_MODEL_LIST_RPC_TIMEOUT_MS = 20_000;
const CODEX_MODEL_REFRESH_DEADLINE_MS = 20_000;

function localControlPlaneHostKey(credentialMode: AgentCredentialMode): string {
  return `${LOCAL_CONTROL_PLANE_HOST_PREFIX}${credentialMode}`;
}

function isLocalControlPlaneHostKey(key: string): boolean {
  return key.startsWith(LOCAL_CONTROL_PLANE_HOST_PREFIX);
}

/**
 * maker permissionMode → app-server { approvalPolicy, approvalsReviewer, sandbox }。
 *
 * Phase 2 起 'ask' 走 'on-request' — server 真发 CommandExecutionRequestApproval,
 * 我们 setRequestHandler 接住转 dispatchInteraction → UI 弹 PermissionPrompt。
 */
type CodexPermissionConfig = {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  approvalsReviewer?: ApprovalsReviewer;
};
function mapPermissionToCodex(
  permissionMode: string | undefined,
  approvalsReviewerProtocolSupported: boolean,
  approvalsReviewerRouteSupported: boolean,
): CodexPermissionConfig {
  const manualApprovalConfig: CodexPermissionConfig = {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    ...(approvalsReviewerProtocolSupported ? { approvalsReviewer: 'user' } : {}),
  };
  // 严格 kebab-case (v2.rs serde rename_all="kebab-case"), camelCase 会被 server -32600 reject
  switch (permissionMode) {
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'auto':
      if (!approvalsReviewerProtocolSupported || !approvalsReviewerRouteSupported) {
        // 旧 app-server 或未验证 reviewer 模型路由时回退到人工 on-request。
        // 不能用 untrusted:它拒绝 require_escalated,即使用户批准普通命令,
        // 网络/沙箱外写入仍会留在受限 sandbox 内。新版协议显式写 user,
        // 还可覆盖恢复 thread 中 sticky 的 auto_review;旧版则安全省略未知字段。
        return manualApprovalConfig;
      }
      // Codex app-server 原生 auto_review 与 Claude Auto 的分工一致:
      // 常规 workspace 动作直接执行,越界动作交给内置 reviewer 判断,而不是交给 UI。
      // workspace-write 仍是硬安全边界; auto_review 只替换审批者,不扩大沙箱。
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' };
    default:
      return manualApprovalConfig;
  }
}

function codexUserAgentAtLeast(
  userAgent: string | undefined,
  minimum: readonly [number, number, number],
): boolean {
  const match = /\/(\d+)\.(\d+)\.(\d+)(?:[-+ )]|$)/.exec(userAgent ?? '');
  if (!match) return false;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let i = 0; i < minimum.length; i += 1) {
    if (version[i]! > minimum[i]!) return true;
    if (version[i]! < minimum[i]!) return false;
  }
  return true;
}

/**
 * `approvalsReviewer` is verified against the app-server bundled with Codex 0.144.6.
 * Remote hosts may keep an older standalone binary across desktop upgrades, so parse the
 * initialize userAgent and conservatively omit the field unless that verified floor is met.
 */
function supportsCodexApprovalsReviewerProtocol(userAgent: string | undefined): boolean {
  return codexUserAgentAtLeast(userAgent, [0, 144, 6]);
}

/**
 * Runtime workspace roots and named permission profiles were verified against
 * the app-server bundled with Codex 0.144.6. Keep older remote daemons
 * fail-closed: without profiles, legacy workspace-write would make every
 * runtime root writable.
 */
function supportsCodexReadonlyReferenceDirs(userAgent: string | undefined): boolean {
  return supportsCodexApprovalsReviewerProtocol(userAgent);
}

/**
 * `excludeTurns` was introduced in Codex 0.125.0 and later marked experimental.
 * Older remote daemons can outlive desktop upgrades, so omit the unknown field
 * and preserve their legacy full-history resume behavior.
 */
function supportsCodexResumeExcludeTurns(userAgent: string | undefined): boolean {
  return codexUserAgentAtLeast(userAgent, [0, 125, 0]);
}

const READONLY_REFERENCES_PERMISSION_PROFILE = 'cindy-readonly-references';

/**
 * SandboxMode (thread/start 用 kebab enum) → SandboxPolicy (turn/start 用 tag union)。
 * 两者**字段名 + 类型都不一样**, 是 Codex 协议的不对称设计 — turn/start 接 SandboxPolicy
 * 让 server 能在 turn 中途切换更细粒度的沙盒配置。
 *
 * 简单映射: 各模式取默认值 (server 端字段都有 #[serde(default)], 省略即可)。
 *
 * extraWritableRoots: 仅 workspaceWrite 模式生效, 把 workspace 之外的额外路径加进
 * 可写白名单, 让 apply_patch 不被 "writing outside of the project" 预检拦掉。
 * 当前用途: 把 <CODEX_HOME>/memories/ 加进去, 让 codex 自家 MemoryTool 的写入流程
 * (model 用 apply_patch 改 memory_summary.md / MEMORY.md) 不撞预检。
 */
function sandboxModeToPolicy(mode: SandboxMode, extraWritableRoots: string[] = []): SandboxPolicy {
  switch (mode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly' };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        ...(extraWritableRoots.length > 0 ? { writableRoots: extraWritableRoots } : {}),
      };
  }
}

/** maker InteractionDecision.behavior → Codex ApprovalDecision (camelCase serde)。 */
function mapBehaviorToApproval(behavior: 'allow' | 'deny'): ApprovalDecision {
  return behavior === 'allow' ? 'accept' : 'decline';
}

const ASK_USER_DYNAMIC_TOOL_NAMESPACE = 'cindy';
const LEGACY_ASK_USER_DYNAMIC_TOOL_NAMESPACE = 'xdt_maker';
const ASK_USER_DYNAMIC_TOOL_NAME = 'ask_user_question';
const MAX_REQUEST_USER_INPUT_QUESTIONS = 3;
const MAX_REQUEST_USER_INPUT_OPTIONS = 10;
const MAX_REQUEST_USER_INPUT_TEXT_CHARS = 1_000;
const MAX_REQUEST_USER_INPUT_ANSWER_CHARS = 2_000;
const DISABLE_ASK_USER_DYNAMIC_TOOL_FALLBACK = process.env.XDT_CODEX_DISABLE_ASK_USER_DYNAMIC_TOOL === '1';
// xAI rejects Codex namespace dynamic tools in its Responses `tools[]` schema.
const CODEX_DYNAMIC_TOOL_UNSUPPORTED_PROVIDER_IDS = new Set(['xai']);

const ASK_USER_DYNAMIC_TOOL: DynamicToolSpec = {
  namespace: ASK_USER_DYNAMIC_TOOL_NAMESPACE,
  name: ASK_USER_DYNAMIC_TOOL_NAME,
  description: [
    'Use this tool instead of listing choices or asking in prose when the user asks to choose, pick a direction, select an approach, or narrow options before you continue.',
    'Use it for product preferences, game/design/business directions, business judgments, and choices between materially different approaches.',
    'Use it when the next useful step depends on the user selecting among options, even if you could provide a generic list yourself.',
    'Ask 1 to 3 short questions in a single call when those questions are independent; do not make several back-to-back calls for independent clarification questions.',
    'Use a later follow-up call only when the next question depends on the user answer to an earlier question.',
    'Do not use it for routine implementation details; choose a reasonable default.',
    'This tool does not replace authorization for destructive or external actions.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        description: 'One to three short user-facing questions to ask together. Bundle independent choices into this array instead of calling the tool repeatedly.',
        minItems: 1,
        maxItems: MAX_REQUEST_USER_INPUT_QUESTIONS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question'],
          properties: {
            id: { type: 'string', description: 'Stable answer key for this question.' },
            header: { type: 'string', description: 'Short label shown above the question.' },
            question: { type: 'string', description: 'Clear question text for the user.' },
            options: {
              type: 'array',
              description: 'Optional single-select answer choices. Omit when free-form input is needed.',
              maxItems: MAX_REQUEST_USER_INPUT_OPTIONS,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label'],
                properties: {
                  label: { type: 'string', description: 'Short option label returned as the answer.' },
                  description: { type: 'string', description: 'Brief explanation of when this option is appropriate.' },
                },
              },
            },
            isOther: { type: 'boolean', description: 'Whether the user may provide a free-form answer outside the listed options.' },
          },
        },
      },
    },
  },
};

interface ActiveToolContext {
  type: 'mcpToolCall' | 'dynamicToolCall';
  turnId?: string | null;
  server?: string | null;
  namespace?: string | null;
  tool?: string | null;
}

function isAskUserDynamicTool(params: Pick<DynamicToolCallParams, 'namespace' | 'tool'>): boolean {
  return (
    (params.namespace === ASK_USER_DYNAMIC_TOOL_NAMESPACE ||
      params.namespace === LEGACY_ASK_USER_DYNAMIC_TOOL_NAMESPACE) &&
    params.tool === ASK_USER_DYNAMIC_TOOL_NAME
  );
}

function shouldRegisterAskUserDynamicTool(opts: Pick<StartSessionOptions, 'model' | 'providerId'>): boolean {
  if (DISABLE_ASK_USER_DYNAMIC_TOOL_FALLBACK) return false;
  const providerId = typeof opts.providerId === 'string' ? opts.providerId.trim() : '';
  if (CODEX_DYNAMIC_TOOL_UNSUPPORTED_PROVIDER_IDS.has(providerId)) return false;
  if (!providerId && opts.model.startsWith('xai/')) return false;
  return true;
}

function truncateUserInputText(value: string): string {
  return value.length > MAX_REQUEST_USER_INPUT_TEXT_CHARS
    ? value.slice(0, MAX_REQUEST_USER_INPUT_TEXT_CHARS)
    : value;
}

function truncateAnswerText(value: string): string {
  return value.length > MAX_REQUEST_USER_INPUT_ANSWER_CHARS
    ? value.slice(0, MAX_REQUEST_USER_INPUT_ANSWER_CHARS)
    : value;
}

function emptyUserInputResponse(questions: readonly Pick<ToolRequestUserInputQuestion, 'id'>[]): ToolRequestUserInputResponse {
  const answers: ToolRequestUserInputResponse['answers'] = {};
  for (const q of questions) {
    if (q.id) answers[q.id] = { answers: [] };
  }
  return { answers };
}

function normalizeRequestUserInputQuestions(
  questions: readonly ToolRequestUserInputQuestion[],
): ToolRequestUserInputQuestion[] {
  return questions.slice(0, MAX_REQUEST_USER_INPUT_QUESTIONS).map((q, index) => ({
    id: q.id || `question-${index + 1}`,
    header: truncateUserInputText(q.header || ''),
    question: truncateUserInputText(q.question || q.header || `Question ${index + 1}`),
    isOther: q.isOther === true,
    isSecret: q.isSecret === true,
    options: Array.isArray(q.options)
      ? q.options.slice(0, MAX_REQUEST_USER_INPUT_OPTIONS).map((option) => ({
          label: truncateUserInputText(option.label || ''),
          description: truncateUserInputText(option.description || ''),
        })).filter((option) => option.label.trim().length > 0)
      : null,
  }));
}

function normalizeDynamicAskUserQuestions(args: unknown): ToolRequestUserInputQuestion[] {
  const input = args && typeof args === 'object' ? args as { questions?: unknown } : {};
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions: ToolRequestUserInputQuestion[] = rawQuestions.map((raw, index) => {
    const q = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const rawOptions = Array.isArray(q.options) ? q.options : null;
    return {
      id: typeof q.id === 'string' && q.id.trim() ? q.id : `question-${index + 1}`,
      header: typeof q.header === 'string' ? q.header : '',
      question: typeof q.question === 'string' ? q.question : '',
      isOther: q.isOther === true,
      // Dynamic fallback is a business-choice tool. It must not collect secrets.
      isSecret: false,
      options: rawOptions
        ? rawOptions.map((rawOption) => {
            const option = rawOption && typeof rawOption === 'object'
              ? rawOption as Record<string, unknown>
              : {};
            return {
              label: typeof option.label === 'string' ? option.label : '',
              description: typeof option.description === 'string' ? option.description : '',
            };
          })
        : null,
    };
  });
  return normalizeRequestUserInputQuestions(questions);
}

function questionsToAskUserItems(questions: readonly ToolRequestUserInputQuestion[]) {
  return questions.map((q) => ({
    question: q.question,
    header: q.header || undefined,
    options: q.options?.map((option) => ({
      label: option.label,
      description: option.description || undefined,
    })),
    multiSelect: false,
  }));
}

function responseFromAskUserAnswers(
  questions: readonly ToolRequestUserInputQuestion[],
  answers: Record<string, string>,
): ToolRequestUserInputResponse {
  const out: ToolRequestUserInputResponse['answers'] = {};
  for (const q of questions) {
    const raw = answers[q.question] ?? answers[q.header] ?? answers[q.id] ?? '';
    if (!raw) {
      out[q.id] = { answers: [] };
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        out[q.id] = { answers: parsed.filter((v): v is string => typeof v === 'string').map(truncateAnswerText) };
        continue;
      }
    } catch {
      // Single-select answers are plain labels, not JSON.
    }
    out[q.id] = { answers: [truncateAnswerText(raw)] };
  }
  return { answers: out };
}

function responseFromPermissionDecision(
  questions: readonly ToolRequestUserInputQuestion[],
  decision: Extract<InteractionDecision, { kind: 'permission' }>,
): ToolRequestUserInputResponse {
  if (decision.behavior === 'deny') return emptyUserInputResponse(questions);
  const out: ToolRequestUserInputResponse['answers'] = {};
  for (const q of questions) {
    const positiveOption = q.options?.find((option) =>
      /^(allow|approve|accept|yes|continue|confirm)$/i.test(option.label.trim()),
    );
    const option = positiveOption?.label ?? q.options?.[0]?.label ?? 'allow';
    out[q.id] = { answers: [option] };
  }
  return { answers: out };
}

function dynamicToolResponseFromUserInput(response: ToolRequestUserInputResponse): DynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{ type: 'inputText', text: JSON.stringify(response.answers) }],
  };
}

function normalizeServiceTier(serviceTier: ServiceTier | null | undefined): ServiceTier | null | undefined {
  return serviceTier === 'priority' ? 'fast' : serviceTier;
}

function isFastServiceTier(serviceTier: ServiceTier | null | undefined): boolean {
  return normalizeServiceTier(serviceTier) === 'fast';
}

function skillDescription(skill: SkillMetadata): string | undefined {
  return (
    skill.interface?.shortDescription?.trim() ||
    skill.shortDescription?.trim() ||
    skill.description?.trim() ||
    undefined
  );
}

function isPaletteVisibleCodexSkill(skill: SkillMetadata): boolean {
  if (!skill.enabled || skill.scope === 'system' || skill.scope === 'admin') return false;

  // Codex plugins can contribute internal skills and currently report them as scope=user.
  // They remain available to Codex's own dispatch, but Cindy's slash palette should only
  // expose installed user/repo skills instead of every plugin implementation detail.
  const normalizedPath = skill.path.replace(/\\/g, '/');
  return !/\/plugins\/cache\/[^/]+\/[^/]+\/[^/]+\/skills\//i.test(normalizedPath);
}

function parseLeadingSlashToken(text: string): { name: string; rest: string } | null {
  const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  return { name: match[1], rest: match[2] ?? '' };
}

function isExpectedTurnIdMismatchError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === -32600 && /expected active turn id\b[\s\S]*\bbut found\b/i.test(message);
}

// 插话 (steer) 时 turn/steer RPC 的 ack 有界等待上限。AppServerClient.request
// 本身没有超时, app-server 卡死时裸 await 会永久挂起 → coordinator steering marker
// 永久残留 → 后续插话点击被静默吞掉。正常情况下 ack 是毫秒级, 10s 足够宽裕。
const STEER_ACK_TIMEOUT_MS = 10_000;

// 权限收紧 fail-safe 的 turn/interrupt RPC ack 有界等待上限。没有超时的话,
// app-server / 连接无响应时该 RPC 永久悬挂 —— 既不走重试、也不透出失败提示,
// 免审 turn 将无声继续跑 (review #969 第六轮 Greptile P1)。取值与 steer 同款 10s。
const TIGHTEN_INTERRUPT_ACK_TIMEOUT_MS = 10_000;

// Permission profile refresh / replacement runs before turn/start and therefore
// sits on the message acceptance path. Keep its app-server acknowledgement
// bounded so a live-but-unresponsive daemon cannot freeze the queued message or
// ignore Stop.
const PROFILE_LIFECYCLE_ACK_TIMEOUT_MS = 10_000;

// thread/start / thread/resume / turn/start 的 RPC 上限。AppServerClient.request
// 默认无超时 — 远端 daemon 失联 (SSH 隧道半开 / daemon 挂起但 socket 未断) 时
// 裸 await 永久挂起, session 永远停在 generating (issue #677 同类断链面)。
// 60s 足够覆盖慢 SSH 链路 + daemon 冷启动, 超时后走既有的「启动失败」收口
// (terminal error + Done status)。注意: 超时只代表**我们不再等**, server 侧
// 可能实际已建 thread/turn — 迟到事件按 stale turn 丢弃, 不影响 UI 复位。
const CRITICAL_THREAD_RPC_TIMEOUT_MS = 60_000;

/**
 * upstream-response-idle watchdog 阈值 — codex 侧对齐 claude-code 的同名机制
 * (claude-code/index.ts parseIdleTimeoutMs)。默认 30min, env
 * `XDT_CODEX_IDLE_TIMEOUT_MS` (ms) 覆盖, 设 0 关闭。
 *
 * 背景: codex 此前只有 willRetry 风暴的终局升级 (retry-escalation.ts) —— 那只覆盖
 * "daemon 在不停重试并如实上报"的情形。daemon **静默**卡死 (后端连接半开、内部
 * 死锁、app-server 不再投递任何通知) 时没有任何兜底, turn 在 UI 上永远转圈。
 *
 * 计时语义与 claude 侧一致: 只在"客户端把 ball 交给上游、等上游回话"期间计时。
 *  - 有未完成的工具类 item (命令执行 / MCP / 动态工具 / web 搜索 / 图像生成) →
 *    停表: 工具执行由 daemon 侧承担, 长 build / 拉大表 / 等审批不该被误杀。
 *  - 任何投递给上层的事件 (reasoning / text delta / status / item 更新) → 重置。
 * 触发后走 turn/interrupt (与用户手动 Stop 同路径, 不销毁 thread), 并推一条终态
 * error, reason 与 claude 侧共用 'upstream_response_idle_timeout'。
 */
const CODEX_UPSTREAM_IDLE_TIMEOUT_DEFAULT_MS = 30 * 60_000;

/** upstream-idle 看门狗的计时分片长度(见 armUpstreamIdleSlice)。 */
const CODEX_UPSTREAM_IDLE_SLICE_MS = 60_000;

/** 分片实际耗时超出片长这么多 → 判为进程被系统挂起过,该片不计入额度。 */
const CODEX_UPSTREAM_IDLE_SUSPEND_GAP_MS = 30_000;

function parseCodexIdleTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return CODEX_UPSTREAM_IDLE_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return CODEX_UPSTREAM_IDLE_TIMEOUT_DEFAULT_MS;
  return Math.floor(n);
}

/**
 * "球不在上游"的 item 类型白名单:这些 item 在 started → completed 之间由 daemon
 * 侧执行(或在等用户审批),期间上游不欠我们回话,idle watchdog 必须停表。
 * 与 translator 的 item 分派保持同一词表(codex/translator.ts)。
 */
const CODEX_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageGeneration',
  'imageView',
  'fileChange',
]);

/**
 * Codex 权限档的严格度序（数值越大越严）。Codex 只支持 ask / auto /
 * bypassPermissions 三档，其余取值走 clamp 后不会到这里；未知值按最严处理，
 * 让比较偏向「需要中断」而不是放行。
 *
 * 用途：判断过载重投持的**冻结**策略是否比当前选择的档更宽。只比较最近一次
 * 模式转换会漏掉 Full access → Ask → Auto 这类中间态。
 */
function codexPermissionStrictnessRank(mode: PermissionMode): number {
  switch (mode) {
    case 'bypassPermissions':
      return 0;
    case 'auto':
      return 1;
    case 'ask':
      return 2;
    default:
      return 2;
  }
}

// 计划批准后自动发起实施 turn 的固定输入 — 与官方 TUI 逐字一致
// (codex-rs/tui/src/chatwidget/plan_implementation.rs 的
// PLAN_IMPLEMENTATION_CODING_MESSAGE), 模型对这句有训练分布上的既有理解。
const PLAN_IMPLEMENTATION_MESSAGE = 'Implement the plan.';
const SYSTEM_PLAN_REVIEW_DISMISSAL_REASONS = new Set([
  'no_listener_attached',
  'no_interaction_resolver',
  'interaction_resolver_error',
  'user_rejected',
]);

// ── 能力声明 (Phase 3 全开) ──────────────────────────────────────────────────

// 模型清单 SSoT 已迁至目录 packages/model-providers/catalog/providers.json。
// availableModels 起始为空,由 host 从 BUNDLED_CATALOG 派生后经 capabilityAdditions 注入
// (见 apps/desktop/src/main/maker-host/catalog-to-descriptors.ts)。

const CODEX_EFFORTS: EffortDescriptor[] = [
  { id: 'low', displayName: 'Low', description: 'Fast responses with minimal reasoning' },
  { id: 'medium', displayName: 'Medium', description: 'Balanced reasoning depth' },
  { id: 'high', displayName: 'High', description: 'Deeper reasoning for harder tasks' },
  { id: 'xhigh', displayName: 'Extra High', description: 'Extended reasoning budget' },
  // max/ultra 仅部分模型支持(如 GPT-5.6 Sol);实际是否可选由该模型目录 efforts 决定,
  // 这里只提供 agent 级档名/描述兜底(桌面 i18n effortLevels.* 优先)。
  { id: 'max', displayName: 'Max', description: 'Very high reasoning budget (model-dependent)' },
  { id: 'ultra', displayName: 'Ultra', description: 'Maximum reasoning budget (model-dependent)' },
];

const CODEX_PERMISSION_MODES: PermissionModeDescriptor[] = [
  { id: 'ask', displayName: 'Default permissions', description: '工作区内可读写,需要更多权限时询问' },
  { id: 'auto', displayName: 'Auto', description: '工作区沙箱内自动执行,越界操作交给自动审查器;高风险操作可能拒绝或询问' },
  { id: 'bypassPermissions', displayName: 'Full access', description: '可改任意文件、跑联网命令,免询问;风险高' },
];

const CAPABILITIES: Capabilities = {
  // Phase 3: turn/start 透传 model 即可 — server 接受 per-turn override
  switchModel: { supported: true },
  availableModels: [],
  hasFastMode: true,
  effort: { supported: true },
  effortLevels: CODEX_EFFORTS,
  reasoningDisplay: ['off', 'summarized'],
  permissionModes: CODEX_PERMISSION_MODES,
  setPermissionModeMidSession: { supported: true },
  turnPermissionPolicy: {
    supported: { supported: true },
    // Full access can mutate workspace files without a host approval callback.
    unsupportedPermissionModes: ['bypassPermissions'],
  },
  // 计划模式一级开关: app-server experimental collaborationMode ({ mode:'plan' }) +
  // plan item 捕获 → plan_review 审批 → 批准后自动发起实施 turn (对齐官方 TUI 流程)。
  planMode: { supported: true },
  multimodal: {
    text: { supported: true },
    image: { supported: true },
    file: { supported: true },
  },
  // Phase 3: thread/fork 已实现 (uuidMap 空, Codex 没有 message uuid 概念但不影响 fork 本身)
  fork: { supported: true },
  // Codex app-server 支持 thread/rollback 裁剪对话 turn；它不做文件回滚。
  // 产品的“代码 + 对话”回退由 Git rollback 负责代码部分，再调用此能力裁剪对话。
  rewind: { supported: true },
  abort: { supported: true },
  sameTurnSteer: { supported: true },
  memory: {
    supported: { supported: true },
    displayName: '记忆 (实验性)',
    description: '从聊天中生成新记忆并在新对话中召回 (Codex Feature::MemoryTool, 默认关)',
    stage: 'experimental',
    defaultEnabled: false,
    resettable: true,
    // experimentalFeature/enablement/set 是 in-memory 进程级覆盖, server 自动 reload_user_config
    // 通知所有 live thread, 真正立即生效
    setEnabledMidSession: { supported: true },
  },
  // Codex app-server 0.144.6+ 支持 runtimeWorkspaceRoots + named permission
  // profiles；每 turn 覆盖 roots，因此会话中途增删可在下一 turn 生效。
  extraDirs: { supported: true },
};

// ── UserMessage → app-server UserInput[] ─────────────────────────────────────

function stripFileUrl(raw: string): string {
  return raw.startsWith('file://') ? raw.slice('file://'.length) : raw;
}

function basenameForMention(rawPath: string): string {
  const pathWithoutScheme = stripFileUrl(rawPath);
  // CodeQL flags regex-based separator trimming on user-controlled paths as a
  // potential slow-regex sink. Path mention labels only need simple separator
  // handling, so keep this branch deterministic and allocation-light.
  let end = pathWithoutScheme.length;
  while (end > 0 && isPathSeparator(pathWithoutScheme.charCodeAt(end - 1))) {
    end -= 1;
  }
  const trimmed = pathWithoutScheme.slice(0, end);
  const lastPosixSlash = trimmed.lastIndexOf('/');
  const lastWinSlash = trimmed.lastIndexOf('\\');
  const lastSlash = Math.max(lastPosixSlash, lastWinSlash);
  return (lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed) || trimmed || 'file';
}

function isPathSeparator(code: number): boolean {
  return code === 47 || code === 92; // '/' or '\'
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWindowsPath(rawPath: string): boolean {
  return (
    (
      rawPath.length >= 3 &&
      isAsciiLetter(rawPath.charCodeAt(0)) &&
      rawPath.charCodeAt(1) === 58 &&
      isPathSeparator(rawPath.charCodeAt(2))
    ) ||
    rawPath.startsWith('\\\\')
  );
}

function resolveMentionPath(rawPath: string, workingDir?: string): string {
  const stripped = stripFileUrl(rawPath);
  if (!workingDir) return stripped;
  if (isWindowsPath(stripped) || path.posix.isAbsolute(stripped)) return stripped;
  if (isWindowsPath(workingDir)) return path.win32.resolve(workingDir, stripped);
  if (path.posix.isAbsolute(workingDir)) return path.posix.resolve(workingDir, stripped);
  return path.resolve(workingDir, stripped);
}

function isToolMentionPath(mentionPath: string): boolean {
  return mentionPath.startsWith('app://') || mentionPath.startsWith('plugin://');
}

interface ReferencedPath {
  kind: 'file' | 'dir';
  label: string;
  path: string;
}

const FILES_MENTIONED_HEADER = '# Files mentioned by the user:';
const DIRECTORIES_MENTIONED_HEADER = '# Directories mentioned by the user:';
const USER_REQUEST_HEADER = '## My request for Codex:';

function referencedPathForBlock(
  rawPath: string,
  workingDir: string | undefined,
  kind: 'file' | 'dir' | 'agent' | undefined,
): ReferencedPath {
  const resolved = resolveMentionPath(rawPath, workingDir);
  return {
    kind: kind === 'dir' ? 'dir' : 'file',
    label: basenameForMention(resolved),
    path: resolved,
  };
}

function appendReferencedPathSection(lines: string[], header: string, refs: ReferencedPath[]): void {
  if (refs.length === 0) return;
  if (lines.length > 0) lines.push('');
  lines.push(header, '');
  for (const ref of refs) {
    lines.push(`## ${ref.label}: ${ref.path}`, '');
  }
  lines.pop();
}

function formatReferencedPathsForCodex(refs: ReferencedPath[], requestText: string): string {
  const lines: string[] = [];
  appendReferencedPathSection(lines, FILES_MENTIONED_HEADER, refs.filter((ref) => ref.kind === 'file'));
  appendReferencedPathSection(lines, DIRECTORIES_MENTIONED_HEADER, refs.filter((ref) => ref.kind === 'dir'));

  if (requestText.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(USER_REQUEST_HEADER, requestText);
  }

  return lines.join('\n');
}

/**
 * 把 UserMessage content 转成 codex app-server 的 UserInput 数组。
 *
 * Async 而非 sync —— LocalImage 的 path 会先经过 image-resizer 透明替换为缩好的
 * 缓存副本路径(命中走缓存近乎 0ms, miss 后台 sharp 处理 ~200-500ms), codex
 * Rust 端读到的就是缩好的文件, 显著节省 vision token。
 *
 * 远程 http(s):// 图片不动 (resizer 不抓远程图)。失败安全降级回原 path。
 */
export async function toAppServerInput(
  content: UserMessage['content'],
  workingDir?: string,
): Promise<UserInput[]> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  const resizer = getDefaultImageResizer();
  // 同 turn 多张本地图并发缩, semaphore 在 resizer 内部控并发上限
  const localImageJobs = new Map<number, Promise<string>>();
  content.forEach((block, idx) => {
    if (block.type !== 'image') return;
    const raw = block.path;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return;
    localImageJobs.set(idx, resizer.process(stripFileUrl(raw)));
  });
  const resizedPaths = new Map<number, string>();
  for (const [idx, p] of localImageJobs) {
    resizedPaths.set(idx, await p);
  }

  type PlannedInput = UserInput | { type: 'referencedPathsPreamble' } | { type: 'requestText'; text: string };
  const inputs: UserInput[] = [];
  const plannedInputs: PlannedInput[] = [];
  const referencedPaths: ReferencedPath[] = [];
  const requestTexts: string[] = [];
  let preambleInserted = false;

  const insertPreambleOnce = (): void => {
    if (preambleInserted) return;
    plannedInputs.push({ type: 'referencedPathsPreamble' });
    preambleInserted = true;
  };

  content.forEach((block, idx) => {
    if (block.type === 'text') {
      requestTexts.push(block.text);
      insertPreambleOnce();
      plannedInputs.push({ type: 'requestText', text: block.text });
    } else if (block.type === 'image') {
      // 协议两个变体 (v2.rs UserInput):
      //   - Image { url: string }       — 远程 http(s):// URL, server fetch
      //   - LocalImage { path: string } — 本地绝对路径, server 自己读 (path 不带 file:// 前缀!)
      // 桌面端附件 99% 是本地图, 走 LocalImage; 只在 path 是 http(s):// 时走 Image。
      const raw = block.path;
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        plannedInputs.push({ type: 'image', url: raw });
      } else {
        // 去掉可能带的 file:// 前缀, server 期望裸路径 (PathBuf)。
        // 优先用 resizer 缩好的副本, miss 时降级回原 path。
        const finalPath = resizedPaths.get(idx) ?? stripFileUrl(raw);
        plannedInputs.push({ type: 'localImage', path: finalPath });
      }
    } else if (block.type === 'file') {
      referencedPaths.push(referencedPathForBlock(block.path, workingDir, 'file'));
      insertPreambleOnce();
    } else if (block.type === 'mention') {
      if (!block.kind && isToolMentionPath(block.path)) {
        plannedInputs.push({ type: 'mention', name: block.name || basenameForMention(block.path), path: block.path });
      } else {
        referencedPaths.push(referencedPathForBlock(block.path, workingDir, block.kind));
        insertPreambleOnce();
      }
    }
  });
  if (referencedPaths.length > 0) {
    const preamble = formatReferencedPathsForCodex(referencedPaths, requestTexts.join('\n'));
    for (const item of plannedInputs) {
      if (item.type === 'referencedPathsPreamble') {
        inputs.push({ type: 'text', text: preamble });
      } else if (item.type === 'requestText') {
        // Text is already folded into the Desktop-style request section.
      } else {
        inputs.push(item);
      }
    }
  } else {
    for (const item of plannedInputs) {
      if (item.type === 'referencedPathsPreamble') {
        // No path references: keep the previous per-block text behavior below.
      } else if (item.type === 'requestText') {
        inputs.push({ type: 'text', text: item.text });
      } else {
        inputs.push(item);
      }
    }
  }
  if (inputs.length === 0) inputs.push({ type: 'text', text: '' });
  return inputs;
}

// ── Agent 实现 ────────────────────────────────────────────────────────────────

export class CodexAgent extends BaseAgent {
  readonly kind = 'codex' as const;
  readonly capabilities: Capabilities;

  /**
   * Hosts keyed by target — `'local'` 或 `remote:<remoteHostId>`。每个 target
   * 一个 AppServerHost (= 一个 codex app-server, 本地 spawn / 远端 daemon-bridged
   * 都对应自己的)。
   *
   * 为什么不是单 host: 用户可能同时开本地 session 和 ssh 远端 session, 两条路
   * 走不同 transport (StdioTransport vs SshDaemonTransport), 没法共用一个 host。
   * "1 agent N host" 是 codex 端做不到 "1 server N transport" 的必然后果。
   */
  private hosts = new Map<string, AppServerHost>();

  /**
   * getHost() 的 in-flight Promise 去重, per target — 创建过程含 3 个 await
   * (auth.getState / buildCodexEnv / prepareCodexExtraSpawnConfig), 不去重则
   * 启动期间并发 (skillHubScanner / startSession / IPC list) 各看到 hosts.get(...)=undefined,
   * 各自 spawn 一个 codex app-server 子进程, 第二个会覆盖 hosts.set(...), 第一个变孤儿。
   */
  private hostPromises = new Map<string, {
    promise: Promise<AppServerHost>;
    credentialMode: AgentCredentialMode | undefined;
    credentialModeResolved: boolean;
    generation: number;
  }>();

  /**
   * 本地 app-server 的 spawn-time 凭证形态(超集归一化后的实际 spawn 形态)。
   *
   * 方案 A(2026-07)后的复用语义:oauth-bearer spawn 是「订阅超集 host」——proxy 按
   * 请求/会话换网关 key,gateway-key 会话可直接复用它(见 canReuseCodexHostForCredentialMode),
   * 订阅与 API 会话得以并行,不再因来源切换重建 host。反向仍然重建:env-key spawn 的
   * 进程服务不了订阅会话。createHost 对本地 gateway-key 诉求做超集归一化(有 OAuth 时
   * 升格为 oauth-bearer spawn),登记的就是归一化后的形态。
   */
  private hostCredentialModes = new Map<string, AgentCredentialMode | undefined>();
  /**
   * createHost 时从(本来就要做的)auth.getState 推出的归一化凭证形态。
   * hostCredentialModes 登记实际 spawn 形态 —— getHost 快路径对实际形态与诉求
   * 做逐字比较(implicit-implicit / 同显式),零 IO;本表只在快路径
   * 不等、需要跨形态仲裁时参与 canReuseCodexHostForCredentialMode 比较(review P2:
   * 归一化解析含 fs,不允许进无条件路径)。
   */
  private hostEffectiveCredentialModes = new Map<string, AgentCredentialMode | undefined>();

  /**
   * target host 的生命周期版本。只在 agent 主动替换/销毁 host 时递增。
   * transport error 的同对象自愈不递增,保留现有 session 内恢复能力。
   */
  private hostGenerations = new Map<string, number>();

  /**
   * createHost 调用计数 —— 按 host key 诊断 in-flight 去重是否生效。
   * 正常每个 host key 的生命周期内每次 dispose 之间应该恰好 +1; 出现 >1 说明 hostPromise 去重失效
   * (旧 bug: 会 spawn 多个 codex app-server 子进程, 前面的变孤儿)。
   */
  private createHostSeqByKey = new Map<string, number>();

  /**
   * thread/start|resume 已开始但尚未 subscribeThread 的会话绑定计数。
   *
   * activeSubscriptions 只能覆盖已订阅的 session;这个 lease 补上 thread 创建成功到订阅
   * 建立前的短窗口,避免 credential switch 在中途 retire host 造成新会话 stale。
   */
  private hostSessionBindingLeases = new Map<string, number>();

  /**
   * 本地 host 凭证形态切换锁。
   *
   * 切换期间旧 host 还在 map 里,但已经进入 draining 状态;同 key 的新 getHost 必须先等
   * 当前切换完成,不能继续把新 session 挂到即将 retire 的旧 host 上。
   */
  private hostCredentialModeSwitches = new Map<string, Promise<void>>();

  /**
   * app-server 启动时返回的 $CODEX_HOME 绝对路径 (InitializeResponse.codexHome)。
   * 用来推 codex 自家 memory 数据目录 (<CODEX_HOME>/memories/), 进而把它加进 turn/start
   * 的 sandboxPolicy.workspaceWrite.writableRoots, 让 codex 内置 MemoryTool 写
   * memory_summary.md / MEMORY.md 时不被 "writing outside of the project" 预检拦掉。
   *
   * 启动时由 ensureStarted() 返回值填; dispose 后清零, 下次 host 重建再填。
   */
  private codexHome: string | null = null;

  /**
   * 各 app-server host 已 push 的 memoryOverride 值。
   *
   * memoryOverride 是 host 端的意图, app-server 是另一个进程, 不会自动同步; 必须主动
   * RPC (experimentalFeature/enablement/set) 推过去。本字段按 host key 记录
   * "上次 push 的值是什么", 让 ensureMemoryOverridePushed 可以判断 "需不需要再 push"。
   *
   * 重置时机:
   *  - host 重建/dispose: server 重启会丢内存 enablement, 清掉对应 key 让下次 ensure 再 push
   *  - setMemory 后立即 RPC 同步所有 live host; 无 live host 时在下一次 startSession ensure 时补齐
   */
  private memoryOverridePushedByHost = new Map<string, boolean | undefined>();
  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(CAPABILITIES);
  }

  /**
   * Agent 内置 command —— 见 ./commands.ts。当前 codex 白名单为空,
   * 内置 slash 全走 app-server skills/list 归 'agent-skill' 类目。
   */
  override listAgentCommands(): AgentBuiltinCommand[] {
    return CODEX_AGENT_COMMANDS;
  }

  /**
   * Skill 扫描 —— 与老 listSlashCommands 共享同一套 listSkillsForCwd / 未授权静默处理,
   * 只是包成新的 AgentSkillCommand 形状(kind='agent-skill')。
   */
  override async listAgentSkills(opts: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    // Codex app-server 的 skills/list 强制要求 cwd；无项目的新对话用 HOME 作为
    // 查询上下文，既能发现全局 skills，又不会误带任意项目的 repo skills。
    const workingDir = opts.workingDir || os.homedir();
    try {
      const { skills, errors } = await this.listSkillsForCwd(workingDir, opts.forceReload ?? false);
      const out: ListAgentSkillsResult = {
        skills: skills
          .filter(isPaletteVisibleCodexSkill)
          .map((skill) => ({
            kind: 'agent-skill' as const,
            name: skill.name,
            description: skillDescription(skill),
            source: 'skill' as const,
            path: skill.path,
            scope: skill.scope,
            enabled: skill.enabled,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      if (errors.length > 0) out.errors = errors;
      return out;
    } catch (err) {
      if (err instanceof AgentNotAuthenticatedError) {
        return { skills: [] };
      }
      throw err;
    }
  }

  /**
   * Codex customization 入口 —— 纯文件系统扫描，不触发 app-server。
   *
   * 扫描 ~/.agents/skills/ + ~/.codex/skills/ + project skill dirs。
   * 用于 SkillHub 管理页面（快速发现磁盘上的 skill）。
   * 运行时技能列表（command palette）走 listAgentSkills → RPC，不受影响。
   */
  async listCustomizations(opts: ListCustomizationsOptions): Promise<ListCustomizationsResult> {
    return scanCodexCustomizations(opts);
  }

  private async listSkillsForCwd(
    workingDir: string,
    forceReload: boolean,
  ): Promise<{ skills: SkillMetadata[]; errors: Array<{ path?: string; message: string }> }> {
    const { host } = await this.getUtilityHost();
    const response = await host.request<SkillsListResponse>(Method.SkillsList, {
      cwds: [workingDir],
      forceReload,
      perCwdExtraUserRoots: null,
    });
    const entry = response.data.find((item) => item.cwd === workingDir) ?? response.data[0];
    return {
      skills: entry?.skills ?? [],
      errors: (entry?.errors ?? []).map((err) => ({ path: err.path, message: err.message })),
    };
  }

  /**
   * 懒创建 host (但 spawn 由 ensureStarted 触发)。
   *
   * **Auth gate**: 第一次创建前先 `auth.getState()`,未授权直接抛
   * `AgentNotAuthenticatedError` — 不让 codex app-server 子进程在 "未登录" 状态下
   * 起来 (起来后 auth.json 即使写好也读不到,会导致首 turn 401)。
   *
   * 复合检查: 已经有 host 时不重复 getState — host 存在即说明之前授权过且 dispose
   * 钩子还没触发(logout 时会 dispose 清掉)。这样热路径 (每次 send) 不会多一次 fs 读。
   */
  private canReuseHostCredentialMode(
    currentMode: AgentCredentialMode | undefined,
    requestedMode: AgentCredentialMode | undefined,
  ): boolean {
    // 语义在 credential-mode.ts:两侧都是归一化后的形态,同族即复用;codex 额外放宽
    // 「oauth-bearer 超集 host 服务 gateway-key 会话」(方案 A,proxy 按请求换网关 key)。
    // 解析不出形态(undefined)保持保守语义要求重建,不把意图不明的会话挂到显式凭证进程上。
    return canReuseCodexHostForCredentialMode(currentMode, requestedMode);
  }

  private canReuseHostForCredentialRequest(
    host: AppServerHost,
    currentMode: AgentCredentialMode | undefined,
    requestedMode: AgentCredentialMode | undefined,
  ): boolean {
    if (!this.canReuseHostCredentialMode(currentMode, requestedMode)) return false;
    // provider-oauth(如 xAI)的真实鉴权和 model rewrite 都在 loopback proxy 内完成。
    // 如果当前 host 是 proxy 不可用时退化启动的直连 gateway host, family 虽然可复用,
    // 但请求会绕过 proxy 而误路由;必须重建或由 active-session gate fail closed。
    if (requestedMode === 'provider-oauth' && !host.isCodexProxyActive()) return false;
    // 超集复用(oauth-bearer host 承载 gateway-key 会话)同样硬依赖 proxy:换网关 key
    // 发生在 proxy 路由层,退化直连的 oauth host 上 key 会话会带 OAuth token 直打网关 → 401。
    if (
      requestedMode === 'gateway-key' &&
      currentMode === 'oauth-bearer' &&
      !host.isCodexProxyActive()
    ) return false;
    return true;
  }

  /**
   * oauth 超集 host 复用 gateway-key 诉求前，单独验证网关凭证仍然可用。
   * host 自己通过 OAuth auth gate 只能证明订阅身份有效，不能替代 API Key 校验；
   * 否则缺 key 的 XD 会话会被错误挂载，直到首个请求才以 401 失败。
   */
  private async assertSupersetRequestedCredentialAvailable(
    currentMode: AgentCredentialMode | undefined,
    requestedMode: AgentCredentialMode | undefined,
  ): Promise<void> {
    if (currentMode !== 'oauth-bearer' || requestedMode !== 'gateway-key') return;
    const state = await this.deps.auth.getState({ credentialMode: 'gateway-key' });
    if (!state.authenticated) {
      throw new AgentNotAuthenticatedError(
        'codex',
        `codex gateway credentials unavailable: ${state.errorReason ?? 'no_credentials'}`,
      );
    }
  }

  /**
   * 归一化本地会话的凭证形态:显式指定原样返回;未指定(providerId=null 的会话)则读
   * auth fallback 的 authSource 推出它实际会用的钥匙形态。返回值只用于 host 复用比较
   * 与登记,**不**改变 spawn 时传给 adapter 的 authOptions(spawn 行为字节级不变)。
   */
  private async resolveEffectiveLocalCredentialMode(
    requested: AgentCredentialMode | undefined,
  ): Promise<AgentCredentialMode | undefined> {
    if (requested) return requested;
    try {
      const state = await this.deps.auth.getState();
      const resolved = resolveEffectiveCredentialModeFromAuthSource(undefined, state.authSource);
      if (resolved) {
        // 只在跨形态仲裁时才会走到这里(懒解析),频率低;debug 级避免刷日志。
        this.deps.logger.debug('codex getHost: implicit credential mode resolved from auth fallback', {
          authSource: state.authSource,
          resolved,
        });
      } else {
        this.deps.logger.warn('codex getHost: implicit credential mode unresolved; keeping legacy strict comparison', {
          authenticated: state.authenticated,
          errorReason: state.errorReason,
        });
      }
      return resolved;
    } catch (error) {
      this.deps.logger.warn('codex getHost: implicit credential mode resolution failed; keeping legacy strict comparison', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private bumpHostGeneration(key: string): number {
    const next = (this.hostGenerations.get(key) ?? 0) + 1;
    this.hostGenerations.set(key, next);
    return next;
  }

  private acquireHostSessionBindingLease(key: string): () => void {
    this.hostSessionBindingLeases.set(key, (this.hostSessionBindingLeases.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.hostSessionBindingLeases.get(key) ?? 1) - 1;
      if (next <= 0) this.hostSessionBindingLeases.delete(key);
      else this.hostSessionBindingLeases.set(key, next);
    };
  }

  private hostActiveUseCount(
    key: string,
    host: AppServerHost,
    opts: { ignoreBindingLeases?: number } = {},
  ): number {
    const bindingLeases = Math.max(
      0,
      (this.hostSessionBindingLeases.get(key) ?? 0) - (opts.ignoreBindingLeases ?? 0),
    );
    return host.activeSubscriptions + bindingLeases;
  }

  private async shutdownHostForCredentialModeChange(
    key: string,
    host: AppServerHost,
    fromMode: AgentCredentialMode | undefined,
    toMode: AgentCredentialMode | undefined,
    opts: { ignoreBindingLeases?: number } = {},
  ): Promise<void> {
    while (true) {
      const previous = this.hostCredentialModeSwitches.get(key);
      if (!previous) break;
      await previous.catch(() => undefined);
    }
    const run = this.shutdownHostForCredentialModeChangeUnlocked(key, host, fromMode, toMode, opts);
    this.hostCredentialModeSwitches.set(key, run);
    try {
      await run;
    } finally {
      if (this.hostCredentialModeSwitches.get(key) === run) {
        this.hostCredentialModeSwitches.delete(key);
      }
    }
  }

  private async waitForHostCredentialModeSwitch(key: string): Promise<void> {
    while (true) {
      const switching = this.hostCredentialModeSwitches.get(key);
      if (!switching) return;
      await switching.catch(() => undefined);
    }
  }

  async beginLocalHostCredentialChange(
    reason = 'CodexAgent local credential state changed',
  ): Promise<{
    assertIdle(): void;
    finalize(): Promise<void>;
    release(): void;
  }> {
    const key = hostKey();
    await this.waitForHostCredentialModeSwitch(key);

    let releaseSwitch!: () => void;
    const switchPromise = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    this.hostCredentialModeSwitches.set(key, switchPromise);
    let released = false;

    const cleanup = (): void => {
      if (released) return;
      released = true;
      if (this.hostCredentialModeSwitches.get(key) === switchPromise) {
        this.hostCredentialModeSwitches.delete(key);
      }
      releaseSwitch();
    };

    const activeUseCount = (): number => {
      const host = this.hosts.get(key);
      return host
        ? this.hostActiveUseCount(key, host)
        : (this.hostSessionBindingLeases.get(key) ?? 0);
    };

    return {
      assertIdle: () => {
        const count = activeUseCount();
        if (count > 0) {
          throw new Error(
            `Cannot restart local Codex host while ${count} active Codex session(s) are attached`,
          );
        }
      },
      finalize: async () => {
        if (released) return;
        try {
          await this.disposeLocalHostForCredentialChangeUnlocked(key, reason);
        } finally {
          cleanup();
        }
      },
      release: cleanup,
    };
  }

  private async shutdownHostForCredentialModeChangeUnlocked(
    key: string,
    host: AppServerHost,
    fromMode: AgentCredentialMode | undefined,
    toMode: AgentCredentialMode | undefined,
    opts: { ignoreBindingLeases?: number } = {},
  ): Promise<void> {
    if (this.hosts.get(key) !== host) return;
    const currentMode = this.hostCredentialModes.get(key);
    // 仲裁用归一化形态(登记于 createHost,零额外 IO);缺失时回退原始形态。
    const currentEffective = this.hostEffectiveCredentialModes.get(key) ?? currentMode;
    if (this.canReuseHostForCredentialRequest(host, currentEffective, toMode)) return;

    let activeUseCount = this.hostActiveUseCount(key, host, opts);
    const coordinator = this.deps.prepareCodexLocalCredentialModeSwitch;
    if (coordinator) {
      await coordinator({
        fromMode: currentMode,
        fromModeEffective: currentEffective,
        toMode,
        activeSubscriptions: activeUseCount,
      });
      if (this.hosts.get(key) !== host) return;
      activeUseCount = this.hostActiveUseCount(key, host, opts);
      if (activeUseCount > 0) {
        throw new Error(
          `Cannot switch Codex credential mode; active Codex session(s) still attached after coordination: ${activeUseCount}`,
        );
      }
    } else if (activeUseCount > 0) {
      throw new Error(
        `Cannot switch Codex credential mode while ${activeUseCount} active Codex session(s) are attached`,
      );
    }

    this.deps.logger.info('codex createHost: credential mode changed, restarting local app-server', {
      key,
      fromMode: currentMode ?? fromMode ?? 'fallback',
      fromModeEffective: currentEffective ?? 'unresolved',
      toMode: toMode ?? 'fallback',
    });
    this.hosts.delete(key);
    this.hostCredentialModes.delete(key);
    this.hostEffectiveCredentialModes.delete(key);
    this.memoryOverridePushedByHost.delete(key);
    this.bumpHostGeneration(key);
    if (key === hostKey()) this.codexHome = null;
    this.createHostSeqByKey.delete(key);
    try {
      await host.retire('CodexAgent credential mode changed');
    } catch (error) {
      this.deps.logger.warn('codex host shutdown after credential mode change failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getHost(
    remoteHostId?: string,
    credentialMode?: AgentCredentialMode,
    opts: {
      ignoreBindingLeases?: number;
      keyOverride?: string;
      hostPurpose?: 'control-plane';
    } = {},
  ): Promise<AppServerHost> {
    const key = opts.keyOverride ?? hostKey(remoteHostId);
    // spawnMode = 调用方原始诉求(undefined 保持 adapter fallback,spawn 行为不变)。
    // 复用判定分两级(review P2:归一化解析走 getState、含 reconcile/fs,不允许进
    // 无条件路径):
    //   快路径:原始诉求与登记的原始形态逐字相等(implicit-implicit / 同显式)→
    //           直接复用,零 IO,与本次改动前的行为完全一致;
    //   仲裁路径:快路径不等时,才把隐式诉求懒解析成归一化形态(同一次 getHost 内
    //           memo,显式诉求无需解析),与登记的归一化形态(createHost 时零额外
    //           IO 推出)做 canReuseCodexHostForCredentialMode 同族比较。
    const spawnMode = remoteHostId ? undefined : credentialMode;
    let requestedEffectiveMemo: { value: AgentCredentialMode | undefined } | null =
      remoteHostId || credentialMode ? { value: spawnMode } : null;
    const resolveRequestedEffective = async (): Promise<AgentCredentialMode | undefined> => {
      if (!requestedEffectiveMemo) {
        requestedEffectiveMemo = { value: await this.resolveEffectiveLocalCredentialMode(undefined) };
      }
      return requestedEffectiveMemo.value;
    };
    const canReuseRegistered = async (
      host: AppServerHost,
      registeredRaw: AgentCredentialMode | undefined,
      registeredEffective: AgentCredentialMode | undefined,
    ): Promise<boolean> => {
      if (registeredRaw === spawnMode) {
        return spawnMode !== 'provider-oauth' || host.isCodexProxyActive();
      }
      const requested = await resolveRequestedEffective();
      const current = registeredEffective ?? registeredRaw;
      if (!this.canReuseHostForCredentialRequest(host, current, requested)) return false;
      await this.assertSupersetRequestedCredentialAvailable(current, requested);
      return true;
    };
    while (true) {
      if (!remoteHostId) await this.waitForHostCredentialModeSwitch(key);

      const existing = this.hosts.get(key);
      if (existing) {
        const currentMode = this.hostCredentialModes.get(key);
        const currentEffective = this.hostEffectiveCredentialModes.get(key);
        if (remoteHostId || (await canReuseRegistered(existing, currentMode, currentEffective))) {
          return existing;
        }
        await this.shutdownHostForCredentialModeChange(
          key,
          existing,
          currentMode,
          await resolveRequestedEffective(),
          opts,
        );
        continue;
      }

      const inflight = this.hostPromises.get(key);
      if (inflight) {
        // inflight 的归一化形态要等 createHost 内 getState 完成才知道,这里按
        // undefined(保守)参与仲裁:跨形态请求会走重建,与改动前语义一致。
        // in-flight host 还不知道 codexProxyActive。provider-oauth 只复用同为 provider-oauth
        // 的 in-flight host(该路径 proxy 不可用会 fatal reject);不挂到 gateway/oauth 启动中的
        // host 上,避免它最终退化成 non-proxy 直连进程。
        const mayReuseInflight = !(spawnMode === 'provider-oauth' && inflight.credentialMode !== 'provider-oauth');
        // gateway-key 冷启动可能在 createHost 内升格成 oauth-bearer。若并发的订阅
        // 会话恰好在 auth fallback 尚未返回时进来，先等同一个 in-flight host 定型，
        // 再按注册后的实际形态仲裁；不能提前 supersede，避免无意义双 spawn。
        const mayResolveAsOauthSuperset =
          !inflight.credentialModeResolved &&
          spawnMode === 'oauth-bearer' &&
          inflight.credentialMode === 'gateway-key';
        if (remoteHostId || mayResolveAsOauthSuperset || (mayReuseInflight && (
          inflight.credentialMode === spawnMode ||
          this.canReuseHostCredentialMode(inflight.credentialMode, await resolveRequestedEffective())
        ))) {
          if (remoteHostId) return inflight.promise;
          let inflightHost: AppServerHost;
          try {
            inflightHost = await inflight.promise;
          } catch (error) {
            if (!mayResolveAsOauthSuperset) throw error;
            // 订阅请求只是在等待 gateway-key 冷启动完成凭据校验、确认它是否会
            // 升格成 OAuth 超集 host；若该校验自身失败(缺 key / key 过期),不能把
            // gateway 的失败传染给凭据有效的订阅会话。failed promise 的 finally
            // 已清掉 hostPromises，重新仲裁会独立创建 oauth-bearer host。
            this.deps.logger.warn('codex getHost: unresolved gateway inflight failed; retrying OAuth host independently', {
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          const registeredRaw = this.hostCredentialModes.get(key) ?? inflight.credentialMode;
          const registeredEffective = this.hostEffectiveCredentialModes.get(key);
          if (await canReuseRegistered(inflightHost, registeredRaw, registeredEffective)) {
            return inflightHost;
          }
          continue;
        }
        const requestedEffective = await resolveRequestedEffective();
        const currentInflight = this.hostPromises.get(key);
        if (currentInflight?.promise === inflight.promise) {
          this.hostPromises.delete(key);
        }
        inflight.promise.then(
          async (inflightHost) => {
            if (this.hosts.get(key) === inflightHost) {
              await this.shutdownHostForCredentialModeChange(
                key,
                inflightHost,
                inflight.credentialMode,
                requestedEffective,
                opts,
              );
              return;
            }
            await inflightHost.retire('CodexAgent credential mode changed while host was starting');
          },
          () => undefined,
        ).catch(() => undefined);
      }

      const generation = this.bumpHostGeneration(key);
      // 超集归一化发生在 createHost 内(gateway-key → oauth-bearer);通过回调同步
      // in-flight 登记,让并发的 oauth-bearer 诉求命中复用而不是 supersede 重建。
      let inflightEntry: {
        promise: Promise<AppServerHost>;
        credentialMode: AgentCredentialMode | undefined;
        credentialModeResolved: boolean;
        generation: number;
      } | null = null;
      const promise = this.createHost(
        remoteHostId,
        key,
        spawnMode,
        generation,
        (resolvedMode) => {
          if (inflightEntry) {
            inflightEntry.credentialMode = resolvedMode;
            inflightEntry.credentialModeResolved = true;
          }
        },
        opts.hostPurpose,
      ).finally(() => {
        // 成功: this.hosts 已赋值, 后续走快路径; 失败: 清掉 promise 让下次调用能重试
        const current = this.hostPromises.get(key);
        if (current?.promise === promise) this.hostPromises.delete(key);
      });
      inflightEntry = {
        promise,
        credentialMode: spawnMode,
        credentialModeResolved: remoteHostId !== undefined || spawnMode !== 'gateway-key',
        generation,
      };
      this.hostPromises.set(key, inflightEntry);
      return promise;
    }
  }

  private async getUtilityHost(): Promise<{ key: string; host: AppServerHost }> {
    const key = hostKey();
    await this.waitForHostCredentialModeSwitch(key);
    const existing = this.hosts.get(key);
    if (existing) return { key, host: existing };
    const inflight = this.hostPromises.get(key);
    if (inflight) return { key, host: await inflight.promise };
    const host = await this.getHost();
    return { key, host };
  }

  /** Start the local OAuth host used by non-model account control-plane RPCs. */
  private async getStartedAccountHost(): Promise<AppServerHost> {
    const host = await this.getHost(undefined, 'oauth-bearer');
    const init = await host.ensureStarted();
    if (init.codexHome) this.codexHome = init.codexHome;
    return host;
  }

  /**
   * 向本地 app-server 实时读取完整模型清单并交给宿主。
   *
   * 不能只读 `models_cache.json`：OAuth 登录前会按账号边界删掉旧 cache，而登录 CLI
   * 成功时未必已经触发模型注册表刷新。`model/list` 是官方 app-server 的权威读取面，
   * 同时也是 cache ready barrier；分页全部读完后才一次性交给宿主，避免 UI 看到半份目录。
   */
  override async refreshLocalModels(options?: RefreshLocalModelsOptions): Promise<boolean> {
    const credentialMode = options?.credentialMode;
    if (!credentialMode) return this.refreshLocalModelsWithinDeadline(options);

    const key = localControlPlaneHostKey(credentialMode);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AppServerRequestTimeoutError('model refresh', CODEX_MODEL_REFRESH_DEADLINE_MS));
      }, CODEX_MODEL_REFRESH_DEADLINE_MS);
    });
    try {
      return await Promise.race([
        this.refreshLocalModelsWithinDeadline(options),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof AppServerRequestTimeoutError) {
        await this.retireHostKey(key, 'Codex control-plane model refresh timed out', {
          failIfActive: false,
          logPrefix: 'codex model refresh',
        });
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async refreshLocalModelsWithinDeadline(
    options?: RefreshLocalModelsOptions,
  ): Promise<boolean> {
    const credentialMode = options?.credentialMode;
    // 显式 provider 刷新使用独立 control-plane app-server。不能为了发一次 model/list
    // 切换共享 local host 的凭证形态：切换协调器会关闭空闲会话，忙碌会话则直接拒绝。
    const key = credentialMode
      ? localControlPlaneHostKey(credentialMode)
      : hostKey();
    const host = credentialMode
      ? await this.getHost(undefined, credentialMode, {
        keyOverride: key,
        hostPurpose: 'control-plane',
      })
      : (await this.getUtilityHost()).host;
    const init = await host.ensureStarted();
    if (init.codexHome) this.codexHome = init.codexHome;

    const models: CodexModelListResponse['data'] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        const page: CodexModelListResponse = await host.request<CodexModelListResponse>(
          Method.ModelList,
          {
            cursor,
            limit: 100,
            includeHidden: false,
          },
          { timeoutMs: CODEX_MODEL_LIST_RPC_TIMEOUT_MS },
        );
        models.push(...(Array.isArray(page.data) ? page.data : []));
        const next: string | null = typeof page.nextCursor === 'string' && page.nextCursor.length > 0
          ? page.nextCursor
          : null;
        if (next && seenCursors.has(next)) {
          throw new Error(`Codex app-server model/list repeated cursor: ${next}`);
        }
        if (next) seenCursors.add(next);
        cursor = next;
      } while (cursor !== null);
    } catch (error) {
      if (credentialMode && error instanceof AppServerRequestTimeoutError) {
        await this.retireHostKey(key, 'Codex control-plane model/list timed out', {
          failIfActive: false,
          logPrefix: 'codex model list refresh',
        });
      }
      throw error;
    }

    // Auth 切换 / logout 可能在分页请求期间 retire 旧 host。旧账号的迟到响应绝不能
    // 覆盖新账号目录；只有仍登记为当前 local host 的结果才允许交给宿主。
    if (this.hosts.get(key) !== host || !this.deps.onCodexLocalModelsListed) return false;
    await this.deps.onCodexLocalModelsListed(models);
    return true;
  }

  /** Read ChatGPT subscription windows and banked reset credits via app-server RPC. */
  override async readAccountRateLimits(): Promise<AccountRateLimitsResponse> {
    // This RPC is credential-specific, unlike model/list or memory utilities. Requiring
    // oauth-bearer prevents a gateway/provider host from reading or mutating the wrong
    // account context; getHost refuses to replace a differently-authenticated active host.
    const host = await this.getStartedAccountHost();
    return await host.request<AccountRateLimitsResponse>(Method.AccountRateLimitsRead, undefined);
  }

  /** Consume one reset credit on the non-model app-server control plane. */
  override async consumeAccountRateLimitResetCredit(
    params: ConsumeAccountRateLimitResetCreditParams,
  ): Promise<ConsumeAccountRateLimitResetCreditResponse> {
    const host = await this.getStartedAccountHost();
    return await host.request<ConsumeAccountRateLimitResetCreditResponse>(
      Method.AccountRateLimitResetCreditConsume,
      params,
    );
  }

  private async createHost(
    remoteHostId: string | undefined,
    key: string,
    credentialMode: AgentCredentialMode | undefined,
    generation: number,
    onSpawnCredentialModeResolved?: (mode: AgentCredentialMode | undefined) => void,
    hostPurpose?: 'control-plane',
  ): Promise<AppServerHost> {
    const seq = (this.createHostSeqByKey.get(key) ?? 0) + 1;
    this.createHostSeqByKey.set(key, seq);
    // 诊断日志: 正常每次 dispose 之间 seq 只应该出现一次。出现 seq>=2 或 hadHost=true
    // = in-flight 去重失效, 多个 codex app-server 子进程被 spawn, 前面的会变孤儿。
    // 正常路径走 info, 异常路径才升级到 error, 避免首次启动刷 ERROR 误导排查。
    const hadHost = this.hosts.has(key);
    const abnormal = seq > 1 || hadHost;
    const level = abnormal ? 'error' : 'info';
    this.deps.logger[level]('codex createHost: spawning app-server', {
      seq,
      hadHost,
      key,
      credentialMode: credentialMode ?? 'fallback',
      generation,
    });
    const assertCurrentGeneration = (stage: string): void => {
      if ((this.hostGenerations.get(key) ?? 0) === generation) return;
      throw new Error(`Codex app-server host creation was superseded before ${stage}`);
    };
    // 方案 A(订阅超集 spawn):本地 gateway-key 诉求且 auth fallback 实际持有 OAuth 时,
    // 升格为 oauth-bearer spawn。超集进程经 proxy 按会话换网关 key(XD/折扣计费不变),
    // 同时还能服务订阅会话 —— 订阅/API 会话真正并行,不再因来源切换重建 host 排队。
    let spawnCredentialMode = credentialMode;
    let requestedGatewayState: AuthState | null = null;
    if (!remoteHostId && credentialMode === 'gateway-key') {
      // 即使升格为 OAuth spawn,API 会话的出口仍依赖 gateway key,必须先验证原诉求。
      requestedGatewayState = await this.deps.auth.getState({ credentialMode: 'gateway-key' });
      assertCurrentGeneration('gateway credential validation');
      if (!requestedGatewayState.authenticated) {
        throw new AgentNotAuthenticatedError(
          'codex',
          `codex gateway credentials unavailable: ${requestedGatewayState.errorReason ?? 'no_credentials'}`,
        );
      }
      try {
        const fallbackState = await this.deps.auth.getState();
        if (fallbackState.authenticated && fallbackState.authSource === 'oauth') {
          spawnCredentialMode = 'oauth-bearer';
          this.deps.logger.info('codex createHost: upgrading gateway-key spawn to oauth superset host', { key });
        }
      } catch (error) {
        this.deps.logger.warn('codex createHost: superset spawn resolution failed; keeping gateway-key spawn', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      assertCurrentGeneration('superset spawn resolution');
    }

    // 超集升格硬依赖 proxy。proxy 不可用时降级回原 gateway-key spawn 重来一轮;
    // 降级后 upgraded=false,循环至多跑两轮必收敛。
    let effectiveMode: AgentCredentialMode | undefined;
    let env: Record<string, string> = {};
    let extraArgs: string[] = [];
    let codexProxyActive = false;
    let remoteCompactionProviderId: string | undefined;
    for (;;) {
      const upgradedToSuperset = spawnCredentialMode !== credentialMode;
      onSpawnCredentialModeResolved?.(spawnCredentialMode);
      const authOptions = spawnCredentialMode ? { credentialMode: spawnCredentialMode } : undefined;
      const state =
        spawnCredentialMode === 'gateway-key' && requestedGatewayState
          ? requestedGatewayState
          : await this.deps.auth.getState(authOptions);
      assertCurrentGeneration('auth');
      if (!state.authenticated) {
        throw new AgentNotAuthenticatedError('codex', `codex not authenticated: ${state.errorReason ?? 'no_credentials'}`);
      }
      effectiveMode =
        spawnCredentialMode ?? resolveEffectiveCredentialModeFromAuthSource(undefined, state.authSource);
      env = await buildCodexEnv(this.deps.auth, this.deps.runtimeConfig, authOptions);
      assertCurrentGeneration('env');

      extraArgs = [];
      codexProxyActive = false;
      remoteCompactionProviderId = undefined;
      if (this.deps.prepareCodexExtraSpawnConfig) {
        try {
          const cfg = await this.deps.prepareCodexExtraSpawnConfig(
            this.deps.mcpProviders ?? [],
            {
              remoteHostId,
              credentialMode: spawnCredentialMode,
              ...(hostPurpose ? { hostPurpose } : {}),
            },
          );
          assertCurrentGeneration('spawn config');
          Object.assign(env, cfg.extraEnv);
          extraArgs = cfg.extraArgs;
          codexProxyActive = cfg.codexProxyActive === true && !remoteHostId;
          // OpenAI 身份 provider 依赖 loopback proxy 路由订阅直连;proxy 不可用
          // (退化直连网关)时不得下发,否则远端压缩请求会打到不支持它的上游。
          if (codexProxyActive && cfg.codexRemoteCompactionProviderId) {
            remoteCompactionProviderId = cfg.codexRemoteCompactionProviderId;
          }
          this.deps.logger.info('codex MCP bridge ready', {
            providers: this.deps.mcpProviders?.length ?? 0,
            extraArgsCount: extraArgs.length,
            codexProxyActive,
          });
        } catch (e) {
          const isFatalSpawnConfigError =
            (typeof e === 'object' && e !== null &&
              (e as { codexSpawnConfigFatal?: unknown }).codexSpawnConfigFatal === true);
          if (isFatalSpawnConfigError && upgradedToSuperset) {
            this.deps.logger.warn('codex createHost: superset spawn hit fatal proxy error; downgrading to gateway-key spawn', {
              key,
              message: (e as Error).message,
            });
            spawnCredentialMode = credentialMode;
            continue;
          }
          this.deps.logger.error(
            isFatalSpawnConfigError
              ? 'codex MCP bridge prep failed with fatal spawn config error'
              : 'codex MCP bridge prep failed, continuing without lizi MCP',
            { message: (e as Error).message },
          );
          if (isFatalSpawnConfigError) throw e;
        }
      }
      if (upgradedToSuperset && !codexProxyActive) {
        this.deps.logger.warn('codex createHost: superset spawn lacks loopback proxy; downgrading to gateway-key spawn', { key });
        spawnCredentialMode = credentialMode;
        continue;
      }
      break;
    }
    assertCurrentGeneration('transport');

    // 选 transport: 本地 → StdioTransport (spawn codex app-server)
    //               远端 → host 注入的 getRemoteCodexTransport (SSH+daemon+proxy+ws)
    // 注意: 远端路径下 env/extraArgs/buildCodexEnv 不参与 — 远端 daemon 由远端
    // isolated CODEX_HOME 的配置驱动, 我们走 daemon control socket 拿到的协议
    // channel, 不在本地起进程, 所以本地的 env / -c overrides 没有意义。MCP 桥接
    // 改由 desktop 侧在 session start 前置完成 (remote-ssh/codex-remote-mcp.ts):
    // 往远端 config.toml 写 mcp_servers 段, daemon 经 SSH remote-forward 直连
    // 本机 HTTP bridge, tool call 按 params._meta.threadId 路由(与本地一致)。
    let createTransport: () => import('./app-server/transport.js').Transport;
    if (remoteHostId) {
      if (!this.deps.getRemoteCodexTransport) {
        throw new Error(
          `codex remote session requested (remoteHostId=${remoteHostId}) but host did not provide getRemoteCodexTransport`,
        );
      }
      const provider = this.deps.getRemoteCodexTransport;
      createTransport = () => provider(remoteHostId);
    } else {
      const binaryPath = this.deps.binaryPath;
      createTransport = () => createStdioTransport({
        binaryPath,
        env,
        extraArgs,
      });
    }

    const host = new AppServerHost({
      createTransport,
      logger: this.deps.logger,
      // 自报名只进 codex app-server 的 userAgent 展示串,无门控消费
      // (2026-07-17 随品牌翻转改 cindy;上游 gating 走 originator,与此无关)。
      clientInfo: { name: 'cindy', version: '0.0.0' },
      codexProxyActive,
      remoteCompactionProviderId,
      // app-server 对失败 RPC 返回 cloudRequirements + Auth/relogin 结构化错误时,当前 host
      // 持有的 token 已不可用。stderr 与工具输出只做诊断,绝不驱动鉴权状态。保留 host 只会
      // 持续撞鉴权失败; auth.invalidate 会触发 logout + 通知 UI 重登。延后到 microtask
      // 防止在 JSON-RPC response 分发回调里同步收割自己。远端也走同一结构化协议路径。
      onAuthInvalidated: (reason) => {
        const usesLocalAuth = !remoteHostId;
        this.deps.logger.warn('codex auth invalidated', {
          reason,
          key,
          localAuthWillInvalidate: usesLocalAuth,
        });
        Promise.resolve()
          .then(async () => {
            if (usesLocalAuth) {
              try {
                await this.deps.auth.invalidate?.(reason);
              } catch (e) {
                this.deps.logger.error('auth.invalidate threw', { message: (e as Error).message });
              }
            }
            // 防御兜底: 只收掉报错的 host key。远端 daemon 的 auth 失效不应该扩散到
            // local host 或其它 remote host,否则无关会话会绕过 Session.close 变 stale。
            try {
              await this.retireHostKey(key, `CodexAgent auth invalidated: ${reason}`, {
                failIfActive: false,
                logPrefix: 'codex auth invalidated',
              });
            } catch { /* no-op */ }
          })
          .catch(() => undefined);
      },
    });
    try {
      assertCurrentGeneration('registration');
    } catch (error) {
      await host.retire('CodexAgent host creation superseded');
      throw error;
    }
    this.hosts.set(key, host);
    // 登记超集归一化后的实际 spawn 形态,供后续复用仲裁。
    this.hostCredentialModes.set(key, spawnCredentialMode);
    this.hostEffectiveCredentialModes.set(key, effectiveMode);
    return host;
  }

  /**
   * Phase 4: oneShot 也走 host (临时 thread, 跑完 release subscription, server 端 thread state
   * 自然 GC)。不再依赖 @openai/codex-sdk。
   *
   * 用 gpt-5.4-mini + tmpdir + sandbox readOnly + approvalPolicy never (起标题不能弹审批)。
   *
   * 失败语义: 跟 claude-code/oneShot 对齐, 抛 OneShotError (timeout/malformed),
   * 调用方按 reason 决定 catch/swallow。OneShotOptions 中 model/maxTokens 字段当前忽略
   * (Codex host 协议没暴露 max_tokens; model 走 thread/start 那已是默认 mini), signal 接通。
   */
  async oneShot(prompt: string, opts?: OneShotOptions): Promise<string> {
    const log = this.deps.logger.child('codex/oneShot');
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    // OneShotOptions.maxTokens 在 Codex 协议层就没暴露 (protocol.ts ThreadStartParams /
    // TurnStartParams 都没 max_tokens 字段) —— 静默忽略, 但调用方传了就 warn 一下,
    // 避免未来加新 oneShot 场景时 "我设了上限怎么没生效" 的隐性 bug。
    if (opts?.maxTokens !== undefined) {
      log.warn(`maxTokens=${opts.maxTokens} ignored — Codex host protocol does not expose max_tokens`);
    }
    let subscription: ThreadSubscription | null = null;
    try {
      const { host } = await this.getUtilityHost();
      await host.ensureStarted();

      // 创建临时 thread (跟主 session 共享 server 但 thread state 隔离)
      const startResp = await host.request<ThreadStartResponse>(Method.ThreadStart, {
        cwd: os.tmpdir(),
        model: opts?.model ?? 'gpt-5.4-mini',
        approvalPolicy: 'never',
        sandbox: 'read-only', // kebab-case (v2.rs SandboxMode)
      } as ThreadStartParams);
      const threadId = startResp.thread.id;

      // 等首条 agentMessage.completed 文本; 出 error 通知用 sentinel object 区分超时/正常
      type OneShotResult = { kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'error'; message: string };
      let resolve: (r: OneShotResult) => void = () => {};
      const result = new Promise<OneShotResult>((res) => {
        resolve = res;
      });
      let currentTurnId: string | null = null;
      let resolved = false;

      subscription = host.subscribeThread(threadId, {
        turnStarted: (params) => {
          currentTurnId = params.turn.id;
        },
        itemCompleted: (params) => {
          if (resolved) return;
          const item = params.item as { type?: string; text?: string };
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            resolved = true;
            resolve({ kind: 'text', text: item.text.trim() });
          }
        },
        turnCompleted: () => {
          if (!resolved) {
            resolved = true;
            resolve({ kind: 'empty' });
          }
        },
        error: (params) => {
          if (resolved) return;
          // willRetry=true 是 codex server 可自愈的暂时错误(transient blip /
          // "Reconnecting... N/5"),server 会自动重连重试,不应中断 turn — 与主
          // 会话 error handler、translator 及 protocol.ts ErrorNotification 注释
          // 一致。忽略它,继续等 agentMessage / turnCompleted / 自家超时,否则像
          // 起标题这种短任务会被一次上游抖动直接打成 OneShotError。
          if (params.willRetry === true) {
            log.debug('oneShot transient error (will retry), ignored', {
              message: params.error?.message,
            });
            return;
          }
          resolved = true;
          log.warn('oneShot error notification', { message: params.error?.message });
          resolve({ kind: 'error', message: params.error?.message ?? 'unknown codex error' });
        },
      });

      await host.request(Method.TurnStart, {
        threadId,
        input: [{ type: 'text', text: prompt }],
      } as TurnStartParams);

      // 自家超时 sentinel (kind 'timeout'), 走外部 signal 也走同一通道
      const timeoutP = new Promise<OneShotResult>((res) => {
        const t = setTimeout(() => res({ kind: 'error', message: '__TIMEOUT__' }), timeoutMs);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          res({ kind: 'error', message: '__ABORTED__' });
        });
      });
      const r = await Promise.race([result, timeoutP]);

      // 如果 turn 没结束就拿到结果, 主动 interrupt 避免 server 继续算
      if (r.kind === 'text' && currentTurnId) {
        host.request(Method.TurnInterrupt, { threadId, turnId: currentTurnId }).catch(() => undefined);
      }

      if (r.kind === 'text') {
        if (!r.text) throw new OneShotError('malformed', 'Empty agentMessage from codex');
        return r.text;
      }
      if (r.kind === 'empty') {
        throw new OneShotError('malformed', 'Codex turn completed without agentMessage');
      }
      // r.kind === 'error'
      if (r.message === '__TIMEOUT__') {
        throw new OneShotError('timeout', `Codex oneShot timed out after ${timeoutMs}ms`);
      }
      if (r.message === '__ABORTED__') {
        // 外部 abort 不归类成 OneShotError (跟 claude 端一致)。Claude 端走 SDK 抛 web 标准
        // AbortError (DOMException), 这里手动 abort 也用同款类型, 让调用方一律靠
        // err.name === 'AbortError' 或 signal.aborted 判断, 不用区分 agent。
        throw new DOMException('aborted', 'AbortError');
      }
      throw new OneShotError('malformed', `Codex error: ${r.message}`);
    } catch (err) {
      if (err instanceof OneShotError) {
        log.error('oneShot failed', { reason: err.reason, error: err.message });
        throw err;
      }
      log.error('oneShot failed', { error: String(err) });
      // 网络/host 启动等未分类失败统一归 'network' (跟 claude 端 mapAnthropicError 一致)
      throw new OneShotError('network', err instanceof Error ? err.message : String(err));
    } finally {
      try { await subscription?.release(); } catch { /* no-op */ }
    }
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    // scope 带完整 s:<sessionId> 前缀 → host logger 落盘时提取 business sessionId,
    // 路由到 sessions/<id>/<date>.ndjson (logger.ts extractSessionId / sessionAgentSlot)。
    const sid = opts.sessionId ?? '';
    const log = this.deps.logger.child(sid ? `s:${sid}/codex` : 'codex');

    log.info('startSession', {
      model: opts.model,
      providerId: opts.providerId ?? null,
      effort: opts.effort ?? 'default',
      fastMode: opts.fastMode ?? 'default',
      workDir: opts.workingDir,
      resume: opts.resumeSessionId ?? 'new',
      remoteHostId: opts.remoteHostId ?? null,
      mcpProvidersCount: this.deps.mcpProviders?.length ?? 0,
    });

    // ── Maker Memory: 启动时预拉 MEMORY.md 索引 + 写入规范段 ────────────────
    // thread/start 仍把 developerInstructions 写入新 thread; thread/resume 在非 proxy
    // 路径只在 host 明确告知历史未含产品 prompt 时补发一次,避免常规 resume 重复堆积。
    // proxy active 时两条路径都用同一份构建结果登记到 registry。跟 userPrompt 同语义 — 启动时快照,跨 session 不实时同步。
    let makerMemoryRules = '';
    let makerMemoryIndex = '';
    let memoryFlushController: MemoryFlushController | null = null;
    // opts.makerMemoryEnabled 优先 (per-session, renderer 透传); fallback 到 runtimeConfig。
    const makerMemoryFlag =
      opts.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled ?? false;
    const makerMemory = this.deps.makerMemory;
    const makerMemoryEnabled = makerMemoryFlag === true && !!makerMemory;
    // SSH remote 的 workingDir 是远端路径 — store 定位统一经 scope key,
    // 键规则与理由见 buildMemoryScopeKey (memory/storage.ts)。
    const memoryScopeKey = buildMemoryScopeKey(opts.workingDir, opts.remoteHostId);
    // This per-session injection flag must not mutate the shared manager.
    if (makerMemoryEnabled && makerMemory) {
      try {
        const store = await makerMemory.getStore(memoryScopeKey);
        makerMemoryRules = MAKER_MEMORY_RULES;
        makerMemoryIndex = await store.getIndex();
        memoryFlushController = new MemoryFlushController({
          logger: log.child('memory-flush'),
          workdir: memoryScopeKey,
          agentKind: 'codex',
        });
        log.debug('maker memory loaded for session', {
          rulesBytes: makerMemoryRules.length,
          indexBytes: makerMemoryIndex.length,
        });
      } catch (e) {
        log.warn('maker memory load failed at session start (skipping injection)', {
          error: String(e),
        });
      }
    }

    const eventQueue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
    const usageTracker = new UsageTracker();
    const translatorRt: CodexRuntimeState = newCodexRuntimeState();

    let sdkSessionId: string | undefined;
    let currentTurnId: string | null = null;
    let isTurnInFlight = false;
    /**
     * 本 handle 上「起过多少个 turn」的单调计数器,每次 isTurnInFlight 被置活 +1。
     *
     * 存在的唯一理由:延迟很久的善后动作(upstream-idle 看门狗那条要等两次 interrupt
     * ack、最长 20s)不能只看**当下**有没有 turn 在跑 —— 新 turn 完全可能在这段窗口里
     * 起来又正常结束,把 isTurnInFlight / currentTurnId 双双复位,善后于是误判成"没人
     * 用了"并关掉这个已被证明健康的 host(review #944 第十八轮 P1)。存量瞬时状态答不了
     * "期间有没有发生过新活儿",单调计数器可以。
     *
     * 与 sendGeneration 的区别:那个按 send() 计数,起不来 turn 的 send(RPC 失败、
     * 被拒)也会 +1,而计划实施 turn 这类不经 send 的路径反而不 +1。这里要的恰恰是
     * "turn 被置活"这件事。
     */
    let turnStartGeneration = 0;
    let isTurnStartPending = false;
    // turn/start RPC 失败(超时/拒绝)后置位: server 可能实际已建 turn,
    // 迟到的孤儿 turnStarted 由 turnStarted handler 拦下并补 interrupt。
    let turnStartFailedWithoutTurnId = false;
    // 孤儿守卫生效期间又有新 turn/start 在飞时, 到达的 turnStarted 归属不明
    // (协议不带 request id: 可能是失败 RPC 的孤儿, 也可能是在飞 RPC 合法的
    // started-before-resp) — 先缓冲隔离, 等响应到了按 turnId 对账: 一致激活,
    // 不一致 interrupt + 墓碑 (codex R9 P2)。缓冲期间不置 currentTurnId,
    // 孤儿 turn 的 item 事件不会被渲染到本次 send 下。
    const bufferedOrphanTurnIds = new Set<string>();
    type TurnCompletedParams = Parameters<NonNullable<ThreadEventHandlers['turnCompleted']>>[0];
    // 缓冲隔离期间到达的**所有** turn 事件按 turnId 排队 (greptile R11 P1 +
    // codex R12 P1): 对账证明合法时激活后按到达序重放 (早期 item/usage 不丢,
    // 终态自然收口 send), 证明孤儿时整队丢弃。只拦 turnStarted 或只缓存终态
    // 都会出反例: 前者让孤儿输出渲染到在飞 send 下, 后者把合法 turn 的
    // 早期输出/终态永久丢掉 (send 卡 generating)。队列元素是重放闭包 —
    // 重放时 buffer 已清空且 turn 已激活, 闭包重进 handler 走正常路径。
    const bufferedTurnEventQueues = new Map<string, Array<() => void>>();
    // 正常完成的 turn 也必须保留墓碑:app-server 允许 turn/completed 早于仍在
    // 后台收尾的 item 事件到达。没有这层墓碑时,currentTurnId 已清空,迟到 item
    // 会重新发出 running status,而该 turn 的 done 已消费完,会话将永久假忙。
    // turn id 在同一 thread 内唯一;墓碑随 session handle 释放,不跨 session 泄漏。
    const completedTurnIds = new Set<string>();
    const terminalErroredTurnIds = new Set<string>();
    // daemon 后端 retry-loop 的终局升级 (issue #677): 远端摸不到 Codex 后端时
    // daemon 无限 willRetry, turn 永不收口。同 turn 重试超阈值 → 合成终态错误,
    // 走与终态 error 完全相同的收口路径 (terminalErroredTurnIds + Done status)。
    const turnRetryTracker = new TurnRetryTracker();
    const deferredTerminalTurnCompletions = new Map<string, TurnCompletedParams>();
    // 最近一次 thread/tokenUsage/updated 的 last 增量 + contextWindow,
    // 缓存供 turn end 日志读取 (协议本身不在 turn/completed 里带 usage)。
    let lastTurnTokenUsage: TokenUsageBreakdown | null = null;
    let lastModelContextWindow: number | null = null;
    /**
     * 已产出过模型内容(item 或 reasoning 增量)的 turn id。
     *
     * 只用于判断服务过载错误能否安全重投：容量拒绝发生在 admission 阶段时模型
     * 一个字都没写过，重投同一份 turnParams 不会重复任何副作用；一旦已经产出过
     * 内容（写过文件、跑过命令），重放就会让模型重做已完成的工作，那种情况必须
     * 交回用户决定。
     *
     * **按 turn 记账而不是一个会话级标量**: 被 Stop 的旧 send 的隔离 start 若带着缓冲事件
     * 回包(那要按"有产出"处理), 标量写的是**当前**这一轮的账 —— 而新一轮的 turnStarted 若
     * 进过缓冲或作为同 turn 通知到达, 都不会把它清掉, 于是新消息一次本来安全的零产出容量
     * 重投被误判成"有产出, 不重投", 自动重试静默失效(review #844 codex P1)。
     * 每个写入方都拿得到自己的 turnId, 读取方(scheduleOverloadRetry)拿得到死 turn 的 id,
     * 按 id 记账后跨轮污染在结构上就不成立, 也不再需要"换 turn 才清零"这类时序守卫。
     */
    const producedOutputTurnIds = new Set<string>();
    /**
     * 服务过载退避重投状态。`retry` 由 send() 每轮登记，闭包持有该 turn 的
     * turnParams 与响应处理逻辑，因此重投投递的是同一条用户消息、同一套策略，
     * 不会因为期间 mutable 配置变化而偷偷换参数。
     */
    let overloadRetry: {
      retry: () => Promise<void>;
      attempt: number;
      timer: ReturnType<typeof setTimeout> | null;
      /**
       * 重投的 turn/start RPC 是否在途。计时器到点后 `timer` 已清空、新 turn 又
       * 尚未激活，中间这段窗口若报 idle，并发 send 会被误接受并把原消息静默丢掉。
       * 刻意用独立标记而不是复用 `isTurnStartPending`：后者在正常 send 路径上被
       * 既有语义要求保持 idle（终态先于 turn/start 响应到达时，coordinator 必须
       * 看到 idle 才能收口，否则 send 挂死），不能一起收紧。
       */
      inFlight: boolean;
      /**
       * 本轮 send 的取消信号是否已 abort。由 send() 闭包提供 —— `sendOpts` 只在
       * 那个作用域里可见，而重投的失败收口判断发生在本文件的调度器作用域。
       */
      isCancelled: () => boolean;
      /**
       * 冻结 turnParams 时生效的权限档。判断「重投持的策略是否比当前更宽」要靠它：
       * 只看最近一次模式转换会漏掉 Full access → Ask → Auto 这类中间态（Ask→Auto
       * 不算收紧，会把延迟中断标记清掉，而冻结的 Full access 仍然更宽）。
       */
      launchedPermissionMode: PermissionMode;
      /**
       * 在途 RPC 期间又收到容量失败 → 那条错误被延后处理（既没排计时器也没收口）。
       * RPC settle 且新 turn 没能激活时，必须凭这个标记补排一次，否则逻辑 send
       * 永久悬空：错误已被落墓碑、响应因墓碑拒绝激活、inFlight 又被 finally 清掉，
       * 没有任何计时器或终态事件残留（review #844 codex P1）。
       */
      deferredCapacityFailure: { deadTurnId: string | null } | null;
      /** 这份重投状态属于哪一轮 send(判断"尾巴动作还有没有权限动全局状态")。 */
      sendGen: number;
      /** 摘掉本轮 send 信号的 abort 监听（状态被替换 / 收口时必须调）。 */
      disposeSignalWatch: (() => void) | null;
    } | null = null;
    /**
     * 在飞的 turn/start 请求登记表: 请求序号 → 该请求自己的状态。
     *
     * 为什么必须是**表**而不是几个标量: 这个文件其余部分假定"同一时刻只有一个 start 在
     * 飞", 但 Stop 会让 handle 变 idle —— 用户可以在被 Stop 的那次 RPC 仍在飞时发下一条
     * 消息, 于是确实会有两个 start 并存。用标量记"哪一次要被隔离 / 有没有 start 在飞"时,
     * 后一个请求会把前一个的记账覆盖掉: 被 Stop 的旧 turn 于是逃过隔离、在响应回来时被
     * 正常激活并继续跑工具; 反过来也可能把合法的新 turn 误杀
     * (review #844 codex P1, 连续四轮都栽在同一个形状上)。
     *
     * 每个 per-request 的事实都住在自己的条目里, 请求 settle 时整条删掉, 天然不串味;
     * "有没有 start 在飞"一律由 `inFlightStarts.size` 派生, 不再有第二份真相。
     */
    const inFlightStarts = new Map<number, { quarantined: boolean; terminalSettled: boolean }>();
    /** 每次 turn/start RPC 的自增序号, 作为登记表的键。 */
    let turnStartSeq = 0;
    /**
     * 每轮 send 的自增世代。
     *
     * Stop 会让 handle 变 idle, 于是被 Stop 的那一轮 send 还有"尾巴"在跑(它的 RPC 尚未
     * settle、迟到的通知、失败清理), 而**下一轮 send 可能已经接管会话**。这些尾巴动作若
     * 照旧操作全局状态(推终态、把 currentTurnId 当自己的孤儿收掉), 就会二次收口、甚至误杀
     * 新一轮的合法 turn(review #844 codex/greptile P1)。判据统一为"我这一轮还是最新世代吗"。
     */
    let sendGeneration = 0;

    /** 登记一次即将发出的 turn/start, 返回它的序号。 */
    const beginTurnStart = (): number => {
      const seq = ++turnStartSeq;
      inFlightStarts.set(seq, { quarantined: false, terminalSettled: false });
      isTurnStartPending = true;
      return seq;
    };

    /**
     * 注销一次已 settle 的 turn/start。
     *
     * `isTurnStartPending` 随之按"还有没有别的 start 在飞"重算 —— 直接置 false 会在两个
     * start 并存时把属于**另一个**请求的状态清掉(review #844 codex P1)。
     */
    const endTurnStart = (seq: number): void => {
      inFlightStarts.delete(seq);
      isTurnStartPending = inFlightStarts.size > 0;
    };

    /**
     * 除了 `seq` 这一次, 还有别的 turn/start 在飞吗。
     *
     * 缓冲集里的歧义 started **无法归属**(协议层分不清失败 RPC 的孤儿与在飞 RPC 的
     * started-before-resp), 所以一个 id 只有在**所有候选归属方都被排除**之后才能被坐实成
     * 孤儿 —— 也就是没有别的 start 还在飞的时候。隔离(reject)与对账(resolve)两条路共用这条
     * 判据(review #844 codex P1)。
     *
     * 显式传 seq 而不是判 `inFlightStarts.size > 1`: 后者只在"调用点一定早于本请求
     * endTurnStart"时才等价, 而那正是本 PR 反复踩过的隐式耦合。
     */
    /**
     * turnId → 生出它的那一次 turn/start 的 seq。
     *
     * 用途只有一个: 判断"空 id 的容量拒绝能不能算在当前活跃 turn 头上"。活跃 turn 的
     * 归属方若已 settle, 而登记表里还躺着**别人**的 start(典型: Stop 留下的旧 RPC), 那条
     * 空 id 通知就可能是那一位的 —— 算在活跃 turn 头上会把一个正常在跑的 turn 落墓碑并
     * 重放它的输入(review #844 codex P1)。
     *
     * sendGen 则回答"这个 turn 属于哪一轮 send": 退避 / 延后中的重投属于某一轮, 一个**不属于
     * 那一轮**的 turn 的迟到终态不得替它收口, 也不得顺手撤销它的重投
     * (review #844 greptile P1)。
     *
     * 按 turnId 建索引而不是存一个"当前 turn 的归属方"标量: 后者要跟着 currentTurnId 的
     * 每一处清理同步, 漏一处就读到上一个 turn 的归属 —— 本 PR 已经在别的标量上踩过。
     * 键就是 turnId 本身, 旧条目不可能被当成另一个 turn 的答案。
     */
    const turnOriginByTurnId = new Map<string, { startSeq: number | null; sendGen: number }>();

    const hasOtherInFlightStart = (seq: number): boolean => {
      for (const other of inFlightStarts.keys()) if (other !== seq) return true;
      return false;
    };

    /**
     * 标记某次在飞的 start:它的响应回来时**不得激活**带回的 turn, 必须落墓碑 + interrupt。
     *
     * 两个来源:
     *  - 已接管一条**不带 turnId** 的容量拒绝(app-server 尚未回包时的空 id 形状): 要等响应
     *    回来才知道那条失败说的是哪个 turn —— 记最新那一次(错误紧跟在它之后到达);
     *  - 挂起重投期间的 Stop / 撤单: 已经推过终态事件, 随后回来的响应若照常激活, 用户看到
     *    「已停止」而工具还在跑 —— 这种要把**当前所有**在飞的 start 一起隔离, 因为 Stop 的
     *    语义是"什么都别再跑"。
     */
    const quarantineLatestInFlightStart = (): void => {
      const seqs = [...inFlightStarts.keys()];
      const latest = seqs[seqs.length - 1];
      if (latest === undefined) return;
      const entry = inFlightStarts.get(latest);
      if (entry) entry.quarantined = true;
      armLateStartOrphanGuard();
    };
    /**
     * 标记当前所有在飞 start:这一轮已经由 Stop / 撤单推过终态, 它们的失败尾巴不得再推
     * 第二组终态事件。
     *
     * 挂在**每个请求的条目**上而不是一个标量: 两轮 send 先后被 Stop 且各自的 RPC 都还在飞
     * 时, 后一次会把标量覆盖掉 —— 先那次的 reject 于是又推一组终态, 而事件里不带 send 世代,
     * 下游可能把这份过期收口套到后一个 turn 上(review #844 codex P1)。条目随 endTurnStart
     * 一起删, 也不会泄漏。
     */
    const markInFlightStartsTerminallySettled = (): void => {
      for (const entry of inFlightStarts.values()) entry.terminalSettled = true;
    };
    const quarantineAllInFlightStarts = (): void => {
      if (inFlightStarts.size === 0) return;
      for (const entry of inFlightStarts.values()) entry.quarantined = true;
      armLateStartOrphanGuard();
    };
    /**
     * 被隔离的 start 也可能在响应之前先推回 turnStarted —— 那个 handler 只看
     * `turnStartFailedWithoutTurnId`, 不看登记表的 quarantined, 于是会把这个"已经判定不许
     * 运行"的 turn 正常激活, 工具在 Stop 之后继续跑(review #844 codex P1)。
     *
     * 语义上这两件事是同一类: "有一次 start 我们拿不到 id 却已经决定它不许活"。所以复用既有
     * 的通知级孤儿守卫, 让迟到的未知 started 走缓冲 / 墓碑 + interrupt 那条既有路径, 而不是
     * 在 turnStarted handler 里再加一份并行判定。
     */
    function armLateStartOrphanGuard(): void {
      turnStartFailedWithoutTurnId = true;
    }

    let closed = false;
    let subscriptionInvalidatedByTransport = false;
    let subscription: ThreadSubscription | null = null;
    let interactionResolver: InteractionResolver | null = null;
    // Kept across the internal plan implementation/revision turns. A later
    // explicit Session.send replaces it before turn/start.
    let activeTurnPermissionPolicy: TurnPermissionPolicy | null = null;
    const forceTurnConfirmation = (toolName: string, input: unknown): boolean => {
      const policy = activeTurnPermissionPolicy;
      if (!policy) return false;
      try {
        return policy.forceConfirmToolCall(toolName, input) === true;
      } catch (error) {
        log.error('turn permission policy threw -> force confirmation', {
          toolName,
          origin: policy.origin,
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    };
    let stopRolloutPlanFallback: (() => void) | null = null;
    const seenRolloutPlanCallIds = new Set<string>();
    const latestPlanByTurn = new Map<string, TurnPlanUpdatedNotification['params']['plan']>();
    // 当前 session 的 one-shot tip 状态 (turn-start status 用):
    //  - displayed: id → 已展示次数 (≥ 该 tip 的 guarantees.length 时退出抽样池)
    //  - pity:      id → 自上次展示以来候选轮次 (pickTurnStartStatus 内部自增 / 触发保底)
    // /clear 等价于开新 session → 重建 handle → 状态自然清零, 无需额外重置。
    const oneShotTipState: OneShotState = { displayed: new Map(), pity: new Map() };

    /** Phase 3: mutable 配置, 下一个 turn/start 透传; resume 时也透传一次。 */
    let mutableModel = opts.model;
    let mutableEffort: Effort = opts.effort ?? 'high';
    let mutablePermissionMode: PermissionMode = opts.permissionMode ?? 'ask';
    let mutableExtraDirs = [...(opts.extraDirs ?? [])];
    // Named profiles defined through thread/start.config are thread-local. Codex
    // 0.145.0 cannot resolve that thread-local definition when the selector is
    // repeated on turn/start, so remember whether the thread is already using it.
    let readonlyReferencesProfileActive = false;
    // A fresh thread/start has no rollout yet, so thread/resume fails until a
    // turn/start may have crossed the server acceptance boundary. Once a turn
    // was attempted, prefer resume before replacing the thread; "no rollout"
    // is the only safe proof that the thread is still unused.
    let threadMayHaveRollout = false;
    // 计划模式(与 permissionMode 正交, **一次性选择**): mutablePlanMode 是 UI 勾选的
    // "武装"态 —— send 消耗它并立即 emit plan_mode_changed(false) 让勾选熄灭;
    // 本轮「计划 → 审阅 → 修订/批准」循环由 planCycleActive 承载:
    // 修订 turn 保持 plan, 批准/取消/计划轮空跑(没产出计划)/turn 失败都会结束循环。
    let mutablePlanMode = opts.planMode === true;
    let planCycleActive = false;
    let currentTurnPlanModeActive = false;
    let pendingTurnStartPlanMode: boolean | null = null;
    // collaborationMode 是 sticky 语义 — 线程一旦进过 plan, 退出后必须持续显式发
    // default 复位, 否则 server 端停留在 plan 模式。
    let threadTouchedPlanMode = false;
    let planModeDefaultMarkerNeeded = false;
    // 当前 plan turn 流出的 proposed plan 文本 (plan item / <proposed_plan> 块)。
    let proposedPlanText: string | null = null;
    const endPlanCycleAfterPreStartFailure = (reason: string): void => {
      if (!planCycleActive) return;
      planCycleActive = false;
      proposedPlanText = null;
      currentTurnPlanModeActive = false;
      pendingTurnStartPlanMode = null;
      log.debug(`${reason} during plan cycle — plan cycle ends`);
    };
    // plan_review requestId 去重序号 (同一 turn 理论上只有一个 plan item, 防御性加序号)。
    let planReviewSeq = 0;
    // Undefined = 不覆盖 app-server/config 默认; null = explicit standard; 'fast' = Fast mode.
    let mutableServiceTier: ServiceTier | null | undefined =
      opts.fastMode === undefined ? undefined : opts.fastMode ? 'fast' : null;
    // Older async thread start/resume responses must not overwrite a newer
    // Fast mode choice made while the request was in flight.
    let serviceTierMutationGeneration = 0;
    const vo: Record<string, unknown> = { ...(opts.vendorOptions ?? {}) };
    const credentialMode = opts.remoteHostId
      ? undefined
      : resolveAgentCredentialMode({
          agentKind: 'codex',
          providerId: opts.providerId,
          model: opts.model,
        });
    const currentHostKey = hostKey(opts.remoteHostId);
    let releaseHostBindingLease: (() => void) | null = null;
    const acquireHostBindingLeaseIfNeeded = (): void => {
      if (opts.remoteHostId || releaseHostBindingLease) return;
      releaseHostBindingLease = this.acquireHostSessionBindingLease(currentHostKey);
    };
    const releaseHostBindingLeaseIfNeeded = (): void => {
      const release = releaseHostBindingLease;
      releaseHostBindingLease = null;
      release?.();
    };
    const getSessionHost = async (): Promise<AppServerHost> => {
      if (opts.remoteHostId) return await this.getHost(opts.remoteHostId, credentialMode);
      // 本地会话先等已有 credential switch 完成，再占用 startup reservation。否则
      // session 已拿到旧 host、但尚未 thread/start 订阅时，credential 切换看不到它。
      await this.waitForHostCredentialModeSwitch(currentHostKey);
      acquireHostBindingLeaseIfNeeded();
      return await this.getHost(opts.remoteHostId, credentialMode, { ignoreBindingLeases: 1 });
    };
    const host = await getSessionHost().catch((error) => {
      releaseHostBindingLeaseIfNeeded();
      throw error;
    });
    const hostGeneration = this.hostGenerations.get(currentHostKey) ?? 0;
    const capturedHostWasRegistered = this.hosts.get(currentHostKey) === host;
    const connectionId = host.getConnectionId();
    const isCurrentHost = (): boolean => {
      const currentHost = this.hosts.get(currentHostKey);
      if ((this.hostGenerations.get(currentHostKey) ?? 0) !== hostGeneration) return false;
      return capturedHostWasRegistered ? currentHost === host : currentHost === undefined;
    };
    const staleHostError = (operation: string): Error =>
      new Error(`Codex session expired because its app-server was replaced before ${operation}; restart the session`);
    const assertCurrentHost = (operation: string): void => {
      if (isCurrentHost()) return;
      log.warn('codex session handle rejected after app-server replacement', {
        operation,
        hostKey: currentHostKey,
        credentialMode: credentialMode ?? 'fallback',
      });
      throw staleHostError(operation);
    };
    const skipIfStaleHost = (operation: string): boolean => {
      if (isCurrentHost()) return false;
      log.warn('codex session handle ignored after app-server replacement', {
        operation,
        hostKey: currentHostKey,
        credentialMode: credentialMode ?? 'fallback',
      });
      return true;
    };
    let initResp: Awaited<ReturnType<AppServerHost['ensureStarted']>>;
    try {
      assertCurrentHost('initialize');
      // 直调也必须有上界 (codex R13 P1): 冷启动 / transport 重建时
      // bootstrap 挂死 (远端 daemon 无响应 / SSH 通道死) 会让 startSession
      // 永不返回, UI 无限卡初始化 — 与 request() 的 startup deadline 同款。
      initResp = await host.ensureStartedWithTimeout(CRITICAL_THREAD_RPC_TIMEOUT_MS, 'startSession initialize');
      assertCurrentHost('initialize');
    } catch (error) {
      releaseHostBindingLeaseIfNeeded();
      throw error;
    }
    if (initResp.codexHome) this.codexHome = initResp.codexHome;
    // reviewer 路由的凭证模式判定: 远程 daemon 用的是 auth sync 推过去的
    // 同一份订阅凭证, reviewer 调用发生在 daemon 本地 — 订阅下走 daemon →
    // chatgpt.com 直连, 与本地订阅同构 (远端出网由用户网络或 agent-proxy
    // 隧道保障)。resolveAgentCredentialMode 只看 providerId/model, 远程同样
    // 可判; 默认远程 session (无 providerId + 无前缀 model) 解析不出时,
    // 兜底用 host 创建时登记的 effective mode (auth fallback 的实际钥匙 —
    // 订阅即 oauth-bearer), 与本地默认 session 的兜底链对齐 (codex R17 P1)。
    // 远程订阅与本地订阅同等启用 (#667 的远程一律回退是隧道方案缺位时的
    // 保守, 隧道落地后放开)。
    const sessionCredentialMode = opts.remoteHostId
      ? resolveAgentCredentialMode({
          agentKind: 'codex',
          providerId: opts.providerId,
          model: opts.model,
        }) ?? this.hostEffectiveCredentialModes.get(currentHostKey)
      : credentialMode ?? this.hostEffectiveCredentialModes.get(currentHostKey);
    const approvalsReviewerProtocolSupported =
      supportsCodexApprovalsReviewerProtocol(initResp.userAgent);
    // OpenAI OAuth can use Codex's hidden reviewer model directly. Local proxy
    // routes may opt in after registering a parent-thread → session → main-model
    // context; until that synchronous registration succeeds they stay on the
    // explicit user reviewer. Remote non-subscription routes have no local proxy
    // rewrite and therefore keep the conservative manual fallback.
    const nativeApprovalsReviewerRouteSupported = sessionCredentialMode === 'oauth-bearer';
    let approvalsReviewerRouteSupported = nativeApprovalsReviewerRouteSupported;
    const readonlyReferenceDirsSupported = supportsCodexReadonlyReferenceDirs(initResp.userAgent);
    const resumeExcludeTurnsSupported = supportsCodexResumeExcludeTurns(initResp.userAgent);
    if (mutableExtraDirs.length > 0 && !readonlyReferenceDirsSupported) {
      releaseHostBindingLeaseIfNeeded();
      throw new Error(
        `Codex reference directories require app-server 0.144.6 or newer (current: ${initResp.userAgent ?? 'unknown'})`,
      );
    }
    if (
      mutablePermissionMode === 'auto' &&
      !(approvalsReviewerProtocolSupported && approvalsReviewerRouteSupported)
    ) {
      log.warn('Codex Auto falling back to user approvals: automatic reviewer is unavailable on this route', {
        userAgent: initResp.userAgent,
        providerId: opts.providerId ?? null,
        credentialMode: sessionCredentialMode ?? 'unknown',
        remote: Boolean(opts.remoteHostId),
        protocolSupported: approvalsReviewerProtocolSupported,
        routeSupported: approvalsReviewerRouteSupported,
      });
    }
    // 闭包 capture 一次, 整个 session 复用 — codexHome 是 server 进程级常量, host 不变就不变。
    // memories 目录是 codex 自家私域 (<CODEX_HOME>/memories/), 永远塞进 writableRoots,
    // 即使用户当前没开 memories: 写权限多给一个固定子目录开销可忽略, 还能避免"开关 memories
    // 后第一个 turn 之内写入失败"的 race。
    // 关键: codexHome 可能是 remote Linux 路径(/root/.xdt-server/...) — 此时必须
    // 用 posix join, 否则 Windows 上 path.join 会拼出反斜杠分隔符, daemon 反序列化
    // writable_roots (AbsolutePathBuf) 时 Path::is_absolute() = false → 报
    // "AbsolutePathBuf deserialized without a base path" -32600。
    // 判断: 以 '/' 开头视为 posix, 其它走平台默认 (Windows 本地 codex daemon)。
    const joinCodexHome = (sub: string) =>
      this.codexHome?.startsWith('/')
        ? `${this.codexHome.replace(/\/+$/, '')}/${sub}`
        : path.join(this.codexHome ?? '', sub);
    const codexExtraWritableRoots = this.codexHome ? [joinCodexHome('memories')] : [];
    const runtimeWorkspaceRoots = (): string[] => [opts.workingDir, ...mutableExtraDirs];
    const readonlyReferencesConfig: Record<string, unknown> = {
      [`permissions.${READONLY_REFERENCES_PERMISSION_PROFILE}`]: {
        filesystem: {
          ':root': 'read',
          ':workspace_roots': 'read',
          ':tmpdir': 'write',
          ':slash_tmp': 'write',
          [opts.workingDir]: {
            '.': 'write',
            '.git': 'read',
            '.agents': 'read',
            '.codex': 'read',
          },
          ...(codexExtraWritableRoots[0] ? { [codexExtraWritableRoots[0]]: 'write' } : {}),
        },
        network: { enabled: false },
      },
    };
    // Codex same-turn 插话走 `turn/steer` 方法，不走
    // `experimentalFeature/enablement/set`。这里特意不 push `{ steer: true }`:
    // 2026-06 实测当前内置 app-server 的 enablement 白名单没有 `steer`，
    // 强行写入会让整次 enablement/set 失败，并连带破坏 memory override 热更新。
    // memory 覆盖只在 host 起来后能 push (RPC); 第一次 startSession 触发, 后续 setMemory 自己 push。
    // 失败 → warn + 继续, 不让 memory 配置阻塞主对话。
    assertCurrentHost('memory override');
    if (!opts.remoteHostId) {
      await this.ensureMemoryOverridePushed(host, currentHostKey).catch((e) => {
        log.warn('ensureMemoryOverridePushed failed, continuing without memory override', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }

    const registerCodexMcpContext = (threadId: string): void => {
      // remoteHostId 不再跳过:远端 daemon 经 SSH remote-forward 直连本机
      // HTTP MCP bridge 后,tool call 同样按 params._meta.threadId 路由,
      // 需要这条注册让 CodexMcpThreadContextStore 能解析 remote thread。
      if (!sid) return;
      try {
        const register = this.deps.registerCodexMcpThreadContext;
        if (!register) return;
        register({
          threadId,
          sessionId: sid,
          workingDir: opts.workingDir,
          // remote thread ctx: scope key 语义见 buildMemoryScopeKey。
          ...(opts.remoteHostId ? { remoteHostId: opts.remoteHostId } : {}),
          vendorOptions: vo,
        });
        log.debug('codex MCP thread context registered', {
          threadId: prefixId(threadId),
          sessionId: prefixId(sid),
          orcaRole: typeof vo.orcaRole === 'string' ? vo.orcaRole : undefined,
          workerId: typeof vo.orcaWorkerId === 'string' ? prefixId(vo.orcaWorkerId) : undefined,
        });
      } catch (e) {
        log.warn('registerCodexMcpThreadContext threw', { error: String(e) });
      }
    };
    const unregisterCodexMcpContext = (threadId: string): void => {
      // 与 register 对齐:remote thread 同样注册过 context,close 时同样注销。
      if (!sid) return;
      try {
        const unregister = this.deps.unregisterCodexMcpThreadContext;
        if (!unregister) return;
        unregister(threadId);
        log.debug('codex MCP thread context unregistered', {
          threadId: prefixId(threadId),
        });
      } catch (e) {
        log.warn('unregisterCodexMcpThreadContext threw', { error: String(e) });
      }
    };
    function currentApprovalConfig(): CodexPermissionConfig {
      return mapPermissionToCodex(
        mutablePermissionMode,
        approvalsReviewerProtocolSupported,
        approvalsReviewerRouteSupported,
      );
    }

    function shouldUseReadonlyReferencesProfile(): boolean {
      return (
        readonlyReferenceDirsSupported &&
        mutableExtraDirs.length > 0 &&
        mutablePermissionMode !== 'bypassPermissions'
      );
    }

    function currentThreadWorkspaceConfig(): Pick<
      ThreadStartParams,
      | 'approvalPolicy'
      | 'approvalsReviewer'
      | 'sandbox'
      | 'permissions'
      | 'runtimeWorkspaceRoots'
      | 'config'
    > {
      const { approvalPolicy, approvalsReviewer, sandbox } = currentApprovalConfig();
      const shared = {
        approvalPolicy,
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
        ...(readonlyReferenceDirsSupported
          ? {
              runtimeWorkspaceRoots: runtimeWorkspaceRoots(),
              config: readonlyReferencesConfig,
            }
          : {}),
      };
      if (shouldUseReadonlyReferencesProfile()) {
        return {
          ...shared,
          permissions: READONLY_REFERENCES_PERMISSION_PROFILE,
        };
      }
      return { ...shared, sandbox };
    }

    function currentTurnWorkspaceConfig(): Pick<
      TurnStartParams,
      | 'approvalPolicy'
      | 'approvalsReviewer'
      | 'sandboxPolicy'
      | 'runtimeWorkspaceRoots'
    > {
      // A policy turn must make execution observable to the host. Read-only +
      // untrusted routes command/file escalations through the request handlers;
      // those handlers auto-accept non-forced actions in Auto mode.
      const turnApprovalConfig: CodexPermissionConfig = activeTurnPermissionPolicy
        ? {
            approvalPolicy: 'untrusted',
            sandbox: 'read-only',
          }
        : currentApprovalConfig();
      const { approvalPolicy, approvalsReviewer, sandbox } = turnApprovalConfig;
      const shared = {
        approvalPolicy,
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
        ...(readonlyReferenceDirsSupported
          ? { runtimeWorkspaceRoots: runtimeWorkspaceRoots() }
          : {}),
      };
      if (
        shouldUseReadonlyReferencesProfile() &&
        !activeTurnPermissionPolicy
      ) {
        // The profile was selected on thread/start or thread/resume. Repeating
        // the selector here makes Codex 0.145.0 reload its base config (which
        // does not contain our per-thread definition) and reject turn/start
        // with "default_permissions requires a `[permissions]` table".
        if (!readonlyReferencesProfileActive) {
          throw new Error(
            'Codex read-only reference profile is not active for this thread; restore it with thread/resume before turn/start',
          );
        }
        return shared;
      }
      return {
        ...shared,
        sandboxPolicy: sandboxModeToPolicy(sandbox, codexExtraWritableRoots),
      };
    }

    /**
     * 计划模式的 turn/start collaborationMode 装配:
     *  - 开启 → mode:'plan' + developer_instructions:null (server 注入官方内置 plan 指令);
     *  - 关闭但线程进过 plan → 持续发 mode:'default' 复位 (sticky 语义, 见 protocol.ts)。
     *    首个退出 default turn 用 developer_instructions:null, 让 app-server 注入
     *    官方 Default Mode marker 覆盖历史里的 Plan Mode marker; 之后用 ''
     *    避免重复注入, 与从未进过 plan 的线程行为保持接近;
     *  - 常规线程 → undefined, turn 参数与旧版逐字节一致 (不影响既有会话)。
     * settings.model / reasoning_effort 必须带当前 mutable 值 — collaborationMode
     * 对 model/effort 有覆盖优先级, 缺省会把用户的模型选择顶掉。
     */
    function collaborationModeForTurn(
      planThisTurn: boolean,
      continuePlanCycleThisTurn = planCycleActive,
    ): CollaborationModeParam | undefined {
      // 只由「本 turn 意图(per-send 快照/消耗武装态的结果) + 进行中的循环」驱动,
      // **不**读武装态 mutablePlanMode —— 排队普通消息(快照 false)派发时武装态
      // 可能为 true(用户为未来消息重新勾选), 不能影响本 turn 的线上参数。
      if (planThisTurn || continuePlanCycleThisTurn) {
        return {
          mode: 'plan',
          settings: {
            model: mutableModel,
            reasoning_effort: clampEffortForCodex(mutableModel, mutableEffort),
            developer_instructions: null,
          },
        };
      }
      if (threadTouchedPlanMode) {
        const developerInstructions = planModeDefaultMarkerNeeded ? null : '';
        return {
          mode: 'default',
          settings: {
            model: mutableModel,
            reasoning_effort: clampEffortForCodex(mutableModel, mutableEffort),
            developer_instructions: developerInstructions,
          },
        };
      }
      return undefined;
    }

    const toTurnInput = async (content: UserMessage['content']): Promise<UserInput[]> => {
      if (typeof content !== 'string') return toAppServerInput(content, opts.workingDir);

      const slash = parseLeadingSlashToken(content.trim());
      if (!slash) return toAppServerInput(content, opts.workingDir);

      try {
        const { skills } = await this.listSkillsForCwd(opts.workingDir, false);
        const skill = skills.find(
          (item) => item.enabled && item.name.toLowerCase() === slash.name.toLowerCase(),
        );
        if (!skill) return toAppServerInput(content, opts.workingDir);

        const inputs: UserInput[] = [{ type: 'skill', name: skill.name, path: skill.path }];
        const prompt = slash.rest.trim() || skill.interface?.defaultPrompt?.trim() || '';
        if (prompt) inputs.push({ type: 'text', text: prompt });
        return inputs;
      } catch (err) {
        log.warn('failed to resolve leading slash as Codex skill, sending literal text', {
          name: slash.name,
          error: String(err),
        });
        return toAppServerInput(content, opts.workingDir);
      }
    };

    const hostUsesCodexProxy = host.isCodexProxyActive();
    const isCodexProxyChannelReady = (): boolean =>
      hostUsesCodexProxy && typeof this.deps.registerCodexSystemPromptForThread === 'function';

    // ── OpenAI 远端压缩身份(thread 级,start/resume 冻结)────────────────────
    // 仅当 ① host 是 oauth spawn 且下发了 OpenAI 身份 provider(见
    // CodexExtraSpawnConfig.codexRemoteCompactionProviderId),② 本会话的凭证家族
    // 解析为 oauth-bearer(显式 openai 来源,或隐式来源 + host 归一化形态为订阅)
    // 时,才让 thread 选 OpenAI 身份 provider → codex 走 OpenAI 远端压缩。
    // codex/ 折扣(gateway-key)、xai/、chatgpt/ 与显式第三方来源(provider-oauth)
    // 都被 resolveAgentCredentialMode 排除 —— 它们的上游不支持远端压缩,且 codex
    // 远端压缩失败无本地回退,错配会打断长会话。
    const threadModelProvider = (() => {
      if (opts.remoteHostId) return undefined;
      const providerIdFromHost = host.getRemoteCompactionProviderId?.();
      if (!providerIdFromHost) return undefined;
      const family = credentialMode ?? this.hostEffectiveCredentialModes.get(currentHostKey);
      return family === 'oauth-bearer' ? providerIdFromHost : undefined;
    })();

    let registeredDeveloperInstructions = '';
    const registerCodexDeveloperInstructions = (threadId: string, text: string): void => {
      if (!text) return;
      registeredDeveloperInstructions = text;
      const register = this.deps.registerCodexSystemPromptForThread;
      if (!register) return;
      register({ sessionId: sid, threadId, text });
    };
    const registerCodexReviewerRouteContext = (targetThreadId: string): void => {
      if (!sid || opts.remoteHostId || !hostUsesCodexProxy || !approvalsReviewerProtocolSupported) {
        approvalsReviewerRouteSupported = nativeApprovalsReviewerRouteSupported;
        return;
      }
      // `gpt-5` is the app-server's "use its default" sentinel, not an
      // authoritative provider model id. A runtime switch to it deliberately
      // skips thread/settings/update, so there is no concrete model to register
      // for a third-party Guardian route. Keep manual review until a later
      // start/resume/settings notification supplies the resolved model.
      if (mutableModel === 'gpt-5') {
        approvalsReviewerRouteSupported = nativeApprovalsReviewerRouteSupported;
        if (!nativeApprovalsReviewerRouteSupported) {
          log.warn('Codex Auto keeping user approvals: default model sentinel is unresolved', {
            threadId: prefixId(targetThreadId),
            sessionId: prefixId(sid),
          });
        }
        return;
      }
      const register = this.deps.registerCodexReviewerRouteContext;
      if (!register) {
        approvalsReviewerRouteSupported = nativeApprovalsReviewerRouteSupported;
        return;
      }
      try {
        const registered = register({
          sessionId: sid,
          threadId: targetThreadId,
          model: mutableModel,
        });
        approvalsReviewerRouteSupported =
          nativeApprovalsReviewerRouteSupported || registered === true;
        if (registered === true) {
          log.debug('codex provider-aware Guardian reviewer route registered', {
            threadId: prefixId(targetThreadId),
            sessionId: prefixId(sid),
            model: mutableModel,
          });
        } else if (!nativeApprovalsReviewerRouteSupported) {
          log.warn('Codex Auto keeping user approvals: Guardian reviewer route registration declined', {
            threadId: prefixId(targetThreadId),
            sessionId: prefixId(sid),
            model: mutableModel,
          });
        }
      } catch (e) {
        approvalsReviewerRouteSupported = nativeApprovalsReviewerRouteSupported;
        log.warn('registerCodexReviewerRouteContext threw; keeping safe reviewer route', {
          error: String(e),
          threadId: prefixId(targetThreadId),
          sessionId: prefixId(sid),
        });
      }
    };

    // ── thread/start 或 thread/resume ────────────────────────────────────────
    // 防御: resumeSessionId 偶尔会是上次失败 session 残留的占位 ('<failed>' / '<pending>')
    // 或非 UUID 格式 — server 直接 -32600 invalid thread id, 整个 session 起不来。
    // 看到不像 UUID 就走新 thread/start, 不让 ghost id 阻塞用户。
    const isLikelyValidThreadId = (id: string | undefined): id is string =>
      typeof id === 'string' && id.length > 0 && !id.startsWith('<') && /^[0-9a-fA-F-]+$/.test(id);
    if (opts.resumeSessionId && !isLikelyValidThreadId(opts.resumeSessionId)) {
      log.warn('resumeSessionId looks invalid, falling back to thread/start', {
        resumeSessionId: opts.resumeSessionId,
      });
    }
    const developerInstructions = buildCodexDeveloperInstructions({
      makerMemoryRules,
      runtimeSystemPrompt: this.deps.runtimeConfig.systemPrompt,
      makerMemoryIndex,
      userPrompt: opts.userPrompt,
    });
    const useProxyChannel = isCodexProxyChannelReady();
    let threadId: string;
    let codexProductPromptDelivery: AgentSessionHandle['codexProductPromptDelivery'];

    /**
     * 会话中途把单个设置 (serviceTier / model / effort) 立即推给 app-server,
     * 写入后续 turn 的 sticky context — 不必等下一个 turn/start 携带 (与官方
     * Codex Desktop 的 thread/settings/update 通道对齐; experimentalApi 已恒开,
     * 0.142.0 实测支持)。
     *
     * - 门: 只在 thread 已 start (threadId 就绪) 且会话未关时发; thread/start 前的
     *   设置由首个 thread/start 携带, 不需要这条。
     * - **串行化**: 用 promise 链把多条 update 排队顺序发 (前一条 ack 后再发下一条)。
     *   renderer 单次切换会并发触发 setModel/setEffort/setFastMode, 若并发发送, server
     *   回带的 thread/settings/updated 通知会乱序到达, reconcile 出现中间态闪现 (实测过
     *   null→fast→default)。串行后 server 按序处理、通知按序回, 最终态一次到位。
     * - serviceTier 双 Option: 调用方传 'fast' (开) / null (清空); 不传该 key = 不变。
     * - **失败吞错**: settings/update 失败绝不抛 — turn/start 携带仍是兜底, 会话不受
     *   影响。server 回 ack 后真正状态经 thread/settings/updated 通知回带 (见 handlers)。
     *
     * 返回入队任务的 promise (链已 catch, 永不 reject), 调用方可 await 到本次发送完成。
     */
    let settingsUpdateChain: Promise<void> = Promise.resolve();
    const pushThreadSettings = (patch: Omit<ThreadSettingsUpdateParams, 'threadId'>): Promise<void> => {
      if (!threadId || closed) return Promise.resolve();
      const run = settingsUpdateChain.then(async () => {
        if (!threadId || closed) return; // 排到队头时再校验一次 (期间可能已 close)
        if (skipIfStaleHost('thread/settings/update')) return;
        try {
          await host.request<ThreadSettingsUpdateResponse>(Method.ThreadSettingsUpdate, {
            threadId,
            ...patch,
          });
        } catch (e) {
          log.warn('thread/settings/update failed (turn/start carry remains fallback)', {
            threadId,
            patchKeys: Object.keys(patch),
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
      settingsUpdateChain = run;
      return run;
    };
    if (opts.resumeSessionId && isLikelyValidThreadId(opts.resumeSessionId)) {
      // Phase 3: thread/resume 真接通, 不再 fallback 到 thread/start
      if (this.deps.prepareCodexResumeSession) {
        try {
          await this.deps.prepareCodexResumeSession(opts.resumeSessionId);
        } catch (e) {
          log.warn('prepareCodexResumeSession failed, continuing to thread/resume', {
            resumeSessionId: opts.resumeSessionId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const params: ThreadResumeParams = {
        threadId: opts.resumeSessionId,
        ...(resumeExcludeTurnsSupported ? { excludeTurns: true } : {}),
        cwd: opts.workingDir,
        ...currentThreadWorkspaceConfig(),
        ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
        ...(mutableModel && mutableModel !== 'gpt-5' ? { model: mutableModel } : {}),
        ...(mutableServiceTier !== undefined ? { serviceTier: mutableServiceTier } : {}),
        ...(developerInstructions && !useProxyChannel && opts.codexHistoryHasProductPrompt !== true
          ? { developerInstructions }
          : {}),
      };
      try {
        acquireHostBindingLeaseIfNeeded();
        assertCurrentHost('thread/resume');
        const resp = await host.request<ThreadResumeResponse>(Method.ThreadResume, params, {
          timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS,
        });
        assertCurrentHost('thread/resume');
        if (Object.hasOwn(resp, 'serviceTier')) {
          mutableServiceTier = normalizeServiceTier(resp.serviceTier) ?? null;
        }
        if (mutableModel === 'gpt-5' && resp.model) {
          mutableModel = resp.model;
        }
        threadId = resp.thread.id;
        registerCodexReviewerRouteContext(threadId);
        if (useProxyChannel) {
          registerCodexDeveloperInstructions(threadId, developerInstructions);
          codexProductPromptDelivery = { threadId, historyHasProductPrompt: false };
        } else if (developerInstructions && opts.codexHistoryHasProductPrompt !== true) {
          codexProductPromptDelivery = { threadId, historyHasProductPrompt: true };
        }
        sdkSessionId = threadId;
        readonlyReferencesProfileActive = shouldUseReadonlyReferencesProfile();
        threadMayHaveRollout = true;
        // Resumed app-server threads may have sticky collaborationMode='plan' from
        // a previous handle whose plan cycle ended without a follow-up turn. Since
        // that sticky state lives server-side, conservatively send mode:'default'
        // on future normal turns after any successful resume.
        threadTouchedPlanMode = true;
        // excludeTurns intentionally loads no history, so we cannot prove whether
        // the persisted thread last used Plan Mode. Inject the official Default
        // marker once; markCollaborationModeAccepted() suppresses repeats.
        planModeDefaultMarkerNeeded = true;
        log.info('thread/resume ok', { threadId, model: resp.model, serviceTier: mutableServiceTier ?? null });
      } catch (e) {
        releaseHostBindingLeaseIfNeeded();
        log.error('thread/resume failed', { error: String(e), resumeSessionId: opts.resumeSessionId });
        const message = `Failed to resume Codex thread: ${String(e)}`;
        eventQueue.push({
          type: 'error',
          data: { message, isTerminal: true },
          source: 'codex',
        });
        eventQueue.end();
        throw new Error(message);
      }
    } else {
      // developerInstructions 五段拼接 (协议见 thread/start.developerInstructions):
      //   [2] MAKER_CODEX_SYSTEM_PROMPT_APPEND — maker engine (system-prompt-append.md)
      //   [3] makerMemoryRules                 — maker memory 写入规范 (条件式)
      //   [4] runtimeConfig.systemPrompt       — host runtime (host 维护的 .md)
      //   [5] makerMemoryIndex                 — 当前 workdir MEMORY.md 内容 (条件式,
      //                                          紧邻 userPrompt 高优先级, 启动时快照)
      //   [6] opts.userPrompt                  — per-call 用户级 (renderer 本地 storage,
      //                                          每次 startSession 透传, 优先级最高)
      // 跟 claude-code 六段语义对齐。空段被 .filter 跳过,
      // 内容为空时不发送 developerInstructions 字段。
      const params: ThreadStartParams = {
        cwd: opts.workingDir,
        ...currentThreadWorkspaceConfig(),
        ...(shouldRegisterAskUserDynamicTool(opts) ? { dynamicTools: [ASK_USER_DYNAMIC_TOOL] } : {}),
        ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
        ...(mutableModel && mutableModel !== 'gpt-5' ? { model: mutableModel } : {}),
        ...(mutableServiceTier !== undefined ? { serviceTier: mutableServiceTier } : {}),
        ...(developerInstructions && !useProxyChannel ? { developerInstructions } : {}),
      };
      try {
        acquireHostBindingLeaseIfNeeded();
        assertCurrentHost('thread/start');
        const resp = await host.request<ThreadStartResponse>(Method.ThreadStart, params, {
          timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS,
        });
        assertCurrentHost('thread/start');
        if (Object.hasOwn(resp, 'serviceTier')) {
          mutableServiceTier = normalizeServiceTier(resp.serviceTier) ?? null;
        }
        if (mutableModel === 'gpt-5' && resp.model) {
          mutableModel = resp.model;
        }
        threadId = resp.thread.id;
        registerCodexReviewerRouteContext(threadId);
        if (useProxyChannel) {
          registerCodexDeveloperInstructions(threadId, developerInstructions);
          codexProductPromptDelivery = { threadId, historyHasProductPrompt: false };
        } else if (developerInstructions) {
          codexProductPromptDelivery = { threadId, historyHasProductPrompt: true };
        }
        sdkSessionId = threadId;
        readonlyReferencesProfileActive = shouldUseReadonlyReferencesProfile();
        threadMayHaveRollout = false;
        log.info('thread/start ok', { threadId, model: resp.model, serviceTier: mutableServiceTier ?? null });
      } catch (e) {
        releaseHostBindingLeaseIfNeeded();
        log.error('thread/start failed', { error: String(e) });
        const message = `Failed to start Codex thread: ${String(e)}`;
        eventQueue.push({
          type: 'error',
          data: { message, isTerminal: true },
          source: 'codex',
        });
        eventQueue.end();
        throw new Error(message);
      }
    }

    const requestProfileLifecycle = <Response>({
      action,
      signal,
      request,
      onLateResolve,
    }: {
      action: 'refresh' | 'replacement';
      signal?: AbortSignal;
      request: () => Promise<Response>;
      onLateResolve?: (response: Response) => Promise<void> | void;
    }): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const resolveOnce = (value: Response) => {
          if (settled) {
            if (onLateResolve) {
              void Promise.resolve(onLateResolve(value)).catch((error) => {
                log.warn(`late read-only reference profile ${action} cleanup threw`, {
                  error: String(error),
                  threadId,
                });
              });
            }
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        };
        const rejectOnce = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          rejectOnce(new Error('Codex send cancelled before acceptance'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        timer = setTimeout(() => {
          rejectOnce(
            new Error(
              `Codex read-only reference profile ${action} did not acknowledge within ${PROFILE_LIFECYCLE_ACK_TIMEOUT_MS}ms`,
            ),
          );
        }, PROFILE_LIFECYCLE_ACK_TIMEOUT_MS);
        timer.unref?.();
        try {
          request().then(
            resolveOnce,
            (error) => rejectOnce(
              error instanceof Error ? error : new Error(String(error)),
            ),
          );
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
        }
      });

    /**
     * A thread that has not accepted a turn has no rollout and cannot be
     * resumed. Recreate that unused thread with the current profile instead,
     * then move the live subscription and thread-scoped registrations.
     */
    const replaceUnusedThreadWithCurrentProfile = async (
      signal?: AbortSignal,
    ): Promise<void> => {
      const previousThreadId = threadId;
      const replacementServiceTierGeneration = serviceTierMutationGeneration;
      const inheritedHostBindingLease = releaseHostBindingLease !== null;
      acquireHostBindingLeaseIfNeeded();
      try {
        assertCurrentHost('read-only reference profile replacement');
        const resp = await requestProfileLifecycle<ThreadStartResponse>({
          action: 'replacement',
          signal,
          request: () => host.request<ThreadStartResponse>(Method.ThreadStart, {
            cwd: opts.workingDir,
            ...currentThreadWorkspaceConfig(),
            ...(shouldRegisterAskUserDynamicTool(opts) ? { dynamicTools: [ASK_USER_DYNAMIC_TOOL] } : {}),
            ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
            ...(mutableModel && mutableModel !== 'gpt-5' ? { model: mutableModel } : {}),
            ...(mutableServiceTier !== undefined ? { serviceTier: mutableServiceTier } : {}),
            ...(developerInstructions && !useProxyChannel ? { developerInstructions } : {}),
          }),
          onLateResolve: async (lateResp) => {
            const lateThreadId = lateResp.thread.id;
            if (lateThreadId === previousThreadId) return;
            await host.unsubscribeThread(lateThreadId);
            log.debug('discarded late unused profile replacement', {
              previousThreadId,
              threadId: lateThreadId,
            });
          },
        });
        assertCurrentHost('read-only reference profile replacement');
        const nextThreadId = resp.thread.id;
        if (closed) {
          try {
            await host.unsubscribeThread(nextThreadId);
          } catch (e) {
            log.warn('unused profile replacement cleanup threw after close', {
              error: String(e),
              threadId: nextThreadId,
            });
          }
          throw new Error('Codex session closed during read-only reference profile replacement');
        }
        if (
          Object.hasOwn(resp, 'serviceTier') &&
          replacementServiceTierGeneration === serviceTierMutationGeneration
        ) {
          mutableServiceTier = normalizeServiceTier(resp.serviceTier) ?? null;
        }
        if (nextThreadId !== previousThreadId) {
          try {
            await subscription?.release();
          } catch (e) {
            log.warn('unused profile replacement release threw', {
              error: String(e),
              threadId: previousThreadId,
            });
          }
          unregisterCodexMcpContext(previousThreadId);
          if (closed) {
            try {
              await host.unsubscribeThread(nextThreadId);
            } catch (e) {
              log.warn('unused profile replacement cleanup threw after concurrent close', {
                error: String(e),
                threadId: nextThreadId,
              });
            }
            throw new Error('Codex session closed during read-only reference profile replacement');
          }
          threadId = nextThreadId;
          sdkSessionId = nextThreadId;
          subscription = host.subscribeThread(threadId, handlers);
          registerCodexMcpContext(threadId);
          registerCodexReviewerRouteContext(threadId);
          eventQueue.push({ type: 'session_id', data: sdkSessionId, source: 'codex' });
          if (replacementServiceTierGeneration !== serviceTierMutationGeneration) {
            // setFastMode() updated the old thread while thread/start was
            // pending. turn/start still carries the current value; reapply the
            // sticky thread setting without blocking dispatch.
            void pushThreadSettings({ serviceTier: mutableServiceTier ?? null });
          }
        }
        if (useProxyChannel) {
          registerCodexDeveloperInstructions(threadId, developerInstructions);
          codexProductPromptDelivery = { threadId, historyHasProductPrompt: false };
        } else {
          codexProductPromptDelivery = developerInstructions
            ? { threadId, historyHasProductPrompt: true }
            : undefined;
        }
        readonlyReferencesProfileActive = shouldUseReadonlyReferencesProfile();
        threadMayHaveRollout = false;
        log.debug('unused thread replaced with read-only reference profile', {
          previousThreadId,
          threadId,
          referenceRoots: mutableExtraDirs.length,
        });
      } finally {
        if (!inheritedHostBindingLease) releaseHostBindingLeaseIfNeeded();
      }
    };

    /**
     * turn/start cannot select a profile that only exists in this thread's
     * per-request config. Most turns simply inherit the profile selected by
     * thread/start. A live thread only needs a refresh after it previously used
     * a sandboxPolicy (for example Full access), or when references are added
     * to a thread that started without them.
     */
    const ensureReadonlyReferencesProfileForNextTurn = (
      signal?: AbortSignal,
    ): Promise<void> | null => {
      if (!shouldUseReadonlyReferencesProfile() || readonlyReferencesProfileActive) return null;
      return (async () => {
        if (!threadMayHaveRollout) {
          await replaceUnusedThreadWithCurrentProfile(signal);
          return;
        }
        const resumeThreadWorkspaceConfig = currentThreadWorkspaceConfig();
        const resumeServiceTierGeneration = serviceTierMutationGeneration;
        assertCurrentHost('read-only reference profile refresh');
        let resp: ThreadResumeResponse;
        try {
          resp = await requestProfileLifecycle<ThreadResumeResponse>({
            action: 'refresh',
            signal,
            request: () => host.request<ThreadResumeResponse>(Method.ThreadResume, {
              threadId,
              ...(resumeExcludeTurnsSupported ? { excludeTurns: true } : {}),
              cwd: opts.workingDir,
              ...resumeThreadWorkspaceConfig,
              ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
              ...(mutableModel && mutableModel !== 'gpt-5' ? { model: mutableModel } : {}),
              ...(mutableServiceTier !== undefined ? { serviceTier: mutableServiceTier } : {}),
            }),
          });
        } catch (e) {
          if (!/no rollout found/i.test(String(e))) throw e;
          if (signal?.aborted) throw new Error('Codex send cancelled before acceptance');
          threadMayHaveRollout = false;
          await replaceUnusedThreadWithCurrentProfile(signal);
          return;
        }
        assertCurrentHost('read-only reference profile refresh');
        if (
          Object.hasOwn(resp, 'serviceTier') &&
          resumeServiceTierGeneration === serviceTierMutationGeneration
        ) {
          mutableServiceTier = normalizeServiceTier(resp.serviceTier) ?? null;
        } else if (resumeServiceTierGeneration !== serviceTierMutationGeneration) {
          void pushThreadSettings({ serviceTier: mutableServiceTier ?? null });
        }
        readonlyReferencesProfileActive = 'permissions' in resumeThreadWorkspaceConfig;
        threadMayHaveRollout = true;
        log.debug('read-only reference profile restored before turn/start', {
          threadId,
          referenceRoots: mutableExtraDirs.length,
        });
      })();
    };

    // ── dispatchInteraction + pendingApprovals (Claude 同款 dismissAllPending 模式) ──
    //
    // 为什么需要 pendingApprovals Map: server 发来 ServerRequest, 我们 await
    // dispatchInteraction(...) 等用户点 PermissionPrompt。期间用户在另一处 UI
    // 切了 permissionMode → setPermissionMode 应该把所有挂起的请求按新 mode
    // 自动 resolve (allow/deny), 同时 emit interaction_dismissed 让 dialog 自动关。
    // 不维护 pending Map 的话, 切 mode 不影响挂起 dialog → UX bug。
    interface PendingEntry {
      resolve: (decision: ApprovalDecision) => void;
      kind: 'commandExecution' | 'fileChange' | 'mcpServerElicitation';
      settled: boolean;
      /** prompt-each-time 高风险审批: 宽松模式也必须弹 UI, dismissAllPending('allow') 不得放行 */
      forcePrompt?: boolean;
    }
    const pendingApprovals = new Map<string, PendingEntry>();
    const seenGuardianReviewIds = new Set<string>();
    const userInputBroker = new CodexInteractionBroker<ToolRequestUserInputResponse>();
    const dynamicToolBroker = new CodexInteractionBroker<DynamicToolCallResponse>();
    const activeToolContexts = new Map<string, ActiveToolContext>();
    registerCodexMcpContext(threadId);
    let mcpElicitationSeq = 0;

    const codexSessionApprovalSuggestions = () =>
      this.createSessionPermissionUpdates({ type: 'codexSessionApproval' });

    const mapPermissionDecisionToApproval = (
      decision: Extract<InteractionDecision, { kind: 'permission' }>,
    ): ApprovalDecision => {
      if (decision.behavior === 'allow' && this.permissionDecisionRequestsSessionApproval(decision)) {
        return 'acceptForSession';
      }
      return mapBehaviorToApproval(decision.behavior);
    };

    function defaultInteractionDecision(req: InteractionRequest, reason: string): InteractionDecision {
      if (req.kind === 'ask_user_question') {
        return { kind: 'ask_user_question', answers: {} };
      }
      if (req.kind === 'plan_review') {
        // dismissed: 系统性 deny(无 resolver / resolver 抛错), reason 是系统代码,
        // 绝不能被 plan 修订循环当成用户反馈发起修订 turn。
        return { kind: 'plan_review', behavior: 'deny', reason, dismissed: true };
      }
      return { kind: 'permission', behavior: 'deny', reason };
    }

    async function dispatchInteraction(req: InteractionRequest): Promise<InteractionDecision> {
      if (!interactionResolver) {
        log.warn('dispatchInteraction without resolver — defaulting to deny', { kind: req.kind, requestId: req.requestId });
        return defaultInteractionDecision(req, 'no_interaction_resolver');
      }
      try {
        return await interactionResolver(req);
      } catch (e) {
        log.error('interactionResolver threw → deny', { kind: req.kind, message: (e as Error).message });
        return defaultInteractionDecision(req, 'interaction_resolver_error');
      }
    }

    /**
     * 计划模式审批闭环 (对齐官方 TUI plan_implementation 流程, 全部代码驱动):
     * plan turn 结束 → 把捕获的 proposed plan 发给用户审批 (plan_review, 复用
     * Claude 同款 PlanViewerCard/PlanActionCard UI) →
     *   - 批准: 退出计划模式 (emit plan_mode_changed 让 host 回写持久化), 下一
     *     turn 经 collaborationMode default 复位, 并自动发起实施 turn
     *     ("Implement the plan.", 用户编辑过计划时附修订版全文);
     *   - 反馈: 保持计划模式, 把反馈作为下一 plan turn 的输入让模型修订计划
     *     (Claude 的 deny+reason 在同 turn 内回给模型; codex turn 已结束, 只能开新 turn);
     *   - 取消 / 无反馈的 deny (会话关闭 / 交互被 dismiss): 结束本轮循环, 下一条
     *     消息回到常规模式(想再规划需重新勾选), 不发起任何新 turn。
     */
    async function runPlanReviewFlow(plan: string, turnId: string): Promise<void> {
      planReviewSeq += 1;
      const requestId = `codex-plan-review:${turnId}:${planReviewSeq}`;
      const emitPlanFollowUpStartFailure = (kind: 'implementation' | 'revision', error: unknown): void => {
        log.warn(`plan ${kind} turn failed to start`, { error: String(error) });
        // If handle.send throws before it can emit its own terminal event (for
        // example a stale-host assertion before turn/start), main still needs a
        // terminal signal to release the resolved plan_review busy boundary and
        // re-check queued composer messages.
        eventQueue.push({
          type: 'error',
          data: { message: `plan ${kind} turn failed to start: ${String(error)}`, isTerminal: true },
          source: 'codex',
        });
        eventQueue.push({
          type: 'status',
          data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
          source: 'codex',
        });
      };
      log.debug('plan review ▶ dispatch', { turnId, planChars: plan.length });
      const decision = await dispatchInteraction({ kind: 'plan_review', requestId, plan });
      if (closed) return;
      if (decision.kind !== 'plan_review') {
        log.warn('plan review got mismatched decision', { decKind: decision.kind });
        return;
      }
      if (decision.behavior === 'allow') {
        planCycleActive = false;
        // 兜底: 审阅期间用户又重新勾选了计划模式 → 尊重批准语义, 一并消耗掉。
        if (mutablePlanMode) {
          mutablePlanMode = false;
          eventQueue.push({ type: 'plan_mode_changed', data: { enabled: false }, source: 'codex' });
        }
        const edited = decision.editedPlan?.trim();
        const message = edited && edited !== plan.trim()
          ? `${PLAN_IMPLEMENTATION_MESSAGE} Follow this revised plan:\n\n${edited}`
          : PLAN_IMPLEMENTATION_MESSAGE;
        log.debug('plan review ◀ approved — starting implementation turn', { turnId, edited: Boolean(edited && edited !== plan.trim()) });
        try {
          await handle.send(
            { type: 'user', content: message },
            activeTurnPermissionPolicy
              ? { turnPermissionPolicy: activeTurnPermissionPolicy }
              : undefined,
          );
        } catch (e) {
          emitPlanFollowUpStartFailure('implementation', e);
        }
        return;
      }
      const feedback = decision.reason?.trim();
      // 系统性 dismissal(abort/close/mode 切换等自动 deny)或无反馈 → 结束本轮循环,
      // 绝不把系统 reason 当用户反馈发修订 turn。
      if (decision.dismissed || !feedback || SYSTEM_PLAN_REVIEW_DISMISSAL_REASONS.has(feedback)) {
        // 一次性语义: 取消/系统 dismissal 同样结束本轮循环 —— 下一条消息回到常规模式,
        // 想再规划需重新勾选。
        planCycleActive = false;
        log.debug('plan review ◀ dismissed — plan cycle ends', {
          turnId,
          dismissed: decision.dismissed === true,
          reason: decision.reason ?? null,
        });
        return;
      }
      log.debug('plan review ◀ revision requested — starting plan revision turn', { turnId });
      try {
        await handle.send(
          { type: 'user', content: feedback },
          activeTurnPermissionPolicy
            ? { turnPermissionPolicy: activeTurnPermissionPolicy }
            : undefined,
        );
      } catch (e) {
        planCycleActive = false;
        proposedPlanText = null;
        emitPlanFollowUpStartFailure('revision', e);
      }
    }

    /**
     * 用 Promise.race 把"用户点按钮"和"外部 dismissAllPending 强制 resolve"两条路统一成
     * 一个 Promise<ApprovalDecision>。dispatchInteraction 完成时若 entry 还没 settled
     * 就走用户决策; settled=true 说明 dismissAllPending 已经替它做了决定, 用户后续点了也吞掉。
     */
    function awaitApprovalDecision(
      requestId: string,
      kind: 'commandExecution' | 'fileChange' | 'mcpServerElicitation',
      req: InteractionRequest,
      opts?: { forcePrompt?: boolean },
    ): Promise<ApprovalDecision> {
      const forcePrompt =
        opts?.forcePrompt === true ||
        (req.kind === 'permission' &&
          forceTurnConfirmation(req.toolName, req.input));
      // Full access 的普通审批不应打断用户。Auto 在已验证路由上由 app-server
      // auto_review 负责；降级路由则由 user reviewer 把越界请求发回客户端。
      // 两条路径只要收到请求都走 UI，不能绕过 reviewer / 降级审批直接放行。
      // forcePrompt 高风险 MCP inner tool
      // (如 contacts delete/merge/系统回写)在任何模式下都必须拿到用户的逐次确认。
      if (
        !forcePrompt &&
        mutablePermissionMode === 'bypassPermissions'
      ) {
        return Promise.resolve('accept');
      }
      // Policy turns deliberately route otherwise-unattended Auto actions back
      // through the host. Preserve Auto semantics by accepting non-forced
      // callbacks without opening Desktop UI.
      if (
        !forcePrompt &&
        activeTurnPermissionPolicy &&
        mutablePermissionMode === 'auto'
      ) {
        return Promise.resolve('accept');
      }
      const routedRequest =
        forcePrompt && req.kind === 'permission'
          ? { ...req, suggestions: undefined }
          : req;
      return new Promise<ApprovalDecision>((resolve) => {
        const entry: PendingEntry = { resolve, kind, settled: false, forcePrompt };
        pendingApprovals.set(requestId, entry);
        const finalize = (d: ApprovalDecision) => {
          if (entry.settled) return;
          entry.settled = true;
          pendingApprovals.delete(requestId);
          // A stale/custom UI may still return a session grant. Forced policy
          // confirmation applies to this call only and must never persist.
          resolve(forcePrompt && d === 'acceptForSession' ? 'accept' : d);
        };
        dispatchInteraction(routedRequest)
          .then((decision) => {
            if (decision.kind !== 'permission') {
              log.warn('unexpected non-permission decision → decline', { kind: decision.kind });
              finalize('decline');
              return;
            }
            finalize(mapPermissionDecisionToApproval(decision));
          })
          .catch((e) => {
            log.error('dispatchInteraction threw → decline', { requestId, message: (e as Error).message });
            finalize('decline');
          });
      });
    }

    /**
     * 强制 resolve 所有挂起的 approval, emit interaction_dismissed 让 UI 关 dialog。
     * 调用场景: setPermissionMode 切换 / close session。
     *   - resolveAs='allow' (mode 切到 bypass; forcePrompt 仍 fail-closed): decision='accept'
     *   - resolveAs='deny'  (mode 切到 ask/auto 或 close): decision='decline'
     */
    function dismissAllPending(reason: string, resolveAs: 'allow' | 'deny'): void {
      if (pendingApprovals.size === 0) return;
      const entries = Array.from(pendingApprovals.entries());
      for (const [requestId, entry] of entries) {
        if (entry.settled) continue;
        entry.settled = true;
        pendingApprovals.delete(requestId);
        // forcePrompt(prompt-each-time 高风险审批)不接受"切到宽松模式"的批量放行——
        // 没拿到用户对这一次调用的明确确认就 fail-closed 拒绝, 与 awaitApprovalDecision
        // 里宽松模式仍强制弹 UI 的语义一致。
        const effectiveResolveAs: 'allow' | 'deny' =
          resolveAs === 'allow' && entry.forcePrompt === true ? 'deny' : resolveAs;
        entry.resolve(effectiveResolveAs === 'allow' ? 'accept' : 'decline');
        eventQueue.push({
          type: 'interaction_dismissed',
          data: { requestId, reason, resolvedAs: effectiveResolveAs },
          source: 'codex',
        });
      }
    }

    const cancelledDynamicToolResponse = (reason: string): DynamicToolCallResponse => ({
      contentItems: [{ type: 'inputText', text: `Request cancelled: ${reason}` }],
      success: false,
    });

    function dismissPendingUserInput(
      reason: string,
      predicate: (meta: { threadId?: string; turnId?: string | null }) => boolean,
    ): void {
      const dismissed = new Set<string>();
      const cancelledUserInput = userInputBroker.cancelWhere(
        predicate,
        { answers: {} },
      );
      const cancelledDynamicTools = dynamicToolBroker.cancelWhere(
        predicate,
        cancelledDynamicToolResponse(reason),
      );
      for (const meta of [...cancelledUserInput, ...cancelledDynamicTools]) {
        const requestId = String(meta.requestId);
        if (dismissed.has(requestId)) continue;
        dismissed.add(requestId);
        eventQueue.push({
          type: 'interaction_dismissed',
          data: { requestId, reason, resolvedAs: 'deny' },
          source: 'codex',
        });
      }
    }

    function dismissPendingUserInputForTurn(turnId: string, reason: string): void {
      dismissPendingUserInput(reason, (meta) => meta.turnId === turnId);
    }

    function dismissAllPendingUserInput(reason: string): void {
      dismissPendingUserInput(reason, (meta) => meta.threadId === threadId);
    }

    /**
     * 权限收紧 (auto/bypass → ask) 的 fail-safe 中断: Auto 的 auto_review / Full access
     * turn 都是无人值守策略,切换到 Ask 时必须中断当前 turn,
     * 本地 awaitApprovalDecision 无从拦截 —— 中断该 turn 是唯一能立即兑现
     * 「从现在起要问我」的机制。语义与用户手动 stop 一致 (interrupted 不算失败)。
     *
     * 两个触发点共用:
     *   - setPermissionMode: turn id 已知 (currentTurnId) 时立即中断;
     *   - turn/start 在飞 (isTurnStartPending, id 未回) 时置 pendingTightenInterrupt,
     *     由 handleTurnStartResp / turnStarted 通知在拿到 id 的瞬间补中断 ——
     *     那次 turn/start 已携带旧的宽松策略发出,不补会继续无人值守跑到结束。
     */
    let pendingTightenInterrupt = false;
    /**
     * 最近一次 send 的 turn 是否以无人值守策略发射 (覆盖在飞与运行中两个阶段)。
     * auto_review / never / Auto policy turn 在收紧时需要中断;普通 user reviewer
     * 发射的 turn 审批请求照常流经本地、收紧即时生效,即使期间 UI 短暂切过
     * 宽松档也不得误杀。
     */
    let turnLaunchedUnattended = false;
    /**
     * turn/start RPC 响应回来之前就已收到终态 (turnCompleted) 的 turn 墓碑。
     * 收紧补中断是 fire-and-forget: turnStarted 通知先到 → 立即中断 → server 的
     * turnCompleted(interrupted) 可能仍抢在 RPC 响应之前到达; handleTurnStartResp
     * 若无此墓碑会把已终结的 turn 重新置为运行中, 会话永远卡在 running
     * (review #969 第四轮 Codex P2)。send 入口清空 (每个 send 周期独立)。
     */
    const turnsCompletedBeforeStartResp = new Set<string>();
    /**
     * @param opts.suppressFailureEvent 终失败时不推 'permission-tighten-interrupt-failed'
     *        非终态 error。给 upstream-idle watchdog 用:它已经推过一条终态 error,
     *        再补一条"收紧权限时没能停下任务"既词不达意也是重复打扰;它对失败的处置
     *        是直接作废 host(见 onUpstreamIdleTimeout)。
     * @returns true = app-server 确认收到中断;false = 两次 ack 都超时/报错(daemon
     *          对我们哑火)。调用方据此决定要不要升级处置;忽略返回值即维持原行为。
     */
    async function interruptTurnForPermissionTighten(
      turnId: string,
      opts?: { suppressFailureEvent?: boolean },
    ): Promise<boolean> {
      if (closed) return false;
      if (skipIfStaleHost('turn/interrupt')) return false;
      dismissPendingUserInputForTurn(turnId, 'turn_interrupted');
      // 每次尝试都设有界超时: app-server / 连接无响应时该 RPC 会永久悬挂, 没有
      // 超时就既不会走重试、也不会透出失败提示, 免审 turn 将无声继续跑
      // (review #969 第六轮 Greptile P1)。超时后迟到的 settle 结果静默吞掉。
      const requestInterruptWithTimeout = (): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`turn/interrupt did not acknowledge within ${TIGHTEN_INTERRUPT_ACK_TIMEOUT_MS}ms`));
          }, TIGHTEN_INTERRUPT_ACK_TIMEOUT_MS);
          host.request(Method.TurnInterrupt, { threadId, turnId }).then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (err) => {
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
        });
      try {
        await requestInterruptWithTimeout();
        return true;
      } catch (e) {
        // 这次 RPC 是收紧 fail-safe 的唯一执行手段, 失败不能静默: 重试一次,
        // 仍失败则透出非终态 error —— UI 已按 ask 展示, 但免审 turn 还在跑,
        // 用户需要知情并可手动 stop (review #969 第五轮 Codex P2)。
        log.warn('turn/interrupt on permission tighten threw — retrying once', { error: String(e) });
        try {
          await requestInterruptWithTimeout();
          return true;
        } catch (retryErr) {
          log.error('turn/interrupt on permission tighten failed after retry', { error: String(retryErr) });
          if (opts?.suppressFailureEvent) return false;
          eventQueue.push({
            type: 'error',
            data: {
              // reason 是 renderer i18n 的稳定 key (ERROR_REASON_I18N_KEYS, 规则 18);
              // message 仅作非 renderer 消费方 (IM / orca) 的英文兜底。
              reason: 'permission-tighten-interrupt-failed',
              message:
                'Failed to stop the running task while tightening permissions; it may keep running without approval prompts until it finishes. Stop it manually if needed.',
              isTerminal: false,
            },
            source: 'codex',
          });
          return false;
        }
      }
    }

    // ── upstream-response-idle watchdog ────────────────────────────────────
    // 见 CODEX_UPSTREAM_IDLE_TIMEOUT_DEFAULT_MS。探针装在 eventQueue.push 上而不是
    // 逐个 handler 里:所有投递给上层的事件都必经这里,一处覆盖全部通道(item /
    // reasoning / status / error),不会因为漏改某个 handler 就让 watchdog 少收到
    // "还活着"的信号。这段刻意放在 interruptTurnForPermissionTighten 之后:它依赖
    // closed / isTurnInFlight / threadId / 中断实现,全部已在上文声明。
    const upstreamIdleTimeoutMs = parseCodexIdleTimeoutMs(process.env.XDT_CODEX_IDLE_TIMEOUT_MS);
    /** 未完成的工具类 item id;非空 = 球不在上游,watchdog 停表。 */
    const pendingToolItemIds = new Set<string>();
    let upstreamIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let upstreamIdleLastEventType: string | null = null;
    let upstreamIdleLastEventAt = 0;
    /** 还需要"清醒地"静默多久才判上游哑火;按分片递减(见 armUpstreamIdleSlice)。 */
    let upstreamIdleRemainingMs = 0;
    /** 当前分片的起始壁钟时刻;片尾据此识别系统挂起。 */
    let upstreamIdleSliceStartedAt = 0;
    function clearUpstreamIdle(): void {
      if (upstreamIdleTimer) {
        clearTimeout(upstreamIdleTimer);
        upstreamIdleTimer = null;
      }
      upstreamIdleRemainingMs = 0;
      upstreamIdleSliceStartedAt = 0;
    }
    function armUpstreamIdle(): void {
      clearUpstreamIdle();
      if (upstreamIdleTimeoutMs <= 0) return;
      if (closed || !isTurnInFlight) return;
      // 工具执行 / 等审批期间 ball 不在上游,不计 idle 配额。
      if (pendingToolItemIds.size > 0) return;
      upstreamIdleRemainingMs = upstreamIdleTimeoutMs;
      armUpstreamIdleSlice();
    }
    /**
     * 分片计时,片尾核对真实耗时。不能用一个 30 分钟的长定时器直接判定 —— Electron 被
     * 系统挂起(合盖睡眠)期间没有任何事件,定时器一旦在唤醒后到期就立刻开火,一次午休
     * 就能让看门狗中断一条完全健康的 turn(review #944 第十二轮 P1,与 Session 层的
     * armTurnStallSlice、claude-code 的 armUpstreamResponseIdleSlice、scheduler 的
     * absorbSuspendGap 同源)。
     */
    function armUpstreamIdleSlice(): void {
      const slice = Math.min(upstreamIdleRemainingMs, CODEX_UPSTREAM_IDLE_SLICE_MS);
      upstreamIdleSliceStartedAt = Date.now();
      upstreamIdleTimer = setTimeout(() => {
        upstreamIdleTimer = null;
        const elapsed = Date.now() - upstreamIdleSliceStartedAt;
        if (elapsed > slice + CODEX_UPSTREAM_IDLE_SUSPEND_GAP_MS) {
          log.info('upstream-idle watchdog skipped a suspended slice', {
            threadId,
            sliceMs: slice,
            elapsedMs: elapsed,
          });
          // 唤醒后状态可能已变(turn 结束 / 又有工具在跑),走完整重判。
          armUpstreamIdle();
          return;
        }
        upstreamIdleRemainingMs -= Math.max(0, elapsed);
        if (upstreamIdleRemainingMs > 0) {
          armUpstreamIdleSlice();
          return;
        }
        onUpstreamIdleTimeout();
      }, slice);
      (upstreamIdleTimer as unknown as { unref?: () => void }).unref?.();
    }
    /**
     * 退役这个已确诊无响应的共享 app-server。写成箭头函数:下面的看门狗是 function
     * 声明,拿不到实例 this。
     *
     * **只退役当初超时的那个 host 实例**:两次 interrupt ack 要等 20s,期间别的路径
     * (auth / 凭证重启等)完全可能已经把这个 key 下的 host 换成一个新的健康实例。
     * retireHostKey 只按 key 查删,不加这道闸就会把新 host 退役、连带终止它名下正在
     * 干活的会话(review #944 第九轮 P1)。isCurrentHost 同时校验实例身份与
     * hostGeneration,与 skipIfStaleHost 同款判据。
     */
    const retireUnresponsiveHost = async (reason: string): Promise<void> => {
      if (!isCurrentHost()) {
        log.warn('upstream-idle watchdog: host already replaced, skipping retire', {
          threadId,
          hostKey: currentHostKey,
        });
        return;
      }
      await this.retireHostKey(currentHostKey, reason, {
        failIfActive: false,
        logPrefix: 'codex upstream-idle watchdog',
      });
    };
    /** turn 结束 / 中断时收表并清工具项(终态可能先于 item completed 到达)。 */
    function resetUpstreamIdleForTurnEnd(): void {
      clearUpstreamIdle();
      pendingToolItemIds.clear();
    }
    /**
     * itemStarted / itemCompleted 上维护"球在谁手里"。type / id 缺失的 item 不追踪
     * (宁可少停表:watchdog 仍有 30min 缓冲,也不要因为一个没 id 的 item 永久停表)。
     */
    function noteToolItemLifecycle(item: unknown, phase: 'started' | 'completed'): void {
      const rec = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
      if (!rec) return;
      const type = typeof rec.type === 'string' ? rec.type : null;
      const id = typeof rec.id === 'string' ? rec.id : null;
      if (!type || !id || !CODEX_TOOL_ITEM_TYPES.has(type)) return;
      if (phase === 'started') pendingToolItemIds.add(id);
      else pendingToolItemIds.delete(id);
      // 停/起表边界变了,立即重算(最后一个工具收工 → 球回上游,开始计时)。
      armUpstreamIdle();
    }
    /**
     * 上游连续静默超阈值:daemon 对我们彻底哑火。推一条终态 error 收口(renderer 停
     * 转圈 / scheduler 把 run 记 failed / IM 转播 finalize),再 turn/interrupt 让
     * daemon 侧那个 turn 停掉(与用户手动 Stop 同路径,thread 保持可用)。
     */
    function onUpstreamIdleTimeout(): void {
      if (closed || !isTurnInFlight) return;
      if (pendingToolItemIds.size > 0) return;
      const idleMs = upstreamIdleTimeoutMs;
      const msSinceLast =
        upstreamIdleLastEventAt > 0 ? Date.now() - upstreamIdleLastEventAt : null;
      const turnId = currentTurnId;
      log.warn('upstream-response-idle watchdog tripped — interrupting current turn', {
        idleMs,
        threadId,
        turnId,
        lastEventType: upstreamIdleLastEventType,
        msSinceLastEvent: msSinceLast,
      });
      // 先立终态墓碑:下面合成的本地收口据此走 suppressTerminalUi 分支(只清状态、
      // 不再推一遍终态 UI),迟到的 item / error 也一并被 stale guard 拦住。
      if (turnId) terminalErroredTurnIds.add(turnId);
      eventQueue.push({
        type: 'error',
        data: {
          // reason 与 claude-code 侧共用同一稳定 key(renderer i18n 映射,规则 18);
          // message 仅作非 renderer 消费方(IM / orca / 日志)的英文兜底。
          reason: 'upstream_response_idle_timeout',
          message:
            `The upstream response has been silent for ${Math.round(idleMs / 1000)}s; ` +
            'the turn was interrupted automatically to avoid hanging forever. ' +
            'You can send the next message to continue.',
          isTerminal: true,
          idleMs,
          lastEventType: upstreamIdleLastEventType,
          msSinceLastEvent: msSinceLast,
        },
        source: 'codex',
      });
      resetUpstreamIdleForTurnEnd();
      if (!turnId) return;
      // **先把本地 turn 状态收干净,再去 interrupt**(review #944 第二轮 P1)。
      // interruptTurnForPermissionTighten 在 app-server 彻底哑火时会两次 ack 超时
      // 后放弃,而它按设计不动 isTurnInFlight / currentTurnId —— 那对权限收紧场景是
      // 对的(turn 还在正常跑),但对这里是致命的:我们刚推了终态 error 让上层收口,
      // 若本地仍认为 turn 在跑,handle.isTurnRunning() 恒 true,之后每一条 send 都被
      // in-flight guard 拒掉,会话彻底不可用 —— watchdog 报告"已恢复"实际没有。
      //
      // 合成一次本地 turn 收口:上面已立墓碑,故走 suppressTerminalUi 分支,只清
      // isTurnInFlight / currentTurnId / plan 态并做 usage 收尾,不重复推终态 UI。
      // 同步完成,会话立刻恢复可发。
      handleTurnCompleted({
        threadId,
        turn: { id: turnId, status: 'failed' },
      } as TurnCompletedParams);
      // 再让 daemon 侧那个 turn 也停下。**必须看结果**:上面的本地收口把
      // isTurnInFlight 清成 false,于是 handle.isTurnRunning() 变 false —— Session 层
      // 的 recoverIfTurnStillRunning 正是以它为判据,现在会认为"abort 生效了,会话
      // 仍可用"而放过这个 host。若中断其实没成功,这个已经哑火 30 分钟的 app-server
      // 就被留下来给下一条 send 复用:要么再次超时,要么撞上服务端那个还在跑的 turn
      // (review #944 第五轮 P1)。
      //
      // 所以中断确认失败 = daemon 确诊不可用 → 自己 close():eventQueue.end() 让
      // Session 的事件循环自然收尾 → setStatus('closed') → Maker 摘掉 activeSessions
      // → 下一条 send 走 lazy create 重建 handle 并按 sdkSessionId resume。这条路径
      // 与 Session.recoverIfTurnStillRunning 用的是同一套恢复机制(见 session.ts
      // "handle.events() 自然结束"注释),不需要各 agent 另造一套。
      // 中断成功时什么都不做:daemon 既然 ack 了就还活着,会话继续可用。
      // 在进入 interrupt 等待窗口**之前**取一次快照:窗口里起过的新 turn 即使已经正常
      // 结束(瞬时状态被复位),也要靠它认出来(见 turnStartGeneration 声明处)。
      const turnGenBeforeInterrupt = turnStartGeneration;
      void (async () => {
        const interrupted = await interruptTurnForPermissionTighten(turnId, {
          suppressFailureEvent: true,
        });
        if (interrupted || closed) return;
        // **两次 ack 要等 20s,期间用户完全可能已经起了新 turn** —— 上面那次合成收口把
        // isTurnInFlight 清成了 false,所以新的 send 不会被 in-flight guard 拒掉。此时
        // 无条件 close 会掐死一条完全健康的新 turn,紧随其后的 host 退役还会连带终止同
        // host 上的其它会话。isCurrentHost 只认得出"host 被换掉",认不出"同一 handle 上
        // 起了新 turn"(review #944 第十七轮 P1;与第七轮 Session 的 turnGeneration、
        // 第九轮的 host 身份闸是同一类错误:善后动作没绑定到发起它的那个实体)。
        //
        // 判据有两半,缺一不可:
        // ① isTurnInFlight / currentTurnId —— 我们自己那次合成收口已把它们清空,所以
        //    非空就一定是新活儿(新 turn 此刻仍在跑)。
        // ② turnStartGeneration 与窗口前的快照不一致 —— 新 turn 在这 20s 里起来又**正常
        //    结束**时,①的两个瞬时量会被 handleTurnCompleted 双双复位,只看①会误判成
        //    "没人用了",照样关掉一个刚刚证明自己健康的 host,并连带退役同 host 上的其它
        //    会话(review #944 第十八轮 P1)。单调计数器答得了"期间有没有发生过新活儿"。
        // 两半都不成立才继续善后。留着这个 host 的风险由新 turn 自己的看门狗兜。
        if (isTurnInFlight || currentTurnId !== null || turnStartGeneration !== turnGenBeforeInterrupt) {
          log.warn(
            'upstream-idle watchdog: this handle served a newer turn during the interrupt window — skipping close/retire',
            {
              threadId,
              stalledTurnId: turnId,
              currentTurnId,
              turnGenBeforeInterrupt,
              turnStartGeneration,
            },
          );
          return;
        }
        // 走到这里有两种可能,处置相同:两次 ack 都超时(daemon 哑火),或 host 已被
        // 替换(stale —— 这个 handle 的 send 本来也会被 assertCurrentHost 拒掉)。
        // 两种情况下这个 handle 都已不可用,关掉它让上层重建是唯一正确的出路。
        log.error(
          'upstream-idle watchdog: turn interrupt not confirmed — closing this codex host so the next send rebuilds it',
          { threadId, turnId },
        );
        try {
          await handle.close();
        } catch (e) {
          log.warn('upstream-idle watchdog close threw', { error: String(e) });
        }
        // close() 只放掉本 thread 的订阅并结束自己的事件队列,**共享的 AppServerHost 仍
        // 留在 this.hosts 缓存里** —— 下一次 lazy create 会经 getHost 拿到同一个已确诊
        // 无响应的 app-server,立刻再卡一遍,等于没恢复(review #944 第八轮 P1)。
        // turn/interrupt 是控制面 RPC,两次 ack 都超时说明整个 host 而不只是这个 thread
        // 出了问题,所以要连 host 一起退役。
        //
        // 放在 close 之后:retireHostKey(failIfActive:false) 会向仍挂着的订阅者广播强制
        // 退役的终态 transport error(让它们各自收口 turn 状态,见那里的注释);本会话已经
        // 推过自己的终态 error 并在 close 里解除了订阅,不必再收一遍。
        try {
          await retireUnresponsiveHost(
            `codex app-server unresponsive: no upstream activity for ${Math.round(idleMs / 1000)}s and turn/interrupt was never acknowledged`,
          );
        } catch (e) {
          log.warn('upstream-idle watchdog host retire threw', { error: String(e) });
        }
      })();
    }
    // 装探针:此处仍远早于 handlers 注册(事件开始流动),不会漏掉任何一条。
    const rawEventQueuePush = eventQueue.push;
    eventQueue.push = (ev: AgentEvent): boolean => {
      upstreamIdleLastEventType = ev.type;
      upstreamIdleLastEventAt = Date.now();
      armUpstreamIdle();
      return rawEventQueuePush(ev);
    };

    // ── ServerRequest handlers (Phase 2 approval, Phase 5 dismiss-on-mode-change) ──
    const commandExecutionApproval = async (
      params: CommandExecutionRequestApprovalParams,
    ): Promise<CommandExecutionRequestApprovalResponse> => {
      // buffered/墓碑 turn 的审批请求不得上 UI (codex R12 P1) — 孤儿直接拒。
      const turnGate = gateServerRequestTurn(params.turnId);
      if (turnGate === false) return { decision: 'decline' };
      if (turnGate instanceof Promise && !(await turnGate)) return { decision: 'decline' };
      // requestId: approvalId 优先 (zsh-exec-bridge 多 callback 场景); 否则用 itemId
      const requestId = params.approvalId ?? params.itemId;
      const decision = await awaitApprovalDecision(requestId, 'commandExecution', {
        kind: 'permission',
        requestId,
        toolName: 'exec',
        input: commandExecutionDisplayInput(params.command ?? '', params.cwd ?? ''),
        title: 'Allow Codex to run this command?',
        description: params.reason ?? undefined,
        suggestions: commandSupportsAcceptForSession(params) ? codexSessionApprovalSuggestions() : undefined,
        metadata: params.reason ? { reason: params.reason } : undefined,
      });
      return { decision };
    };

    const fileChangeApproval = async (
      params: FileChangeRequestApprovalParams,
    ): Promise<FileChangeRequestApprovalResponse> => {
      // buffered/墓碑 turn 的审批请求不得上 UI (codex R12 P1) — 孤儿直接拒。
      const turnGate = gateServerRequestTurn(params.turnId);
      if (turnGate === false) return { decision: 'decline' };
      if (turnGate instanceof Promise && !(await turnGate)) return { decision: 'decline' };
      const requestId = params.itemId;
      const decision = await awaitApprovalDecision(requestId, 'fileChange', {
        kind: 'permission',
        requestId,
        toolName: 'file_change',
        input: { grantRoot: params.grantRoot ?? null },
        title: 'Allow Codex to change files?',
        description: params.reason ?? undefined,
        suggestions: codexSessionApprovalSuggestions(),
        metadata: params.reason ? { reason: params.reason } : undefined,
      });
      return { decision };
    };

    function recordFromUnknown(value: unknown): Record<string, unknown> | null {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      return value as Record<string, unknown>;
    }

    function stringFromMeta(meta: Record<string, unknown> | null, key: string): string | undefined {
      const value = meta?.[key];
      return typeof value === 'string' && value.trim() ? value : undefined;
    }

    function commandSupportsAcceptForSession(params: CommandExecutionRequestApprovalParams): boolean {
      const availableDecisions = params.availableDecisions;
      return !Array.isArray(availableDecisions) || availableDecisions.includes('acceptForSession');
    }

    function metaContainsSessionPersist(meta: Record<string, unknown> | null): boolean {
      const persist = meta?.persist;
      return persist === 'session' || (Array.isArray(persist) && persist.includes('session'));
    }

    function mcpElicitationMeta(params: McpServerElicitationRequestParams): Record<string, unknown> | null {
      if (params.mode !== 'form') return null;
      return recordFromUnknown(params._meta);
    }

    function isMcpToolApprovalElicitation(params: McpServerElicitationRequestParams): boolean {
      return stringFromMeta(mcpElicitationMeta(params), 'codex_approval_kind') === 'mcp_tool_call';
    }

    function mcpElicitationAllowsSession(params: McpServerElicitationRequestParams): boolean {
      return metaContainsSessionPersist(mcpElicitationMeta(params));
    }

    function mcpElicitationPermissionInput(params: McpServerElicitationRequestParams): Record<string, unknown> {
      const meta = mcpElicitationMeta(params);
      const input: Record<string, unknown> = {
        serverName: params.serverName,
        message: params.message,
      };
      const toolName = stringFromMeta(meta, 'tool_name');
      const toolTitle = stringFromMeta(meta, 'tool_title');
      const toolDescription = stringFromMeta(meta, 'tool_description');
      if (toolName) input.toolName = toolName;
      if (toolTitle) input.toolTitle = toolTitle;
      if (toolDescription) input.toolDescription = toolDescription;
      if (meta?.tool_params_display != null) input.toolParamsDisplay = meta.tool_params_display;
      if (meta?.tool_params != null) input.toolParams = meta.tool_params;
      return input;
    }

    function mcpToolApprovalContext(params: McpServerElicitationRequestParams) {
      const meta = mcpElicitationMeta(params);
      const toolName = stringFromMeta(meta, 'tool_name');
      return {
        serverName: params.serverName,
        ...(toolName ? { toolName } : {}),
        ...(meta?.tool_params != null ? { toolParams: meta.tool_params } : {}),
      };
    }

    function mcpInnerToolName(params: McpServerElicitationRequestParams): string | undefined {
      const context = mcpToolApprovalContext(params);
      return stringFromMeta(recordFromUnknown(context.toolParams), 'name');
    }

    const mcpToolApprovalPolicy = (params: McpServerElicitationRequestParams) => {
      const classifier = this.deps.getMcpToolApprovalPolicy;
      if (!classifier) return 'prompt' as const;
      try {
        const policy = classifier(mcpToolApprovalContext(params));
        if (policy === 'auto-approve' || policy === 'prompt' || policy === 'prompt-each-time') {
          return policy;
        }
        log.error('invalid MCP approval policy -> prompt each time', {
          serverName: params.serverName,
          policy,
        });
      } catch (error) {
        log.error('MCP approval policy threw -> prompt each time', {
          serverName: params.serverName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return 'prompt-each-time' as const;
    };

    const mcpServerElicitation = async (
      params: McpServerElicitationRequestParams,
    ): Promise<McpServerElicitationRequestResponse> => {
      // buffered/墓碑 turn 的 elicitation 不得上 UI / auto-approve (codex R12 P1)。
      const turnGate = gateServerRequestTurn(params.turnId);
      if (turnGate === false) return { action: 'decline', content: null, _meta: null };
      if (turnGate instanceof Promise && !(await turnGate)) {
        return { action: 'decline', content: null, _meta: null };
      }
      if (!isMcpToolApprovalElicitation(params)) {
        log.warn('unsupported MCP server elicitation -> decline', {
          serverName: params.serverName,
          mode: params.mode,
        });
        return { action: 'decline', content: null, _meta: null };
      }

      // Host policy 可在 outer call_tool 的 metadata 中识别渐进式 server 的
      // inner action。查询继续静默，高风险 action 逐次确认且不得持久化授权。
      const approvalPolicy = mcpToolApprovalPolicy(params);
      const policyPermissionInput = mcpElicitationPermissionInput(params);
      const turnPolicyForcePrompt = forceTurnConfirmation(
        `mcp:${params.serverName}`,
        policyPermissionInput,
      );
      if (approvalPolicy === 'auto-approve' && !turnPolicyForcePrompt) {
        log.debug('mcp elicitation auto-approved by host policy', {
          serverName: params.serverName,
          mode: params.mode,
          toolName: stringFromMeta(mcpElicitationMeta(params), 'tool_name'),
          innerToolName: mcpInnerToolName(params),
        });
        return { action: 'accept', content: null, _meta: null };
      }

      const meta = mcpElicitationMeta(params);
      const toolTitle = stringFromMeta(meta, 'tool_title');
      const innerToolName = mcpInnerToolName(params);
      const requestId = `mcp-elicitation:${params.serverName}:${params.turnId ?? params.threadId}:${++mcpElicitationSeq}`;
      const decision = await awaitApprovalDecision(
        requestId,
        'mcpServerElicitation',
        {
          kind: 'permission',
          requestId,
          toolName: `mcp:${params.serverName}`,
          input: policyPermissionInput,
          title: `Allow Codex to use ${innerToolName ?? toolTitle ?? params.serverName}?`,
          description: params.message,
          suggestions:
            approvalPolicy !== 'prompt-each-time' && mcpElicitationAllowsSession(params)
              ? codexSessionApprovalSuggestions()
              : undefined,
        },
        // prompt-each-time:Full access 也必须逐次弹 UI,否则高风险 inner tool
        // (contacts delete/merge/系统回写)会被 awaitApprovalDecision 首分支静默放行。
        {
          forcePrompt:
            turnPolicyForcePrompt || approvalPolicy === 'prompt-each-time',
        },
      );

      if (decision === 'accept') {
        return { action: 'accept', content: null, _meta: null };
      }
      if (decision === 'acceptForSession') {
        return approvalPolicy === 'prompt-each-time'
          ? { action: 'accept', content: null, _meta: null }
          : { action: 'accept', content: null, _meta: { persist: 'session' } };
      }
      if (decision === 'cancel') {
        return { action: 'cancel', content: null, _meta: null };
      }
      return { action: 'decline', content: null, _meta: null };
    };

    const permissionsApproval = async (
      params: PermissionsRequestApprovalParams,
    ): Promise<PermissionsRequestApprovalResponse> => {
      // buffered/墓碑 turn 的审批请求不得上 UI (codex R12 P1) — 孤儿直接拒
      // (空 permissions 即拒绝授权, 与非 accept 分支同款)。
      const turnGate = gateServerRequestTurn(params.turnId);
      if (turnGate === false) return { permissions: {}, scope: 'turn' };
      if (turnGate instanceof Promise && !(await turnGate)) return { permissions: {}, scope: 'turn' };
      const requestId = params.itemId ?? params.turnId;
      const decision = await awaitApprovalDecision(requestId, 'commandExecution', {
        kind: 'permission',
        requestId,
        toolName: 'permissions',
        input: { permissions: params.permissions },
        title: 'Allow Codex to use these permissions?',
        description: params.reason ?? undefined,
        suggestions: codexSessionApprovalSuggestions(),
        metadata: params.reason ? { reason: params.reason } : undefined,
      });
      if (decision === 'accept') {
        return { permissions: params.permissions as Record<string, unknown>, scope: 'turn' };
      }
      if (decision === 'acceptForSession') {
        return { permissions: params.permissions as Record<string, unknown>, scope: 'session' };
      }
      return { permissions: {}, scope: 'turn' };
    };

    function activeToolContextFromItem(
      item: unknown,
      turnId?: string | null,
    ): { id: string; ctx: ActiveToolContext } | null {
      if (!item || typeof item !== 'object') return null;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === 'string' ? rec.id : '';
      if (!id) return null;
      if (rec.type === 'mcpToolCall') {
        return {
          id,
          ctx: {
            type: 'mcpToolCall',
            turnId,
            server: typeof rec.server === 'string' ? rec.server : null,
            tool: typeof rec.tool === 'string' ? rec.tool : null,
          },
        };
      }
      if (rec.type === 'dynamicToolCall') {
        return {
          id,
          ctx: {
            type: 'dynamicToolCall',
            turnId,
            namespace: typeof rec.namespace === 'string' ? rec.namespace : null,
            tool: typeof rec.tool === 'string' ? rec.tool : null,
          },
        };
      }
      return null;
    }

    function noteActiveToolContext(item: unknown, turnId?: string | null): void {
      const active = activeToolContextFromItem(item, turnId);
      if (!active) return;
      activeToolContexts.set(active.id, active.ctx);
    }

    function clearActiveToolContextsForTurn(turnId: string): void {
      for (const [itemId, ctx] of activeToolContexts) {
        if (ctx.turnId === turnId) activeToolContexts.delete(itemId);
      }
    }

    function classifyUserInputRequest(params: ToolRequestUserInputParams): 'ask_user_question' | 'permission' {
      const ctx = activeToolContexts.get(params.itemId);
      if (!ctx) return 'ask_user_question';
      if (ctx.type === 'mcpToolCall') return 'permission';
      if (ctx.type === 'dynamicToolCall') {
        return isAskUserDynamicTool({ namespace: ctx.namespace ?? '', tool: ctx.tool ?? '' })
          ? 'ask_user_question'
          : 'permission';
      }
      return 'ask_user_question';
    }

    async function askUserViaInteraction(
      requestId: string,
      questions: ToolRequestUserInputQuestion[],
    ): Promise<ToolRequestUserInputResponse> {
      if (questions.some((q) => q.isSecret)) {
        log.warn('requestUserInput secret question refused', {
          requestId,
          questionCount: questions.length,
        });
        return emptyUserInputResponse(questions);
      }
      const decision = await dispatchInteraction({
        kind: 'ask_user_question',
        requestId,
        questions: questionsToAskUserItems(questions),
      });
      if (decision.kind !== 'ask_user_question') {
        log.warn('requestUserInput got mismatched ask decision', { requestId, decKind: decision.kind });
        return emptyUserInputResponse(questions);
      }
      return responseFromAskUserAnswers(questions, decision.answers);
    }

    async function requestUserInputAsPermission(
      requestId: string,
      params: ToolRequestUserInputParams,
      questions: ToolRequestUserInputQuestion[],
    ): Promise<ToolRequestUserInputResponse> {
      const ctx = activeToolContexts.get(params.itemId);
      const toolName = ctx?.type === 'mcpToolCall'
        ? `mcp:${ctx.server ?? 'unknown'}:${ctx.tool ?? 'unknown'}`
        : ctx?.type === 'dynamicToolCall'
          ? `dynamic:${ctx.namespace ? `${ctx.namespace}:` : ''}${ctx.tool ?? 'unknown'}`
          : 'request_user_input';
      const decision = await dispatchInteraction({
        kind: 'permission',
        requestId,
        toolName,
        input: {
          itemId: params.itemId,
          questions: questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            options: q.options,
          })),
        },
        title: 'Allow this tool to ask for user input?',
        description: questions.map((q) => q.question).filter(Boolean).join('\n'),
        metadata: {
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          userInputKind: 'tool_side_effect',
        },
      });
      if (decision.kind !== 'permission') {
        log.warn('requestUserInput permission got mismatched decision', { requestId, decKind: decision.kind });
        return emptyUserInputResponse(questions);
      }
      return responseFromPermissionDecision(questions, decision);
    }

    const requestUserInput = async (
      params: ToolRequestUserInputParams,
      meta: { requestId: string | number },
    ): Promise<ToolRequestUserInputResponse> => {
      // buffered/墓碑 turn 的输入请求不得上 UI (codex R12 P1) — 空 answers 即拒。
      const turnGate = gateServerRequestTurn(params.turnId);
      if (turnGate === false) return { answers: {} };
      if (turnGate instanceof Promise && !(await turnGate)) return { answers: {} };
      const requestId = String(meta.requestId);
      // 挂起期间服务端已取消本请求 (greptile R13 P1): 直接回空响应, 不注册
      // broker 不上 UI — 否则 UI 会等一个服务端已结束的交互, 用户提交后向
      // 已结束请求发迟到响应。
      if (resolvedWhileBufferedRequestIds.delete(requestId)) return { answers: {} };
      const questions = normalizeRequestUserInputQuestions(params.questions);
      if (questions.length === 0) return { answers: {} };
      const kind = classifyUserInputRequest(params);
      log.debug('native requestUserInput received', {
        requestId,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        kind,
        questionCount: questions.length,
      });
      return userInputBroker.track(
        {
          kind: 'request_user_input',
          connectionId,
          requestId: meta.requestId,
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
        },
        async (settle) => {
          const response = kind === 'permission'
            ? await requestUserInputAsPermission(requestId, params, questions)
            : await askUserViaInteraction(requestId, questions);
          settle(response);
        },
      );
    };

    const dynamicToolCall = async (
      params: DynamicToolCallParams,
      meta: { requestId: string | number },
    ): Promise<DynamicToolCallResponse> => {
      // buffered/墓碑 turn 的 tool call 不得上 UI (codex R12 P1)。
      const turnGate = gateServerRequestTurn(params.turnId);
      if (turnGate === false) {
        return {
          contentItems: [
            { type: 'inputText', text: 'Request was rejected because the owning turn is no longer active.' },
          ],
          success: false,
        };
      }
      if (turnGate instanceof Promise && !(await turnGate)) {
        return {
          contentItems: [
            { type: 'inputText', text: 'Request was rejected because the owning turn is no longer active.' },
          ],
          success: false,
        };
      }
      if (!isAskUserDynamicTool(params)) {
        return {
          contentItems: [{ type: 'inputText', text: `Unsupported dynamic tool: ${params.tool}` }],
          success: false,
        };
      }
      const requestId = String(meta.requestId);
      // 挂起期间服务端已取消本请求 (greptile R13 P1): 直接回失败响应, 不注册
      // broker 不上 UI (与 resolved 的 cancel 响应同款文案)。
      if (resolvedWhileBufferedRequestIds.delete(requestId)) {
        return {
          contentItems: [{ type: 'inputText', text: 'Request was resolved before user input was submitted.' }],
          success: false,
        };
      }
      const questions = normalizeDynamicAskUserQuestions(params.arguments);
      if (questions.length === 0) {
        return {
          contentItems: [{ type: 'inputText', text: 'No valid questions were provided.' }],
          success: false,
        };
      }
      return dynamicToolBroker.track(
        {
          kind: 'dynamic_tool',
          connectionId,
          requestId: meta.requestId,
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.callId,
        },
        async (settle) => {
          const response = await askUserViaInteraction(requestId, questions);
          settle(dynamicToolResponseFromUserInput(response));
        },
      );
    };

    function handleServerRequestResolved(params: ServerRequestResolvedNotification['params']): void {
      const requestId = String(params.requestId);
      const userInputCancelled = userInputBroker.cancel(
        { connectionId, requestId: params.requestId },
        { answers: {} },
      );
      const dynamicCancelled = dynamicToolBroker.cancel(
        { connectionId, requestId: params.requestId },
        {
          contentItems: [{ type: 'inputText', text: 'Request was resolved before user input was submitted.' }],
          success: false,
        },
      );
      if (userInputCancelled || dynamicCancelled) {
        eventQueue.push({
          type: 'interaction_dismissed',
          data: { requestId, reason: 'server_request_resolved', resolvedAs: 'deny' },
          source: 'codex',
        });
      } else if (bufferedOrphanTurnIds.size > 0) {
        // cancel 未命中且有 buffered turn: 可能是挂起中的请求 (尚未注册到
        // broker) 被服务端取消 (greptile R13 P1) — 记下 requestId, 对账放行
        // 后 handler 自查回空响应, 不上 UI。requestId 是一次性的 (消费即删),
        // 最坏泄漏 = 一条字符串, 随 session 释放。
        resolvedWhileBufferedRequestIds.add(requestId);
      }
    }

    // ── status 文案: 对齐 claude-code 6 类 chip 文案 ────────────────────────
    // claude-code 由 SDK 直接广播 status 文案 (Generating / Thinking / Compacting / <tool> running / Done);
    // codex 协议没这层 — 必须自己从 item.* lifecycle + thread/status/changed 推断。
    // 实现策略: 每次切换语义化阶段 push 一次, 不在 delta 里 push (会刷成风暴);
    // 由 renderer 显示最新一条, react batch 自然消化中间抖动。
    function pushStatus(text: string): void {
      eventQueue.push({
        type: 'status',
        data: { status: text, ...usageTracker.snapshot(), isRunning: true },
        source: 'codex',
      });
    }

    function pushItemStatus(item: { type?: string; command?: string; tool?: string }): void {
      const text = statusTextForItem(item);
      if (text) pushStatus(text);
    }

    function rejectIfCancelled(sendOpts: SendOptions | undefined, action: string): void {
      if (sendOpts?.signal?.aborted) {
        throw new Error(`Codex ${action} cancelled before acceptance`);
      }
    }

    function rejectClosedOrCancelledSend(sendOpts: SendOptions | undefined, stage: string): boolean {
      rejectIfCancelled(sendOpts, 'send');
      if (!closed) return false;
      log.warn('send called on closed session', { stage });
      if (sendOpts?.throwOnStartFailure || sendOpts?.signal) {
        throw new Error(`Codex send cannot be accepted: session is closed ${stage}`);
      }
      return true;
    }

    function isLocalAcceptBoundaryError(err: unknown): boolean {
      const text = err instanceof Error ? err.message : String(err);
      return /Codex send (?:cancelled|cannot be accepted)/i.test(text);
    }

    // idle 孤儿判定 (codex R15 P1): 孤儿守卫生效 + 无 RPC 在飞 + 无活跃 turn
    // 时, 未知 id 的事件只可能来自失败 RPC 的孤儿 turn (合法 turn 的 id 都
    // 已知)。与 pending 窗口的 buffer 隔离互补: idle 时没有对账 RPC 在飞,
    // 事件直接按孤儿处理 (立墓碑), 不缓冲。
    const isIdleOrphanTurnId = (turnId: string | null | undefined): turnId is string =>
      Boolean(turnId)
      && turnStartFailedWithoutTurnId
      && !isTurnStartPending
      && currentTurnId === null
      && !completedTurnIds.has(turnId as string)
      && !terminalErroredTurnIds.has(turnId as string);

    /**
     * idle 孤儿落墓碑 —— **同时**补 best-effort interrupt。
     *
     * 为什么必须在这里 interrupt: turnStarted 的孤儿分支显式跳过已落墓碑的 id(它假设"已墓碑
     * = interrupt 已经发过"), 而本函数此前只落墓碑、把 interrupt 留给那个分支。于是
     * item/started 之类的事件**先于**迟到的 turnStarted 到达时, 两边各自以为对方会发 ——
     * 谁都没发, 被 server 接受的那个 turn 在 Stop 已经终态收口 UI 之后继续执行工具
     * (review #844 codex P1)。
     *
     * 恰好一次: isIdleOrphanTurnId 要求 id **不在** terminalErroredTurnIds 里, 而本函数第一件
     * 事就是把它加进去, 所以同一个 turn 只会进来一次。
     *
     * turnCompleted 的 idle 孤儿分支**不用**它: 那个 turn 已经结束, interrupt 是纯浪费的 RPC。
     */
    const tombstoneIdleOrphanTurn = (turnId: string, reason: string): void => {
      terminalErroredTurnIds.add(turnId);
      if (!threadId) return;
      host.request(Method.TurnInterrupt, { threadId, turnId }).catch((e: unknown) => {
        log.warn('idle orphan turn interrupt failed (best-effort)', {
          reason,
          turnId,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    };

    const shouldIgnoreStaleTurnEvent =(turnId: string | null | undefined): boolean => {
      if (!turnId) return false;
      if (completedTurnIds.has(turnId)) return true;
      if (terminalErroredTurnIds.has(turnId)) return true;
      // 缓冲隔离中的歧义 turn (codex R9 P2): id 只拦 turnStarted 不够 —
      // 缓冲期间 currentTurnId 为 null, 孤儿 turn 的 item/usage/error 会穿透
      // stale guard 被按当前 pending turn 处理 (旧输出显示在新消息下 / 用量
      // 计错 turn / 孤儿 error 终结合法新 turn, greptile R10 P1)。其事件一律
      // 忽略; 若响应证明合法 (id 一致)  buffer 已清空, 后续事件正常。
      if (bufferedOrphanTurnIds.has(turnId)) return true;
      // idle 孤儿 (codex R15 P1): 立墓碑 + 补 interrupt 并丢弃。interrupt 必须在这里发,
      // 不能像早先那样留给 turnStarted 的孤儿分支 —— 那个分支跳过已落墓碑的 id, 而墓碑正是
      // 这里刚落的; 事件先于迟到的 started 到达时谁都不发, 被接受的 turn 在 UI 已收口之后
      // 继续跑工具 (review #844 codex P1)。
      if (isIdleOrphanTurnId(turnId)) {
        tombstoneIdleOrphanTurn(turnId, 'idle orphan event');
        return true;
      }
      return currentTurnId !== null && turnId !== currentTurnId;
    };

    // buffered turn 的事件入口闸 (greptile R11 P1 + codex R12 P1): 命中缓冲
    // 则把「重进本 handler」的闭包按到达序排进该 turn 的队列, 等对账 —
    // 合法则激活后按序重放 (早期输出不丢, 终态自然收口), 孤儿则整队丢弃。
    // 返回 true = 已入队, 调用方直接 return。重放闭包执行时 buffer 已清空
    // 且 turn 已激活, 重进 handler 会走正常路径, 不会二次入队。
    //
    // 孤儿证据可以比它的 turnStarted 先到 (codex R14 P1): error/item 先到
    // 时 id 尚未入 buffer, 会穿透 stale guard 被按在飞 send 处理 — 孤儿
    // 守卫生效 + 新 RPC 在飞 + 无活跃 turn 时, 未知 id 视同 started 先进
    // buffer 再入队, 等对账。
    /**
     * 缓冲期间**确实产出过模型 / 工具工作**的 turn。
     *
     * 与 bufferedTurnEventQueues 的区别: 队列里什么都有(turn/completed、userMessage echo、
     * tokenUsage、plan 更新…), 拿"队列非空"当产出证据会把一次零产出的容量拒绝误判成
     * "已有产出, 不重投", 结果对用户报硬失败 —— 而这一轮其实什么副作用都没发生
     * (review #844 codex P1)。判据与非缓冲路径统一走 itemRepresentsModelWork。
     */
    const bufferedModelWorkTurnIds = new Set<string>();

    const enqueueIfBufferedTurn = (
      turnId: string | null | undefined,
      replay: () => void,
      opts?: { modelWork?: boolean },
    ): boolean => {
      if (!turnId) return false;
      if (!bufferedOrphanTurnIds.has(turnId)) {
        if (!(turnStartFailedWithoutTurnId && isTurnStartPending && currentTurnId === null)) {
          return false;
        }
        bufferedOrphanTurnIds.add(turnId);
        log.debug('buffering ambiguous turn event (evidence before turnStarted) until turn/start response arrives', {
          turnId,
          threadId,
        });
      }
      const queue = bufferedTurnEventQueues.get(turnId) ?? [];
      queue.push(replay);
      bufferedTurnEventQueues.set(turnId, queue);
      if (opts?.modelWork) bufferedModelWorkTurnIds.add(turnId);
      return true;
    };

    // buffered turn 的 server request (审批/输入) 挂起信号 (codex R12 P1):
    // 归属未定前请求不得上 UI — 用户可能为隐藏的孤儿 turn 批准操作, 而
    // best-effort interrupt 输了竞态时操作会真实执行。每个 buffered id 一组
    // waiter, 对账时 settle: 合法 → true 继续正常流程; 孤儿 / RPC 失败 →
    // false, 调用方返回拒绝响应。挂起窗口 = turn/start RPC 窗口 (最坏
    // 60s), 远小于 daemon 侧审批等待时长。
    const bufferedReconcileWaiters = new Map<string, Array<(valid: boolean) => void>>();
    // 挂起期间到达的 serverRequest/resolved (greptile R13 P1): 请求还没注册
    // 到 broker, cancel 不命中 — 记下 requestId, 对账放行后 handler 自查:
    // 服务端已取消的请求直接回空响应, 不再上 UI 让用户向已结束的请求提交。
    const resolvedWhileBufferedRequestIds = new Set<string>();

    const waitForBufferedTurnReconcile = (turnId: string): Promise<boolean> =>
      new Promise((resolve) => {
        const waiters = bufferedReconcileWaiters.get(turnId) ?? [];
        waiters.push(resolve);
        bufferedReconcileWaiters.set(turnId, waiters);
      });

    const settleBufferedTurnReconcile = (turnId: string, valid: boolean): void => {
      const waiters = bufferedReconcileWaiters.get(turnId);
      if (!waiters) return;
      bufferedReconcileWaiters.delete(turnId);
      for (const resolve of waiters) resolve(valid);
    };

    // 放弃对账时统一释放 (codex R17 P2): close / cancel 边界直接从 send
    // return、或 session close 时, buffered turn 的挂起请求永远等不到
    // settle — handler 永远悬挂, dispatchServerRequest 永不返回, server
    // 侧请求卡死。所有不走路径对账的退出点都必须调用。
    const abandonBufferedTurns = (reason: string): void => {
      if (bufferedOrphanTurnIds.size === 0) return;
      log.debug('abandoning buffered turns', { reason, turnIds: [...bufferedOrphanTurnIds] });
      for (const bufferedId of bufferedOrphanTurnIds) {
        settleBufferedTurnReconcile(bufferedId, false);
      }
      bufferedOrphanTurnIds.clear();
      bufferedTurnEventQueues.clear();
    };

    // server request 入口闸 (codex R12 P1): true = 放行; false = 拒绝
    // (terminal/completed 墓碑 turn — 批了也没人消费; buffered 孤儿)。
    // buffered 归属未定 → 返回 Promise 挂起到对账再定。非 async 签名是故意的:
    // 同步快速路径不引入 microtask 延迟 — handler 第一行的 broker.track 与
    // 紧随其后的 serverRequest/resolved 存在竞态, 哪怕一跳 await 也会让
    // resolved 抢在 track 之前到达 (测试回归实证)。
    const gateServerRequestTurn = (turnId: string | null | undefined): boolean | Promise<boolean> => {
      if (!turnId) return true;
      if (terminalErroredTurnIds.has(turnId) || completedTurnIds.has(turnId)) return false;
      // idle 孤儿 (greptile R16 P1): 无 RPC 在飞时未知 id 的请求只可能来自
      // 失败 RPC 的孤儿 turn — 直接拒, 不得放行上 UI (用户响应会发往旧
      // turn, interrupt 输掉竞态时操作会真实执行)。与 notification 的
      // idle 孤儿闸同款判定, 立墓碑让后续事件一并拦。
      if (isIdleOrphanTurnId(turnId)) {
        // 同上: 落墓碑的同时补 interrupt。只拒掉审批/输入请求不够 —— 那个 turn 还在 server
        // 上跑, 而 turnStarted 的孤儿分支不会为已落墓碑的 id 补发 (review #844 codex P1)。
        tombstoneIdleOrphanTurn(turnId, 'idle orphan server request');
        return false;
      }
      // 孤儿守卫 + 已有活跃 turn: id ≠ currentTurnId 的请求来自失败 RPC 的
      // 孤儿 (codex R17 P1) — 替换 turn 已被接受后, 孤儿迟到的审批/输入
      // 请求既不是 idle 也不是 buffered, 不得放行上 UI。
      if (turnStartFailedWithoutTurnId && currentTurnId !== null && turnId !== currentTurnId) {
        terminalErroredTurnIds.add(turnId);
        return false;
      }
      if (!bufferedOrphanTurnIds.has(turnId)) {
        // 与 enqueueIfBufferedTurn 同款预缓冲 (codex R15 P1): 孤儿 turn 的
        // server request 同样可以比它的 turnStarted 先到 — id 未入 buffer
        // 时若直接放行, 审批框会为隐藏孤儿 turn 上 UI。守卫生效 + RPC 在飞
        // + 无活跃 turn 时视同 buffered, 挂起到对账。
        if (!(turnStartFailedWithoutTurnId && isTurnStartPending && currentTurnId === null)) {
          return true;
        }
        bufferedOrphanTurnIds.add(turnId);
        log.debug('buffering ambiguous turn server request (evidence before turnStarted) until turn/start response arrives', {
          turnId,
          threadId,
        });
      }
      // 挂起到对账; waiter 恢复前复查墓碑 (codex R13 P2): 对账先 settle(true)
      // 再同步重放队列, 队列里若有终态会把该 turn 当场收口 — waiter 在
      // microtask 里恢复时 turn 已死, 此时再上 UI 就是为一个刚收口的 turn
      // 批审批。微任务时机保证这次复查一定看到重放后的最终状态。
      return waitForBufferedTurnReconcile(turnId).then(
        (valid) => valid && !terminalErroredTurnIds.has(turnId) && !completedTurnIds.has(turnId),
      );
    };

    const stopActiveRolloutPlanFallback = (): void => {
      const stop = stopRolloutPlanFallback;
      stopRolloutPlanFallback = null;
      try { stop?.(); } catch { /* no-op */ }
    };

    const startRolloutPlanFallback = (turnId: string): void => {
      stopActiveRolloutPlanFallback();
      seenRolloutPlanCallIds.clear();

      let stopped = false;
      let timer: ReturnType<typeof setInterval> | null = null;
      let rolloutPath = '';
      let offset = 0;
      let remainder = '';

      const scanText = (text: string, allowFallbackTurnId: boolean): void => {
        const lines = `${remainder}${text}`.split(/\r?\n/);
        remainder = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          const parsed = extractRolloutUpdatePlanFunctionCallEvent(
            entry,
            allowFallbackTurnId ? turnId : undefined,
            { requireTurnId: true },
          );
          if (!parsed) continue;
          if (parsed.turnId && shouldIgnoreStaleTurnEvent(parsed.turnId)) continue;
          if (parsed.turnId && parsed.turnId !== turnId) continue;
          if (parsed.callId) {
            if (seenRolloutPlanCallIds.has(parsed.callId)) {
              continue;
            }
            seenRolloutPlanCallIds.add(parsed.callId);
          }
          const input = parsed.event.data as { input?: { plan?: unknown } };
          if (parsed.turnId && Array.isArray(input.input?.plan)) {
            latestPlanByTurn.set(
              parsed.turnId,
              input.input.plan as TurnPlanUpdatedNotification['params']['plan'],
            );
          }
          eventQueue.push(parsed.event);
        }
      };

      const poll = async (allowFallbackTurnId: boolean): Promise<void> => {
        if (stopped || !rolloutPath) return;
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stat = await fs.stat(rolloutPath);
        } catch {
          return;
        }
        if (stat.size < offset) {
          offset = 0;
          remainder = '';
        }
        if (stat.size === offset) return;

        const length = stat.size - offset;
        const buffer = Buffer.alloc(length);
        let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
        try {
          handle = await fs.open(rolloutPath, 'r');
          const read = await handle.read(buffer, 0, length, offset);
          offset += read.bytesRead;
          scanText(buffer.subarray(0, read.bytesRead).toString('utf8'), allowFallbackTurnId);
        } catch (e) {
          log.debug('rollout plan fallback poll failed', { error: String(e), threadId, turnId });
        } finally {
          try { await handle?.close(); } catch { /* no-op */ }
        }
      };

      stopRolloutPlanFallback = () => {
        if (timer) clearInterval(timer);
        stopped = true;
      };

      void (async () => {
        try {
          rolloutPath = await this.findRolloutPath(threadId);
        } catch (e) {
          log.debug('rollout plan fallback disabled: rollout path unavailable', {
            error: String(e),
            threadId,
            turnId,
          });
          return;
        }
        if (stopped) return;
        await poll(false);
        if (stopped) return;
        timer = setInterval(() => void poll(true), 500);
      })();
    };

    const flushDeferredTerminalTurnCompletionsIfIdle = (): void => {
      if (isTurnStartPending || currentTurnId !== null) return;
      for (const [turnId, params] of Array.from(deferredTerminalTurnCompletions.entries())) {
        if (!deferredTerminalTurnCompletions.has(turnId)) continue;
        deferredTerminalTurnCompletions.delete(turnId);
        handleTurnCompleted(params);
      }
    };

    /**
     * 计划模式下拦截 plan item (proposed plan / <proposed_plan> 块): 记录最新文本,
     * 不进 translator —— 计划内容由 turn 结束后的 plan_review 卡片呈现, 不再渲染
     * update_plan 工具行 (避免同一份计划在聊天里出现两次)。
     * 非计划模式不拦截; 普通 Codex turn 也可能产生原生 plan item。
     */
    function interceptProposedPlanItem(item: unknown): boolean {
      if (!currentTurnPlanModeActive) return false;
      const candidate = item as { type?: unknown; text?: unknown } | null | undefined;
      if (!candidate || candidate.type !== 'plan') return false;
      if (typeof candidate.text === 'string') proposedPlanText = candidate.text;
      return true;
    }

    function handleTurnCompleted(params: TurnCompletedParams): void {
      const turn = params.turn;
      // turn/start RPC 响应未回时就收到终态 → 记墓碑, 阻止稍后到达的
      // handleTurnStartResp / 乱序 turnStarted 把已终结的 turn 重新置活。
      if (isTurnStartPending) turnsCompletedBeforeStartResp.add(turn.id);
      const isTerminalErroredTurn = terminalErroredTurnIds.has(turn.id);
      if (isTerminalErroredTurn && isTurnStartPending && currentTurnId !== turn.id) {
        deferredTerminalTurnCompletions.set(turn.id, params);
        return;
      }
      // turn/completed 可能重复投递。只允许第一次进入 usage / UI / done 收口;
      // 同一个墓碑也负责拦截该 turn 随后迟到的 item / reasoning / started 事件。
      if (completedTurnIds.has(turn.id)) return;
      completedTurnIds.add(turn.id);
      const suppressTerminalUi = terminalErroredTurnIds.has(turn.id);
      deferredTerminalTurnCompletions.delete(turn.id);
      if (currentTurnId === turn.id || currentTurnId === null) {
        stopActiveRolloutPlanFallback();
      }
      dismissPendingUserInputForTurn(turn.id, `turn_${turn.status}`);
      clearActiveToolContextsForTurn(turn.id);
      const overlapsActiveTurn = suppressTerminalUi && currentTurnId !== null && currentTurnId !== turn.id;
      if (overlapsActiveTurn) return;
      const completedTurnWasPlanMode = currentTurnPlanModeActive;
      if (currentTurnId === turn.id || currentTurnId === null) {
        isTurnInFlight = false;
        currentTurnId = null;
        currentTurnPlanModeActive = false;
        // 收 idle 表只在**当前** turn 真正结束时做:放在上面的重叠早退之前会把
        // 仍在跑的活跃 turn 的表一并清掉,而它若正好卡住(无事件可再 arm),watchdog
        // 就永久失效了。
        resetUpstreamIdleForTurnEnd();
      }
      const lastSnap = usageTracker.snapshot();
      // turn 桶快照 — endTurn 会清掉 turn 桶, 必须在调用前先取出来
      const preTurnEndCacheStats = usageTracker.getCacheStats();
      // 真实 per-turn 用量 (tokenUsage/updated 逐次累加的 turn 桶) — done 事件的
      // usage 用它, 不用 contextTokens 降级值 (那是整个上下文快照, 不是本 turn 增量)。
      // 必须在 endTurn 之前取: endTurn 会用降级 aggregate 覆盖后 reset。
      const realTurnUsage = usageTracker.getTurnUsage();
      usageTracker.endTurn({
        inputTokens: lastSnap.contextTokens ?? 0,
        outputTokens: 0,
      });

      const endSnap = usageTracker.snapshot();
      const sessionCacheStats = usageTracker.getCacheStats().session;
      const formatBucket = (b: typeof preTurnEndCacheStats.turn) => ({
        hitRate: b.hitRate === null ? 'n/a' : `${(b.hitRate * 100).toFixed(1)}%`,
        read: b.read,
        create: b.create,
        uncached: b.uncachedInput,
        apiCalls: b.apiCalls,
      });
      log.debug('SDK ◀ turn end', {
        turnId: turn.id,
        status: turn.status,
        startedAt: turn.startedAt ?? null,
        completedAt: turn.completedAt ?? null,
        durationMs: turn.durationMs ?? null,
        serviceTier: mutableServiceTier ?? null,
        fastMode: isFastServiceTier(mutableServiceTier),
        // 本 turn 增量 (来自最近一次 thread/tokenUsage/updated 的 last)
        inputTokens: lastTurnTokenUsage?.inputTokens ?? null,
        cachedInputTokens: lastTurnTokenUsage?.cachedInputTokens ?? null,
        outputTokens: lastTurnTokenUsage?.outputTokens ?? null,
        reasoningOutputTokens: lastTurnTokenUsage?.reasoningOutputTokens ?? null,
        contextWindow: lastModelContextWindow,
        cumulative: endSnap,
        // cache 命中率 — 排查第三方 proxy 透传问题用,
        // 公式与代码见 UsageTracker.getCacheStats() 注释。
        cacheStats: {
          turn: formatBucket(preTurnEndCacheStats.turn),
          session: formatBucket(sessionCacheStats),
        },
      });

      if (suppressTerminalUi) {
        latestPlanByTurn.delete(turn.id);
        flushDeferredTerminalTurnCompletionsIfIdle();
        return;
      }
      // 收口前的归属校验。本函数对**不是当前活跃 turn** 的终态一律按"收口当前这一轮"处理
      // (既有行为: currentTurnId 为 null 时走 emit done, 非 null 时也照样推 error + done,
      // 只是不动活跃态), 而挂起 / 延后 / 在飞的重投恰好活在这些窗口里: 被 Stop 的旧 turn 的
      // 迟到 completed 于是既把新一轮报成失败, 又顺手撤销它的重投 —— 那一轮白白丢掉自动
      // 重试, 要用户手动重发(review #844 greptile P1)。
      //
      // 判据**只看归属, 不看有没有活跃 turn**: 早先版本多要求 currentTurnId === null, 于是
      // "重投 RPC 在飞 + 它的 turnStarted 已先到"这种状态(活跃 turn 存在且重投仍挂着)整段
      // 绕过校验, 同一个 bug 换个时序照样成立(review #844 greptile P1)。
      // 归属未知(拿不到 origin)同样算不属于 —— 未知的一律不许替它收口。
      if (overloadRetryPending()) {
        const origin = turnOriginByTurnId.get(turn.id);
        if (origin?.sendGen !== overloadRetry?.sendGen) {
          log.info('ignoring a foreign turn terminal state while an overload retry is pending', {
            turnId: turn.id,
            status: turn.status,
            activeTurnId: currentTurnId,
            turnSendGen: origin?.sendGen ?? null,
            retrySendGen: overloadRetry?.sendGen ?? null,
            threadId,
          });
          latestPlanByTurn.delete(turn.id);
          flushDeferredTerminalTurnCompletionsIfIdle();
          return;
        }
      }
      // 到这里 = 这个 turn 的终态**要出 UI**, 逻辑 send 就此收口。墓碑压掉的那条路在上面
      // 已经 return, 所以退避中的正常重投(死 turn 恒有墓碑)不会被误撤。
      revokeOverloadRetryOnTerminalSettle(`turn_${turn.status}`);

      if (turn.status === 'failed' || turn.status === 'interrupted') {
        // 失败 / 中断的 plan turn 不发审批 — 半截计划没有审批意义, 循环就此结束。
        proposedPlanText = null;
        planCycleActive = false;
        currentTurnPlanModeActive = false;
        if (turn.error?.message) {
          eventQueue.push({
            type: 'error',
            data: { message: turn.error.message, isTerminal: true },
            source: 'codex',
          });
        } else if (turn.status === 'failed') {
          // failed turn 缺 error detail 时也必须推 terminal error —— 否则 renderer
          // 的 state.error 不置位, running→stopped 的通知链路把这次失败当正常完成
          // (桌面/飞书通知显示"已完成")。序列与上面"有 message"的分支同构(error→done)。
          // reason 是稳定 key, renderer 按它走 i18n 文案(规则 18); message 仅作
          // 非 renderer 消费方(IM/orca)的兜底。interrupted(用户主动停)不算失败, 不补。
          eventQueue.push({
            type: 'error',
            data: {
              message: '任务执行失败（模型未返回错误详情）。',
              isTerminal: true,
              reason: 'turn-failed',
            },
            source: 'codex',
          });
        }
        eventQueue.push({
          type: 'done',
          data: { type: 'codex/event/task_complete', cancelled: turn.status === 'interrupted', raw: turn },
          source: 'codex',
        });
        latestPlanByTurn.delete(turn.id);
        flushDeferredTerminalTurnCompletionsIfIdle();
        return;
      }

      eventQueue.push({
        type: 'status',
        data: { status: 'Done', ...endSnap, isRunning: false },
        source: 'codex',
      });
      // 真实 per-turn 用量 (host 的 today chip / daily_model_usage 记账消费):
      //   promptTokens     = 本 turn 未命中缓存的输入 (不再是 contextTokens 上下文快照)
      //   completionTokens = 本 turn 输出+推理合并 (ingest 时已合并, 拆不回, 总量正确)
      //   reasoningTokens  = 0 (已并入 completionTokens, 消费方求和口径不变)
      //   cachedTokens     = 本 turn 命中缓存的输入
      // 契约: 本 payload **永远是 per-turn 增量语义**, 消费方 (today chip /
      // daily_model_usage 记账) 直接累加, 不做任何 delta 化。整个 turn 没收到
      // tokenUsage/updated 时就是全 0 (该 turn 不记账) — 不退回 contextTokens:
      // 在直接累加的消费方手里, 上下文快照会被当成一笔巨额输入, 高估远糟于漏记。
      const codexDoneUsage = {
        promptTokens: realTurnUsage.input,
        completionTokens: realTurnUsage.output,
        reasoningTokens: 0,
        cachedTokens: realTurnUsage.cacheRead,
      };
      eventQueue.push({
        type: 'done',
        data: {
          type: 'codex/event/task_complete',
          usage: codexDoneUsage,
          raw: turn,
          plan: latestPlanByTurn.get(turn.id) ?? null,
        },
        source: 'codex',
      });
      latestPlanByTurn.delete(turn.id);
      // 计划模式: plan turn 正常收尾且产出了 proposed plan → 发起审批闭环。
      // 放在 done 之后 (AsyncQueue FIFO), renderer 先做完 turn 收尾再挂 plan 卡片。
      // 空跑(模型没产出 <proposed_plan>, 例如直接回答了问题) → 循环结束,
      // 下一 turn 经 threadTouchedPlanMode 复位 default。
      const planForReview = proposedPlanText?.trim();
      proposedPlanText = null;
      if (completedTurnWasPlanMode && planCycleActive) {
        if (planForReview) {
          void runPlanReviewFlow(planForReview, turn.id);
        } else {
          log.debug('plan turn produced no proposed plan — plan cycle ends', { turnId: turn.id });
          planCycleActive = false;
        }
      }
      flushDeferredTerminalTurnCompletionsIfIdle();
    }

    /**
     * 该 item 是否代表"模型真的干了活"(有输出或有工具副作用)。
     *
     * app-server 会在 turn 开头把用户输入原样 echo 成一个 userMessage item ——
     * translator 明确不消费它(见 translateItemNotification 里"故意不消费"那份清单)。
     * 把这种 echo 算进产出, 过载重投的产出守卫会在**正常事件序**下就立刻生效, 自动
     * 重投等于整体失效(review #844 codex P1)。hookPrompt 与 review 模式开关同理: 既
     * 不是模型输出也没有工具副作用。
     *
     * 未知 / 缺失 type 一律按"有产出"处理: 宁可少重投一次, 不可把可能有副作用的
     * turn 整体重放。
     */
    const ITEM_TYPES_WITHOUT_MODEL_WORK = new Set([
      'userMessage',
      'hookPrompt',
      'enteredReviewMode',
      'exitedReviewMode',
    ]);
    const itemRepresentsModelWork = (item: { type?: unknown } | null | undefined): boolean => {
      const type = typeof item?.type === 'string' ? item.type : null;
      return type === null || !ITEM_TYPES_WITHOUT_MODEL_WORK.has(type);
    };

    /** 取消挂起的过载重投（会话关闭 / 用户打断 / 新 turn 覆盖时调用）。 */
    const cancelOverloadRetry = (reason: string): void => {
      const state = overloadRetry;
      if (!state?.timer) return;
      clearTimeout(state.timer);
      state.timer = null;
      log.info('codex overload retry cancelled', { reason, threadId });
    };

    /**
     * 彻底废弃当前的重投状态：清计时器、摘 signal 监听、置空引用。
     *
     * 与 cancelOverloadRetry 的分工：后者只清计时器（scheduleOverloadRetry 排新档
     * 前的 'superseded' 就靠它，那时状态本身还要继续用）。凡是**状态整体作废**的地方
     * 都必须走这个，否则 signal 的 abort 监听会残留在一个已废弃的闭包上。
     */
    const discardOverloadRetry = (reason: string): void => {
      const state = overloadRetry;
      if (!state) return;
      cancelOverloadRetry(reason);
      state.disposeSignalWatch?.();
      state.disposeSignalWatch = null;
      overloadRetry = null;
    };

    /**
     * 空 turnId 的容量拒绝, 要等 turn/start 响应回来才知道说的是哪个 turn。
     *
     * 认领它并落墓碑, 否则 handleTurnStartResp 会把这个**已经报过容量失败**的 turn
     * 正常激活: 一边跑着一个已被拒的 turn, 一边还挂着重投计时器 —— 同一条用户输入
     * 会被执行两遍(review #844 codex P1)。初始 turn/start 与重投 turn/start 两条路
     * 共用本函数。
     */
    const adoptUnidentifiedDeadTurn = (resp: TurnStartResponse, startSeq: number): void => {
      const entry = inFlightStarts.get(startSeq);
      if (!entry?.quarantined) return;
      const turnId = resp.turn?.id;
      if (!turnId) return;
      entry.quarantined = false;
      terminalErroredTurnIds.add(turnId);
      // 这个 turn 的产出可能正躺在缓冲队列里(孤儿守卫武装期间 item / tool 都会被缓冲, 而
      // 缓冲**只**表示我们还没渲染 —— daemon 那边命令早就跑了)。此时它自己的产出记账从未
      // 被置上, 于是补排会照常重放同一条输入, 副作用执行两遍(review #844 codex P1)。
      //
      // 判据是"缓冲里有真的模型 / 工具工作", **不是**"队列非空": 队列里 turn/completed、
      // userMessage echo、tokenUsage 都算一条, 拿长度当证据会把一次零产出的容量拒绝误判成
      // 有产出, 对用户报硬失败 —— 而那一轮其实什么副作用都没发生(review #844 codex P1)。
      if (bufferedModelWorkTurnIds.has(turnId)) {
        producedOutputTurnIds.add(turnId);
        log.info('codex adopted turn had buffered events — treating as produced output', {
          turnId,
          threadId,
        });
      }
      // server 侧这个 turn 可能真的在跑(Stop / 撤单那条来源就是), 落墓碑只挡事件、
      // 不停执行 —— 必须补一次 best-effort interrupt。容量拒绝那条来源里它本就已死,
      // interrupt 是无害的空操作。
      if (threadId) {
        host.request(Method.TurnInterrupt, { threadId, turnId }).catch((e: unknown) => {
          log.warn('quarantined pending start turn interrupt failed (best-effort)', {
            turnId,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
      const state = overloadRetry;
      // 被延后的那条失败也要回填 id, 补排时才能清掉它挂起的审批 / 工具上下文。
      if (state?.deferredCapacityFailure?.deadTurnId === null) {
        state.deferredCapacityFailure = { deadTurnId: turnId };
      }
      // turnStarted 可能已经先于响应到达并把这个 id 激活。只落墓碑不清活跃态的话,
      // rescheduleDeferredCapacityFailure 会因为"看起来还有 turn 在跑"而放弃补排(且顺手
      // 清掉延后标记), 而那个 turn 的 turn/completed 又被墓碑压掉 —— 逻辑 send 既没有
      // 下一次重投也没有终态事件, 永久悬空(review #844 codex P1)。与错误自带 id 时的
      // 死 turn 处理保持一致。
      if (currentTurnId === turnId) {
        dismissPendingUserInputForTurn(turnId, 'turn_failed');
        clearActiveToolContextsForTurn(turnId);
        stopActiveRolloutPlanFallback();
        currentTurnId = null;
        isTurnInFlight = false;
      }
      log.info('codex adopted turn/start response id for an id-less capacity failure', {
        turnId,
        threadId,
      });
    };

    /**
     * 挂起的过载重投, 冻结的策略是否比 `mode` 更宽。
     *
     * 重投持的是发射那一刻冻结的 turnParams, 期间任何收紧都不会自动作用到它。判据
     * 必须按严格度直接比"冻结档 vs 目标档", 不能只看"最近一次转换算不算收紧" ——
     * Full access → Ask → Auto 这类中间态下最近一次是放宽, 而冻结的 Full access 仍然
     * 比 Auto 宽(review #844 codex P1)。
     *
     * 公开的 setPermissionMode 与 Guardian 失败时的内部降级
     * (switchAutoRuntimeToAskImmediately) 共用它: 后者绕开了公开路径, 只判
     * currentTurnId / isTurnStartPending, 会漏掉"退避计时器正在等"这个窗口 ——
     * 那时重投一到点就会以已被撤销的宽松档执行工具(review #844 codex P1)。
     */
    /**
     * 本轮 send 的过载重投是否"还会发生"。三种状态都算:
     *   - `timer != null`：退避等待中，计时器持着原消息；
     *   - `inFlight`：计时器已到点、重投 RPC 在途、新 turn 尚未激活；
     *   - `deferredCapacityFailure !== null`：失败已记账、等在途 turn/start settle 后
     *     补排（那一刻既没有计时器也没有 inFlight）。
     *
     * 抽成单一判据是因为它同时决定三件事: 会话忙不忙(isTurnRunning)、取消要不要收口
     * (signal abort)、权限收紧要不要作用到重投。前几轮每处各写一份, 第三种状态加进来
     * 时漏了两处(review #844 codex/greptile P1)。
     */
    const overloadRetryPending = (
      state: typeof overloadRetry = overloadRetry,
    ): state is NonNullable<typeof overloadRetry> =>
      state != null
      && (state.timer != null || state.inFlight || state.deferredCapacityFailure !== null);

    /**
     * 逻辑 send 被终态收口(terminal error + Done 都已推出)时, 撤销挂起 / 延后的重投。
     *
     * 不撤销的话重投会在 UI 已经报失败之后照常发生: 最典型的是延后标记 ——
     * `turn/completed(failed)` 抢在我们落墓碑之前到达(空 id 容量拒绝那条路要等
     * turn/start 响应才知道 turn 身份, 这个窗口是真实存在的), 于是 handleTurnCompleted
     * 正常收口成失败; 标记却还挂着, 等在飞的 turn/start settle 时它的 finally 照常补排
     * 一次 —— 用户看到的是失败, 原消息却在他看不到的地方重投, 服务端已发生但未上报的
     * 工具 / 文件操作跟着跑第二遍(review #844 greptile P1)。
     *
     * 语义上这就是"重投资格随收口一起作废": 代价只是这一轮要用户自己再发一次(与本功能
     * 上线前的行为一致), 而另一侧是重复副作用。
     */
    const revokeOverloadRetryOnTerminalSettle = (reason: string): void => {
      if (!overloadRetryPending()) return;
      log.info('codex overload retry revoked — send already settled terminally', { reason, threadId });
      discardOverloadRetry(`terminal-settle:${reason}`);
    };

    const overloadRetryPolicyLooserThan = (mode: PermissionMode): boolean => {
      const state = overloadRetry;
      if (!overloadRetryPending(state)) return false;
      return (
        codexPermissionStrictnessRank(state.launchedPermissionMode)
        < codexPermissionStrictnessRank(mode)
      );
    };

    /**
     * 取消一轮过载重投时, 把它**已经激活**的 turn 一起收掉。
     *
     * 重投的 turnStarted 可能先于它的 turn/start 响应到达(协议允许的乱序), 那时
     * currentTurnId 已经指向这个真实存在的 server turn。只推终态事件、不动它, 那个
     * turn 会在调用方已按"已取消"处理之后继续执行工具(review #844 codex P1)。
     *
     * 自己落墓碑是关键: 之后到达的 turn/completed 会被压掉, 所以收口恰好一次 ——
     * 无论重投响应最终是 resolve(它自己也会落墓碑)还是 reject。
     * handle.abort() 与 sendOpts.signal 两条取消路径共用本函数。
     */
    const teardownActiveTurnForCancellation = (reason: string): void => {
      const turnId = currentTurnId;
      if (!turnId) return;
      terminalErroredTurnIds.add(turnId);
      dismissPendingUserInputForTurn(turnId, 'turn_interrupted');
      clearActiveToolContextsForTurn(turnId);
      if (threadId && !skipIfStaleHost('turn/interrupt')) {
        host.request(Method.TurnInterrupt, { threadId, turnId }).catch((e: unknown) => {
          log.warn('cancelled overload retry turn interrupt failed (best-effort)', {
            reason,
            turnId,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
      stopActiveRolloutPlanFallback();
      currentTurnId = null;
      isTurnInFlight = false;
      currentTurnPlanModeActive = false;
    };

    /**
     * 退避等待 / 重投 RPC 在途期间发现本轮 send 已被取消时, 收口逻辑 turn。
     *
     * 只有"coordinator 只 abort 了 sendOpts.signal、没走 handle.abort()"那条路需要
     * 它: abort() 自己已经推过终态并把 overloadRetry 置 null, 所以那条路走到这里时
     * overloadRetry !== state, 不会二次收口。
     *
     * 为什么非推不可: signal 在本文件里原本只是**受理前**的取消边界
     * (rejectIfCancelled 抛 "cancelled before acceptance"), 受理后没人再读它 —— 是
     * 过载重投第一次在受理后去读 signal.aborted。若读到 aborted 就静默 return, 上层
     * 永远等不到终态: desktop 的 SessionTurnActivityTracker 只在终态事件后释放派发
     * 闩, Codex coordinator 刻意等这个事件而不自解锁, hook runner 要等一小时硬超时
     * (review #844 greptile P1)。
     */
    const settleCancelledOverloadRetry = (
      state: NonNullable<typeof overloadRetry>,
      reason: string,
    ): void => {
      if (closed || overloadRetry !== state) return;
      discardOverloadRetry(`settle:${reason}`);
      // 重投的 turnStarted 已先于响应到达时, currentTurnId 指着一个真实在跑的
      // server turn —— 必须一起收掉, 否则它会在调用方按"已取消"处理后继续执行工具。
      teardownActiveTurnForCancellation(reason);
      markInFlightStartsTerminallySettled();
      // 还有 turn/start 在飞时同理: 它的响应晚于本次收口回来, 不隔离就会被正常激活。
      // 全部隔离而不只是最新那个: 取消的语义是"这一轮什么都别再跑"。
      quarantineAllInFlightStarts();
      log.info('codex overload retry cancelled via send signal — settling logical turn', {
        reason,
        threadId,
      });
      eventQueue.push({
        type: 'error',
        data: {
          message: 'Codex turn cancelled while waiting to retry a model-capacity failure',
          isTerminal: true,
          reason: 'codex-overload-retry-cancelled',
        },
        source: 'codex',
      });
      eventQueue.push({
        type: 'status',
        data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
        source: 'codex',
      });
    };

    /**
     * 服务过载退避重投调度。
     *
     * 返回进度表示已接管本次错误，**调用方必须跳过终态收口**（不推 terminal
     * error、不推 Done status）——否则 UI 会先收口成失败再重投，用户看到一次假
     * 失败闪烁，非交互入口更会直接把这一轮判死。返回 null 表示不接管，按原
     * 终止路径报错。
     *
     * 为什么必须由我们重投：`Selected model is at capacity` 是模型服务槽位不足，
     * OpenAI 侧不做任何重试就把 turn 判死（openai/codex#22390 请求 backoff 重试
     * 至今 open），用户只能手动再发一次。这类抖动通常几秒内自愈，正是客户端该
     * 兜住的部分。
     *
     * 为什么不自动换模型：容量故障往往横扫同一模型的所有 effort 档
     * （2026-06-16 那次 medium/high/xhigh 全线不可用），换档无效；而换模型会
     * 悄悄改变输出的判断风格，属于隐蔽的质量变更。降级留给用户显式选择。
     */
    const scheduleOverloadRetry = (
      deadTurnId: string | null,
    ): { attempt: number; maxAttempts: number } | null => {
      const state = overloadRetry;
      if (!state || closed) return null;
      // 本轮已被取消(sendOpts.signal 已 abort)→ 一律不接管, 让这条错误走原终态路径收口。
      // 不判的话: signal 在"初始 turn/start 还在飞、容量通知尚未到达"时 abort, 那个 {once}
      // 监听器因为当时无事可做而被消费掉; 随后到达的空 id 容量拒绝照样建出
      // deferredCapacityFailure, 而补排会在 isCancelled() 上退出 —— 标记留着,
      // overloadRetryPending() 因此恒真, isTurnRunning() 永远为真(review #844 codex P1)。
      if (state.isCancelled()) {
        // 不接管**不等于**什么都不用做: 在飞的 start 必须一起隔离。这条错误随后走终态路径,
        // 而在飞那次 RPC 若 resolve, 取消边界会在 quarantineTurnsAfterStartFailure 之前就把
        // 异常抛出去 —— 于是迟到的 turnStarted 既没有隔离也没有墓碑, 会把这个已被取消的 turn
        // 激活并执行工具(review #844 codex P1)。取消语义是"这一轮什么都别再跑", 所以隔离全部
        // 在飞 start(与 settleCancelledOverloadRetry 一致); 隔离后响应回来时
        // adoptUnidentifiedDeadTurn 会落墓碑 + 补 interrupt。
        // 还要记"已由取消收口过": 这条错误马上就以终态形式发出去了(translator 那边),
        // 而在飞那次 RPC 若最终 **reject**, finalErr 分支看到 initialStartSettledByCancel
        // 为 false 会再推一组 terminal error + Done —— 同一轮收口两次, 而事件不带 send 世代,
        // 期间若已有新一轮 send, 这份过期收口会落到它头上(review #844 codex P1)。
        // 两件事一起做才与 settleCancelledOverloadRetry 同构(它也是 mark + quarantine)。
        markInFlightStartsTerminallySettled();
        quarantineAllInFlightStarts();
        log.info('codex not taking over a capacity failure for an already-cancelled send', {
          quarantinedStarts: inFlightStarts.size,
          threadId,
        });
        return null;
      }
      // 空 id 的容量拒绝**无法归属**到具体请求(协议里它既不带 turnId 也不带请求关联)。
      // 只有一个 start 在飞时可以安全地认定就是它; 有两个及以上时(Stop 留下的旧 RPC 仍在飞、
      // 下一轮 send 又已发出)猜错的代价是: 隔离到错的那一个 → 把**已经在 server 上跑过工具**
      // 的新 turn 落墓碑并重放它的输入 → 副作用执行两遍(review #844 codex P1)。
      // 这里选择不接管: 代价只是这一轮要用户自己再发一次, 而错误的一侧是重复副作用。
      if (!deadTurnId && inFlightStarts.size > 1) {
        log.warn('codex id-less capacity failure not attributable — declining takeover', {
          inFlightStarts: inFlightStarts.size,
          threadId,
        });
        return null;
      }
      // 本 turn 已产出内容 → 重放会让模型重做已完成的工作（甚至重复副作用），
      // 交回用户决定是否继续，不自动重投。
      //
      // **必须先于下面的 inFlight 延后分支**：重投出来的 turn 完全可能在自己的
      // turn/start 响应 settle 之前就已经发出 item / tool / reasoning，那时
      // state.inFlight 仍为 true，先走延后分支就会把这个已有产出的 turn 落墓碑、
      // 随后重放原消息 —— 已经执行过的命令与文件改动跑第二遍
      // (review #844 codex P1)。这里返回 null 是安全的：有产出意味着该 turn 早已
      // 被 turnStarted 激活，不存在"UI 收口后在途 RPC 又把 turn 激活"的悬空风险。
      // deadTurnId 为空(空 id 容量拒绝)时查不了, 也不必查: 那条路要求 currentTurnId 为
      // null, 即这个 turn 的 turnStarted 还没到, 它的 item / reasoning 不可能被记到自己
      // 名下(全被 stale 闸或缓冲挡住)。缓冲事件那种"看不见的产出"由
      // adoptUnidentifiedDeadTurn 在响应回来、id 已知时补记, 补排再查一次就拦住了。
      if (deadTurnId && producedOutputTurnIds.has(deadTurnId)) {
        log.info('codex overload error after partial output — not auto-retrying', {
          threadId,
          deadTurnId,
          inFlight: state.inFlight,
        });
        return null;
      }
      // 上一次重投的 turn/start 还在飞 → 绝不能再排一个。cancelOverloadRetry 只能
      // 清计时器、取消不了在途 RPC，两个请求都可能被 server 接受，同一条用户输入
      // 的工具副作用就会执行两遍（review #844 codex P1）。在途那次自己会走完
      // 成功/失败路径，届时若仍缺容量会重新进入本函数。
      if (inFlightStarts.size > 0) {
        // 关键：**不能返回 null**。null 会让 translator 把这条错误报成终态，把逻辑
        // turn 判死（review #844 codex P1），而在途那次 RPC 随后还可能成功并激活
        // turn —— UI 已收口。这里返回当前进度：错误照样透成非终止状态（UI 继续显示
        // 「正在重试」），但不递增预算、不排新计时器。
        // 同时记账：这条失败只是被**延后**，retry() 的 finally 会在 RPC settle 后
        // 补排一次；不记的话没有任何计时器或终态事件残留，逻辑 send 会永久悬空。
        state.deferredCapacityFailure = { deadTurnId };
        if (!deadTurnId) quarantineLatestInFlightStart();
        // 这个 turn 在 app-server 侧已经死了, 必须**当场**把它从"活跃 turn"上摘掉,
        // 不能等它自己的 turn/completed。事件顺序 turnStarted → 容量错误 →
        // turn/start 响应 下, retry() 的 finally 跑到补排判定时 currentTurnId 还挂着
        // 这具尸体 → 补排条件不成立; 而随后到达的 turn/completed 被墓碑压掉, 只清
        // currentTurnId、不排任何东西 —— 逻辑 send 永久悬空(review #844 codex P1)。
        // 只在确认是同一个 turn 时清: 真有别的 turn 活着说明这条错误不针对当前轮,
        // 那时本就不该补排。
        if (deadTurnId && currentTurnId === deadTurnId) {
          dismissPendingUserInputForTurn(deadTurnId, 'turn_failed');
          clearActiveToolContextsForTurn(deadTurnId);
          stopActiveRolloutPlanFallback();
          isTurnInFlight = false;
          currentTurnId = null;
        }
        log.info('codex overload retry already in flight — deferring this failure to it', {
          attempt: state.attempt,
          threadId,
          deadTurnId,
        });
        // 初始 RPC 在飞时 attempt 仍是 0（一次重投都还没发生），报 0/4 既难看也不实。
        // 延后的这条失败补排时会消耗第 1 档，所以下限取 1。
        return {
          attempt: Math.max(1, state.attempt),
          maxAttempts: OVERLOAD_RETRY_MAX_ATTEMPTS,
        };
      }
      if (state.attempt >= OVERLOAD_RETRY_MAX_ATTEMPTS) {
        log.warn('codex overload retry budget exhausted — surfacing terminal error', {
          attempts: state.attempt,
          threadId,
        });
        return null;
      }
      // 同一轮 send 只能有一个在飞的重投计时器。
      cancelOverloadRetry('superseded');
      const attempt = state.attempt + 1;
      state.attempt = attempt;
      const delayMs = overloadRetryDelayMs(attempt);
      // 该 turn 在 app-server 侧确实已经死了：它挂起的审批 / user-input 必须清掉，
      // 否则重投出来的新 turn 会与旧 turn 的悬空交互混在一起。
      if (deadTurnId) {
        dismissPendingUserInputForTurn(deadTurnId, 'turn_failed');
        clearActiveToolContextsForTurn(deadTurnId);
      } else {
        // 空 id: 那个 turn 的身份要等 turn/start 响应才知道(典型是初始投递的
        // turn/start 还没回包)。不记账的话响应会把这个已被拒的 turn 正常激活,
        // 与刚排上的重投计时器一起把同一条输入跑两遍(review #844 codex P1)。
        quarantineLatestInFlightStart();
      }
      stopActiveRolloutPlanFallback();
      isTurnInFlight = false;
      currentTurnId = null;
      log.info('codex model at capacity — scheduling turn/start retry', {
        attempt,
        maxAttempts: OVERLOAD_RETRY_MAX_ATTEMPTS,
        delayMs,
        threadId,
        deadTurnId,
      });
      // 重投持的是**冻结**策略。排上计时器的这一刻若当前档已经比冻结档更严, 必须
      // (重新)武装延迟中断标记: 收紧若发生在"失败已延后、计时器还没排上"的窗口里,
      // 那个标记会先被原始 turn 的 turn/start 响应消费掉(handleTurnStartResp 无条件
      // 消费它), 等重投真的发出去时已经没有任何东西能拦住它 —— 工具就会在权限已被
      // 撤销后执行(review #844 codex P1)。这里按状态重新推导, 不依赖标记存活。
      if (
        codexPermissionStrictnessRank(state.launchedPermissionMode)
        < codexPermissionStrictnessRank(mutablePermissionMode)
      ) {
        pendingTightenInterrupt = true;
        log.info('codex overload retry armed a tighten interrupt (frozen policy is looser)', {
          frozen: state.launchedPermissionMode,
          current: mutablePermissionMode,
          threadId,
        });
      }
      state.timer = setTimeout(() => {
        state.timer = null;
        if (closed || overloadRetry !== state) return;
        void state.retry().catch((error) => {
          // 取消之后 RPC 才 reject：Stop / close / 新 send 都已经各自收口过这一轮
          // （abort 与新 send 会把 overloadRetry 置 null，close 会置 closed）。
          // 此时再报一次 terminal error + Done 会让 UI 二次收口，并把用户主动停止
          // 误报成「重投失败」。只留日志。
          // 成功路径的同款复检在 retry() 内部（cancelledMidFlight）；reject 会绕过
          // 那一段直接落到这里，两条路都要判。
          if (closed || overloadRetry !== state || state.isCancelled()) {
            log.info('codex overload retry rejected after cancellation — not surfacing', {
              attempt,
              error: String(error),
              threadId,
            });
            return;
          }
          // 重投本身失败（含容量再次不足）：转终止错误交回用户，不在这里递归重排——
          // 递归会绕过预算上限，容量故障期把额度烧光。
          log.error('codex overload retry failed', { attempt, error: String(error), threadId });
          // 与原始 turn/start 失败同款隔离：这次 RPC 可能已被 server 接受, 只是响应没
          // 回来。不隔离的话, 先于 reject 到达的 turnStarted 会让 isTurnRunning() 在
          // UI 收口后永真, 晚到的那种则会把一个没人消费的 turn 激活并执行工具
          // (review #844 codex P1)。
          quarantineTurnsAfterStartFailure('overload retry turn/start failed', {
            ownsSession: sendGeneration === state.sendGen,
          });
          eventQueue.push({
            type: 'error',
            data: { message: `turn/start retry failed: ${String(error)}`, isTerminal: true },
            source: 'codex',
          });
          eventQueue.push({
            type: 'status',
            data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
            source: 'codex',
          });
        });
      }, delayMs);
      return { attempt, maxAttempts: OVERLOAD_RETRY_MAX_ATTEMPTS };
    };

    /**
     * turn/start RPC 级失败(超时 / 拒绝)后的孤儿隔离。
     *
     * RPC 失败**不代表** server 没建 turn —— daemon 可能已经接受了 turn/start, 只是
     * 响应没回来。所以必须三件事一起做: 立孤儿守卫(之后迟到的 turnStarted 不得重新
     * 激活会话)、把可能已被 started-before-resp 激活的活跃 turn 收掉(墓碑 + 清状态 +
     * best-effort interrupt)、把缓冲的歧义 started 坐实成孤儿。
     *
     * 过载重投的 RPC 失败走同一套: 只推 terminal error + Done 的话, 迟到的
     * turnStarted 会在 UI 已收口之后把一个没人消费的 turn 激活并执行工具; 而先于
     * reject 到达的那种则会让 isTurnRunning() 永真, 下一条 send 被并发守卫挡死
     * (review #844 codex P1)。
     */
    const quarantineTurnsAfterStartFailure = (
      reason: string,
      opts?: { ownsSession?: boolean },
    ): void => {
      turnStartFailedWithoutTurnId = true;
      // currentTurnId 未必属于**这一次**失败的请求: Stop 之后下一轮 send 可能已经激活了它
      // 自己的 turn, 这时把它当孤儿收掉 = 误杀一个合法在跑的 turn(review #844 codex P1)。
      // 只有"我这一轮还拥有会话"时才动它; 否则只留孤儿守卫与缓冲清理。
      const mayClaimActiveTurn = opts?.ownsSession !== false;
      if (currentTurnId && mayClaimActiveTurn) {
        const orphanTurnId = currentTurnId;
        terminalErroredTurnIds.add(orphanTurnId);
        if (threadId) {
          host.request(Method.TurnInterrupt, { threadId, turnId: orphanTurnId }).catch((e2: unknown) => {
            log.warn('turn/start-failure orphan interrupt failed (best-effort)', {
              reason,
              turnId: orphanTurnId,
              error: e2 instanceof Error ? e2.message : String(e2),
            });
          });
        }
        currentTurnId = null;
        isTurnInFlight = false;
        currentTurnPlanModeActive = false;
      }
      // 缓冲集是**会话级共享**的, 只有"没有别的 start 在飞"时才能把里面的 id 整体坐实成
      // 孤儿。还有 start 在飞时集子里可能躺着**它**的合法 started: Stop 会武装孤儿守卫,
      // 于是下一轮 send 的 turnStarted 同样先进缓冲等对账。无条件清理会给它落墓碑 +
      // interrupt, 它的 turn/start 响应随后拒绝激活 —— 那一轮既没有活跃 turn 也没有终态
      // 事件, 永久卡 generating。ownsSession 挡不住这条: 那个守卫只护 currentTurnId
      // (review #844 codex P1)。
      //
      // 留着不动是正确的收口: 在飞那次的响应本身就是权威对账者(id 不一致的坐实成孤儿并
      // interrupt, 自己的正常激活); 它若也失败, 轮到它调用本函数时 inFlightStarts 已空,
      // 集子在那时才被清。本函数的两个调用点都在各自请求 endTurnStart 之后, 所以这里的
      // size>0 只可能是**别的**请求。
      if (inFlightStarts.size === 0) {
        for (const bufferedId of bufferedOrphanTurnIds) {
          terminalErroredTurnIds.add(bufferedId);
          settleBufferedTurnReconcile(bufferedId, false);
          if (threadId) {
            host.request(Method.TurnInterrupt, { threadId, turnId: bufferedId }).catch((e2: unknown) => {
              log.warn('buffered orphan turn interrupt failed (best-effort)', {
                reason,
                turnId: bufferedId,
                error: e2 instanceof Error ? e2.message : String(e2),
              });
            });
          }
        }
        bufferedOrphanTurnIds.clear();
        bufferedTurnEventQueues.clear();
      } else {
        log.debug('leaving buffered turns to the surviving turn/start response', {
          reason,
          bufferedTurnIds: [...bufferedOrphanTurnIds],
          inFlightStarts: inFlightStarts.size,
        });
      }
    };

    /**
     * 在途的 turn/start settle 后, 补排那条被延后的容量失败。
     *
     * 两条 start 路径共用: 重投自己的 RPC, 以及初始投递的 RPC(空 id 容量拒绝会落在它
     * 还在飞的窗口里)。只有新 turn 确实没能激活时才补排（它被落了墓碑、响应因此拒绝
     * 激活）; turn 活了就说明那条错误针对的是别的 turn, 不该重排。预算耗尽时必须自己
     * 推终态, 否则逻辑 send 永久悬空。
     *
     * rpcSettledOk=false（RPC reject / 本地取消边界）时不补排: 那条路各自有终态收口,
     * 在这里再排一个计时器会与它并存 —— UI 已收口, 原消息却仍被静默重投。
     */
    const rescheduleDeferredCapacityFailure = (
      state: NonNullable<typeof overloadRetry>,
      rpcSettledOk: boolean,
    ): void => {
      const deferred = state.deferredCapacityFailure;
      if (!deferred) return;
      // **只有真正接手时才清掉标记**。此前是一进函数就清: 被取消的旧 send 的 finally 把
      // 当前(属于新 send 的)状态传进来, 随后任一 early return 都会把新 send 的延后失败
      // 丢掉 —— 那一轮既不重投也不收口, 逻辑 turn 永久悬空(review #844 greptile P1)。
      if (!rpcSettledOk) {
        // 只有"标记归属本轮、而本轮 RPC 失败"时才会到这里(见调用点), 那条失败已由终态收口。
        state.deferredCapacityFailure = null;
        return;
      }
      if (closed || overloadRetry !== state) return;
      // 已取消却还挂着延后标记 → **必须收口**, 不能静默返回: 标记留着会让
      // overloadRetryPending() 恒真, isTurnRunning() 永远为真, 上层派发闩不释放
      // (review #844 codex P1)。settleCancelledOverloadRetry 会 discard 状态(标记随之清掉)
      // 并推终态; 重复调用是无害的 no-op(它自查 overloadRetry !== state)。
      if (state.isCancelled()) {
        settleCancelledOverloadRetry(state, 'deferred capacity failure on a cancelled send');
        return;
      }
      if (currentTurnId !== null || isTurnInFlight) return;
      // 还有别的 start 在飞 → 这条失败交给那一次的 settle 去补排, 本次不排:
      // 否则又回到"两个 start 并存"的形状(review #844 codex P1)。
      if (inFlightStarts.size > 0) return;
      state.deferredCapacityFailure = null;
      if (scheduleOverloadRetry(deferred.deadTurnId)) return;
      log.warn('codex deferred capacity failure exhausted the retry budget', {
        attempt: state.attempt,
        threadId,
      });
      eventQueue.push({
        type: 'error',
        data: {
          message: 'Selected model is at capacity. Please try a different model.',
          isTerminal: true,
        },
        source: 'codex',
      });
      eventQueue.push({
        type: 'status',
        data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
        source: 'codex',
      });
    };

    const GUARDIAN_REVIEW_FAILURE_PREFIX = 'Automatic approval review failed:';

    const emitGuardianUnavailable = (params: ItemGuardianApprovalReviewCompletedNotification): void => {
      const timedOut = params.review.status === 'timedOut';
      eventQueue.push({
        type: 'error',
        data: {
          // Renderer uses reason for localized copy. Keep an English fallback for
          // non-renderer consumers while always stating the blocked action + downgrade.
          message: timedOut
            ? 'Codex automatic approval review timed out. The action was blocked and this session is switching to Ask mode.'
            : 'Codex automatic approval review failed. The action was blocked and this session is switching to Ask mode.',
          isTerminal: false,
          reason: 'codex-auto-review-unavailable',
          reviewId: params.reviewId,
          reviewRationale: params.review.rationale,
        },
        source: 'codex',
      });
    };

    /**
     * Close the race between a Guardian failure notification and the async host
     * persistence coordinator. The current action is already blocked; changing the
     * local mode synchronously ensures a message sent immediately afterwards starts
     * in Ask instead of launching another auto_review turn that is then interrupted.
     */
    const switchAutoRuntimeToAskImmediately = (): boolean => {
      if (mutablePermissionMode !== 'auto') return false;
      dismissAllPending('permission_mode_changed_to_ask', 'deny');
      mutablePermissionMode = 'ask';
      // 挂起的过载重投也要一起收紧: 它冻结的是 Auto / Full access, 而 Guardian 已经
      // 不可用、运行期刚降到 Ask。这条路**绕开**了公开的 setPermissionMode, 原本只判
      // currentTurnId / isTurnStartPending —— 退避计时器正在等的那个窗口两者都不成立,
      // 重投一到点就会以已被撤销的宽松档执行工具(review #844 codex P1)。
      const retryPolicyLooserThanAsk = overloadRetryPolicyLooserThan('ask');
      if (!closed && (turnLaunchedUnattended || retryPolicyLooserThanAsk)) {
        if (currentTurnId !== null) {
          void interruptTurnForPermissionTighten(currentTurnId);
        } else if (isTurnStartPending || retryPolicyLooserThanAsk) {
          // 与 turn/start 在飞同构: 标记由 handleTurnStartResp / turnStarted 在拿到
          // turn id 的瞬间消费并补中断。
          pendingTightenInterrupt = true;
        }
      }
      return true;
    };

    const notifyAutoPermissionClassifierUnavailable = (
      params: ItemGuardianApprovalReviewCompletedNotification,
    ): void => {
      if (!switchAutoRuntimeToAskImmediately() || typeof opts.sessionId !== 'string') return;
      const notify = this.deps.onAutoPermissionClassifierUnavailable;
      if (!notify) return;
      const status = params.review.status === 'timedOut' ? 408 : 500;
      queueMicrotask(() => {
        try {
          notify({
            sessionId: opts.sessionId as string,
            agentKind: 'codex',
            status,
          });
        } catch (error) {
          log.warn('Codex Auto fallback notification threw', {
            reviewId: params.reviewId,
            error: String(error),
          });
        }
      });
    };

    const handleGuardianReviewCompleted = (params: ItemGuardianApprovalReviewCompletedNotification): void => {
      if (seenGuardianReviewIds.has(params.reviewId)) return;
      seenGuardianReviewIds.add(params.reviewId);
      const rationale = params.review.rationale?.trim();
      const failedClosedBecauseReviewerUnavailable =
        params.review.status === 'denied' &&
        rationale?.startsWith(GUARDIAN_REVIEW_FAILURE_PREFIX) === true;
      if (params.review.status === 'timedOut' || failedClosedBecauseReviewerUnavailable) {
        emitGuardianUnavailable(params);
        notifyAutoPermissionClassifierUnavailable(params);
        return;
      }
      if (params.review.status === 'denied') {
        // Match Claude Auto: a real classifier verdict is authoritative. Codex has
        // already blocked the action and returned the denial to the model; do not
        // weaken Auto by offering a user override prompt.
        log.info('Codex automatic approval review denied action', {
          reviewId: params.reviewId,
          turnId: params.turnId,
          targetItemId: params.targetItemId,
          actionType: params.action.type,
          riskLevel: params.review.riskLevel,
          rationale: params.review.rationale,
        });
      }
    };

    // ── subscribeThread: notification 路由 + approval handlers ─────────────
    const handlers: ThreadEventHandlers = {
      threadStarted: (params) => {
        const sid = params.thread?.id;
        if (sid && sid !== sdkSessionId) sdkSessionId = sid;
        if (sdkSessionId) {
          eventQueue.push({ type: 'session_id', data: sdkSessionId, source: 'codex' });
        }
      },
      turnStarted: (params) => {
        // turn/start RPC 已失败(超时/拒绝)但 daemon 实际已建 turn — 迟到的孤儿
        // turnStarted 不得重新激活已报终态错误的会话 (greptile P1): 立墓碑 +
        // 补 interrupt 让 daemon 停掉这个没人消费的 turn。分支先于 stale 闸
        // (codex R15 P1): 闸对 idle 孤儿只立墓碑, turnStarted 必须走这里补
        // interrupt; 被闸先拦就发不出了。已墓碑/已完成的 id 不重复进分支
        // (interrupt 不重复发), 交给下面的闸拦。
        if (
          turnStartFailedWithoutTurnId
          && currentTurnId === null
          && !terminalErroredTurnIds.has(params.turn.id)
          && !completedTurnIds.has(params.turn.id)
        ) {
          if (isTurnStartPending) {
            // 新 turn/start 在飞 → 归属不明 (失败 RPC 的孤儿 vs 在飞 RPC 合法的
            // started-before-resp, 协议层无法区分): 缓冲隔离, 等响应按 turnId
            // 对账 (codex R9 P2)。直接接受会让孤儿 turn 的 item 事件渲染到
            // 本次 send 下。
            bufferedOrphanTurnIds.add(params.turn.id);
            log.debug('buffering ambiguous turnStarted until turn/start response arrives', {
              turnId: params.turn.id,
              threadId,
            });
            return;
          }
          terminalErroredTurnIds.add(params.turn.id);
          log.warn('ignoring orphan turnStarted from a failed turn/start — interrupting server-side turn', {
            turnId: params.turn.id,
            threadId,
          });
          if (threadId) {
            host.request(Method.TurnInterrupt, { threadId, turnId: params.turn.id })
              .catch((e: unknown) => {
                log.warn('orphan turn interrupt failed (best-effort)', {
                  turnId: params.turn.id,
                  error: e instanceof Error ? e.message : String(e),
                });
              });
          }
          return;
        }
        // terminal error 已经为该 turn 收口时，晚到的 start 只能忽略，等待 completed 做清理。
        if (shouldIgnoreStaleTurnEvent(params.turn.id)) return;
        // 终态已先到的 turn (墓碑) 不得被乱序晚到的 started 重新置活。
        if (turnsCompletedBeforeStartResp.has(params.turn.id)) return;
        threadMayHaveRollout = true;
        const wasSameTurn = currentTurnId === params.turn.id;
        // started 先于响应到达时归属方只能推断: 只有一个 start 在飞 → 就是它; 多个 → 认不出,
        // 不登记(读取方按"归属不明"从严处理)。
        const startedOwnerSeqs = [...inFlightStarts.keys()];
        turnOriginByTurnId.set(params.turn.id, {
          startSeq: startedOwnerSeqs.length === 1 ? (startedOwnerSeqs[0] as number) : null,
          sendGen: sendGeneration,
        });
        currentTurnId = params.turn.id;
        isTurnInFlight = true;
        turnStartGeneration += 1; // 见声明处:延迟善后靠它判断"期间起过新 turn"
        // turn 开始 → 球在上游,起 idle 表(后续任何事件都会重置它)。
        armUpstreamIdle();
        // turn/start 在飞期间权限被收紧 (turnStarted 通知可能先于 turn/start resp
        // 到达) → 拿到 id 立即补中断, 与 handleTurnStartResp 互斥消费同一标记。
        if (pendingTightenInterrupt) {
          pendingTightenInterrupt = false;
          void interruptTurnForPermissionTighten(params.turn.id);
        }
        if (!wasSameTurn) currentTurnPlanModeActive = pendingTurnStartPlanMode ?? planCycleActive;
        // 新 turn 开始 → 丢弃上一 turn 未消费的 proposed plan (正常路径已在
        // handleTurnCompleted 清空, 这里防御 stale)。same-turn 的晚到 started
        // 不清 (codex R15 P1): buffered turn 的 item 事件可能先于它的 started
        // 被重放 (interceptProposedPlanItem 已存 plan), 随后到达的同 id
        // started 若无条件清空, plan 模式下刚重放的 proposed plan 永久丢失。
        if (!wasSameTurn) proposedPlanText = null;
        terminalErroredTurnIds.delete(params.turn.id);
        // Reset auth retry-loop dedupe key — 让下一个 turn 重新可以 emit 第一条
        // auth error。详见 translator.translateErrorNotification dedupe 逻辑。
        translatorRt.lastAuthErrorKey = null;
        // 持续重试透出状态同理 (字段名沿旧称 networkRetryNotice, 实际已对任意
        // 持续性 willRetry 错误透出, 不限 networkish — issue #677): 新 turn
        // 重新计数, 可再透出一条。
        translatorRt.networkRetryNotice = null;
        // retry 升级计数同样按 turn 隔离 — 新 turn 从零计。
        turnRetryTracker.reset();
        // 产出记账**不在这里清**: 它按 turn id 存(producedOutputTurnIds), 新 turn 天然
        // 从"零产出"起算, 同一 turn 的重复 / 迟到 started 也不会抹掉已记的账 —— 这两条
        // 以前靠 `if (!wasSameTurn)` 的时序守卫维持(review #844 codex P1), 现在是结构性的。
        // **不在这里重置 overloadRetry.attempt**:过载重投本身会开出新 turn,
        // 在这里清预算等于每次重投都续满次数 → 容量故障期无限重试烧额度。
        // 预算只在 send() 收到用户新消息时重置。
        log.debug('SDK ▶ turn start', {
          turnId: params.turn.id,
          model: mutableModel,
          effort: mutableEffort,
          permissionMode: mutablePermissionMode,
          serviceTier: mutableServiceTier ?? null,
          fastMode: isFastServiceTier(mutableServiceTier),
        });
      },
      tokenUsageUpdated: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.tokenUsageUpdated?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        const last = params.tokenUsage?.last;
        if (!last) return;
        lastTurnTokenUsage = last;
        lastModelContextWindow = params.tokenUsage?.modelContextWindow ?? null;
        usageTracker.setContextWindow(lastModelContextWindow ?? 0);
        const cached = last.cachedInputTokens ?? 0;
        const totalInput = last.inputTokens ?? 0;
        const uncachedInput = Math.max(0, totalInput - cached);
        const totalOutput = (last.outputTokens ?? 0) + (last.reasoningOutputTokens ?? 0);
        usageTracker.ingestApiCallUsage({
          inputTokens: uncachedInput,
          outputTokens: totalOutput,
          cacheReadTokens: cached,
          cacheCreateTokens: 0,
        });
        // Maker Memory flush 观察 (A 轻版: 只打日志). makerMemoryEnabled 关时 controller 为 null。
        if (memoryFlushController) {
          const snap = usageTracker.snapshot();
          memoryFlushController.onUsageUpdate(snap.contextTokens, snap.contextWindow);
        }
      },
      turnCompleted: (params) => {
        // buffered turn 的终态同样进队列等对账 (greptile R11 P1 + codex R12 P1):
        // 合法 → 激活后按序重放, handleTurnCompleted 自然收口 send; 孤儿 →
        // 整队丢弃。直接处理会让孤儿 completed 提前收口在飞 send
        // (handleTurnCompleted 在 currentTurnId===null 下也收口 emit done);
        // 直接丢弃会把尸体 turn 激活成 in-flight, send 永久卡 generating。
        if (enqueueIfBufferedTurn(params.turn.id, () => handlers.turnCompleted?.(params))) return;
        // 只拦 idle 孤儿 (codex R15 P1): 无 pending 时它的 completed 会走
        // currentTurnId===null 的收口分支 emit 假 done。这里**只**落墓碑, 不补 interrupt ——
        // 这个 turn 已经结束了, interrupt 是纯浪费的 RPC(与 tombstoneIdleOrphanTurn 的分工)。
        // terminal/completed
        // 墓碑 turn 的迟到 completed 仍走 handleTurnCompleted 的正常
        // bookkeeping (suppressTerminalUi 分支, 不重复出 UI 事件) — 不能上
        // 整个 stale 闸。
        if (isIdleOrphanTurnId(params.turn.id)) {
          terminalErroredTurnIds.add(params.turn.id);
          return;
        }
        handleTurnCompleted(params);
      },
      itemStarted: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.itemStarted?.(params), {
          modelWork: itemRepresentsModelWork(params.item),
        })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        if (interceptProposedPlanItem(params.item)) return;
        // 模型已开始产出 → 本 turn 不再适合被过载重投整体重放。SDK echo 类 item
        // (userMessage 等)不算产出, 见 itemRepresentsModelWork。
        if (itemRepresentsModelWork(params.item)) producedOutputTurnIds.add(params.turnId);
        noteActiveToolContext(params.item, params.turnId);
        noteToolItemLifecycle(params.item, 'started');
        pushItemStatus(params.item);
        translateItemNotification('started', params, eventQueue, {
          rt: translatorRt,
          log,
          ...(memoryFlushController
            ? { onCompactBoundary: () => memoryFlushController?.onCompactBoundary() }
            : {}),
        });
      },
      itemUpdated: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.itemUpdated?.(params), {
          modelWork: itemRepresentsModelWork(params.item),
        })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        if (interceptProposedPlanItem(params.item)) return;
        if (itemRepresentsModelWork(params.item)) producedOutputTurnIds.add(params.turnId);
        noteActiveToolContext(params.item, params.turnId);
        translateItemNotification('updated', params, eventQueue, {
          rt: translatorRt,
          log,
          ...(memoryFlushController
            ? { onCompactBoundary: () => memoryFlushController?.onCompactBoundary() }
            : {}),
        });
      },
      itemCompleted: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.itemCompleted?.(params), {
          modelWork: itemRepresentsModelWork(params.item),
        })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        if (interceptProposedPlanItem(params.item)) return;
        if (itemRepresentsModelWork(params.item)) producedOutputTurnIds.add(params.turnId);
        noteActiveToolContext(params.item, params.turnId);
        noteToolItemLifecycle(params.item, 'completed');
        translateItemNotification('completed', params, eventQueue, {
          rt: translatorRt,
          log,
          ...(memoryFlushController
            ? { onCompactBoundary: () => memoryFlushController?.onCompactBoundary() }
            : {}),
        });
        // item 完成后, 若 turn 仍在跑, 先回到 'Generating...' 兜底 — 下一条 item 起来会再覆盖。
        // turn/completed 在 turn 结束时会 push 'Done' 终态, 不需要在这里特判。
        if (isTurnInFlight) pushStatus('Generating...');
      },
      turnPlanUpdated: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.turnPlanUpdated?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        latestPlanByTurn.set(params.turnId, params.plan);
        translatePlanUpdatedNotification(params, eventQueue);
      },
      reasoningSummaryTextDelta: (params) => {
        // thinking 流同样算产出(与非缓冲路径一致)。
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.reasoningSummaryTextDelta?.(params), { modelWork: true })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        // thinking 流也算产出：模型已经在这一轮里工作了，整体重放不再等价。
        producedOutputTurnIds.add(params.turnId);
        translateReasoningSummaryTextDelta(params, eventQueue, { rt: translatorRt, log });
      },
      reasoningSummaryPartAdded: (params) => {
        // thinking 流同样算产出(与非缓冲路径一致)。
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.reasoningSummaryPartAdded?.(params), { modelWork: true })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        producedOutputTurnIds.add(params.turnId);
        translateReasoningSummaryPartAdded(params, eventQueue, { rt: translatorRt, log });
      },
      reasoningTextDelta: (params) => {
        // thinking 流同样算产出(与非缓冲路径一致)。
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.reasoningTextDelta?.(params), { modelWork: true })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        producedOutputTurnIds.add(params.turnId);
        translateReasoningTextDelta(params, eventQueue, { rt: translatorRt, log });
      },
      accountRateLimitsUpdated: (params) =>
        translateAccountRateLimitsUpdated(params, eventQueue, { rt: translatorRt, log }),
      threadStatusChanged: (params) => {
        // Idle / NotLoaded / SystemError 由 turn/completed + error 主导, 这里不重复 emit。
        // 只把 Active.activeFlags 翻成 "Waiting on approval/input..." status 文案。
        if (!isTurnInFlight) return;
        if (params.status.type !== 'active') return;
        const flags = params.status.activeFlags;
        if (flags.includes('waitingOnApproval')) pushStatus('Waiting on approval...');
        else if (flags.includes('waitingOnUserInput')) pushStatus('Waiting on input...');
      },
      threadSettingsUpdated: (params) => {
        // server 端权威设置快照 (响应我们的 thread/settings/update, 或 server 自身降级)。
        // 把本地 mutable 三态对齐 server 真相 —— 最关键是 serviceTier: 模型不支持 fast
        // 时 server 会把它降级, 这里第一时间感知, getFastMode() 立刻反映正确值, 不必等
        // 某个 turn 的响应推断。通知恒带完整 ThreadSettings, 故 serviceTier 总是 present。
        const s = params.threadSettings;
        const before = mutableServiceTier ?? null;
        const beforeModel = mutableModel;
        mutableServiceTier = normalizeServiceTier(s.serviceTier) ?? null;
        if (typeof s.model === 'string' && s.model) mutableModel = s.model;
        if (mutableModel !== beforeModel) {
          registerCodexReviewerRouteContext(params.threadId);
        }
        // ReasoningEffort 的 'none' 不属于 Effort; 排除后其余值都是合法 Effort, 无需 cast。
        if (s.effort && s.effort !== 'none') mutableEffort = s.effort;
        if (before !== (mutableServiceTier ?? null)) {
          log.debug('thread/settings/updated reconciled serviceTier', {
            threadId: params.threadId,
            from: before,
            to: mutableServiceTier ?? null,
            fastMode: isFastServiceTier(mutableServiceTier),
          });
        }
      },
      autoApprovalReviewStarted: (params: ItemGuardianApprovalReviewStartedNotification) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.autoApprovalReviewStarted?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        log.debug('Codex automatic approval review started', {
          reviewId: params.reviewId,
          turnId: params.turnId,
          targetItemId: params.targetItemId,
          actionType: params.action.type,
        });
      },
      autoApprovalReviewCompleted: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.autoApprovalReviewCompleted?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        handleGuardianReviewCompleted(params);
      },
      guardianWarning: (params: GuardianWarningNotification) => {
        // The completed review carries the actionable denial/timeout details. Keep the
        // warning for diagnostics to avoid rendering a duplicate error card.
        log.warn('Codex Guardian warning', { threadId: params.threadId, message: params.message });
      },
      error: (params) => {
        // buffered turn 的 error (含终态) 同样进队列等对账 (greptile R11 P1 +
        // codex R12 P1): 合法 → 激活后重放走正常终端路径收口 send; 孤儿 →
        // 丢弃, 不得让孤儿 error 终结合法 send。
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.error?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        let effectiveParams = params;
        let isTerminalError = params.willRetry !== true;
        const isTransportError = params.scope === 'transport';
        if (isTransportError) {
          subscriptionInvalidatedByTransport = true;
          dismissAllPendingUserInput('transport_error');
          activeToolContexts.clear();
        }
        const targetsPendingTurn = isTurnStartPending && currentTurnId === null && Boolean(params.turnId);
        // 空 turnId 的容量拒绝: 过载重投的 RPC 还在飞、而它的 turnStarted 尚未到达时,
        // currentTurnId 是 null 且 isTurnInFlight 是 false —— 上面两条既有判据都不成立,
        // 这条错误会被当 stale 整条丢掉。后果是既不落墓碑也不记账, 随后到达的
        // turn/start 响应把这个已经报过容量失败的 turn 激活成活跃 turn, 剩余重投预算
        // 被绕过, 只能等它自己的 turn/completed 收口成硬失败(review #844 codex P1)。
        // 只对**过载类**放行: 其它空 id 终态错误(含 transport)保持既有行为, 免得把
        // 与本轮无关的错误误认成"针对当前 turn"。
        // 判据用 isTurnStartPending 而**不是** overloadRetry.inFlight: 后者只由重投路径
        // 设置, 初始投递的 turn/start 在飞时永远为 false —— 那个窗口里的空 id 容量拒绝
        // 一样会被丢掉, 响应随后激活一个已被拒的 turn, 自动重投预算整轮白给
        // (review #844 codex P1)。
        // 归属唯一时(只有一个 start 在飞)才认它。两个及以上在飞时这条通知无法归属:
        // 既不能接管重投(猜错就重放已跑过工具的 turn), 也**不能**让它走终态 —— 后者会
        // 拿别人的错误把当前这一轮判死, 而那一轮的响应随后照样会被激活, 于是"UI 已收口、
        // 工具还在跑"(review #844 codex P1)。
        // 不认 → 落到既有的 `stale codex terminal error ignored` 分支被丢掉, 这是安全的:
        // 真属于某个 turn 的话, server 随后会为那个 turn 发权威的 turn/completed(failed),
        // 收口由它完成。
        // 判定同样优先吃结构化 codexErrorInfo, 文案只作老 daemon 兜底: 这条判据决定
        // 空 id 的容量拒绝能不能被归属到在飞的 turn/start, 漏判 = 整轮重投预算白给。
        const idLessCapacityError =
          params.turnId === ''
          && isTerminalError
          && parseOverloadError(
            params.error?.message ?? '',
            extractNonSecretErrorSignals(params.error?.message ?? '').errorStatus,
            codexErrorInfoTag(params.error?.codexErrorInfo),
          ) !== null;
        const idLessAttributable = inFlightStarts.size === 1;
        const targetsIdLessPendingStart =
          idLessCapacityError
          && isTurnStartPending
          && currentTurnId === null
          && idLessAttributable;
        // 空 id 的容量拒绝什么时候才算"活跃 turn 的"。
        //
        // 判据是**它自己的 admission 还没回包**: 空 turnId 这个形状的含义就是"server 还没能
        // 告诉你是哪个 turn", 也就是容量在 admission 阶段被拒。活跃 turn 的 turn/start 若已
        // 经回包, 它早就过了 admission —— 之后真为它发的容量错误一定带得上 turnId。所以此时
        // 的空 id 通知只可能来自别处(最典型: 被 Stop 的旧 send, 它的 turn id 我们从没学到),
        // 认在活跃 turn 头上的后果是: scheduleOverloadRetry 拿 currentTurnId 当死 turn, 把一
        // 个正常在跑的 turn 落墓碑、撤销重投、推 Done, 而 server 侧那个 turn 还在执行工具
        // (review #844 codex/greptile P1)。
        //
        // 覆盖三种此前漏掉或猜错的形状, 收敛成一条:
        //  - 活跃 turn 的 start 已 settle、登记表里躺着**别人**的 start(Stop 留下的旧 RPC);
        //  - 活跃 turn 的 start 已 settle、且**没有任何** start 在飞(上一条的对称情形);
        //  - 归属未知(拿不到 origin.startSeq)。
        // 保留的是唯一合法形状: started-before-resp —— 活跃 turn 是它自己那次仍在飞的 start
        // 生出来的, 那条空 id 拒绝确实可能是它的 admission。
        // 只收紧**容量**这一类: 其它空 id 终态错误保持既有行为, 免得顺手改了无关语义。
        const activeTurnStartSeq =
          currentTurnId !== null ? turnOriginByTurnId.get(currentTurnId)?.startSeq ?? null : null;
        const idLessCapacityTargetsActiveTurn =
          isTurnInFlight
          && currentTurnId !== null
          && activeTurnStartSeq !== null
          && inFlightStarts.has(activeTurnStartSeq)
          && !hasOtherInFlightStart(activeTurnStartSeq);
        const targetsCurrentTurn =
          params.turnId === currentTurnId
          || (params.turnId === ''
            && isTurnInFlight
            && (!idLessCapacityError || idLessCapacityTargetsActiveTurn))
          || targetsPendingTurn
          || targetsIdLessPendingStart;
        if (isTerminalError && isTransportError && !targetsCurrentTurn) {
          translateErrorNotification(effectiveParams, eventQueue, { rt: translatorRt, log });
          return;
        }
        if (isTerminalError && !targetsCurrentTurn) {
          log.warn('stale codex terminal error ignored', {
            errorTurnId: params.turnId,
            currentTurnId,
            isTurnInFlight,
          });
          return;
        }
        // ── retry-loop 终局升级 (issue #677) ──
        // 远端摸不到 Codex 后端时 daemon 无限发 willRetry=true — 协议层设计上
        // willRetry 不收口, 但持续性不可达 (403 / Network unreachable / timeout)
        // 意味着 retry 永远不会成功。同 turn 计数/时长超阈值后合成终态错误,
        // 落入下面与原生终态 error 完全相同的收口路径。
        // auth 相关错误 (缺失 401 / 无效凭证 marker) 排除: 它们走 auth 修复 UX
        // (「同步登录态」/ 重新登录), 升级成「后端不可达」会抢路径并误导排查
        // (review: PR #715 五轮审核 P1 — 判定与 translator 共用 isAuthRelated*)。
        // rate-limit / usage-limit (429 / quota) 同样排除 (codex R12 P2):
        // 那是 provider 让等的正常退避窗口, daemon 的 willRetry 会在窗口后
        // 成功; 升级成「后端不可达」+ proxy/VPN 引导既误杀可恢复重试又误导
        // 排查方向。willRetry 透出 (networkRetryNotice) 不受影响, 用户仍能
        // 看到「在限流退避」。
        if (!isTerminalError && targetsCurrentTurn) {
          const rawMessage = params.error?.message ?? '';
          const retrySignals = extractNonSecretErrorSignals(rawMessage);
          const isRateLimitBackoff = retrySignals.errorStatus === 429 || retrySignals.usageLimit;
          if (!isAuthRelatedErrorMessage(rawMessage) && !isRateLimitBackoff) {
            const decision = turnRetryTracker.track(
              params.turnId || currentTurnId || '(pending)',
              Date.now(),
            );
            if (decision.escalate) {
              // 本地收口后 daemon 侧原 turn 还在无限 retry — fire-and-forget 补
              // interrupt, 否则它继续烧远端资源, 还可能与下一轮 send 的新 turn
              // 撞车 (review: PR #715 五轮审核 P1)。失败仅 warn: 本地已按终态
              // 处理, daemon 死亡/重启时该 turn 自然消失。
              if (params.threadId && params.turnId) {
                host.request(Method.TurnInterrupt, {
                  threadId: params.threadId,
                  turnId: params.turnId,
                }).catch((e: unknown) => {
                  log.warn('escalated turn interrupt failed (best-effort)', {
                    turnId: params.turnId,
                    error: e instanceof Error ? e.message : String(e),
                  });
                });
              }
              // 出站路径快照只对本地有意义 (远端 daemon 自己出网, 见
              // buildBackendUnreachableMessage 注释)。必须带 threadId: host 侧靠它
              // 定位本次请求实际打的上游 (codex 的出口随会话 provider 变), 查不到就
              // 返回 null 而不是拿「最近一条」凑。读取按 best-effort: 诊断绝不能反过来
              // 把已经在收口的错误路径搞崩。
              let outboundPath = null as OutboundPathFact | null;
              if (!opts.remoteHostId && this.deps.getOutboundPathFact) {
                try {
                  outboundPath = this.deps.getOutboundPathFact({
                    threadId: params.threadId,
                  }) ?? null;
                } catch (e) {
                  log.warn('outbound path fact lookup failed (best-effort)', {
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              }
              const message = buildBackendUnreachableMessage({
                isRemote: Boolean(opts.remoteHostId),
                remoteHostId: opts.remoteHostId,
                retryCount: decision.retryCount,
                elapsedMs: decision.elapsedMs,
                lastError: rawMessage,
                outboundPath,
              });
              log.error('codex retry-loop escalated to terminal error (backend unreachable)', {
                threadId: params.threadId,
                turnId: params.turnId,
                retryCount: decision.retryCount,
                elapsedMs: decision.elapsedMs,
                // 与用户看到的消息同源;`at` 让排查者判断这条判定有多新
                // (系统代理判定有 TTL 缓存, 陈旧快照要按陈旧解读)。
                ...(outboundPath ? { outboundPath } : {}),
              });
              effectiveParams = { ...params, willRetry: false, error: { message } };
              isTerminalError = true;
            }
          }
        }
        const wasTurnRunning = isTurnInFlight || targetsPendingTurn;
        // 服务过载(模型容量不足)时接管重投：translator 命中 capacity 才回调，
        // 拿到进度就把错误透成非终止状态，本函数随后跳过 Done 收口。
        let overloadRetryScheduled = false;
        translateErrorNotification(effectiveParams, eventQueue, {
          rt: translatorRt,
          log,
          tryTakeOverOverload: () => {
            // 只接管 app-server 本来就不重试的容量拒绝(原始 willRetry !== true)。
            // TurnRetryTracker 把持续 retry 升级成终态的那条路径不接管：那说明
            // daemon 已经重试很久仍不行，我们再叠一层退避重投属于双层重试。
            if (params.willRetry === true) return null;
            const progress = scheduleOverloadRetry(effectiveParams.turnId || currentTurnId);
            if (progress) overloadRetryScheduled = true;
            return progress;
          },
        });
        // 与 translator 的 terminal 判定保持一致：willRetry=false 或缺省都视为终态。
        if (!isTerminalError) return;
        const terminalTurnId = effectiveParams.turnId || currentTurnId;
        if (overloadRetryScheduled) {
          // 死掉的 turn **必须**落墓碑：app-server 随后还会为它发正常的
          // turn/completed(failed)，没有墓碑 handleTurnCompleted 就会 emit terminal
          // error + done，把 UI 与 goal turn 直接收口，我们刚透出的非终止重试状态
          // 白费。重投会开出新的 turn id，不受这块墓碑影响。
          if (terminalTurnId) terminalErroredTurnIds.add(terminalTurnId);
          // **刻意不推任何 status**：renderer 的 handleStreamEvent 会在每个非 error
          // 事件上清掉 recoverableError，紧跟其后的 status 会立刻把刚透出的本地化
          // 「模型服务繁忙，正在自动重试（N/M）」横幅冲掉（review #844 codex P1）。
          // 会话状态本来就还是 running（没推 Done），退避期间的用户可见提示由那条
          // 非终止 error 横幅承担。
          return;
        }
        if (terminalTurnId) {
          terminalErroredTurnIds.add(terminalTurnId);
          dismissPendingUserInputForTurn(terminalTurnId, 'turn_failed');
          clearActiveToolContextsForTurn(terminalTurnId);
        }
        stopActiveRolloutPlanFallback();
        isTurnInFlight = false;
        currentTurnId = null;
        if (!wasTurnRunning) return;
        // 没接管(预算耗尽 / 已有产出 / 非容量错误)且这一轮确实在跑 → 下面推 Done 收口。
        // 同上: 收口即撤销重投资格, 否则延后标记会在别的 start settle 时补排。
        revokeOverloadRetryOnTerminalSettle('terminal error notification');
        eventQueue.push({
          type: 'status',
          data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
          source: 'codex',
        });
      },
      commandExecutionApproval,
      fileChangeApproval,
      mcpServerElicitation,
      permissionsApproval,
      serverRequestResolved: handleServerRequestResolved,
      requestUserInput,
      dynamicToolCall,
    };
    try {
      assertCurrentHost('thread subscription');
      subscription = host.subscribeThread(threadId, handlers);
    } finally {
      releaseHostBindingLeaseIfNeeded();
    }

    function resubscribeAfterTransportErrorIfNeeded(): void {
      if (!subscriptionInvalidatedByTransport) return;
      assertCurrentHost('resubscribe');
      subscription = host.subscribeThread(threadId, handlers);
      subscriptionInvalidatedByTransport = false;
    }

    // ── AgentSessionHandle ──────────────────────────────────────────────────
    const handle: AgentSessionHandle = {
      get id() { return sdkSessionId ?? '<pending>'; },
      agentKind: 'codex',
      get model() { return mutableModel; },
      get codexProxyActive() { return hostUsesCodexProxy; },
      get codexProductPromptDelivery() { return codexProductPromptDelivery; },

      validateSendOptions(sendOpts: SendOptions) {
        if (
          sendOpts.turnPermissionPolicy &&
          mutablePermissionMode === 'bypassPermissions'
        ) {
          throw new TurnPermissionPolicyUnsupportedError(
            'codex',
            mutablePermissionMode,
          );
        }
      },

      async send(message: UserMessage, sendOpts?: SendOptions) {
        if (rejectClosedOrCancelledSend(sendOpts, 'before start')) {
          return;
        }
        if (sendOpts) handle.validateSendOptions?.(sendOpts);
        activeTurnPermissionPolicy = sendOpts?.turnPermissionPolicy ?? null;
        assertCurrentHost('turn/start');
        resubscribeAfterTransportErrorIfNeeded();
        // 新 turn 总是携带当前 (可能已收紧的) 策略, 上一轮残留的延迟中断标记
        // 不得误伤本 turn (典型: 上次 turn/start 终失败, 标记未被 id 到达点消费)。
        pendingTightenInterrupt = false;
        // 上一 send 周期的墓碑一并清空 (仅用于拦本周期内抢跑的终态)。
        turnsCompletedBeforeStartResp.clear();
        // 用户发新消息 = 上一轮的过载重投彻底作废(它要重投的是旧消息)。
        // 这里也是**唯一**重置重投预算的地方，见 turnStarted 的说明。
        discardOverloadRetry('new send');
        // 产出记账不需要按 send 归零: 它按 turn id 存, 新一轮读的是新 turn 的账。
        // 早先的标量要在这里清, 是因为"新 turn 的响应 / 容量错误先于它的 turnStarted
        // 到达"时会读到上一个 turn 的状态(review #844 codex P1); 按 id 记账后这类乱序
        // 不再影响判定, 也不会再被别的 turn(含被 Stop 的旧 send 的孤儿)污染。
        const mySendGen = ++sendGeneration;
        isTurnStartPending = true;
        usageTracker.beginTurn();
        log.debug('send ▶ user message', {
          model: mutableModel,
          effort: mutableEffort,
          permissionMode: mutablePermissionMode,
          serviceTier: mutableServiceTier ?? null,
          threadId,
          logTitle: sendOpts?.logTitle,
        });
        // turn-start status: 抽样 recurring + one-shot 引导 (含阶梯 pity 保底)。
        // 命中 one-shot 时推进展示次数, 并清 pity 计数让下一档保底独立累计。
        const turnStartPick = pickTurnStartStatus(sendOpts?.userName, oneShotTipState);
        if (turnStartPick.oneShotId) {
          const id = turnStartPick.oneShotId;
          oneShotTipState.displayed.set(id, (oneShotTipState.displayed.get(id) ?? 0) + 1);
          oneShotTipState.pity.delete(id);
        }
        eventQueue.push({
          type: 'status',
          data: {
            status: turnStartPick.text,
            ...usageTracker.snapshot(),
            isRunning: true,
          },
          source: 'codex',
        });

        // Phase 3: 把 mutable 配置每 turn 透传 — server 接受 per-turn 覆盖。
        // **关键**: 无引用目录时用 sandboxPolicy: SandboxPolicy；有引用目录时继承
        // thread/start / thread/resume 已激活的 named permissions profile。profile
        // selector 不能在 turn/start 重复发送，见 ensureReadonlyReferencesProfileForNextTurn。
        // effort 同理: 协议层只能在 turn/start 透传 (v2.rs:5800), thread/start 不接;
        // 用户在 session 创建时选的 effort 也是靠 first turn/start 这里传过去才生效。
        let turnWorkspaceConfig: ReturnType<typeof currentTurnWorkspaceConfig>;
        let turnThreadWorkspaceConfig: ReturnType<typeof currentThreadWorkspaceConfig>;
        try {
          const profileRefresh = ensureReadonlyReferencesProfileForNextTurn(sendOpts?.signal);
          if (profileRefresh) await profileRefresh;
          turnWorkspaceConfig = currentTurnWorkspaceConfig();
          // A stale-daemon retry must hydrate the exact thread-level profile
          // that matches this turn, not mutable settings changed while the
          // original turn/start RPC was pending.
          turnThreadWorkspaceConfig = currentThreadWorkspaceConfig();
        } catch (e) {
          isTurnStartPending = false;
          endPlanCycleAfterPreStartFailure('read-only reference profile refresh failed');
          flushDeferredTerminalTurnCompletionsIfIdle();
          rejectIfCancelled(sendOpts, 'send');
          const message = `Failed to restore Codex read-only reference permissions: ${String(e)}`;
          log.error('read-only reference profile refresh failed', { error: String(e), threadId });
          eventQueue.push({
            type: 'error',
            data: { message, isTerminal: true },
            source: 'codex',
          });
          eventQueue.push({
            type: 'status',
            data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
            source: 'codex',
          });
          if (sendOpts?.throwOnStartFailure) throw new Error(message);
          return;
        }
        const { approvalPolicy, approvalsReviewer } = turnWorkspaceConfig;
        // 记录本 turn 是否由无人值守策略发射。普通降级路由显式使用 user reviewer,
        // 与 Ask 权限等价；policy turn 则以 untrusted + read-only 发射，并由 host
        // 自动接受非强制回调，仍属于无人值守执行。
        turnLaunchedUnattended =
          approvalPolicy === 'never' ||
          approvalsReviewer === 'auto_review' ||
          (activeTurnPermissionPolicy !== null && mutablePermissionMode === 'auto');
        if (!turnLaunchedUnattended) {
          pendingTightenInterrupt = false;
        }
        let turnInput: TurnStartParams['input'];
        try {
          turnInput = await toTurnInput(message.content);
        } catch (e) {
          isTurnStartPending = false;
          flushDeferredTerminalTurnCompletionsIfIdle();
          throw e;
        }
        if (rejectClosedOrCancelledSend(sendOpts, 'after input preparation')) {
          isTurnStartPending = false;
          abandonBufferedTurns('send cancelled after input preparation');
          flushDeferredTerminalTurnCompletionsIfIdle();
          return;
        }
        assertCurrentHost('turn/start');
        // 本条消息的计划意图:sendOpts.planMode 是点击发送瞬间的快照(排队行透传),
        // 权威于 agent 当前武装态;undefined 走旧语义(消耗武装态)。一次性语义:
        // 消耗时 emit plan_mode_changed 让 UI 勾选熄灭;显式 false(排队普通消息后
        // 用户重新勾选)不消耗武装态。修订 turn 由 runPlanReviewFlow 内部 send
        // (无 planMode 快照), planCycleActive 仍在 → 继续携带 plan。
        const explicitNormalTurn = sendOpts?.planMode === false;
        const requestedPlanTurn = sendOpts?.planMode ?? mutablePlanMode;
        const continuePlanCycleThisTurn = planCycleActive && !explicitNormalTurn;
        if (requestedPlanTurn) {
          planCycleActive = true;
          if (mutablePlanMode && sendOpts?.planMode !== false) {
            mutablePlanMode = false;
            eventQueue.push({ type: 'plan_mode_changed', data: { enabled: false }, source: 'codex' });
          }
        }
        // sticky 语义要求进过 plan 的线程后续持续复位, 见 collaborationModeForTurn。
        const collaborationMode = collaborationModeForTurn(requestedPlanTurn, continuePlanCycleThisTurn);
        const turnStartsInPlanMode = collaborationMode?.mode === 'plan';
        const turnParams: TurnStartParams = {
          threadId,
          input: turnInput,
          ...turnWorkspaceConfig,
          effort: clampEffortForCodex(mutableModel, mutableEffort),
          // 强制 reasoning summary='auto' — 不依赖用户 ~/.codex/config.toml 写没写
          // model_reasoning_summary, 让 thinking 文本在所有用户机器上一致流式出。
          // (v2.rs:5801-5803 turn/start 的 summary 会 override server config)
          summary: 'auto',
          ...(mutableModel && mutableModel !== 'gpt-5' ? { model: mutableModel } : {}),
          ...(mutableServiceTier !== undefined ? { serviceTier: mutableServiceTier } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        };
        const markTurnConfigAccepted = (): void => {
          threadMayHaveRollout = true;
          if (turnParams.collaborationMode?.mode === 'plan') {
            threadTouchedPlanMode = true;
            planModeDefaultMarkerNeeded = true;
            return;
          }
          if (turnParams.collaborationMode?.mode === 'default') {
            threadTouchedPlanMode = true;
            if (turnParams.collaborationMode.settings.developer_instructions === null) {
              planModeDefaultMarkerNeeded = false;
            }
          }
        };
        // A sandboxPolicy overrides the thread-local profile. Invalidate before
        // the request crosses the acceptance boundary: the peer can accept the
        // turn even if the local transport loses the response.
        if ('sandboxPolicy' in turnWorkspaceConfig) {
          readonlyReferencesProfileActive = false;
        }
        // After turn/start is attempted, resume before ever replacing this
        // thread. Only an explicit "no rollout found" proves it stayed unused.
        threadMayHaveRollout = true;
        pendingTurnStartPlanMode = turnStartsInPlanMode;
        // turn/start 失败若是 "thread not found" — 通常 daemon 重启 (sync auth /
        // OOM / 服务器 reboot / 我们主动 pkill) 导致 in-memory thread state 丢失,
        // 但 disk rollout 还在。自动 thread/resume hydrate 回 daemon 然后重 turn/start,
        // 用户体验:透明续聊, 不感知 daemon 重启过。
        //
        // 只动 error path, happy path 完全不变 (规则 19: 不影响 cache hit /
        // 性能 / 准确性 4 指标)。重试只发生在 "thread not found" 字符串匹配时,
        // 普通 LLM 错误 / 超时 / auth 失败照原路径报错。
        const handleTurnStartResp = (resp: TurnStartResponse, ownerSeq: number): void => {
          if (resp.turn?.id) {
            // 缓冲的歧义 started 对账 (codex R9 P2): 本响应确立在飞 RPC 的
            // turnId — 缓冲里 id 一致的是它的合法 started (下方正常激活),
            // 不一致的是失败 RPC 的孤儿 (interrupt + 墓碑, 没人消费)。
            //
            // 但"不是我的"只有在**没有别的 start 在飞**时才等于"是孤儿": Stop 会武装孤儿
            // 守卫, 于是下一轮 send 的 turnStarted 同样先进这个**会话级共享**的缓冲集; 被
            // Stop 的旧 RPC 若是 resolve(而不是 reject)回来, 它照样走到这里, 把新一轮那条
            // 合法 started 当孤儿坐实 —— 墓碑 + interrupt 之后新一轮的响应拒绝激活, 那一轮
            // 永久卡 generating(review #844 codex P1, 与隔离路径同源)。
            //
            // 非唯一权威时只做能确定的那一半: 把自己的 id 从缓冲里摘掉(否则 stale 闸会继续
            // 忽略它已激活 turn 的事件), 其余留给仍在飞的那些 start 去对账。
            if (bufferedOrphanTurnIds.size > 0) {
              const wasBuffered = bufferedOrphanTurnIds.has(resp.turn.id);
              const soleAuthority = !hasOtherInFlightStart(ownerSeq);
              if (!soleAuthority) {
                bufferedOrphanTurnIds.delete(resp.turn.id);
                log.debug('turn/start response is not the sole reconciler — leaving other buffered turns', {
                  acceptedTurnId: resp.turn.id,
                  remaining: [...bufferedOrphanTurnIds],
                  threadId,
                });
              }
              for (const bufferedId of soleAuthority ? bufferedOrphanTurnIds : []) {
                if (bufferedId === resp.turn.id) continue;
                terminalErroredTurnIds.add(bufferedId);
                // 孤儿的事件队列整队丢弃 (greptile R11 P1) — 任何事件都不得
                // 渲染到 / 收口本次 send; 挂起的审批/输入请求按拒绝释放
                // (codex R12 P1)。
                bufferedTurnEventQueues.delete(bufferedId);
                settleBufferedTurnReconcile(bufferedId, false);
                log.warn('buffered turnStarted proven orphan by turn/start response — interrupting', {
                  turnId: bufferedId,
                  acceptedTurnId: resp.turn.id,
                  threadId,
                });
                if (threadId) {
                  host.request(Method.TurnInterrupt, { threadId, turnId: bufferedId }).catch((e2: unknown) => {
                    log.warn('buffered orphan turn interrupt failed (best-effort)', {
                      turnId: bufferedId,
                      error: e2 instanceof Error ? e2.message : String(e2),
                    });
                  });
                }
              }
              if (soleAuthority) bufferedOrphanTurnIds.clear();
              if (wasBuffered) {
                // 合法 started 曾被缓冲: 补做 turnStarted 正常路径被跳过的
                // per-turn 状态重置 (与 turnStarted handler 同款)。
                proposedPlanText = null;
                translatorRt.lastAuthErrorKey = null;
                translatorRt.networkRetryNotice = null;
                turnRetryTracker.reset();
              }
            }
            // turn/start 成功后孤儿守卫**保持**, 不解除 (codex R14 P1): 失败
            // RPC 的孤儿证据 (turnStarted/error/completed) 可能任意晚才到 —
            // 解除后迟到的孤儿 started 在 currentTurnId===null 窗口会被正常
            // 激活成假 running (会话永久卡)。守卫保持下: 未知 id 的迟到
            // started 按孤儿墓碑 + interrupt; 合法 turn 的 started 由
            // currentTurnId 匹配 (重复 started 幂等) 或 buffered 对账放行,
            // 不受影响。守卫在 RPC 失败路径 (4413) 已把在飞 buffer 坐实孤儿,
            // 语义依然自洽。
            // 墓碑: 该 turn 的终态已抢在本响应之前到达 (典型: 收紧补中断后
            // turnCompleted(interrupted) 先回), 不得重新置活, 否则会话卡 running。
            const alreadyCompleted = turnsCompletedBeforeStartResp.has(resp.turn.id);
            if (!alreadyCompleted && !terminalErroredTurnIds.has(resp.turn.id)) {
              // 权威归属: 这个 turn 由本次 start 生出, 属于本轮 send。
              turnOriginByTurnId.set(resp.turn.id, { startSeq: ownerSeq, sendGen: mySendGen });
              currentTurnId = resp.turn.id;
              isTurnInFlight = true;
              turnStartGeneration += 1; // 见声明处:延迟善后靠它判断"期间起过新 turn"
              currentTurnPlanModeActive = turnStartsInPlanMode;
              pendingTurnStartPlanMode = null;
              startRolloutPlanFallback(resp.turn.id);
              // 合法 buffered turn 激活成功: 挂起的审批/输入请求放行 (走正常
              // UI 流程), 再按到达序重放缓存事件 (greptile R11 P1 +
              // codex R12 P1): 早期 item/usage 不再永久丢失; 队列里若有终态
              // (turn 在缓冲期间已结束), 重放自然收口 send — 不会把尸体 turn
              // 挂成 in-flight 永久卡 generating。重放闭包重进 handler 时
              // buffer 已清空 + currentTurnId 已置, 全部走正常路径。
              settleBufferedTurnReconcile(resp.turn.id, true);
              const replayQueue = bufferedTurnEventQueues.get(resp.turn.id);
              if (replayQueue) {
                bufferedTurnEventQueues.delete(resp.turn.id);
                log.debug('replaying buffered events for accepted turn', {
                  turnId: resp.turn.id,
                  eventCount: replayQueue.length,
                });
                for (const replay of replayQueue) replay();
              }
            } else {
              // 未激活 (墓碑): 队列丢弃, 挂起请求按拒绝释放 — 不得穿透。
              bufferedTurnEventQueues.delete(resp.turn.id);
              settleBufferedTurnReconcile(resp.turn.id, false);
            }
            // turn/start 在飞期间权限被收紧 → 本 turn 携带的还是旧宽松策略,
            // 拿到 id 立即补中断 (fire-and-forget, 失败仅 warn); turn 已终结则
            // 收紧目的已达成, 消费标记即可, 不再发无意义的 interrupt。
            if (pendingTightenInterrupt) {
              pendingTightenInterrupt = false;
              if (!alreadyCompleted) void interruptTurnForPermissionTighten(resp.turn.id);
            }
          }
          if (Object.hasOwn(resp, 'serviceTier')) {
            mutableServiceTier = normalizeServiceTier(resp.serviceTier) ?? null;
            log.debug('turn/start response serviceTier', {
              turnId: resp.turn?.id ?? null,
              serviceTier: mutableServiceTier,
              fastMode: isFastServiceTier(mutableServiceTier),
              note: 'serviceTier returned by app-server turn/start response',
            });
          }
        };
        // 登记本轮的过载重投器。闭包持有 turnParams 与本轮的响应处理逻辑，因此
        // 重投投递的是同一条用户消息、同一套策略，不受期间 mutable 配置变化影响。
        //
        // 刻意**不**复用 happy path 的整段 send 逻辑：`usageTracker.beginTurn()`、
        // turn-start status 抽样、planMode 武装态消耗都是"用户发了一条消息"的
        // 一次性副作用，重投是同一条消息的再次投递，重跑那些会让用量统计与
        // 计划模式状态错乱。
        overloadRetry = {
          attempt: 0,
          timer: null,
          inFlight: false,
          isCancelled: () => sendOpts?.signal?.aborted === true,
          launchedPermissionMode: mutablePermissionMode,
          sendGen: mySendGen,
          deferredCapacityFailure: null,
          disposeSignalWatch: null,
          retry: async () => {
            const state = overloadRetry;
            // 发出前复检：本轮 send 的取消信号在退避等待期间才 abort（coordinator
            // 撤单、上层超时）时不走 handle.abort()，计时器到点仍会把一条已被取消
            // 的消息重新投出去。
            if (closed || !state || state.isCancelled()) {
              log.info('codex overload retry skipped (send already cancelled)', { threadId });
              if (state) settleCancelledOverloadRetry(state, 'cancelled before retry send');
              return;
            }
            assertCurrentHost('turn/start overload retry');
            resubscribeAfterTransportErrorIfNeeded();
            // RPC 在途也算忙（见 isTurnRunning 注释）：计时器已清、turn 未激活的
            // 这段窗口若报 idle，并发 send 会把原消息挤掉。
            state.inFlight = true;
            const retryStartSeq = beginTurnStart();
            // RPC 是否走完了成功路径。补排延后的容量失败**只能**在成功路径上做:
            // finally 先于外层 state.retry().catch 执行, 若 RPC 已经 reject 却在这里
            // 排上新计时器, 紧随其后的 catch 会推终态 error + Done 收口 UI, 而那个
            // 计时器没人取消 —— 会话已收口, 原消息却在稍后被静默重投并真的执行工具
            // 副作用(review #844 codex P1)。失败路径统一由外层 catch 报终态。
            let rpcSettledOk = false;
            try {
              // 必须带超时：AppServerHost.request 默认不超时，daemon / 远端传输
              // 卡住时这个 RPC 会永久在飞，而 inFlight 被算作忙 → 会话永久卡死
              // 且无人可解（review #844 codex P1）。与正常 turn/start 同款边界。
              const resp = await host.request<TurnStartResponse>(Method.TurnStart, turnParams, {
                timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS,
              });
              // **发出后再复检**：RPC 在途期间 Stop / close / 撤单都拦不住它——
              // 计时器早已清空，cancelOverloadRetry 无从取消；abort() 又因为
              // currentTurnId 仍是 null 而直接返回。此时若照常激活，一个已被用户
              // 撤销的 turn 会真的跑起来并执行命令、改文件。
              // server 侧 turn 已经启动，所以不能只是丢掉响应：落墓碑挡住它的后续
              // 事件，并 best-effort interrupt 把它停掉（与上方孤儿 turn 同款处理）。
              const cancelledMidFlight =
                closed || state.isCancelled() || overloadRetry !== state;
              if (cancelledMidFlight) {
                const staleTurnId = resp.turn?.id;
                log.warn('codex overload retry cancelled while turn/start was in flight', {
                  threadId,
                  turnId: staleTurnId ?? null,
                  closed,
                  aborted: sendOpts?.signal?.aborted ?? false,
                });
                if (staleTurnId) {
                  terminalErroredTurnIds.add(staleTurnId);
                  if (threadId) {
                    host
                      .request(Method.TurnInterrupt, { threadId, turnId: staleTurnId })
                      .catch((e: unknown) => {
                        log.warn('cancelled overload retry interrupt failed (best-effort)', {
                          turnId: staleTurnId,
                          error: e instanceof Error ? e.message : String(e),
                        });
                      });
                  }
                }
                // server 侧 turn 已挡掉, 但逻辑 turn 还得有人收口(同上)。
                settleCancelledOverloadRetry(state, 'cancelled while turn/start was in flight');
                return;
              }
              markTurnConfigAccepted();
              adoptUnidentifiedDeadTurn(resp, retryStartSeq);
              handleTurnStartResp(resp, retryStartSeq);
              rpcSettledOk = true;
            } finally {
              state.inFlight = false;
              // 注销本次请求(isTurnStartPending 由登记表重算, 不会误清别的请求的状态)。
              endTurnStart(retryStartSeq);
              flushDeferredTerminalTurnCompletionsIfIdle();
              // 在途期间又撞容量、当时被延后的那条失败在这里收尾。只有新 turn 确实
              // 没能激活时才补排（它被落了墓碑、响应因此拒绝激活）；turn 活了就说明
              // 那条错误针对的是别的 turn，不该重排。预算耗尽时必须自己推终态，
              // 否则逻辑 send 永久悬空。
              // 同上: 延后的失败若属于另一轮仍活着的 send, 与本次 RPC 成败无关。
              rescheduleDeferredCapacityFailure(
                overloadRetry ?? state,
                overloadRetry === state ? rpcSettledOk : true,
              );
            }
          },
        };
        // 退避窗口里的取消要**立刻**收口, 不能等计时器到点。isCancelled() 是轮询式的,
        // 只在 retry() 里被读到; 只 abort signal(不走 handle.abort())时, 会话会在剩余
        // 退避里继续 isTurnRunning()===true —— 最多 30s 内后续排队消息全被挡住, 上层
        // 派发闩也不释放(review #844 greptile P1)。
        const armedRetryState = overloadRetry;
        const sendSignal = sendOpts?.signal;
        if (armedRetryState && sendSignal) {
          const onSendAbort = (): void => {
            if (overloadRetry !== armedRetryState) return;
            // 两类要收口的状态:
            //  1. 重投还会发生(退避等待 / RPC 在途 / 失败已延后等补排);
            //  2. 重投已经把一个 turn 跑起来了(计时器已消费、inFlight 已清、
            //     currentTurnId 已置)。这时若直接 return, 取消既不落墓碑也不
            //     interrupt, 那个 turn 会继续执行命令与文件改动
            //     (review #844 greptile P1)。
            // 判据用 attempt > 0 限定在"本轮确实被重投接管过"上: 没发生过重投的
            // 普通 send 里 signal 仍只是**受理前**的取消边界, 语义不变。
            const retryOwnsActiveTurn =
              armedRetryState.attempt > 0 && (currentTurnId !== null || isTurnInFlight);
            if (!overloadRetryPending(armedRetryState) && !retryOwnsActiveTurn) return;
            cancelOverloadRetry('send signal aborted');
            settleCancelledOverloadRetry(armedRetryState, 'send signal aborted');
          };
          sendSignal.addEventListener('abort', onSendAbort, { once: true });
          armedRetryState.disposeSignalWatch = () => {
            sendSignal.removeEventListener('abort', onSendAbort);
          };
        }
        let finalErr: unknown = null;
        // 初始 RPC 在飞期间到达的空 id 容量拒绝只会被"延后"(不排计时器), 由下面的
        // finally 在响应处理完之后补排 —— 保证任一时刻只有一个 turn/start 在飞。
        const initialStartSeq = beginTurnStart();
        let initialStartSettledOk = false;
        /** 本次请求是否已被 Stop / 撤单收口过(条目会在 finally 里删掉, 所以先取出来)。 */
        let initialStartSettledByCancel = false;
        try {
          const resp = await host.request<TurnStartResponse>(Method.TurnStart, turnParams, {
            timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS,
          });
          markTurnConfigAccepted();
          adoptUnidentifiedDeadTurn(resp, initialStartSeq);
          if (rejectClosedOrCancelledSend(sendOpts, 'after turn/start')) {
            // 本地取消边界直接 return: 挂起的 buffered 请求没有 settle 者
            // (codex R17 P2), 统一释放。
            abandonBufferedTurns('send cancelled after turn/start');
            return;
          }
          handleTurnStartResp(resp, initialStartSeq);
          initialStartSettledOk = true;
        } catch (e) {
          if (isLocalAcceptBoundaryError(e)) {
            throw e;
          }
          if (/thread not found/i.test(String(e))) {
            log.info('turn/start hit "thread not found" — daemon likely restarted, attempting thread/resume + retry', {
              threadId,
            });
            try {
              // **必须先重 subscribe**: daemon 重启会触发 transport error →
              // host.shutdown() 清空 this.subscribers Map (host.ts:373), 原 subscription
              // 失效。如果不重 subscribe, thread/resume + turn/start retry RPC 都会成功,
              // 但 daemon 推回的 turnStarted / agentMessage / 任何 notification routing
              // 找不到 handler 全部 silent drop, UI 永远转圈 (currentTurnId 从未被 set,
              // isTurnInFlight 永远 false, token 流也没人消费)。
              // 用同一个 handlers 对象 re-subscribe (host.subscribers.set 覆盖语义),
              // 顶层 startSession 拿到的原 subscription 句柄仍能正确清理当前 entry,
              // 无需在这里管理新返回的 subscription 句柄。
              assertCurrentHost('thread/resume retry subscribe');
              host.subscribeThread(threadId, handlers);
              const resumeModel = mutableModel;
              const resumeServiceTierGeneration = serviceTierMutationGeneration;
              const resumeParams: ThreadResumeParams = {
                threadId,
                ...(resumeExcludeTurnsSupported ? { excludeTurns: true } : {}),
                cwd: opts.workingDir,
                ...turnThreadWorkspaceConfig,
                ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
                ...(resumeModel && resumeModel !== 'gpt-5' ? { model: resumeModel } : {}),
                ...(mutableServiceTier !== undefined ? { serviceTier: mutableServiceTier } : {}),
              };
              const resumeResp = await host.request<ThreadResumeResponse>(Method.ThreadResume, resumeParams, {
                timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS,
              });
              if (mutableModel === resumeModel && resumeModel === 'gpt-5' && resumeResp.model) {
                mutableModel = resumeResp.model;
              }
              if (
                Object.hasOwn(resumeResp, 'serviceTier') &&
                resumeServiceTierGeneration === serviceTierMutationGeneration
              ) {
                mutableServiceTier = normalizeServiceTier(resumeResp.serviceTier) ?? null;
              } else if (resumeServiceTierGeneration !== serviceTierMutationGeneration) {
                void pushThreadSettings({ serviceTier: mutableServiceTier ?? null });
              }
              turnParams.effort = clampEffortForCodex(mutableModel, mutableEffort);
              if (mutableModel && mutableModel !== 'gpt-5') {
                turnParams.model = mutableModel;
              } else {
                delete turnParams.model;
              }
              if (mutableServiceTier !== undefined) {
                turnParams.serviceTier = mutableServiceTier ?? null;
              } else {
                delete turnParams.serviceTier;
              }
              if (turnParams.collaborationMode) {
                turnParams.collaborationMode.settings.model = mutableModel;
                turnParams.collaborationMode.settings.reasoning_effort =
                  clampEffortForCodex(mutableModel, mutableEffort);
              }
              readonlyReferencesProfileActive = 'permissions' in turnThreadWorkspaceConfig;
              threadMayHaveRollout = true;
              if (collaborationMode?.mode === 'default') {
                planModeDefaultMarkerNeeded = true;
                if (turnParams.collaborationMode?.mode === 'default') {
                  turnParams.collaborationMode.settings.developer_instructions = null;
                }
              }
              log.info('thread/resume after stale daemon ok, retrying turn/start', { threadId });
              const resp = await host.request<TurnStartResponse>(Method.TurnStart, turnParams, {
                timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS,
              });
              markTurnConfigAccepted();
              adoptUnidentifiedDeadTurn(resp, initialStartSeq);
              if (rejectClosedOrCancelledSend(sendOpts, 'after turn/start retry')) {
                abandonBufferedTurns('send cancelled after turn/start retry');
                return;
              }
              handleTurnStartResp(resp, initialStartSeq);
              initialStartSettledOk = true;
            } catch (retryErr) {
              if (isLocalAcceptBoundaryError(retryErr)) throw retryErr;
              log.error('thread/resume + retry turn/start failed', {
                originalError: String(e),
                retryError: String(retryErr),
              });
              finalErr = retryErr;
            }
          } else {
            finalErr = e;
          }
        } finally {
          // 条目即将被删, 先把"已由取消收口"取出来供下面的 finalErr 分支判断。
          initialStartSettledByCancel =
            inFlightStarts.get(initialStartSeq)?.terminalSettled === true;
          // 先注销本次请求(isTurnStartPending 由登记表重算) —— 无条件置 false 会在两个
          // start 并存时清掉属于**另一个**请求的状态(review #844 codex P1)。注销必须早于
          // flush: 后者按 idle 与否决定是否放行缓存的终态。
          endTurnStart(initialStartSeq);
          pendingTurnStartPlanMode = null;
          flushDeferredTerminalTurnCompletionsIfIdle();
          // 初始 RPC 已 settle → 现在才允许重投计时器排上（顺序见
          // inFlightStarts 的注释）。终失败路径 settledOk 为 false，不补排；那条由下面的
          // discardOverloadRetry + terminal error 收口。
          const armedState = overloadRetry;
          if (armedState) {
            // rpcSettledOk 的本意是"我这次 RPC 失败了, 别在推终态之外再排一个计时器"。
            // 但延后的那条失败可能属于**另一轮仍然活着的** send(它的容量错误在我还在飞时
            // 到达, 于是只被记账): 那一轮的命运与我这次 RPC 成败无关, 用我的失败去压掉它
            // 会让它既不重投也不收口(写本轮回归用例时实测到, review 未提)。
            const ownedByThisSend = armedState.sendGen === mySendGen;
            rescheduleDeferredCapacityFailure(
              armedState,
              ownedByThisSend ? initialStartSettledOk : true,
            );
          }
        }
        if (finalErr) {
          // 容量通知可能先于本次 turn/start 响应到达(协议允许的乱序), 那时重投
          // 计时器已经排上。原始请求随后终失败 → 下面会推 terminal error + Done,
          // UI 与调用方都已按失败处理; 若不把重投一起废掉, 计时器到点会重投一条
          // 已判失败的消息, 副作用在用户看不到的地方执行(review #844 codex P1)。
          // 只废弃**属于本轮**的重投状态: Stop 之后下一轮 send 可能已经装上了自己的
          // overloadRetry, 无条件 discard 会把它连同它记账的延后失败一起清掉 —— 那一轮
          // 于是既不重投也不收口(review #844 codex P1)。
          if (overloadRetry?.sendGen === mySendGen) {
            discardOverloadRetry('original turn/start failed');
          }
          // 计划模式: turn 从未启动就终失败 → 结束半开循环(与 turnCompleted 的
          // failed 分支同语义), 否则 planCycleActive 泄漏, 下一条常规消息仍会
          // 携带 collaborationMode plan(勾选与 chip 早已熄灭, 行为与 UI 脱节)。
          endPlanCycleAfterPreStartFailure('turn/start failed');
          // RPC 级失败(超时/拒绝)不代表 server 没建 turn — daemon 可能已接受
          // turn/start 只是响应没回来。立孤儿守卫: 之后迟到的 turnStarted 不得
          // 重新激活会话 (greptile P1: 已报终态错误的会话又回到 generating)。
          // turnStarted 也可能已先于响应到达并被接受 (started-before-resp 是
          // 协议允许的乱序) — 此时 currentTurnId/isTurnInFlight 已置位, 失败
          // 收口必须把这个活跃 turn 一起收掉; 缓冲的歧义 started 同样坐实成孤儿
          // (greptile R6 P1 + codex R9 P2)。细节见 helper 顶注。
          quarantineTurnsAfterStartFailure('original turn/start failed', {
            ownsSession: sendGeneration === mySendGen,
          });
          log.error('turn/start failed', { error: String(finalErr) });
          // Stop / 撤单已经为这一轮推过终态时不得再推一组: 否则取消被改报成"启动失败",
          // 且 coordinator / 活动状态 / goal 会对同一个 turn 收口两次
          // (review #844 greptile P1)。
          if (initialStartSettledByCancel) {
            log.info('turn/start failure suppressed — this send was already settled by cancel', {
              threadId,
            });
          } else {
            eventQueue.push({
              type: 'error',
              data: { message: `turn/start failed: ${String(finalErr)}`, isTerminal: true },
              source: 'codex',
            });
            eventQueue.push({
              type: 'status',
              data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
              source: 'codex',
            });
          }
          if (sendOpts?.throwOnStartFailure) {
            throw new Error(`Codex turn/start failed: ${String(finalErr)}`);
          }
        }
        if (rejectClosedOrCancelledSend(sendOpts, 'before resolving send')) {
          return;
        }
      },

      async steer(message: UserMessage, sendOpts?: SendOptions) {
        rejectIfCancelled(sendOpts, 'steer');
        assertCurrentHost('turn/steer');
        if (closed) {
          log.warn('steer called on closed session');
          throw new Error('No active Codex turn to steer: session is closed');
        }
        const steeredTurnId = currentTurnId;
        if (!isTurnInFlight || !steeredTurnId) {
          throw new Error('No active Codex turn to steer');
        }
        // Validate content before steering. `toTurnInput` can touch local
        // files/images; if that fails, leaving the current turn untouched is
        // better than sending a broken 插话.
        const input = await toTurnInput(message.content);
        rejectIfCancelled(sendOpts, 'steer');
        if (closed) {
          throw new Error('No active Codex turn to steer: session is closed');
        }
        if (!isTurnInFlight || currentTurnId !== steeredTurnId) {
          // Conversion can take long enough for a fast turn to finish. Do not
          // silently route a stale 插话 into a later turn; renderer keeps the
          // original queue/composer content and can retry through the normal path.
          throw new Error('No active Codex turn to steer');
        }
        // 同轮注入(2026-07-12 产品决策,与 Claude 对齐):turn/steer 把消息追加进
        // in-flight turn,不打断当前工作,模型在下一个工具调用边界消化这条输入
        // (与 Codex 官方 CLI 排队消息 "submitted after next tool call" 同语义)。
        // 需要真打断的用户自己点 Stop。挂起的审批 / user-input 不 dismiss——turn
        // 没有被打断,它们仍然有效。
        // (历史:2026-06 曾以「模型继续旧工具计划」为由改成 interrupt+follow-up,
        // 那正是注入语义的预期行为,现按统一产品决策回归注入。)
        // expectedTurnId 是 stale-client 防线:server 端 turn 已结束时会报
        // "no active turn to steer",或在当前已有另一 turn 时报告 expected/found
        // id 不匹配。后者同样是明确的 pre-accept 拒绝,需归一化为 no-active-turn,
        // 让 coordinator fallback 成普通派发,消息不丢。
        log.debug('steer ▶ inject into active turn', {
          threadId,
          turnId: steeredTurnId,
        });
        // turn/steer 的 ack 没有内建超时 (AppServerClient.request 会一直挂等);
        // app-server 卡死 / 不回包时裸 await 会让 steer promise 永久 pending,
        // coordinator 的 steering marker 随之永久残留 —— 后续所有插话点击被静默
        // 吞掉、队列 drain 冻结 (2026-06 用户反馈"插话没反应"的根因之一)。
        // 这里给 ack 加有界等待; abort (Stop / close) 复用 rejectIfCancelled
        // 同款取消文案。
        // ⚠️ turn/steer 是 content-bearing RPC(消息本体随请求送出),与旧
        // turn/interrupt(幂等控制信号)不同,超时后请求无法撤回、结果不确定
        // (review #939 P1):RPC 迟到成功时消息其实已注入当前 turn,而上层已按
        // 失败处理。超时错误 message 携带 'did not acknowledge' 特征,coordinator
        // 据此把该行保留为**暂停队列**交用户决策、不自动重派,堵住"已注入 +
        // turn 结束后队列再发一遍"的重复消费;这里同时给在飞 RPC 挂
        // late-resolution 观察,迟到结果留日志现场。
        assertCurrentHost('turn/steer');
        const steerRpc = host.request(Method.TurnSteer, {
          threadId,
          input,
          expectedTurnId: steeredTurnId,
        });
        let ackSettled = false;
        try {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              cleanup();
              // post-send abort(review #939 第二轮 P2):RPC 已发出,Stop/close
              // 赢在 ack 返回前时结果同样不确定——server 仍可能迟到接受注入。
              // coordinator 的 Stop 语义已把队列置为暂停保留 / 显式清空的用户
              // 可控态,这里留 warn 现场 + 交给下方 late-resolution 观察器,
              // 文案保留 'cancelled before acceptance' 前缀(测试与日志兼容)。
              log.warn('turn/steer aborted while request in flight; delivery uncertain', {
                threadId,
                turnId: steeredTurnId,
              });
              reject(new Error('Codex steer cancelled before acceptance; delivery uncertain (request already dispatched)'));
            };
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error(`Codex turn/steer did not acknowledge within ${STEER_ACK_TIMEOUT_MS}ms`));
            }, STEER_ACK_TIMEOUT_MS);
            const cleanup = () => {
              clearTimeout(timer);
              sendOpts?.signal?.removeEventListener('abort', onAbort);
            };
            if (sendOpts?.signal?.aborted) {
              onAbort();
              return;
            }
            sendOpts?.signal?.addEventListener('abort', onAbort, { once: true });
            steerRpc.then(
              () => {
                cleanup();
                resolve();
              },
              (err) => {
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
              },
            );
          });
          ackSettled = true;
        } catch (error) {
          if (isExpectedTurnIdMismatchError(error)) {
            // app-server 已明确拒绝该 stale expectedTurnId,消息没有注入其它 turn。
            // 标记 RPC 已 settle,避免把这类确定性拒绝误当成 timeout/abort 在飞请求。
            ackSettled = true;
            throw new Error('No active Codex turn to steer', { cause: error });
          }
          throw error;
        } finally {
          if (!ackSettled) {
            // 超时 / abort 后请求仍在飞:迟到成功说明消息已注入但上层已按失败
            // 处理(队列行被暂停保留),留 warn 现场供排查;迟到失败静默吞掉,
            // 防 unhandled rejection。
            steerRpc.then(
              () => {
                log.warn('turn/steer acknowledged after local timeout/abort; message may already be injected', {
                  threadId,
                  turnId: steeredTurnId,
                });
              },
              () => {},
            );
          }
        }
        // ack 成功 = server 已确认接受注入,消息已进入该 turn 的输入(即使本地
        // 已先收到 turn 终态事件,ack 与终态乱序)。这里必须按**已投递**成功返回
        // (review #939 第二轮 P1)——此前按 NO_ACTIVE_TURN 抛出会让 coordinator
        // fallback 把同一条消息再作为普通 turn 重发,模型消费两次。turn 已死时
        // "steer activeTurn 等不到终态事件"的收口责任在 coordinator 侧:它在
        // accepted 落库后自查 isTurnRunning,已终结则立即合成收口,队列不冻结。
        if (!isTurnInFlight || currentTurnId !== steeredTurnId) {
          log.info('turn/steer acknowledged after local turn end; treated as delivered', {
            threadId,
            turnId: steeredTurnId,
          });
        }
      },

      async abort() {
        // 用户点 Stop = 明确不想继续这一轮，挂起的过载重投必须一起撤掉。
        // 放在 currentTurnId 判空之前：重投等待期间 turn 已死、currentTurnId 为
        // null，此时正是最需要响应 Stop 的时刻（否则计时器到点又发一个新 turn）。
        const hadPendingOverloadRetry = overloadRetryPending();
        discardOverloadRetry('aborted');
        if (closed) return;
        // 有挂起重投时的 Stop **必须**由这里显式收口逻辑 turn —— desktop 的
        // SessionTurnActivityTracker 只在收到终态事件后才释放派发闩，Codex
        // coordinator 也刻意等这个事件而不自己解锁，hook runner 同样等到一小时硬
        // 超时才罢休。不发的话会话永久忙、后续消息无法派发（review #844 codex P1）。
        //
        // 两种排序都要覆盖:
        //  - 退避等待中: server 侧没有 turn 可 interrupt (currentTurnId 为 null);
        //  - 重投的 turnStarted 已先于它的响应到达: currentTurnId 非空, 但**不能**
        //    像普通 Stop 那样把收口交给 turn/completed —— 随后到达的重投响应会走
        //    cancelledMidFlight 把同一个 id 落墓碑, handleTurnCompleted 于是把唯一
        //    那条完成事件压掉, 派发闩永远不释放（review #844 codex P1）。这里自己
        //    落墓碑 + interrupt + 推终态, 保证恰好一次收口。
        if (hadPendingOverloadRetry) {
          teardownActiveTurnForCancellation('stopped while an overload retry was pending');
          markInFlightStartsTerminallySettled();
          // turn/start 还在飞时按下 Stop: 这里马上会推终态事件, 而那个 RPC 的响应随后
          // 才回来。不武装隔离的话 handleTurnStartResp 会照常激活它 —— 用户看到
          // 「已停止」, 工具还在跑(review #844 codex P1)。
          quarantineAllInFlightStarts();
          eventQueue.push({
            type: 'error',
            data: {
              message: 'Codex turn stopped while waiting to retry a model-capacity failure',
              isTerminal: true,
              reason: 'codex-overload-retry-aborted',
            },
            source: 'codex',
          });
          eventQueue.push({
            type: 'status',
            data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
            source: 'codex',
          });
          return;
        }
        if (!currentTurnId) return;
        if (skipIfStaleHost('turn/interrupt')) return;
        // 中断已在进行:收 idle 表,别让 watchdog 在收口窗口里再开一次火。
        resetUpstreamIdleForTurnEnd();
        dismissPendingUserInputForTurn(currentTurnId, 'turn_interrupted');
        try {
          await host.request(Method.TurnInterrupt, { threadId, turnId: currentTurnId });
        } catch (e) {
          log.warn('turn/interrupt threw', { error: String(e) });
        }
      },

      getCurrentTurnId() {
        return currentTurnId;
      },

      async close() {
        if (closed) return;
        closed = true;
        resetUpstreamIdleForTurnEnd();
        unregisterCodexMcpContext(threadId);
        // close 时 buffer 里可能还有等对账的挂起请求 (codex R17 P2):
        // 统一按拒绝释放, 否则 handler 永远悬挂, dispatchServerRequest
        // 永不返回, server 侧请求卡死。
        abandonBufferedTurns('session closed');
        // 把挂起的 approval 强制 deny + emit interaction_dismissed (UI 关 dialog),
        // 否则 server 那边没回 response 会卡; UI 上的 PermissionPrompt 也会留尸
        try { dismissAllPending('session_closed', 'deny'); } catch (e) { log.warn('dismissAllPending threw', { error: String(e) }); }
        try { dismissAllPendingUserInput('session_closed'); } catch (e) { log.warn('dismissAllPendingUserInput threw', { error: String(e) }); }
        try { stopActiveRolloutPlanFallback(); } catch (e) { log.warn('stop rollout plan fallback threw', { error: String(e) }); }
        // 挂起的过载重投计时器必须清掉：否则会话已关，计时器到点仍会对已释放的
        // thread 发 turn/start（assertCurrentHost 会抛，但那是在无人接收的
        // setTimeout 回调里，白留一次失败与一条误导日志）。
        try { discardOverloadRetry('session_closed'); } catch (e) { log.warn('cancel overload retry threw', { error: String(e) }); }
        try { await subscription?.release(); } catch (e) { log.warn('release threw', { error: String(e) }); }
        try { eventQueue.end(); } catch (e) { log.warn('eventQueue.end threw', { error: String(e) }); }
      },

      events(): AsyncIterable<AgentEvent> {
        return eventQueue;
      },

      getUsageSnapshot(): UsageSnapshot {
        return usageTracker.snapshot();
      },

      setInteractionResolver(resolver: InteractionResolver) {
        interactionResolver = resolver;
      },

      // ── Phase 3: 运行时切换 (下一 turn 才生效, 内部已是 mutable 闭包) ──
      async setModel(newModel: string) {
        if (newModel === mutableModel) return; // 去重: 值没变不重推 (renderer 单次切换会全量重调 set*)
        log.debug('setModel', { from: mutableModel, to: newModel });
        mutableModel = newModel;
        registerCodexReviewerRouteContext(threadId);
        // thread 已启动 → 立即经 thread/settings/update 推给 server (sticky); 未启动则由
        // 首个 thread/start 携带。沿用 turn/start 的 'gpt-5'=server 默认哨兵约定 (省略),
        // 避免把占位 model id 发给 server。失败时 turn/start 透传仍是兜底。
        if (newModel && newModel !== 'gpt-5') await pushThreadSettings({ model: newModel });
      },

      async setEffort(newEffort: Effort) {
        if (newEffort === mutableEffort) return; // 去重: 值没变不重推
        const clamped = clampEffortForCodex(mutableModel, newEffort);
        log.debug('setEffort', { from: mutableEffort, to: newEffort, clamped });
        mutableEffort = newEffort;
        // thread 已启动 → 立即经 thread/settings/update 生效; 未启动由首个 turn/start
        // 携带 (TurnStartParams.effort, v2.rs:5800)。发 clamp 后的值, 与 turn/start 一致。
        await pushThreadSettings({ effort: clamped });
      },

      async setPermissionMode(newMode: PermissionMode) {
        log.debug('setPermissionMode', { from: mutablePermissionMode, to: newMode });
        // Full access 才能批量放行挂起的 ask。切到 Auto 时，已有请求不能绕过
        // reviewer / 人工降级审批，先 fail-closed 关闭；后续重试按当前路由能力
        // 选择 auto_review 或 user reviewer。
        const allowPending = newMode === 'bypassPermissions';
        dismissAllPending(`permission_mode_changed_to_${newMode}`, allowPending ? 'allow' : 'deny');
        const wasAuto = mutablePermissionMode === 'auto';
        const wasBypass = mutablePermissionMode === 'bypassPermissions';
        const wasOpen = wasAuto || wasBypass;
        const tightensCurrentTurn =
          (newMode === 'ask' && wasOpen) ||
          (newMode === 'auto' && wasBypass);
        mutablePermissionMode = newMode;
        // 下一 turn 通过 approvalPolicy + 已激活的 profile / sandboxPolicy 透传。
        //
        // 收紧兜底 (auto/bypass → ask): 见 interruptTurnForPermissionTighten 顶注。
        // turn id 已知 → 立即中断; turn/start 在飞 (id 未回) → 置标记, 由
        // handleTurnStartResp / turnStarted 在拿到 id 的瞬间补中断。放宽则清标记
        // (收紧后又切回宽松档, 在飞的 turn 无需再中断)。
        // 过载重投持的是**冻结**策略。只看最近一次转换会漏掉 Full access → Ask →
        // Auto 这类中间态：Ask→Auto 不算收紧会把标记清掉，而冻结的 Full access 仍然
        // 比 Auto 宽，重投出来的 turn 就能以 Full access 执行（review #844 codex P1）。
        // 按严格度排序直接比冻结档与当前档。
        const retryPolicyLooserThanNow = overloadRetryPolicyLooserThan(newMode);
        if (!tightensCurrentTurn && !retryPolicyLooserThanNow) {
          pendingTightenInterrupt = false;
        } else if (!closed && (turnLaunchedUnattended || retryPolicyLooserThanNow)) {
          // 只中断 auto_review / never / Auto policy turn;普通 user reviewer 发射的
          // turn 审批请求照常流经本地、收紧即时生效,期间 UI 短暂切过宽松档
          // 不构成中断理由。
          // retryPolicyLooserThanNow 是过载重投的补充判据: 挂起的重投冻结的是发射时
          // 那档策略, 只看"最近一次转换算不算收紧"会漏掉 Full access → Ask → Auto
          // 这类中间态(review #844 codex P1)。
          if (currentTurnId !== null) {
            await interruptTurnForPermissionTighten(currentTurnId);
          } else if (isTurnStartPending || overloadRetry?.timer != null || overloadRetry?.inFlight === true) {
            // 过载退避等待中 / 重投 RPC 在途时，既没有 currentTurnId 也不一定有
            // isTurnStartPending，但重投持着的 turnParams 是**收紧之前**冻结的旧
            // 宽松策略。不置这个标记，重投出来的 turn 会在权限已被撤销后继续执行
            // 工具（review #844 codex P1）。与 turn/start 在飞的处理同构：标记由
            // handleTurnStartResp 在拿到 turn id 的瞬间消费并补中断。
            pendingTightenInterrupt = true;
          }
        }
      },

      async setExtraDirs(newDirs: string[]) {
        if (newDirs.length > 0 && !readonlyReferenceDirsSupported) {
          throw new Error(
            `Codex reference directories require app-server 0.144.6 or newer (current: ${initResp.userAgent ?? 'unknown'})`,
          );
        }
        mutableExtraDirs = [...newDirs];
        log.debug('setExtraDirs', { count: mutableExtraDirs.length });
      },

      async setPlanMode(enabled: boolean) {
        if (mutablePlanMode === enabled) return;
        mutablePlanMode = enabled;
        log.debug('setPlanMode', { enabled });
        // 下一 turn 经 turn/start.collaborationMode 生效 (与 permissionMode 同款
        // "下一 turn 透传"语义); 中途关闭时挂起的 plan_review 由用户自行处理。
      },

      getPlanMode() {
        return mutablePlanMode;
      },

      async setFastMode(enabled: boolean) {
        // 去重以"fast 是否开启"为准: undefined(未覆盖) / null / 'default' 都视为未开,
        // 重复关 fast 或重复开 fast 不重推 (renderer 单次切换会全量重调 set*)。
        if (isFastServiceTier(mutableServiceTier) === enabled) return;
        const next: ServiceTier | null = enabled ? 'fast' : null;
        log.debug('setFastMode', { from: mutableServiceTier ?? null, to: next });
        serviceTierMutationGeneration += 1;
        mutableServiceTier = next;
        // thread 已启动 → 立即经 thread/settings/update 生效 (serviceTier 双 Option:
        // 'fast'=开 / null=清空 standard); 未启动则由首个 thread/start 携带。server 端
        // 若因模型不支持 fast 而降级, 会经 thread/settings/updated 通知回带, handlers
        // 里把 mutableServiceTier 对齐到权威值。失败时 turn/start 透传仍是兜底。
        await pushThreadSettings({ serviceTier: next });
      },

      async setVendorOptions(patch: Record<string, unknown>) {
        // Keep the same vendorOptions object so active MCP handlers and the
        // host bridge see runtime Orca role/workflow updates by reference.
        Object.assign(vo, patch);
        registerCodexMcpContext(threadId);
        log.debug('setVendorOptions', {
          patchKeys: Object.keys(patch),
        });
      },

      getFastMode() {
        return isFastServiceTier(mutableServiceTier);
      },

      async previewRewindFiles() {
        // Codex 的 thread/rollback 只裁剪对话上下文，不提供文件 checkpoint dry-run。
        // 代码回退由产品层 Git rollback 负责；单独点 Rewind 时 UI 会显示“无文件改动”。
        return {
          canRewind: true,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
        };
      },

      async commitRewindFiles(_userUuid, _priorAssistantUuid, rewindOpts) {
        const tailTurnsToDrop = normalizeTailTurnsToDrop(rewindOpts?.tailTurnsToDrop);
        if (tailTurnsToDrop <= 0) {
          log.warn('commitRewindFiles called without tailTurnsToDrop; skipping thread/rollback', {
            threadId,
          });
          return { sdkSessionId: threadId };
        }
        log.info('commitRewindFiles ▶ thread/rollback', {
          threadId,
          tailTurnsToDrop,
        });
        assertCurrentHost('thread/rollback');
        const rollbackResp = await host.request<ThreadRollbackResponse>(
          Method.ThreadRollback,
          { threadId, numTurns: tailTurnsToDrop } as ThreadRollbackParams,
        );
        const previousThreadId = threadId;
        const nextThreadId = rollbackResp.thread.id || previousThreadId;
        if (nextThreadId !== previousThreadId) {
          try {
            await subscription?.release();
          } catch {
            // no-op: stale subscription cleanup should not fail a successful rollback.
          }
          unregisterCodexMcpContext(previousThreadId);
          if (closed) {
            try {
              await host.unsubscribeThread(nextThreadId);
            } catch (e) {
              log.warn('thread/unsubscribe replacement after close threw', {
                error: String(e),
                threadId: nextThreadId,
              });
            }
            log.info('commitRewindFiles discarded replacement after concurrent close', {
              previousThreadId,
              nextThreadId,
            });
            return sdkSessionId ? { sdkSessionId } : {};
          }
          threadId = nextThreadId;
          sdkSessionId = nextThreadId;
          readonlyReferencesProfileActive = false;
          threadMayHaveRollout = true;
          subscription = host.subscribeThread(threadId, handlers);
          registerCodexMcpContext(threadId);
          registerCodexReviewerRouteContext(threadId);
          registerCodexDeveloperInstructions(threadId, registeredDeveloperInstructions);
          eventQueue.push({ type: 'session_id', data: sdkSessionId, source: 'codex' });
        } else {
          sdkSessionId = threadId;
          threadMayHaveRollout = true;
        }
        currentTurnId = null;
        isTurnInFlight = false;
        log.info('commitRewindFiles ◀ thread/rollback done', {
          threadId,
          tailTurnsToDrop,
        });
        return sdkSessionId ? { sdkSessionId } : {};
      },

      isTurnRunning() {
        // 本方法是 Session.send() 的 in-flight guard 判据（另见上方 turn/start
        // 失败收口处的注释）。过载重投把这一轮拆成了两段 app-server 侧「没有活着
        // 的 turn」但逻辑上没结束的窗口，只看 isTurnInFlight 都会漏：并发 send
        // 被误接受后，send() 开头的 cancelOverloadRetry 会把原消息静默丢掉。
        //
        // 三种状态见 overloadRetryPending 的注释(退避等待 / RPC 在途 / 失败已延后
        // 等补排)。漏掉"已延后"那种时, Session.send() 会把会话当 idle 接受第二条
        // 消息, 把第一条的重投状态连同它仍在飞的原始 RPC 一起丢掉
        // (review #844 codex P1)。三者都在 retry() 的 finally /
        // rescheduleDeferredCapacityFailure / cancelOverloadRetry 里必定复位。
        // **不把 `isTurnStartPending` 一起算进来**：正常 send 路径上它必须保持
        // idle 语义——终态先于 turn/start 响应到达时（协议允许的乱序），
        // coordinator 要看到 idle 才能收口，否则 send 挂死（既有用例
        // "accepts terminal error before TurnStartResponse…" 锁的就是这条）。
        return isTurnInFlight || overloadRetryPending();
      },
    };

    return handle;
  }

  /**
   * Phase 3: thread/fork — Codex 协议层 fork 当前 thread 成新 thread。
   *
   * 与 Claude 不同:
   *  - Claude fork 可 truncate 到指定 message uuid (sdkForkSession upToMessageId)
   *  - Codex 协议没有 message uuid 概念; 精确 fork 需要先 fork latest,
   *    再对新 thread 调 thread/rollback 从尾部移除 N 个 turn
   *
   * opts.upToMessageId 在 Codex 这里被忽略。uuidMap 返回空 — Codex agentMeta 不存
   * message uuid, maker 那边也找不到东西可 remap, 不会 break。
   */
  private async findRolloutPath(threadId: string, preferredPath?: string): Promise<string> {
    if (preferredPath && !isRemoteLikePath(preferredPath)) {
      try {
        const stat = await fs.stat(preferredPath);
        if (stat.isFile()) return preferredPath;
      } catch {
        // Fall through to the normal CODEX_HOME scan when preparation only
        // returned a stale state-db pointer.
      }
    }
    const codexHome = this.codexHome;
    if (!codexHome || isRemoteLikePath(codexHome)) {
      throw new Error('Codex rollout path is unavailable for this session');
    }

    const roots = [
      path.join(codexHome, 'sessions'),
      path.join(codexHome, 'archived_sessions'),
    ];
    let bestPath = '';
    let bestMtimeMs = -1;

    const visit = async (dir: string): Promise<void> => {
      let entries: Array<import('node:fs').Dirent>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith('rollout-') || !entry.name.endsWith(`${threadId}.jsonl`)) continue;
        const stat = await fs.stat(full);
        if (stat.mtimeMs > bestMtimeMs) {
          bestPath = full;
          bestMtimeMs = stat.mtimeMs;
        }
      }
    };

    for (const root of roots) {
      await visit(root);
    }
    if (!bestPath) {
      throw new Error(`Codex rollout not found for thread ${threadId}`);
    }
    return bestPath;
  }

  private async createSafeForkRolloutCopy(threadId: string, preferredPath?: string): Promise<string> {
    const sourcePath = await this.findRolloutPath(threadId, preferredPath);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-codex-fork-'));
    const copyPath = path.join(tempDir, path.basename(sourcePath));
    const text = await fs.readFile(sourcePath, 'utf8');
    const out = text
      .split(/\r?\n/)
      .filter((line) => !line.trim() || !hasUnsafeForkRolloutPayload(line))
      .join('\n');
    await fs.writeFile(copyPath, out.endsWith('\n') || out.length === 0 ? out : `${out}\n`, 'utf8');
    return copyPath;
  }

  async forkSdkSession(opts: ForkSdkSessionOptions): Promise<ForkSdkSessionResult> {
    const log = this.deps.logger.child('codex/fork');
    const tailTurnsToDrop = normalizeTailTurnsToDrop(opts.tailTurnsToDrop);
    let stripCopyPath: string | undefined;
    log.info('forkSdkSession ▶', {
      sourceSdkSessionId: opts.sourceSdkSessionId,
      upToMessageId: opts.upToMessageId,
      tailTurnsToDrop,
      stripEncryptedReasoning: opts.stripEncryptedReasoning === true,
      note: 'Codex 精确 fork: thread/fork 后按需 thread/rollback 新 thread 尾部 turn',
    });
    try {
      const { host } = await this.getUtilityHost();
      await host.ensureStarted();
      // Imported Codex threads may still live under another CODEX_HOME. Resume
      // already asks the desktop host to link/adopt their state and rollout;
      // fork must cross the same preparation boundary before thread/fork or the
      // utility app-server cannot resolve a freshly imported thread.
      const preparedRolloutResult = await this.deps.prepareCodexResumeSession?.(opts.sourceSdkSessionId);
      const preparedRolloutPath = typeof preparedRolloutResult === 'string'
        ? preparedRolloutResult
        : undefined;
      // 选项名沿用历史语义;安全副本同时会丢弃会让 Responses fork/retry 失败的坏历史 payload。
      if (opts.stripEncryptedReasoning) {
        stripCopyPath = await this.createSafeForkRolloutCopy(
          opts.sourceSdkSessionId,
          preparedRolloutPath,
        );
      }
      const params: ThreadForkParams = {
        threadId: opts.sourceSdkSessionId,
        persistExtendedHistory: true,
        ...(stripCopyPath ? { path: stripCopyPath } : {}),
        ...(opts.workingDir ? { cwd: opts.workingDir } : {}),
      };
      const resp = await host.request<ThreadForkResponse>(Method.ThreadFork, params);
      let newSdkSessionId = resp.thread.id;
      if (tailTurnsToDrop > 0) {
        const rollbackParams: ThreadRollbackParams = {
          threadId: newSdkSessionId,
          numTurns: tailTurnsToDrop,
        };
        const rollbackResp = await host.request<ThreadRollbackResponse>(
          Method.ThreadRollback,
          rollbackParams,
        );
        newSdkSessionId = rollbackResp.thread.id || newSdkSessionId;
      }
      log.info('forkSdkSession ◀', { newSdkSessionId, tailTurnsToDrop });
      return { newSdkSessionId, uuidMap: new Map() };
    } finally {
      if (stripCopyPath) {
        await fs.rm(path.dirname(stripCopyPath), { recursive: true, force: true }).catch((err) => {
          log.warn('strip encrypted rollout temp cleanup failed', {
            path: stripCopyPath,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  /**
   * app.before-quit 调一次, 杀所有 codex app-server 子进程 (本地 spawn + 远端
   * SSH-bridged 各一份)。Windows 不会随父进程死, 必须显式收割。幂等。
   */
  async dispose(): Promise<void> {
    this.deps.logger.error('codex dispose called', {
      hostCount: this.hosts.size,
      inflightCount: this.hostPromises.size,
      createHostSeqByKey: Object.fromEntries(this.createHostSeqByKey),
    });
    // 如果有正在创建中的 host (logout 撞上启动期 in-flight getHost), 等它出来再 shutdown,
    // 否则刚 spawn 出来的子进程没人收 → 孤儿。await 失败说明创建本身炸了, 没东西可收。
    //
    // **before-quit 兜底**: hostPromise 卡住 (auth.getState hang / prepareCodexExtraSpawnConfig
    // hang) 时不能让 dispose 跟着卡到 lifecycle 6s 超时, 否则 SIGTERM 永远发不出。安全性:
    // hostPromise resolve 之前真正的 child spawn 还没发生 (start() 在 ensureStarted
    // 里才调, app-server/host.ts), 所以超时跳过 host.shutdown 不会留孤儿子进程。
    if (this.hostPromises.size > 0) {
      const inflightSnapshot = Array.from(this.hostPromises.values()).map((entry) => entry.promise);
      for (const key of this.hostPromises.keys()) {
        this.bumpHostGeneration(key);
      }
      try {
        await Promise.race([
          Promise.allSettled(inflightSnapshot),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('hostPromise timeout in dispose (1500ms)')), 1500),
          ),
        ]);
      } catch (e) {
        this.deps.logger.warn('codex dispose: hostPromise await skipped', {
          message: (e as Error).message,
        });
      }
    }
    const hostsSnapshot = Array.from(this.hosts.values());
    for (const key of this.hosts.keys()) {
      this.hostGenerations.set(key, (this.hostGenerations.get(key) ?? 0) + 1);
    }
    this.hosts.clear();
    this.hostPromises.clear();
    this.hostCredentialModes.clear();
    this.hostEffectiveCredentialModes.clear();
    this.hostSessionBindingLeases.clear();
    this.hostCredentialModeSwitches.clear();
    // 进程重启后 server 端 in-memory enablement 会丢, 重置 push flag 让下次 ensure 再 push 一次
    this.memoryOverridePushedByHost.clear();
    // codexHome 也跟着 host 走: 下次 ensureStarted() 会用新 server 的返回值重新填,
    // 防止用户中途切 CODEX_HOME (改 auth / 重登) 后这边还拿着老路径。
    this.codexHome = null;
    if (hostsSnapshot.length > 0) {
      // 并发 shutdown — 互不依赖, 一起更快收完。失败不阻断其他。
      await Promise.allSettled(
        hostsSnapshot.map((h) => h.retire('CodexAgent.dispose()')),
      );
    }
    // dispose 完毕 → 重置 seq, 下次 createHost 重新从 1 开始计数 (logout/切账号场景)
    this.createHostSeqByKey.clear();
  }

  /**
   * 本地 Codex 凭证状态变化时只重置 local app-server。
   *
   * 远端 host 使用 remote daemon / remote 用户配置；本地 key、OAuth 或 proxy 注入状态变化
   * 不应该 retire `remote:*` host，否则远端 session 会绕过 Session.close 留下 stale 状态。
   */
  async disposeLocalHostForCredentialChange(reason = 'CodexAgent local credential state changed'): Promise<void> {
    const switchGuard = await this.beginLocalHostCredentialChange(reason);
    await switchGuard.finalize();
  }

  /**
   * 本地 Codex OAuth/logout 失效时强制收掉共享 local host 与独立 control-plane hosts。
   *
   * 这些 host 都持有本机凭证，账号边界变化后不能继续复用；remote hosts 使用远端
   * 用户配置，不在本次清理范围内。
   */
  async forceDisposeLocalHostForAuthChange(reason = 'CodexAgent local auth changed'): Promise<void> {
    const keys = new Set<string>([hostKey()]);
    for (const key of this.hosts.keys()) {
      if (isLocalControlPlaneHostKey(key)) keys.add(key);
    }
    for (const key of this.hostPromises.keys()) {
      if (isLocalControlPlaneHostKey(key)) keys.add(key);
    }
    await Promise.all(Array.from(keys, (key) =>
      this.retireHostKey(key, reason, {
        failIfActive: false,
        logPrefix: 'codex local auth restart',
      })));
  }

  private async disposeLocalHostForCredentialChangeUnlocked(key: string, reason: string): Promise<void> {
    await this.retireHostKey(key, reason, {
      failIfActive: true,
      logPrefix: 'codex local credential restart',
    });
  }

  private async retireHostKey(
    key: string,
    reason: string,
    opts: { failIfActive: boolean; logPrefix: string },
  ): Promise<void> {
    const inflight = this.hostPromises.get(key);
    if (inflight) {
      this.bumpHostGeneration(key);
      this.hostPromises.delete(key);
      try {
        await Promise.race([
          inflight.promise.catch(() => undefined),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('local hostPromise timeout in credential restart (1500ms)')), 1500),
          ),
        ]);
      } catch (e) {
        this.deps.logger.warn(`${opts.logPrefix}: hostPromise await skipped`, {
          message: (e as Error).message,
        });
      }
    }

    const host = this.hosts.get(key);
    const activeUseCount = host
      ? this.hostActiveUseCount(key, host)
      : (this.hostSessionBindingLeases.get(key) ?? 0);
    if (opts.failIfActive && activeUseCount > 0) {
      throw new Error(
        `Cannot restart local Codex host while ${activeUseCount} active Codex session(s) are attached`,
      );
    }
    if (!opts.failIfActive && activeUseCount > 0) {
      this.deps.logger.warn(`${opts.logPrefix}: retiring host with active sessions`, {
        key,
        activeUseCount,
      });
      // 强杀 host 不走 Session.close —— 先把终态 transport error 广播给订阅者,
      // 让每个 session 自己收口 turn 状态 (isTurnInFlight→false + 补发 isRunning:false)。
      // 不广播的话上层 busy 判定永久 stale:输入排队不派发、Stop 的 abort 锁解不开、
      // 凭证切换 busy 重试风暴 (2026-07-19 auth app_session_terminated 实排)。
      host?.notifySubscribersOfForcedRetire(reason);
    }

    this.hosts.delete(key);
    this.hostPromises.delete(key);
    this.hostCredentialModes.delete(key);
    this.hostEffectiveCredentialModes.delete(key);
    this.hostSessionBindingLeases.delete(key);
    this.memoryOverridePushedByHost.delete(key);
    if (key === hostKey()) this.codexHome = null;
    this.createHostSeqByKey.delete(key);
    this.bumpHostGeneration(key);
    if (!host) return;
    try {
      await host.retire(reason);
    } catch (error) {
      this.deps.logger.warn(`${opts.logPrefix}: host shutdown failed`, {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Memory 实现 ────────────────────────────────────────────────────────
  // 范围: codex Feature::MemoryTool ("memories", 实验性, 默认关)。
  // 控制走 experimentalFeature/enablement/set (in-memory 进程级 + 自动热重载所有 live thread),
  // 不写 config.toml 文件; 数据落 <CODEX_HOME>/memories/ + state_*.sqlite。

  async getMemoryStatus(): Promise<MemoryStatus> {
    // config/read 返回的 effective config 已经把 in-memory enablement 合并进去了
    // (config_processor.rs:99-110), 所以 setMemory 后立刻 read 也能看到新值
    try {
      const { key, host } = await this.getUtilityHost();
      // app-server 重启后 in-memory enablement 会丢, server 端回到 config.toml 默认值 (memories=false);
      // 读之前先把 maker 端持久化的 memoryOverride 同步过去, 否则 Settings 界面显示的是 server 默认值,
      // 不是用户上次保存的设置。ensureMemoryOverridePushed 内部用 memoryOverridePushed 去重, 已 push 是 no-op。
      await host.ensureStarted();
      await this.ensureMemoryOverridePushed(host, key).catch((e) => {
        this.deps.logger.warn('codex.getMemoryStatus: ensureMemoryOverridePushed failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
      type ConfigReadResp = { config?: { features?: { memories?: boolean } } };
      const resp = await host.request<ConfigReadResp>(Method.ConfigRead, { includeLayers: false });
      const enabled = resp.config?.features?.memories ?? false;
      return {
        enabled,
        // memoryOverride 没设过时 enabled 来自 config.toml + server 默认, 算 'user-config';
        // host 显式覆盖过算 'host-runtime'
        source: this.memoryOverride === undefined ? 'user-config' : 'host-runtime',
      };
    } catch (err) {
      if (err instanceof AgentNotAuthenticatedError) {
        // 未授权 → host 起不来, 报推断值 (codex 默认 false)
        return {
          enabled: this.memoryOverride ?? false,
          source: this.memoryOverride === undefined ? 'agent-default' : 'host-runtime',
        };
      }
      throw err;
    }
  }

  async setMemory(enabled: boolean): Promise<MemorySetResult> {
    const log = this.deps.logger.child('codex/setMemory');
    log.info('setMemory ▶', { from: this.memoryOverride, to: enabled });
    this.memoryOverride = enabled;
    // 立即 push, 让所有 live thread 通过 server 端 reload_user_config 拿到新值
    try {
      const localSessionHosts = Array.from(this.hosts.entries()).filter(
        ([key]) => !key.startsWith('remote:') && !isLocalControlPlaneHostKey(key),
      );
      if (localSessionHosts.length === 0) {
        log.info('setMemory ◀ no live app-server, will apply on next session');
        return { effective: 'next-session' };
      }
      await Promise.all(localSessionHosts.map(async ([key, host]) => {
        // Only thread-serving local hosts receive Maker Memory. Remote hosts own
        // their native setting; model-list control-plane hosts have no live threads.
        await host.request(Method.ExperimentalFeatureEnablementSet, {
          enablement: { memories: enabled },
        });
        this.memoryOverridePushedByHost.set(key, enabled);
        return key;
      }));
      log.info('setMemory ◀ pushed to app-server, hot-reloaded all live threads');
      return { effective: 'immediate' };
    } catch (err) {
      if (err instanceof AgentNotAuthenticatedError) {
        // 未授权 → host 起不来, 但 memoryOverride 已记下, 等下次 ensure (startSession 触发) 再 push
        log.warn('setMemory: not authenticated, deferring push to next session');
        this.memoryOverridePushedByHost.clear();
        return { effective: 'next-session' };
      }
      // server 端 RPC 失败 → 把 push flag 重置, 下次 ensure 再试
      this.memoryOverridePushedByHost.clear();
      throw err;
    }
  }

  async resetMemory(): Promise<MemoryResetResult> {
    const log = this.deps.logger.child('codex/resetMemory');
    log.info('resetMemory ▶');
    const { host } = await this.getUtilityHost();
    // server 端清 <CODEX_HOME>/memories/ 目录 + state_*.sqlite 的 memory stage 数据;
    // 不影响各 thread 的 memory_mode (用户随后改 thread/memoryMode/set 才动那个)
    await host.request(Method.MemoryReset, {});
    log.info('resetMemory ◀ ok');
    // server 不返回数量统计, removedEntries / removedBytes 留 undefined
    return {};
  }

  /**
   * memoryOverride 同步到 app-server。
   *
   * 调用时机:
   *  - 每次 startSession 调一次 (在 host.ensureStarted 之后)
   *  - 内部已用 memoryOverridePushed 去重, 已 push 同样的值就 no-op
   *
   * 失败语义: 抛错由调用方决定。startSession 那边会 catch + warn + 继续, 不让
   * memory 配置 block 主对话流。
   */
  private async ensureMemoryOverridePushed(host: AppServerHost, key: string): Promise<void> {
    if (this.memoryOverride === undefined) return; // 没设 override 不动 server, 让 server 走自带配置
    if (this.memoryOverridePushedByHost.get(key) === this.memoryOverride) return; // 已 push 同值, no-op
    await host.request(Method.ExperimentalFeatureEnablementSet, {
      enablement: { memories: this.memoryOverride },
    });
    this.memoryOverridePushedByHost.set(key, this.memoryOverride);
    this.deps.logger.info('codex: memoryOverride pushed to app-server', {
      memories: this.memoryOverride,
    });
  }
}
