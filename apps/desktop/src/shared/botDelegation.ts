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

export interface BotDelegationWorkspaceSnapshot {
  bindingId: string;
  bindingUpdatedAt: number;
  projectKey: string;
  workingDir: string;
  remoteHostId: string | null;
  defaultBranch: string | null;
  workspacePolicy: 'none' | 'reuse' | 'per-task' | 'read-only';
  allowedPaths: string[];
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
  automationEnabled: boolean;
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

export interface BotCapabilityProjectView {
  bindingId: string;
  projectKey: string;
  workingDir: string;
  remoteHostId: string | null;
  defaultBranch: string | null;
  workspacePolicy: 'none' | 'reuse' | 'per-task' | 'read-only';
  allowedPaths: string[];
  isDefault: boolean;
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
  projects: BotCapabilityProjectView[];
  activeInboundDelegations: number;
  activeOutboundDelegations: number;
  activeAutomations: number;
  busy: boolean;
  capabilityTags: string[];
  /**
   * Present only when the caller is a Bot Automation task. Automation may
   * delegate solely to the targets frozen into that run's execution plan.
   * A stale target remains visible for diagnosis but cannot receive work.
   */
  automationAuthorization?: {
    state: 'allowed' | 'stale';
    reason: string | null;
  };
}

/**
 * Immutable execution plan captured before a child task is made visible.
 *
 * Bot Profile versions freeze identity, but project bindings and capability
 * catalogs are mutable. Delegations therefore persist the exact authorization
 * and workspace facts that were approved at creation time. Runtime startup and
 * restart recovery must consume this snapshot instead of re-reading a Bot's
 * current default project.
 */
export interface BotDelegationPlanSnapshot {
  version: 1;
  createdAt: number;
  targetBotId: string;
  target: BotDelegationCapabilitySnapshot;
  workspace: BotDelegationWorkspaceSnapshot | null;
  access: {
    callerProjectBindingId: string | null;
    projectKey: string | null;
    remoteHostId: string | null;
    contextRefs: string[];
    artifactRefs: string[];
  };
  /**
   * Frozen destination for the completion result. Optional only for delegation
   * rows created before Cindy persisted Route ownership in the execution plan.
   */
  completionTarget?: {
    parentSessionId: string;
    channelId: string | null;
    routeId: string | null;
    ownerGeneration: number;
  };
  limits: {
    maxDepth: number;
    budgetTokens: number | null;
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
  const target = parsed.target;
  const access = parsed.access;
  const limits = parsed.limits;
  const permission = parsed.permission;
  const workspace = parsed.workspace;
  const completionTarget = parsed.completionTarget;
  if (
    typeof parsed.createdAt !== 'number'
    || typeof parsed.targetBotId !== 'string'
    || !isRecord(target)
    || !isRecord(access)
    || !isRecord(limits)
    || !isRecord(permission)
  ) return null;
  if (completionTarget !== undefined) {
    if (
      !isRecord(completionTarget)
      || typeof completionTarget.parentSessionId !== 'string'
      || (completionTarget.channelId !== null && typeof completionTarget.channelId !== 'string')
      || (completionTarget.routeId !== null && typeof completionTarget.routeId !== 'string')
      || typeof completionTarget.ownerGeneration !== 'number'
    ) return null;
  }
  if (
    typeof target.profileVersion !== 'number'
    || (target.agentKind !== 'cc' && target.agentKind !== 'codex' && target.agentKind !== 'pi')
    || typeof target.model !== 'string'
    || typeof target.capabilitiesSha256 !== 'string'
    || typeof target.identitySha256 !== 'string'
    || !isStringArray(target.skills)
    || (target.skillMode !== 'inherit' && target.skillMode !== 'allowlist')
    || !isStringArray(target.mcpServers)
    || (target.mcpMode !== 'inherit' && target.mcpMode !== 'allowlist')
    || !isStringArray(target.toolsets)
    || (target.toolsetMode !== 'inherit' && target.toolsetMode !== 'allowlist')
    || typeof target.memoryEnabled !== 'boolean'
    || typeof target.automationEnabled !== 'boolean'
  ) return null;
  if (
    (access.callerProjectBindingId !== null && typeof access.callerProjectBindingId !== 'string')
    || (access.projectKey !== null && typeof access.projectKey !== 'string')
    || (access.remoteHostId !== null && typeof access.remoteHostId !== 'string')
    || !isStringArray(access.contextRefs)
    || !isStringArray(access.artifactRefs)
  ) return null;
  if (
    typeof limits.maxDepth !== 'number'
    || (limits.budgetTokens !== null && typeof limits.budgetTokens !== 'number')
    || typeof limits.timeoutMs !== 'number'
    || typeof limits.deadlineAt !== 'number'
    || (permission.mode !== 'ask' && permission.mode !== 'bypassPermissions')
    || (permission.requesterMode !== null && typeof permission.requesterMode !== 'string')
    || (permission.targetConfigured !== 'ask' && permission.targetConfigured !== 'trusted')
  ) return null;
  if (workspace !== null) {
    if (
      !isRecord(workspace)
      || typeof workspace.bindingId !== 'string'
      || typeof workspace.bindingUpdatedAt !== 'number'
      || typeof workspace.projectKey !== 'string'
      || typeof workspace.workingDir !== 'string'
      || (workspace.remoteHostId !== null && typeof workspace.remoteHostId !== 'string')
      || (workspace.defaultBranch !== null && typeof workspace.defaultBranch !== 'string')
      || (
        workspace.workspacePolicy !== 'none'
        && workspace.workspacePolicy !== 'reuse'
        && workspace.workspacePolicy !== 'per-task'
        && workspace.workspacePolicy !== 'read-only'
      )
      || !isStringArray(workspace.allowedPaths)
    ) return null;
  }
  return parsed as unknown as BotDelegationPlanSnapshot;
}

export interface BotDelegationView {
  id: string;
  requestingBotId: string;
  targetBotId: string;
  targetBotName: string;
  parentSessionId: string | null;
  childSessionId: string | null;
  objective: string;
  contextRefs: string[];
  artifactRefs: string[];
  outputArtifacts: import('./botOutputArtifact').BotOutputArtifact[];
  completionDelivery: {
    id: string;
    status: import('./botDelivery').BotDeliveryStatus;
    attempts: number;
    lastError: string | null;
    diagnostic?: import('./botDeliveryDiagnostic').BotDeliveryDiagnostic;
  } | null;
  permissionSnapshot: Record<string, unknown>;
  lineage: string[];
  targetProfileVersion: number;
  depth: number;
  budgetTokens: number | null;
  tokensUsed: number;
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
