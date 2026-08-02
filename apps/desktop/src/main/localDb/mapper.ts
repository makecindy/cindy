/**
 * chat-data-localization F5：IPC 边界 row ↔ camel/ISO 转换。
 *
 * 出口（DB row → IPC payload）：snake_case → camelCase；unix ms → ISO 8601；TEXT → JSON 解析。
 * 入口（IPC payload → DB row）：camelCase → snake_case；ISO 8601 → unix ms；JSON → TEXT。
 *
 * 目的：让上层 sessionService/messageService 函数签名与原 HTTP 响应字段完全一致，hooks 零改动。
 */

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import type {
  sessions,
  messages,
  schedules,
  projectAutomationConsents,
  scheduleRuns,
} from './schema';
// 类型从 renderer 共享（仅 type-only import，运行时无 import 副作用）
import type {
  Session,
  SessionStatus,
  Message,
  MessageRole,
  AgentKind,
  AgentMeta,
  OrcaRole,
  WorkspaceKind,
} from '../../renderer/lib/ccAgent.types';
import type { Effort, PermissionMode } from '../../renderer/lib/userPreferences.types';
// scheduler 模块的纯类型/接口契约——零运行时依赖（package main 是 src/index.ts，
// type-only import 编译期消除）。
import type {
  Schedule,
  ScheduleRun,
  ScheduleStatus,
  RunStatus,
  AgentKind as SchedulerAgentKind,
  ScriptExecutionConfig,
  ScriptCapability,
  PreRunHookRunResult,
} from '@cindy/maker-scheduler';
import { normalizeSessionSource } from '../../shared/sessionSource.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { isSyntheticTriggerText } from '../../shared/interruptedTurn.js';
import {
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  usdMoney,
  zeroUsageMoney,
} from '../../shared/regionalMoney.js';

type SessionRow = typeof sessions.$inferSelect;
type SessionInsert = typeof sessions.$inferInsert;
type MessageRow = typeof messages.$inferSelect;
type MessageInsert = typeof messages.$inferInsert;
type ScheduleRow = typeof schedules.$inferSelect;
type ScheduleInsert = typeof schedules.$inferInsert;
type ProjectAutomationConsentRow = typeof projectAutomationConsents.$inferSelect;
type ProjectAutomationConsentInsert = typeof projectAutomationConsents.$inferInsert;
type ScheduleRunRow = typeof scheduleRuns.$inferSelect;
type ScheduleRunInsert = typeof scheduleRuns.$inferInsert;

/**
 * SessionRow + 同 session 下 messages 总条数。IPC handler 必须通过 LEFT JOIN + GROUP BY
 * 或子查询同时带出 messageCount，再交给 `sessionToCamel`。
 *
 * 原服务端响应里 `_count.messages` 是 Prisma `include: { _count: { select: { messages: true } } }`
 * 注入的字段，侧栏的 projectGrouping 依赖该值 > 0 才把 session 归入 Project 分组，
 * 否则一律放"未分类"。本地切层后必须在 mapper 出口处保留这个契约。
 *
 * sidebar-card-mode：latestMessageContent/Role 是最近一条 user/assistant 消息的
 * 原始 content（JSON string）+ role，由 IPC 层 correlated 子查询带出；mapper 出口
 * 提炼成 `Session.preview` 纯文本。两字段可选——单字段 bump 等不带它们的路径
 * preview 落 null，渲染端兜底隐藏。
 */
export type SessionRowWithCount = SessionRow & {
  messageCount: number;
  latestMessageContent?: string | null;
  latestMessageRole?: string | null;
};

/** preview 最大长度（字符）。渲染端 3 行 line-clamp 之外的兜底硬上限。 */
const PREVIEW_MAX_CHARS = 140;

/**
 * 从消息 content（DB 存的 JSON string）提炼 sidebar 卡片预览纯文本。
 *  - user 消息：content 是 `{"text":"...","images":[],"files":[]}` → 取 .text
 *  - assistant 消息：content 是 JSON.stringify 后的 markdown 字符串 → 解析后原样用
 *  - 解析失败 / 空文本 → null（渲染端隐藏预览行）
 * 换行折叠成空格——卡片预览是流式 3 行 clamp，不保留消息内排版。
 */
export function extractMessagePreview(
  raw: string | null | undefined,
  role: string | null | undefined,
): string | null {
  if (!raw) return null;
  let text: string | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') {
      text = parsed;
    } else if (role === 'user' && parsed !== null && typeof parsed === 'object') {
      const t = (parsed as { text?: unknown }).text;
      if (typeof t === 'string') text = t;
    }
  } catch {
    // 极端情况 content 不是合法 JSON（旧手工写入）——按纯文本兜底
    text = raw;
  }
  if (!text) return null;
  // 合成 UI 指令行(隐藏续跑 / 图片按钮)不进 sidebar 预览(review P2):它是
  // role='user' 的正常落库行,但对用户不可见 —— 预览显示隐藏英文指令会暴露
  // 实现细节。返回 null 与"无预览"同渲染语义。
  if (isSyntheticTriggerText(text)) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > PREVIEW_MAX_CHARS ? collapsed.slice(0, PREVIEW_MAX_CHARS) : collapsed;
}

/**
 * Session 行 → 与原 HTTP 响应同形的 camel + ISO 对象。
 *
 * 注意：原 HTTP `Session` 类型有 `userId` 字段，本地 db 不存（按 db 文件已经按 userId 隔离）。
 * 出口处补一个空字符串 `userId: ''`，避免类型缺失；上层消费如果需要用户 id 应该读 AuthContext。
 */
export function sessionToCamel(row: SessionRowWithCount): Session {
  const legacyMoney =
    row.totalCostUsd > 0 ? legacyUsdMoney(row.totalCostUsd) : undefined;
  const currentMoney =
    row.totalCostCurrency && row.totalCostAmount > 0
      ? normalizeRegionalMoney({
          amount: row.totalCostAmount,
          currency: row.totalCostCurrency,
          approximate: row.totalCostIsApproximate,
          kind: 'actual-cost',
        })
      : undefined;
  const totalMoney =
    legacyMoney && currentMoney
      ? legacyMoney.currency === currentMoney.currency
        ? addRegionalMoney([legacyMoney, currentMoney])
        : currentMoney
      : (currentMoney ?? legacyMoney ?? zeroUsageMoney());
  // 旧字段兼容投影,与 totalMoney 同一 combine 语义:结构化累计仍是 USD 时并入,
  // 否则(CNY 无法表达进 USD 字段)保持冻结历史值。只消费 totalCostUsd 的读方
  // (device-link v1 / 手机端)在全量 reseed 后才不会丢本构建新增的 USD 花费。
  const legacyUsdProjection =
    row.totalCostUsd +
    (row.totalCostCurrency === 'USD' ? row.totalCostAmount : 0);
  return {
    id: row.id,
    userId: '', // 本地 db 已按 user 隔离，无需冗余存储
    title: row.title,
    workingDir: row.workingDir,
    workspaceKind: normalizeWorkspaceKind(row.workspaceKind),
    model: row.model,
    effort: row.effort as Effort,
    permissionMode: row.permissionMode as PermissionMode,
    providerId: row.providerId,
    status: row.status as SessionStatus,
    sdkSessionId: row.sdkSessionId,
    totalTokenUsage: row.totalTokenUsage,
    totalCostUsd: legacyUsdProjection,
    totalMoney,
    contextTokens: row.contextTokens,
    contextWindow: row.contextWindow,
    fastMode: !!row.fastMode,
    planModeEnabled: !!row.planModeEnabled,
    clearedAt: msToIso(row.clearedAt),
    pinnedAt: msToIso(row.pinnedAt),
    userSendAt: msToIso(row.userSendAt),
    agentKind: row.agentKind as AgentKind,
    source: normalizeSessionSource(row.source),
    orcaRole: row.orcaRole as OrcaRole | null,
    parentSessionId: row.parentSessionId,
    forkedAtMessageId: row.forkedAtMessageId,
    worktreePath: row.worktreePath,
    usedProjectContext: !!row.usedProjectContext,
    extraDirs: safeParseStringArray(row.extraDirs),
    remoteHostId: row.remoteHostId ?? null,
    // interrupted-turn-resume:「疑似中断」判定的两个时间戳(unix ms 原样透出,
    // renderer 打开会话时比较 startedAt > endedAt,见 sessionActiveTurn.ts)。
    activeTurnStartedAt: row.activeTurnStartedAt ?? null,
    lastTurnEndedAt: row.lastTurnEndedAt ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    _count: { messages: row.messageCount },
    preview: extractMessagePreview(row.latestMessageContent, row.latestMessageRole),
    summary: row.summary ?? null,
  };
}

export function messageToCamel(row: MessageRow): Message {
  let content: unknown = row.content;
  try {
    content = JSON.parse(row.content);
  } catch {
    // 容错：极端情况下 content 可能不是合法 JSON（例如旧手工写入），保留原字符串
    content = row.content;
  }
  // agent_meta 列存的是 JSON.stringify 后的字符串，老消息为 NULL。
  // 解析失败时返回 null 而非抛——容错保证历史消息能正常加载。
  let agentMeta: AgentMeta | null = null;
  if (row.agentMeta !== null && row.agentMeta !== undefined) {
    try {
      agentMeta = JSON.parse(row.agentMeta) as AgentMeta;
    } catch {
      agentMeta = null;
    }
  }
  return {
    id: row.id,
    clientId: row.clientId,
    sessionId: row.sessionId,
    role: row.role as MessageRole,
    content,
    toolUseId: row.toolUseId,
    agentMeta,
    agentKind: (row.agentKind as 'cc' | 'codex' | 'pi' | null) ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/**
 * 规范化 remoteHostId 边界值：只有 trim 后非空的字符串才算有效 remote host，
 * 其余(undefined / null / 空串 / 纯空白)一律落 null。
 *
 * 为什么放在 main 边界层：renderer 正常路径已 trim，但 IPC 是信任边界——后续脚本、
 * 测试或新入口可能传入 `''`。若空串原样入库，renderer grouping 用
 * `s.remoteHostId ? 'remote' : 'local'` 仍会把它当本地，但 maker send 等路径却拿着
 * 一个"看似 remote 实则空"的值，行为不一致。统一在此收敛成 null，单一真相。
 */
export function normalizeRemoteHostId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Session create 入口字段映射。生成 timestamps + 默认值由调用方保证必填。 */
export function sessionCreateToRow(
  id: string,
  body:
    | {
        id?: string;
        workingDir?: string;
        workspaceKind?: WorkspaceKind;
        model?: string;
        effort?: string;
        permissionMode?: string;
        fastMode?: boolean;
        planModeEnabled?: boolean;
        agentKind?: AgentKind;
        orcaRole?: OrcaRole | null;
        parentSessionId?: string | null;
        forkedAtMessageId?: string | null;
        extraDirs?: string[];
        /** Remote codex (P2): 远端 SSH host alias; null/undefined = 本地。 */
        remoteHostId?: string | null;
        /**
         * per-session 来源(供应商)显式选择,落盘 sessions.provider_id(与 update 同列)。
         * null/undefined = 不显式选,跟随该 agent 的原生默认路由(no-break)。草稿态首次
         * create 由 renderer 透传用户在草稿里选定的来源,使新会话首个请求就走对供应商。
         */
        providerId?: string | null;
      }
    | undefined,
  now: number,
): SessionInsert {
  return {
    id,
    title: DEFAULT_DRAFT_SESSION_TITLE,
    workingDir: normalizeWorkingDirForStorage(body?.workingDir),
    workspaceKind: body?.workspaceKind ?? 'project',
    model: body?.model ?? 'claude-sonnet-4-6',
    effort: (body?.effort as SessionInsert['effort']) ?? 'high',
    permissionMode: (body?.permissionMode as SessionInsert['permissionMode']) ?? 'ask',
    status: 'active',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    // 新建 session 默认 Fast Mode OFF；调用方显式传 true 时才打开。
    fastMode: !!body?.fastMode,
    // 计划模式默认 OFF；草稿里开了计划模式的会话显式传 true。
    planModeEnabled: !!body?.planModeEnabled,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: null,
    agentKind: body?.agentKind ?? 'cc',
    orcaRole: body?.orcaRole ?? null,
    parentSessionId: body?.parentSessionId ?? null,
    forkedAtMessageId: body?.forkedAtMessageId ?? null,
    worktreePath: null,
    extraDirs: safeStringify(body?.extraDirs ?? []),
    remoteHostId: normalizeRemoteHostId(body?.remoteHostId),
    // 显式来源:trim 后非空才入库,其余(undefined / null / 空串 / 纯空白)一律落 null,
    // 与 session-provider-store 的 null 语义对齐(null → 回落默认路由,字节级不变)。
    providerId:
      typeof body?.providerId === 'string' && body.providerId.trim().length > 0
        ? body.providerId.trim()
        : null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Session patch 入口字段映射。
 * - 仅写入显式提供的字段（undefined 跳过）
 * - 时间字段 ISO ↔ unix ms
 * - `updatedAt` 总是刷新为当前时间
 */
export function sessionPatchToRow(
  patch: {
    title?: string;
    workingDir?: string;
    workspaceKind?: WorkspaceKind;
    model?: string;
    effort?: string;
    permissionMode?: string;
    providerId?: string | null;
    fastMode?: boolean;
    planModeEnabled?: boolean;
    sdkSessionId?: string | null;
    totalTokenUsage?: number;
    totalCostUsd?: number;
    contextTokens?: number;
    contextWindow?: number;
    clearedAt?: string | null;
    pinnedAt?: string | null;
    status?: SessionStatus;
    orcaRole?: OrcaRole | null;
    extraDirs?: string[];
  },
  opts?: { bumpUpdatedAt?: boolean },
): Partial<SessionInsert> {
  const out: Partial<SessionInsert> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.workingDir !== undefined)
    out.workingDir = normalizeWorkingDirForStorage(patch.workingDir);
  if (patch.workspaceKind !== undefined) out.workspaceKind = patch.workspaceKind;
  if (patch.model !== undefined) out.model = patch.model;
  if (patch.effort !== undefined) out.effort = patch.effort as SessionInsert['effort'];
  if (patch.permissionMode !== undefined)
    out.permissionMode = patch.permissionMode as SessionInsert['permissionMode'];
  if (patch.providerId !== undefined) out.providerId = patch.providerId;
  if (patch.fastMode !== undefined) out.fastMode = !!patch.fastMode;
  if (patch.planModeEnabled !== undefined) out.planModeEnabled = !!patch.planModeEnabled;
  if (patch.sdkSessionId !== undefined) out.sdkSessionId = patch.sdkSessionId;
  if (patch.totalTokenUsage !== undefined) out.totalTokenUsage = patch.totalTokenUsage;
  if (patch.totalCostUsd !== undefined) out.totalCostUsd = patch.totalCostUsd;
  if (patch.contextTokens !== undefined) out.contextTokens = patch.contextTokens;
  if (patch.contextWindow !== undefined) out.contextWindow = patch.contextWindow;
  if (patch.clearedAt !== undefined) out.clearedAt = isoToMs(patch.clearedAt);
  if (patch.pinnedAt !== undefined) out.pinnedAt = isoToMs(patch.pinnedAt);
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.orcaRole !== undefined) out.orcaRole = patch.orcaRole;
  if (patch.extraDirs !== undefined) out.extraDirs = safeStringify(patch.extraDirs);
  if (opts?.bumpUpdatedAt !== false) out.updatedAt = Date.now();
  return out;
}

/** Message create 入口字段映射。content / agentMeta 序列化为 JSON 字符串。 */
export function messageCreateToRow(
  id: string,
  sessionId: string,
  body: {
    clientId: string;
    role: MessageRole;
    content: unknown;
    toolUseId?: string;
    agentMeta?: AgentMeta | null;
    agentKind?: 'cc' | 'codex' | 'pi' | null;
    createdAt?: number;
  },
  now: number,
): MessageInsert {
  return {
    id,
    clientId: body.clientId,
    sessionId,
    role: body.role as MessageInsert['role'],
    content: safeStringify(body.content),
    toolUseId: body.toolUseId ?? null,
    agentMeta:
      body.agentMeta === undefined || body.agentMeta === null
        ? null
        : safeStringify(body.agentMeta),
    agentKind: body.agentKind ?? null,
    createdAt: body.createdAt ?? now,
  };
}

function msToIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

function isoToMs(iso: string | null): number | null {
  if (iso === null || iso === undefined) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

/**
 * 把 JSON 字符串解析成 string[];失败/格式不对返回空数组。
 * 用于 sessions.extra_dirs 这类 TEXT JSON 列的反序列化兜底。
 */
export function safeParseStringArray(raw: string | null | undefined): string[] {
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
    return [];
  } catch {
    return [];
  }
}

function normalizeWorkspaceKind(raw: unknown): WorkspaceKind {
  return raw === 'dialogue' ? 'dialogue' : 'project';
}

// =============================================================================
// scheduler 模块 mapper (Phase 2)
// -----------------------------------------------------------------------------
// 与 sessions/messages mapper 风格一致：DB row 是 snake_case + unix ms；
// 出口对象是 camelCase + unix ms（**不转 ISO**——Schedule 类型本身就用 number ms，
// 与 IPC 边界由 mapper 转 ISO 的旧约定刻意不一致；scheduler 引擎内部就是 ms 算的）。
//
// 关键约束（Phase 2 plan 硬规则）：
//   1. `Schedule.notify` 在内存里是嵌套对象 `{ desktop, feishu, wecomGroup? }`，
//      DB 端拆成三列；mapper 出口合成回对象，入口拆成对应列。
//   2. patch mapper（`schedulePatchToRow`）必须区分：
//        - key 不存在 → SQL 不更新该列
//        - key 存在但值是 undefined → 显式写 NULL
//      这是 Scheduler 引擎语义（参见 Phase 1 changelog L1173）：`patch.nextFireAt`
//      未传 vs 传 undefined，意义不同。Drizzle 把 undefined 当作"忽略"，所以遇到
//      "值是 undefined" 的可空字段必须显式写 null。
//   3. mapper 不做任何业务逻辑（不重算 nextFireAt、不调 cron 引擎）。
// =============================================================================

/** 内部小工具：判断对象自身是否真的有这个 key（而不是值为 undefined）。 */
function hasKey<T extends object>(obj: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseScriptConfig(raw: string | null): ScriptExecutionConfig | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.command !== 'string' || !value.command.trim()) return undefined;
    // 只做结构校验(string 数组),不做能力白名单过滤:白名单是引擎写入侧
    // (normalizeScriptConfig)的业务职责,mapper 复制一份必然漂移——review
    // 实锤过这里漏登记 feishu.read,导致该能力落库后每次回读被静默丢弃。
    const capabilities = Array.isArray(value.capabilities)
      ? value.capabilities.filter(
          (capability): capability is ScriptCapability => typeof capability === 'string',
        )
      : [];
    const timeoutMs =
      typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
        ? Math.floor(value.timeoutMs)
        : undefined;
    return { command: value.command, capabilities, ...(timeoutMs ? { timeoutMs } : {}) };
  } catch {
    return undefined;
  }
}

const PRE_RUN_HOOK_STATUSES = new Set(['passed', 'skipped', 'failed', 'timed_out', 'aborted']);
const PRE_RUN_HOOK_DECISIONS = new Set(['run', 'skip', 'block']);

/** 兼容损坏/手工写入的 JSON：非法结果不应让整个运行历史加载失败。 */
function parsePreRunHookResult(raw: string | null): PreRunHookRunResult | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!PRE_RUN_HOOK_STATUSES.has(String(value.status))) return undefined;
    if (!PRE_RUN_HOOK_DECISIONS.has(String(value.decision))) return undefined;
    if (value.exitCode !== null && typeof value.exitCode !== 'number') return undefined;
    if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs))
      return undefined;
    if (typeof value.stdout !== 'string' || typeof value.stderr !== 'string') return undefined;
    if (
      typeof value.stdoutTruncated !== 'boolean' ||
      typeof value.stderrTruncated !== 'boolean' ||
      typeof value.timedOut !== 'boolean' ||
      typeof value.aborted !== 'boolean'
    ) {
      return undefined;
    }
    if (value.spawnError !== undefined && typeof value.spawnError !== 'string') return undefined;
    if (value.error !== undefined && typeof value.error !== 'string') return undefined;
    return value as unknown as PreRunHookRunResult;
  } catch {
    return undefined;
  }
}

function serializeScriptConfig(config: ScriptExecutionConfig | undefined): string | null {
  return config ? JSON.stringify(config) : null;
}

/** Schedule 行 → 内存对象。`notify` 由两列合成。 */
export function scheduleToCamel(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    jobType: row.jobType,
    jobConfig: row.jobConfig ?? undefined,
    executionMode: row.executionMode === 'script' ? 'script' : 'agent',
    scriptConfig: parseScriptConfig(row.scriptConfig),
    source: row.source === 'project' ? 'project' : 'user',
    projectConfigId: row.projectConfigId ?? undefined,
    kind: row.kind,
    cronExpr: row.cronExpr,
    timezone: row.timezone,
    recurring: !!row.recurring,
    manual: !!row.manual,
    intervalMs: row.intervalMs ?? undefined,
    agentKind: row.agentKind as SchedulerAgentKind,
    model: row.model ?? undefined,
    providerId: row.providerId ?? undefined,
    effort: row.effort ?? undefined,
    fastMode: !!row.fastMode,
    workspaceKind: normalizeWorkspaceKind(row.workspaceKind),
    workingDir: row.workingDir ?? undefined,
    useWorktree: !!row.useWorktree,
    targetSessionId: row.targetSessionId ?? undefined,
    persistentSession: !!row.persistentSession,
    silentWhenIdle: !!row.silentWhenIdle,
    // preRunHook 与 notify 同模式:DB 拆列,内存合成嵌套对象。command 为空即未启用。
    preRunHook: row.preRunHookCommand
      ? {
          command: row.preRunHookCommand,
          timeoutMs: row.preRunHookTimeoutMs ?? undefined,
        }
      : undefined,
    notify: {
      desktop: !!row.notifyDesktop,
      feishu: !!row.notifyFeishu,
      ...(row.notifyWecomGroup ? { wecomGroup: true } : {}),
    },
    status: row.status as ScheduleStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastFiredAt: row.lastFiredAt ?? undefined,
    lastFinishedAt: row.lastFinishedAt ?? undefined,
    nextFireAt: row.nextFireAt ?? undefined,
    expireAt: row.expireAt ?? undefined,
  };
}

/** Schedule 全字段 insert（用于 storage.insert）。`notify` 拆成两列。 */
export function scheduleCreateToRow(s: Schedule): ScheduleInsert {
  return {
    id: s.id,
    name: s.name,
    prompt: s.prompt,
    jobType: s.jobType ?? 'prompt',
    jobConfig: s.jobConfig ?? null,
    executionMode: s.executionMode ?? 'agent',
    scriptConfig: serializeScriptConfig(s.scriptConfig),
    source: s.source ?? 'user',
    projectConfigId: s.projectConfigId ?? null,
    kind: s.kind,
    cronExpr: s.cronExpr,
    timezone: s.timezone,
    recurring: s.recurring,
    manual: s.manual,
    intervalMs: s.intervalMs ?? null,
    agentKind: s.agentKind,
    model: s.model ?? null,
    providerId: s.providerId ?? null,
    effort: (s.effort as ScheduleInsert['effort']) ?? null,
    fastMode: !!s.fastMode,
    workspaceKind: s.workspaceKind ?? 'project',
    workingDir: s.workingDir ?? null,
    useWorktree: s.useWorktree,
    targetSessionId: s.targetSessionId ?? null,
    persistentSession: !!s.persistentSession,
    silentWhenIdle: !!s.silentWhenIdle,
    preRunHookCommand: s.preRunHook?.command ?? null,
    preRunHookTimeoutMs: s.preRunHook?.timeoutMs ?? null,
    notifyDesktop: s.notify.desktop,
    notifyFeishu: s.notify.feishu,
    notifyWecomGroup: s.notify.wecomGroup === true,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastFiredAt: s.lastFiredAt ?? null,
    lastFinishedAt: s.lastFinishedAt ?? null,
    nextFireAt: s.nextFireAt ?? null,
    expireAt: s.expireAt ?? null,
  };
}

/**
 * Schedule patch → 部分行字段。
 *
 * 行为契约：
 *   - 调用方传入的 `patch` 里 **没有** 这个 key → 不进结果（drizzle 跳过）
 *   - 调用方传入了这个 key 但值是 `undefined` → 出口 `null`（写 NULL）
 *   - 调用方传入 `null` → 出口 `null`
 *   - 其它值原样透传
 *
 * `notify` 是嵌套对象，patch 里只要出现就视为整体替换（拆成两列写入）。
 */
export function schedulePatchToRow(patch: Partial<Schedule>): Partial<ScheduleInsert> {
  const out: Partial<ScheduleInsert> = {};
  if (hasKey(patch, 'name')) out.name = patch.name as string;
  if (hasKey(patch, 'prompt')) out.prompt = patch.prompt as string;
  if (hasKey(patch, 'jobType')) out.jobType = patch.jobType ?? 'prompt';
  if (hasKey(patch, 'jobConfig')) out.jobConfig = patch.jobConfig ?? null;
  if (hasKey(patch, 'executionMode')) out.executionMode = patch.executionMode ?? 'agent';
  if (hasKey(patch, 'scriptConfig')) out.scriptConfig = serializeScriptConfig(patch.scriptConfig);
  if (hasKey(patch, 'source')) out.source = patch.source ?? 'user';
  if (hasKey(patch, 'projectConfigId')) out.projectConfigId = patch.projectConfigId ?? null;
  if (hasKey(patch, 'kind')) out.kind = patch.kind as ScheduleInsert['kind'];
  if (hasKey(patch, 'cronExpr')) out.cronExpr = patch.cronExpr as string;
  if (hasKey(patch, 'timezone')) out.timezone = patch.timezone as string;
  if (hasKey(patch, 'recurring')) out.recurring = patch.recurring as boolean;
  if (hasKey(patch, 'manual')) out.manual = patch.manual as boolean;
  // intervalMs：undefined → null（清空，回退到 cron 槽位语义）；数字原样写
  if (hasKey(patch, 'intervalMs')) out.intervalMs = patch.intervalMs ?? null;
  if (hasKey(patch, 'agentKind')) out.agentKind = patch.agentKind as ScheduleInsert['agentKind'];
  if (hasKey(patch, 'model')) out.model = patch.model ?? null;
  if (hasKey(patch, 'providerId')) out.providerId = patch.providerId ?? null;
  if (hasKey(patch, 'effort')) out.effort = (patch.effort as ScheduleInsert['effort']) ?? null;
  if (hasKey(patch, 'fastMode')) out.fastMode = !!patch.fastMode;
  if (hasKey(patch, 'workspaceKind')) out.workspaceKind = patch.workspaceKind ?? 'project';
  if (hasKey(patch, 'workingDir')) out.workingDir = patch.workingDir ?? null;
  if (hasKey(patch, 'useWorktree')) out.useWorktree = patch.useWorktree as boolean;
  if (hasKey(patch, 'targetSessionId')) out.targetSessionId = patch.targetSessionId ?? null;
  if (hasKey(patch, 'persistentSession')) out.persistentSession = !!patch.persistentSession;
  if (hasKey(patch, 'silentWhenIdle')) out.silentWhenIdle = !!patch.silentWhenIdle;
  if (hasKey(patch, 'preRunHook')) {
    // 嵌套对象整体替换(同 notify):出现即两列同写;undefined = 关闭 hook,双列清 NULL
    out.preRunHookCommand = patch.preRunHook?.command ?? null;
    out.preRunHookTimeoutMs = patch.preRunHook?.timeoutMs ?? null;
  }
  if (hasKey(patch, 'notify')) {
    const n = patch.notify;
    if (n == null) {
      out.notifyDesktop = false;
      out.notifyFeishu = false;
      out.notifyWecomGroup = false;
    } else {
      // 兼容不知道新通知渠道的旧客户端：对象内只更新实际出现的 key。
      if (hasKey(n, 'desktop')) out.notifyDesktop = !!n.desktop;
      if (hasKey(n, 'feishu')) out.notifyFeishu = !!n.feishu;
      if (hasKey(n, 'wecomGroup')) out.notifyWecomGroup = !!n.wecomGroup;
    }
  }
  if (hasKey(patch, 'status')) out.status = patch.status as ScheduleStatus;
  if (hasKey(patch, 'createdAt')) out.createdAt = patch.createdAt as number;
  if (hasKey(patch, 'updatedAt')) out.updatedAt = patch.updatedAt as number;
  // 三个可空时间戳：undefined 也要写成 null（业务语义"清空 nextFireAt"）
  if (hasKey(patch, 'lastFiredAt')) out.lastFiredAt = patch.lastFiredAt ?? null;
  if (hasKey(patch, 'lastFinishedAt')) out.lastFinishedAt = patch.lastFinishedAt ?? null;
  if (hasKey(patch, 'nextFireAt')) out.nextFireAt = patch.nextFireAt ?? null;
  if (hasKey(patch, 'expireAt')) out.expireAt = patch.expireAt ?? null;
  return out;
}

export interface ProjectAutomationConsent {
  workingDir: string;
  consentedAt: number;
  configHash: string;
}

export function projectAutomationConsentToCamel(
  row: ProjectAutomationConsentRow,
): ProjectAutomationConsent {
  return {
    workingDir: row.workingDir,
    consentedAt: row.consentedAt,
    configHash: row.configHash,
  };
}

export function projectAutomationConsentToRow(
  consent: ProjectAutomationConsent,
): ProjectAutomationConsentInsert {
  return {
    workingDir: consent.workingDir,
    consentedAt: consent.consentedAt,
    configHash: consent.configHash,
  };
}

/** ScheduleRun 行 → 内存对象。 */
export function scheduleRunToCamel(row: ScheduleRunRow): ScheduleRun {
  const legacyCost =
    row.costUsd > 0 ? legacyUsdMoney(row.costUsd) : undefined;
  const currentCost =
    row.costCurrency && row.costAmount > 0
      ? normalizeRegionalMoney({
          amount: row.costAmount,
          currency: row.costCurrency,
          approximate: row.costIsApproximate,
          kind: 'actual-cost',
        })
      : undefined;
  const costMoney =
    legacyCost && currentCost
      ? legacyCost.currency === currentCost.currency
        ? addRegionalMoney([legacyCost, currentCost])
        : currentCost
      : (currentCost ?? legacyCost ?? zeroUsageMoney());
  const legacyEstimate =
    row.estimatedValueUsd > 0
      ? usdMoney(row.estimatedValueUsd, 'value-estimate', 'legacy-usd')
      : undefined;
  const currentEstimate =
    row.costCurrency && row.estimatedValueAmount > 0
      ? normalizeRegionalMoney({
          amount: row.estimatedValueAmount,
          currency: row.costCurrency,
          approximate: true,
          kind: 'value-estimate',
          estimateReasons: ['subscription-value'],
        })
      : undefined;
  const estimatedValueMoney =
    legacyEstimate && currentEstimate
      ? legacyEstimate.currency === currentEstimate.currency
        ? addRegionalMoney([legacyEstimate, currentEstimate])
        : currentEstimate
      : (currentEstimate ??
        legacyEstimate ??
        zeroUsageMoney('value-estimate'));
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    sessionId: row.sessionId ?? undefined,
    firedAt: row.firedAt,
    finishedAt: row.finishedAt ?? undefined,
    status: row.status as RunStatus,
    errorMsg: row.errorMsg ?? undefined,
    costUsd: row.costUsd,
    estimatedValueUsd: row.estimatedValueUsd,
    costMoney,
    estimatedValueMoney,
    costAttribution: row.costAttribution,
    resultText: row.resultText ?? undefined,
    preRunHookResult: parsePreRunHookResult(row.preRunHookResult),
    readAt: row.readAt ?? undefined,
    heartbeatAt: row.heartbeatAt ?? undefined,
  };
}

/** ScheduleRun 全字段 insert。 */
export function scheduleRunCreateToRow(r: ScheduleRun): ScheduleRunInsert {
  return {
    id: r.id,
    scheduleId: r.scheduleId,
    sessionId: r.sessionId || null,
    firedAt: r.firedAt,
    finishedAt: r.finishedAt ?? null,
    status: r.status,
    errorMsg: r.errorMsg ?? null,
    costUsd: r.costUsd ?? 0,
    estimatedValueUsd: r.estimatedValueUsd ?? 0,
    costAmount: r.costMoney?.amount ?? 0,
    estimatedValueAmount: r.estimatedValueMoney?.amount ?? 0,
    costCurrency: r.costMoney?.currency ?? r.estimatedValueMoney?.currency ?? null,
    costIsApproximate: r.costMoney?.approximate ?? false,
    // 新写入的 run 从创建起就带 runId origin；迁移前旧行由列默认值标为 legacy。
    costAttribution: r.costAttribution ?? 'exact',
    resultText: r.resultText ?? null,
    preRunHookResult: r.preRunHookResult ? JSON.stringify(r.preRunHookResult) : null,
    readAt: r.readAt ?? null,
    heartbeatAt: r.heartbeatAt ?? null,
  };
}

/**
 * ScheduleRun patch → 部分行字段。
 * 与 schedulePatchToRow 同样的 hasOwn 语义：key 不存在 = 不更新；
 * key 存在但 undefined = 写 NULL。
 */
export function scheduleRunPatchToRow(patch: Partial<ScheduleRun>): Partial<ScheduleRunInsert> {
  const out: Partial<ScheduleRunInsert> = {};
  if (hasKey(patch, 'scheduleId')) out.scheduleId = patch.scheduleId as string;
  // 空字符串等同 null：FireResult.sessionId 是 required string，但 runner
  // 在无实际 session 时可能返回 ''；schedule_runs.session_id 是 FK，写空串会触发 FK 违反。
  if (hasKey(patch, 'sessionId')) out.sessionId = patch.sessionId || null;
  if (hasKey(patch, 'firedAt')) out.firedAt = patch.firedAt as number;
  if (hasKey(patch, 'finishedAt')) out.finishedAt = patch.finishedAt ?? null;
  if (hasKey(patch, 'status')) out.status = patch.status as ScheduleRunInsert['status'];
  if (hasKey(patch, 'errorMsg')) out.errorMsg = patch.errorMsg ?? null;
  if (hasKey(patch, 'costUsd')) out.costUsd = patch.costUsd ?? 0;
  if (hasKey(patch, 'estimatedValueUsd')) {
    out.estimatedValueUsd = patch.estimatedValueUsd ?? 0;
  }
  if (hasKey(patch, 'costMoney')) {
    out.costAmount = patch.costMoney?.amount ?? 0;
    out.costCurrency = patch.costMoney?.currency ?? null;
    out.costIsApproximate = patch.costMoney?.approximate ?? false;
  }
  if (hasKey(patch, 'estimatedValueMoney')) {
    out.estimatedValueAmount = patch.estimatedValueMoney?.amount ?? 0;
    out.costCurrency = patch.estimatedValueMoney?.currency ?? out.costCurrency ?? null;
  }
  if (hasKey(patch, 'costAttribution')) {
    out.costAttribution = patch.costAttribution ?? 'legacy';
  }
  if (hasKey(patch, 'resultText')) out.resultText = patch.resultText ?? null;
  if (hasKey(patch, 'preRunHookResult')) {
    out.preRunHookResult = patch.preRunHookResult ? JSON.stringify(patch.preRunHookResult) : null;
  }
  if (hasKey(patch, 'readAt')) out.readAt = patch.readAt ?? null;
  if (hasKey(patch, 'heartbeatAt')) out.heartbeatAt = patch.heartbeatAt ?? null;
  return out;
}
