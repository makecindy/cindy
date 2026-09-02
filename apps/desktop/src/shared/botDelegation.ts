export const BOT_DELEGATION_STATUSES = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
] as const;

export type BotDelegationStatus = (typeof BOT_DELEGATION_STATUSES)[number];

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
    mode: 'ask' | 'bypassPermissions';
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
    || (permission.mode !== 'ask' && permission.mode !== 'bypassPermissions')
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
  resultSummary: string | null;
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
}

export type BotDelegationListResult =
  | { ok: true; delegations: BotDelegationView[] }
  | { ok: false; errorCode: string; message: string };

export type BotDelegationCancelResult =
  | { ok: true; delegationId: string; childSessionId: string | null }
  | { ok: false; errorCode: string; message: string };
