/**
 * 一次 call 的状态机(伙伴目标与 Cindy 任务目标共用同一套):
 *
 *   queued → running ⇄ waiting → completed | failed | cancelled
 *
 * - queued:    已发起,对方还没接手(含首句没送进去、正在退避重试)。
 * - running:   对方正在做。
 * - waiting:   对方停在一个要人拍板的地方(权限确认 / 提问 / 计划审核),
 *              `pendingInteraction` 里是具体在等什么;发起方伙伴替用户答,
 *              或用户直接在子任务里答,任一侧答了就回到 running。
 * - completed / failed / cancelled: 终态。超时归入 failed(lastError 以 TIMEOUT 开头)。
 */
export const BOT_DELEGATION_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  /** Legacy terminal rows remain readable; new timeouts are stored as failed + TIMEOUT. */
  'timed-out',
] as const;

export type BotDelegationStatus = (typeof BOT_DELEGATION_STATUSES)[number];

export type BotDelegationInteractionKind = 'permission' | 'ask_user_question' | 'plan_review';

/** waiting 状态下对方正在等的那件事,给卡片与发起方伙伴看的同一份摘要。 */
export interface BotDelegationPendingInteraction {
  requestId: string;
  kind: BotDelegationInteractionKind;
  /** 人话摘要:要批的是什么 / 问的是什么 / 计划标题。 */
  summary: string;
  raisedAt: number;
}

/** 子任务交出的文件(相对子任务工作目录的路径 + 绝对路径)。 */
export interface BotDelegationArtifact {
  path: string;
  absolutePath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface BotDelegationCapabilitySnapshot {
  profileVersion: number;
  agentKind: 'cc' | 'codex' | 'pi';
  model: string;
  capabilitiesSha256: string;
  identitySha256: string;
  skills: string[];
  skillMode: 'inherit' | 'allowlist';
  mcpServers: string[];
  mcpMode: 'inherit' | 'allowlist';
  toolsets: string[];
  toolsetMode: 'inherit' | 'allowlist';
  memoryEnabled: boolean;
}

export type BotCapabilityRuntimeStatus =
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'unverified';

export interface BotCapabilityRuntimeView {
  status: BotCapabilityRuntimeStatus;
  snapshotId: string | null;
  sessionId: string | null;
  preparedAt: number | null;
  reason: string | null;
  resolvedSkills: string[];
  unavailableSkills: string[];
  resolvedMcpServers: string[];
  unavailableMcpServers: string[];
  resolvedToolsets: string[];
  unavailableToolsets: string[];
  unavailableMemoryRefs: string[];
}

/**
 * Trustworthy delegation catalog entry. Configured values come from the
 * current immutable Profile version; runtime values come only from the latest
 * native runtime snapshot for that exact version. A Bot without such a
 * snapshot is explicitly unverified instead of being advertised as ready.
 */
export interface BotCapabilityCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  isCurrent: boolean;
  currentVersion: number;
  canonicalSessionId: string | null;
  configured: BotDelegationCapabilitySnapshot;
  runtime: BotCapabilityRuntimeView;
  activeInboundDelegations: number;
  activeOutboundDelegations: number;
  busy: boolean;
  capabilityTags: string[];
}

/**
 * Immutable execution plan captured before a child task is made visible.
 *
 * Bot Profile versions freeze identity, but capability catalogs are mutable.
 * Delegations therefore persist the exact authorization facts approved at
 * creation time. Runtime startup and restart recovery must consume this
 * snapshot instead of re-reading the Bot's current configuration.
 *
 * `targetBotId === null` means the child is a plain Cindy task (not another
 * Bot): no target Profile freeze, no target-side timeline mirror — the child
 * session itself is the user-visible workspace.
 */
export interface BotDelegationPlanSnapshot {
  version: 1;
  createdAt: number;
  targetBotId: string | null;
  /**
   * The target Bot task that received the human-visible delegation transcript.
   * Frozen at creation so a later Renew never splits the request and result
   * across two tasks. Absent for plain-Cindy delegations.
   */
  targetCanonicalSessionId?: string;
  /** Frozen target capability facts. Absent for plain-Cindy delegations. */
  target?: BotDelegationCapabilitySnapshot;
  access: {
    contextRefs: string[];
  };
  /** Frozen destination for the completion signal. */
  completionTarget: {
    parentSessionId: string;
  };
  limits: {
    maxDepth: number;
    timeoutMs: number;
    deadlineAt: number;
  };
  permission: {
    /** 子任务实际运行的权限档;Cindy 任务目标从 ask 开始并把交互回调给发起伙伴。 */
    mode: string;
    requesterMode: string | null;
    targetConfigured: 'ask' | 'trusted';
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCapabilitySnapshot(target: unknown): target is BotDelegationCapabilitySnapshot {
  if (!isRecord(target)) return false;
  return (
    typeof target.profileVersion === 'number'
    && (target.agentKind === 'cc' || target.agentKind === 'codex' || target.agentKind === 'pi')
    && typeof target.model === 'string'
    && typeof target.capabilitiesSha256 === 'string'
    && typeof target.identitySha256 === 'string'
    && isStringArray(target.skills)
    && (target.skillMode === 'inherit' || target.skillMode === 'allowlist')
    && isStringArray(target.mcpServers)
    && (target.mcpMode === 'inherit' || target.mcpMode === 'allowlist')
    && isStringArray(target.toolsets)
    && (target.toolsetMode === 'inherit' || target.toolsetMode === 'allowlist')
    && typeof target.memoryEnabled === 'boolean'
  );
}

/** Strict parser: malformed or pre-v1 plans are never silently reinterpreted. */
export function parseBotDelegationPlanSnapshot(
  value: string | Record<string, unknown> | null | undefined,
): BotDelegationPlanSnapshot | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  const access = parsed.access;
  const limits = parsed.limits;
  const permission = parsed.permission;
  const completionTarget = parsed.completionTarget;
  if (
    typeof parsed.createdAt !== 'number'
    || (parsed.targetBotId !== null && typeof parsed.targetBotId !== 'string')
    || !isRecord(access)
    || !isRecord(limits)
    || !isRecord(permission)
    || !isRecord(completionTarget)
    || typeof completionTarget.parentSessionId !== 'string'
  ) return null;
  if (
    parsed.targetCanonicalSessionId !== undefined
    && (
      typeof parsed.targetCanonicalSessionId !== 'string'
      || parsed.targetCanonicalSessionId.length === 0
    )
  ) return null;
  if (parsed.targetBotId !== null && !isCapabilitySnapshot(parsed.target)) return null;
  if (parsed.targetBotId === null && parsed.target !== undefined) return null;
  if (!isStringArray(access.contextRefs)) return null;
  if (
    typeof limits.maxDepth !== 'number'
    || typeof limits.timeoutMs !== 'number'
    || typeof limits.deadlineAt !== 'number'
    || typeof permission.mode !== 'string'
    || permission.mode.length === 0
    || (permission.requesterMode !== null && typeof permission.requesterMode !== 'string')
    || (permission.targetConfigured !== 'ask' && permission.targetConfigured !== 'trusted')
  ) return null;
  return parsed as unknown as BotDelegationPlanSnapshot;
}

export interface BotDelegationView {
  id: string;
  requestingBotId: string;
  /** null = 委派给一条普通 Cindy 任务。 */
  targetBotId: string | null;
  targetBotName: string;
  parentSessionId: string | null;
  childSessionId: string | null;
  objective: string;
  contextRefs: string[];
  permissionSnapshot: Record<string, unknown>;
  lineage: string[];
  targetProfileVersion: number | null;
  depth: number;
  status: BotDelegationStatus;
  /** 只在 waiting 时非空。 */
  pendingInteraction: BotDelegationPendingInteraction | null;
  resultSummary: string | null;
  artifacts: BotDelegationArtifact[];
  lastError: string | null;
  createdAt: number;
  acceptedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface BotDelegationChangedPayload {
  delegationId: string;
  parentSessionId: string | null;
  childSessionId: string | null;
  status: BotDelegationStatus;
  pendingInteraction?: BotDelegationPendingInteraction | null;
}

export type BotDelegationListResult =
  | { ok: true; delegations: BotDelegationView[] }
  | { ok: false; errorCode: string; message: string };

export type BotDelegationCancelResult =
  | { ok: true; delegationId: string; childSessionId: string | null }
  | { ok: false; errorCode: string; message: string };
