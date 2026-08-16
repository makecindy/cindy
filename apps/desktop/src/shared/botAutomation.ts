import type {
  PreRunHookConfig,
  ScheduleStatus,
} from '@cindy/maker-scheduler';
import type {
  BotDelegationCapabilitySnapshot,
  BotDelegationWorkspaceSnapshot,
} from './botDelegation';
import type { BotOutputArtifact } from './botOutputArtifact';
import type { BotDeliveryDiagnostic } from './botDeliveryDiagnostic';

export type BotAutomationStatus = 'active' | 'paused' | 'error' | 'archived';

export type BotAutomationRunStatus =
  | 'claimed'
  | 'running'
  | 'completing'
  | 'success'
  | 'failed'
  | 'aborted'
  | 'interrupted'
  | 'skipped'
  | 'unknown';

export type BotAutomationDeliveryStatus =
  | 'not-requested'
  | 'enqueue-failed'
  | 'pending'
  | 'sending'
  | 'suspended'
  | 'failed'
  | 'delivered'
  | 'dead-letter'
  | 'cancelled';

export interface BotAutomation {
  id: string;
  botId: string;
  scheduleId?: string;
  name: string;
  prompt: string;
  cronExpr: string;
  timezone: string;
  recurring: boolean;
  manual: boolean;
  intervalMs?: number;
  preRunHook?: PreRunHookConfig;
  projectBindingId?: string;
  targetRouteId?: string;
  durableNoteNamespace?: string;
  executionPolicy: BotAutomationExecutionPolicy;
  createdWithProfileVersion: number;
  status: BotAutomationStatus;
  scheduleStatus?: ScheduleStatus;
  nextFireAt?: number;
  lastFiredAt?: number;
  lastFinishedAt?: number;
  createdAt: number;
  updatedAt: number;
  activeRunCount: number;
}

export interface BotAutomationRun {
  id: string;
  automationLinkId: string;
  scheduleRunId?: string;
  sessionId?: string;
  workspaceLeaseId?: string;
  worktreePath?: string;
  profileVersion: number;
  executionPlan?: BotAutomationExecutionPlan;
  projectBindingId?: string;
  targetRouteId?: string;
  workingDir?: string;
  remoteHostId?: string;
  status: BotAutomationRunStatus;
  scheduleStatus?:
    | 'running'
    | 'success'
    | 'failed'
    | 'aborted'
    | 'interrupted'
    | 'skipped';
  resultText?: string;
  outputArtifacts: BotOutputArtifact[];
  errorMessage?: string;
  deliveryOutboxId?: string;
  deliveryStatus: BotAutomationDeliveryStatus;
  deliveryError?: string;
  deliveryDiagnostic?: BotDeliveryDiagnostic;
  createdAt: number;
  updatedAt: number;
  firedAt?: number;
  finishedAt?: number;
}

export interface CreateBotAutomationInput {
  botId: string;
  name: string;
  prompt: string;
  cronExpr: string;
  timezone: string;
  recurring: boolean;
  manual?: boolean;
  intervalMs?: number;
  preRunHook?: PreRunHookConfig | null;
  projectBindingId?: string | null;
  targetRouteId?: string | null;
  durableNoteNamespace?: string | null;
  executionPolicy?: Partial<BotAutomationExecutionPolicy> | null;
}

export type UpdateBotAutomationInput = Partial<
  Omit<CreateBotAutomationInput, 'botId'>
>;

export type BotAutomationDelegateTargetMode = 'none' | 'allowlist' | 'all-active';

export interface BotAutomationExecutionPolicy {
  timeoutMs: number;
  budgetTokens: number | null;
  maxDelegationDepth: number;
  delegateTargetMode: BotAutomationDelegateTargetMode;
  allowedDelegateBotIds: string[];
}

export interface BotAutomationDelegateTargetSnapshot {
  botId: string;
  profileVersion: number;
  capabilitiesSha256: string;
  identitySha256: string;
  defaultWorkspace: BotDelegationWorkspaceSnapshot | null;
}

/** Immutable authorization and runtime plan captured for one automation fire. */
export interface BotAutomationExecutionPlan {
  version: 1;
  createdAt: number;
  deadlineAt: number;
  botId: string;
  profile: BotDelegationCapabilitySnapshot;
  workspace: BotDelegationWorkspaceSnapshot | null;
  delivery: {
    targetRouteId: string | null;
    ownerGeneration: number | null;
  };
  limits: {
    timeoutMs: number;
    budgetTokens: number | null;
    maxDelegationDepth: number;
  };
  delegation: {
    mode: BotAutomationDelegateTargetMode;
    targets: BotAutomationDelegateTargetSnapshot[];
  };
}

export const DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY: BotAutomationExecutionPolicy = {
  timeoutMs: 30 * 60_000,
  budgetTokens: null,
  maxDelegationDepth: 1,
  delegateTargetMode: 'none',
  allowedDelegateBotIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeBotAutomationExecutionPolicy(
  value: unknown,
): BotAutomationExecutionPolicy {
  const record = isRecord(value) ? value : {};
  const timeoutMs =
    typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)
      ? Math.max(1_000, Math.min(24 * 60 * 60_000, Math.floor(record.timeoutMs)))
      : DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY.timeoutMs;
  const budgetTokens =
    record.budgetTokens === null
      ? null
      : typeof record.budgetTokens === 'number'
          && Number.isSafeInteger(record.budgetTokens)
          && record.budgetTokens > 0
        ? record.budgetTokens
        : DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY.budgetTokens;
  const maxDelegationDepth =
    typeof record.maxDelegationDepth === 'number'
      && Number.isSafeInteger(record.maxDelegationDepth)
      ? Math.max(1, Math.min(5, record.maxDelegationDepth))
      : DEFAULT_BOT_AUTOMATION_EXECUTION_POLICY.maxDelegationDepth;
  const delegateTargetMode =
    record.delegateTargetMode === 'allowlist' || record.delegateTargetMode === 'all-active'
      ? record.delegateTargetMode
      : 'none';
  const allowedDelegateBotIds = Array.isArray(record.allowedDelegateBotIds)
    ? [...new Set(
        record.allowedDelegateBotIds
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean),
      )].slice(0, 100)
    : [];
  return {
    timeoutMs,
    budgetTokens,
    maxDelegationDepth,
    delegateTargetMode,
    allowedDelegateBotIds: delegateTargetMode === 'allowlist' ? allowedDelegateBotIds : [],
  };
}

export function parseBotAutomationExecutionPlan(
  value: string | Record<string, unknown> | null | undefined,
): BotAutomationExecutionPlan | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  const profile = parsed.profile;
  const delivery = parsed.delivery;
  const limits = parsed.limits;
  const delegation = parsed.delegation;
  if (
    typeof parsed.createdAt !== 'number'
    || typeof parsed.deadlineAt !== 'number'
    || typeof parsed.botId !== 'string'
    || !isRecord(profile)
    || !isRecord(delivery)
    || !isRecord(limits)
    || !isRecord(delegation)
    || !Array.isArray(delegation.targets)
  ) return null;
  return parsed as unknown as BotAutomationExecutionPlan;
}
