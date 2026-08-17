import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { getDbClient } from '../localDb/client/current.js';
import type { BotsFinishDelegationResult } from '../localDb/client/tx/types.js';
import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure.js';
import { ensureDialogueWorkspaceDir } from '../localDb/dialogueWorkspace.js';
import { createBotCanonicalSession } from '../localDb/ipc/bots.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { sessionCreateToRow } from '../localDb/mapper.js';
import {
  botAutomationLinks,
  botAutomationRuns,
  botChannels,
  botDelegations,
  botDeliveryOutbox,
  botProfileVersions,
  botProfiles,
  botProjectBindings,
  botRoutes,
  botRuntimeSnapshots,
  botSessionLinks,
  botWorkspaceAttachments,
  botWorkspaceLeases,
  messages,
  scheduleRuns,
  sessions,
} from '../localDb/schema.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import { createLogger } from '../logger.js';
import { resolveBusinessSessionId } from '../sessionIds.js';
import { registerBotDelegationParentCancellation } from './botDelegationLifecycle.js';
import type {
  BotCapabilityCatalogEntry,
  BotDelegationChangedPayload,
  BotDelegationCapabilitySnapshot,
  BotDelegationPlanSnapshot,
  BotDelegationStatus,
  BotDelegationView,
  BotDelegationWorkspaceSnapshot,
} from '../../shared/botDelegation.js';
import { parseBotDelegationPlanSnapshot } from '../../shared/botDelegation.js';
import type {
  BotAutomationDelegateTargetSnapshot,
  BotAutomationExecutionPlan,
} from '../../shared/botAutomation.js';
import { parseBotAutomationExecutionPlan } from '../../shared/botAutomation.js';
import {
  collectBotOutputArtifacts,
  parseBotOutputArtifacts,
} from '../../shared/botOutputArtifact.js';
import { parseBotDeliveryDiagnostic } from '../../shared/botDeliveryDiagnostic.js';

const ACTIVE_DELEGATION_STATUSES = ['queued', 'running', 'waiting'] as const;
const DEFAULT_MAX_DEPTH = 1;
const HARD_MAX_DEPTH = 5;
const DEFAULT_MAX_ACTIVE_CHILDREN = 10;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_OBJECTIVE_CHARS = 12_000;
const MAX_RESULT_CHARS = 12_000;
const MAX_RETRY_DELAY_MS = 60_000;
const messageRowid = sql<number>`"messages"."rowid"`;
const log = createLogger('bot-delegation');

function schedulePerTaskWorkspaceReclaim(sessionId: string): void {
  void import('./botWorkspaceRuntime.js')
    .then((module) => module.schedulePerTaskBotWorkspaceReclaim(sessionId))
    .catch(() => undefined);
}

type DelegationStatus = BotDelegationStatus;
type DelegationRow = typeof botDelegations.$inferSelect;
type ProjectBindingRow = typeof botProjectBindings.$inferSelect;
type AutomationRunRow = typeof botAutomationRuns.$inferSelect;

interface AutomationDelegationContext {
  run: AutomationRunRow;
  rootSessionId: string;
  plan: BotAutomationExecutionPlan;
}

type DispatchResult =
  | {
      ok: true;
      targetSessionId: string;
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
    }
  | { ok: false; errorCode: string; message: string };

export interface BotDelegationServiceDeps {
  dispatch: (params: {
    targetSessionId: string;
    message: string;
    persistedContent?: string;
    clientId?: string;
    onAccepted?: () => void | Promise<void>;
  }) => Promise<DispatchResult>;
  enqueueDelivery?: (params: {
    botId: string;
    channelId?: string | null;
    routeId?: string | null;
    sessionId: string | null;
    idempotencyKey: string;
    ownerGeneration?: number;
    payload: {
      version: 1;
      kind: 'session-message';
      targetSessionId: string;
      fallbackBotId: string;
      clientId: string;
      message: string;
      persistedContent: string;
    };
  }) => Promise<{ id: string }>;
  abortSession: (sessionId: string) => Promise<void>;
  archiveSession?: (sessionId: string) => Promise<void>;
  closeSession?: (sessionId: string) => Promise<void>;
  broadcastSessionCreated?: (sessionId: string) => void;
  persistTimelineMessage?: (params: {
    sessionId: string;
    clientId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt?: number;
  }) => Promise<void>;
  onChanged?: (payload: BotDelegationChangedPayload) => void;
  now?: () => number;
  createId?: () => string;
  maxActiveChildren?: number;
  /** Production requires the native runtime snapshot before accepting work. */
  requireRuntimeSnapshot?: boolean;
}

export function isBotRuntimeSnapshotForCapabilityTarget(input: {
  runtimeSessionId: string;
  runtimeWorkingDir: string;
  canonicalSessionId: string | null;
  automationWorkingDir?: string | null;
}): boolean {
  if (input.automationWorkingDir) {
    return input.runtimeWorkingDir === input.automationWorkingDir;
  }
  return Boolean(input.canonicalSessionId)
    && input.runtimeSessionId === input.canonicalSessionId;
}

export interface DelegateToBotInput {
  callerSessionId: string;
  targetBotId: string;
  objective: string;
  contextRefs?: string[];
  artifactRefs?: string[];
  budgetTokens?: number;
  maxDepth?: number;
  timeoutMs?: number;
}

export type BotDelegationResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; errorCode: string; message: string };

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function boundedStringList(value: string[] | undefined, max = 32): string[] {
  if (!value) return [];
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
    .slice(0, max)
    .map((item) => item.slice(0, 4_000));
}

function botAgentKind(config: Record<string, unknown>): 'cc' | 'codex' | 'pi' {
  return config.harness === 'codex' ? 'codex' : config.harness === 'pi' ? 'pi' : 'cc';
}

function targetPermissionMode(
  config: Record<string, unknown>,
  requesterPermissionMode: string | null | undefined,
): 'ask' | 'bypassPermissions' {
  return config.permissions === 'trusted' && requesterPermissionMode === 'bypassPermissions'
    ? 'bypassPermissions'
    : 'ask';
}

function readDeadline(permissionSnapshotJson: string): number | null {
  const plan = parseBotDelegationPlanSnapshot(permissionSnapshotJson);
  const deadlineAt = plan?.limits.deadlineAt ?? parseRecord(permissionSnapshotJson).deadlineAt;
  return typeof deadlineAt === 'number' && Number.isFinite(deadlineAt) ? deadlineAt : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function configStringList(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function unknownStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean),
      )]
    : [];
}

function configuredToolsets(config: Record<string, unknown>): string[] {
  const configured = configStringList(config, 'toolsets');
  if (configured.length > 0) return configured;
  return configStringList(config, 'tools').filter(
    (item) => !['files', 'browser', 'mcp'].includes(item),
  );
}

function configuredCapabilitySnapshot(input: {
  version: number;
  capabilitiesJson: string;
  identitySource: string;
}): BotDelegationCapabilitySnapshot {
  const config = parseRecord(input.capabilitiesJson);
  const skills = configStringList(config, 'skills');
  const mcpServers = configStringList(config, 'mcpServers');
  const toolsets = configuredToolsets(config);
  return {
    profileVersion: input.version,
    agentKind: botAgentKind(config),
    model:
      typeof config.model === 'string' && config.model.trim()
        ? config.model.trim()
        : 'claude-sonnet-4-6',
    capabilitiesSha256: sha256(input.capabilitiesJson),
    identitySha256: sha256(input.identitySource),
    skills,
    skillMode: configuredMode(config.skillMode, skills),
    mcpServers,
    mcpMode: configuredMode(config.mcpMode, mcpServers),
    toolsets,
    toolsetMode: configuredMode(config.toolsetMode, toolsets),
    memoryEnabled: config.memory !== false,
    automationEnabled: config.automation === true,
  };
}

function configuredMode(
  value: unknown,
  configured: string[],
): 'inherit' | 'allowlist' {
  if (value === 'allowlist' || value === 'inherit') return value;
  return configured.length > 0 ? 'allowlist' : 'inherit';
}

function parseAllowedPaths(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

function workspaceSnapshot(binding: ProjectBindingRow | undefined): BotDelegationWorkspaceSnapshot | null {
  if (!binding) return null;
  return {
    bindingId: binding.id,
    bindingUpdatedAt: binding.updatedAt,
    projectKey: binding.projectKey,
    workingDir: binding.workingDir,
    remoteHostId: binding.remoteHostId,
    defaultBranch: binding.defaultBranch,
    workspacePolicy: binding.workspacePolicy,
    allowedPaths: parseAllowedPaths(binding.allowedPathsJson),
  };
}

function bindingAllowsRelativePath(binding: ProjectBindingRow, relativeRef: string): boolean {
  const configured = parseAllowedPaths(binding.allowedPathsJson);
  if (configured.length === 0) return true;
  const pathApi = binding.remoteHostId ? path.posix : path;
  const root = pathApi.resolve(binding.workingDir);
  return configured.some((candidate) => {
    const allowedRelative = pathApi.relative(root, pathApi.resolve(candidate));
    if (
      allowedRelative === '..'
      || allowedRelative.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(allowedRelative)
    ) return false;
    if (!allowedRelative || allowedRelative === '.') return true;
    return relativeRef === allowedRelative || relativeRef.startsWith(`${allowedRelative}${pathApi.sep}`);
  });
}

function normalizeDelegationReferences(input: {
  refs: string[] | undefined;
  callerBinding: ProjectBindingRow | undefined;
  targetBinding: ProjectBindingRow | undefined;
  field: 'context_refs' | 'artifact_refs';
}): BotDelegationResult<{ refs: string[] }> {
  const refs = boundedStringList(input.refs);
  if (refs.length === 0) return { ok: true, refs: [] };
  if (!input.callerBinding || !input.targetBinding) {
    return {
      ok: false,
      errorCode: 'REFERENCE_SCOPE_REQUIRED',
      message: `${input.field} 只能引用调用方与目标 Bot 共同绑定的项目路径`,
    };
  }
  if (
    input.callerBinding.projectKey !== input.targetBinding.projectKey
    || input.callerBinding.remoteHostId !== input.targetBinding.remoteHostId
  ) {
    return {
      ok: false,
      errorCode: 'REFERENCE_SCOPE_MISMATCH',
      message: `${input.field} 不能跨 Bot 项目或远程主机传递`,
    };
  }
  const pathApi = input.targetBinding.remoteHostId ? path.posix : path;
  const normalized: string[] = [];
  for (const raw of refs) {
    if (raw.includes('\0') || raw.includes('\n') || raw.includes('\r') || pathApi.isAbsolute(raw)) {
      return {
        ok: false,
        errorCode: 'INVALID_REFERENCE',
        message: `${input.field} 只接受不含换行的项目相对路径`,
      };
    }
    const ref = pathApi.normalize(raw);
    if (
      !ref
      || ref === '.'
      || ref === '..'
      || ref.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(ref)
    ) {
      return {
        ok: false,
        errorCode: 'INVALID_REFERENCE',
        message: `${input.field} 包含越出项目范围的路径`,
      };
    }
    if (
      !bindingAllowsRelativePath(input.callerBinding, ref)
      || !bindingAllowsRelativePath(input.targetBinding, ref)
    ) {
      return {
        ok: false,
        errorCode: 'REFERENCE_NOT_ALLOWED',
        message: `${input.field} 包含未同时授权给调用方和目标 Bot 的路径`,
      };
    }
    normalized.push(ref);
  }
  return { ok: true, refs: [...new Set(normalized)] };
}

export function createBotDelegationService(deps: BotDelegationServiceDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const maxActiveChildren = Math.max(1, deps.maxActiveChildren ?? DEFAULT_MAX_ACTIVE_CHILDREN);
  const persistTimelineMessage = deps.persistTimelineMessage ?? (async (params) => {
    await createMessage(params.sessionId, {
      clientId: params.clientId,
      role: params.role,
      content: params.content,
      agentKind: null,
      createdAt: params.createdAt,
    });
  });

  const clearTimer = (delegationId: string): void => {
    const timer = timers.get(delegationId);
    if (timer) clearTimeout(timer);
    timers.delete(delegationId);
  };

  const clearRetryTimer = (delegationId: string): void => {
    const timer = retryTimers.get(delegationId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(delegationId);
  };

  const emitChanged = (payload: BotDelegationChangedPayload): void => {
    deps.onChanged?.(payload);
  };

  const isActiveDelegation = (status: DelegationStatus): boolean =>
    ACTIVE_DELEGATION_STATUSES.includes(
      status as (typeof ACTIVE_DELEGATION_STATUSES)[number],
    );

  const buildDelegationGraph = (rows: DelegationRow[]) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const byChildSessionId = new Map(
      rows.flatMap((row) => row.childSessionId ? [[row.childSessionId, row] as const] : []),
    );
    const childrenByParentSessionId = new Map<string, DelegationRow[]>();
    for (const row of rows) {
      if (!row.parentSessionId) continue;
      const children = childrenByParentSessionId.get(row.parentSessionId) ?? [];
      children.push(row);
      childrenByParentSessionId.set(row.parentSessionId, children);
    }
    return { byId, byChildSessionId, childrenByParentSessionId };
  };

  /**
   * Resolve the Automation run that owns a Bot task, including nested
   * delegation descendants. The execution plan is the authorization source;
   * current Bot settings never widen an already-running Automation.
   */
  const resolveAutomationContextForSession = async (
    sessionId: string,
  ): Promise<AutomationDelegationContext | null> => {
    const db = getDbClient().drizzle;
    const activeStatuses = ['claimed', 'running', 'completing'] as const;
    const readRun = async (rootSessionId: string) => {
      const [run] = await db
        .select()
        .from(botAutomationRuns)
        .where(
          and(
            eq(botAutomationRuns.sessionId, rootSessionId),
            inArray(botAutomationRuns.status, [...activeStatuses]),
          ),
        )
        .orderBy(desc(botAutomationRuns.createdAt))
        .limit(1);
      if (!run) return null;
      const plan = parseBotAutomationExecutionPlan(run.executionPlanJson);
      return plan ? { run, rootSessionId, plan } : null;
    };

    const direct = await readRun(sessionId);
    if (direct) return direct;

    const graph = buildDelegationGraph(await db.select().from(botDelegations));
    let currentSessionId = sessionId;
    const seen = new Set<string>();
    while (!seen.has(currentSessionId)) {
      seen.add(currentSessionId);
      const parent = graph.byChildSessionId.get(currentSessionId);
      if (!parent?.parentSessionId) return null;
      currentSessionId = parent.parentSessionId;
      const context = await readRun(currentSessionId);
      if (context) return context;
    }
    return null;
  };

  const validateAutomationTargetSnapshot = async (
    target: BotAutomationDelegateTargetSnapshot,
  ): Promise<{
    ok: true;
    profile: typeof botProfiles.$inferSelect;
    version: typeof botProfileVersions.$inferSelect;
    binding: ProjectBindingRow | undefined;
  } | {
    ok: false;
    reason: string;
  }> => {
    const db = getDbClient().drizzle;
    const [[profile], [version], [binding]] = await Promise.all([
      db
        .select()
        .from(botProfiles)
        .where(eq(botProfiles.id, target.botId))
        .limit(1),
      db
        .select()
        .from(botProfileVersions)
        .where(
          and(
            eq(botProfileVersions.botId, target.botId),
            eq(botProfileVersions.version, target.profileVersion),
          ),
        )
        .limit(1),
      db
        .select()
        .from(botProjectBindings)
        .where(
          and(
            eq(botProjectBindings.botId, target.botId),
            eq(botProjectBindings.status, 'active'),
            eq(botProjectBindings.isDefault, true),
          ),
        )
        .limit(1),
    ]);
    if (!profile || profile.status !== 'active') {
      return { ok: false, reason: '目标 Bot 已停用或归档' };
    }
    if (profile.currentVersion !== target.profileVersion) {
      return { ok: false, reason: '目标 Bot Profile 已在本轮 Automation 启动后更新' };
    }
    if (
      !version
      || sha256(version.capabilitiesJson) !== target.capabilitiesSha256
      || sha256(version.identitySource) !== target.identitySha256
    ) {
      return { ok: false, reason: '目标 Bot Profile 冻结内容已失效' };
    }
    const workspaceMatches = target.defaultWorkspace === null
      ? binding === undefined
      : !!binding
        && binding.id === target.defaultWorkspace.bindingId
        && binding.updatedAt === target.defaultWorkspace.bindingUpdatedAt
        && binding.projectKey === target.defaultWorkspace.projectKey
        && binding.remoteHostId === target.defaultWorkspace.remoteHostId
        && binding.workspacePolicy === target.defaultWorkspace.workspacePolicy;
    if (!workspaceMatches) {
      return { ok: false, reason: '目标 Bot 的默认项目或工作区授权已变更' };
    }
    return { ok: true, profile, version, binding };
  };

  const subtreeActualTokens = (
    root: DelegationRow,
    graph: ReturnType<typeof buildDelegationGraph>,
    seen = new Set<string>(),
  ): number => {
    if (seen.has(root.id)) return 0;
    seen.add(root.id);
    let total = Math.max(0, root.tokensUsed);
    if (!root.childSessionId) return total;
    for (const child of graph.childrenByParentSessionId.get(root.childSessionId) ?? []) {
      total += subtreeActualTokens(child, graph, seen);
    }
    return total;
  };

  const committedSubtreeTokens = (
    root: DelegationRow,
    graph: ReturnType<typeof buildDelegationGraph>,
  ): number => {
    let committed = subtreeActualTokens(root, graph);
    if (!root.childSessionId) return committed;
    for (const child of graph.childrenByParentSessionId.get(root.childSessionId) ?? []) {
      if (!isActiveDelegation(child.status) || child.budgetTokens === null) continue;
      committed += Math.max(0, child.budgetTokens - subtreeActualTokens(child, graph));
    }
    return committed;
  };

  const descendantRows = (
    root: DelegationRow,
    graph: ReturnType<typeof buildDelegationGraph>,
  ): DelegationRow[] => {
    const result: DelegationRow[] = [];
    const pending = root.childSessionId
      ? [...(graph.childrenByParentSessionId.get(root.childSessionId) ?? [])]
      : [];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const next = pending.shift()!;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      result.push(next);
      if (next.childSessionId) {
        pending.push(...(graph.childrenByParentSessionId.get(next.childSessionId) ?? []));
      }
    }
    return result;
  };

  const ensureTargetCanonicalSession = async (target: {
    id: string;
    currentVersion: number;
    canonicalSessionId: string | null;
  }): Promise<BotDelegationResult<{ sessionId: string }>> => {
    const db = getDbClient().drizzle;
    let expectedCanonicalSessionId = target.canonicalSessionId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (expectedCanonicalSessionId) {
        const [current] = await db
          .select({
            status: sessions.status,
            source: sessions.source,
            botId: botSessionLinks.botId,
            role: botSessionLinks.role,
          })
          .from(sessions)
          .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
          .where(eq(sessions.id, expectedCanonicalSessionId))
          .limit(1);
        if (
          current?.status === 'active'
          && current.source === 'bot'
          && current.botId === target.id
          && current.role === 'canonical'
        ) {
          return { ok: true, sessionId: expectedCanonicalSessionId };
        }
        const replacement = await createBotCanonicalSession({
          botId: target.id,
          expectedCanonicalSessionId,
          expectedProfileVersion: target.currentVersion,
          recoverMissingOnly: current === undefined,
        });
        if (replacement.created) deps.broadcastSessionCreated?.(replacement.canonicalSessionId);
        expectedCanonicalSessionId = replacement.canonicalSessionId;
        continue;
      }
      const created = await createBotCanonicalSession({
        botId: target.id,
        expectedCanonicalSessionId: null,
        expectedProfileVersion: target.currentVersion,
      });
      if (created.created) deps.broadcastSessionCreated?.(created.canonicalSessionId);
      expectedCanonicalSessionId = created.canonicalSessionId;
    }
    return {
      ok: false,
      errorCode: 'TARGET_CANONICAL_UNAVAILABLE',
      message: '目标 Bot 的主任务正在变化，请稍后重试委派',
    };
  };

  const requesterDisplayName = async (botId: string): Promise<string> => {
    const db = getDbClient().drizzle;
    const [profile] = await db
      .select({ displayName: botProfiles.displayName })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    return profile?.displayName || botId;
  };

  const projectTargetRequest = async (row: Pick<DelegationRow,
    'id' | 'requestingBotId' | 'objective' | 'permissionSnapshotJson' | 'createdAt'
  >): Promise<void> => {
    const plan = parseBotDelegationPlanSnapshot(row.permissionSnapshotJson);
    if (!plan?.targetCanonicalSessionId) return;
    const requesterName = await requesterDisplayName(row.requestingBotId);
    await persistTimelineMessage({
      sessionId: plan.targetCanonicalSessionId,
      clientId: `bot-delegation-target-request:${row.id}`,
      role: 'user',
      content: [
        `[来自 ${requesterName} 的 Bot 委派]`,
        row.objective,
        `委派记录：${row.id}`,
      ].join('\n\n'),
      createdAt: row.createdAt,
    });
  };

  const projectTargetResult = async (row: Pick<DelegationRow,
    | 'id'
    | 'requestingBotId'
    | 'objective'
    | 'childSessionId'
    | 'status'
    | 'resultSummary'
    | 'lastError'
    | 'permissionSnapshotJson'
    | 'completedAt'
  >): Promise<void> => {
    const plan = parseBotDelegationPlanSnapshot(row.permissionSnapshotJson);
    if (!plan?.targetCanonicalSessionId || isActiveDelegation(row.status)) return;
    const requesterName = await requesterDisplayName(row.requestingBotId);
    const statusLabel = row.status === 'completed'
      ? '已完成'
      : row.status === 'cancelled'
        ? '已取消'
        : row.status === 'timed-out'
          ? '已超时'
          : '失败';
    await persistTimelineMessage({
      sessionId: plan.targetCanonicalSessionId,
      clientId: `bot-delegation-target-result:${row.id}`,
      role: 'assistant',
      content: [
        `[Bot 委派${statusLabel}]`,
        `来源：${requesterName}`,
        `任务：${row.objective}`,
        row.resultSummary ? `结果：\n${row.resultSummary}` : '',
        row.lastError ? `错误：${row.lastError}` : '',
        row.childSessionId ? `完整执行任务：${row.childSessionId}` : '',
      ].filter(Boolean).join('\n\n'),
      createdAt: row.completedAt ?? undefined,
    });
  };

  const deliverCompletion = async (params: {
    id: string;
    requestingBotId: string;
    targetBotId: string;
    parentSessionId: string | null;
    childSessionId: string | null;
    objective: string;
    status: Extract<DelegationStatus, 'completed' | 'failed' | 'cancelled' | 'timed-out'>;
    resultSummary?: string | null;
    lastError?: string | null;
    permissionSnapshotJson: string;
  }): Promise<void> => {
    if (!params.parentSessionId) return;
    const db = getDbClient().drizzle;
    const [parent] = await db
      .select({
        status: sessions.status,
        role: botSessionLinks.role,
        botId: botSessionLinks.botId,
        routeKey: botSessionLinks.routeKey,
      })
      .from(sessions)
      .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
      .where(eq(sessions.id, params.parentSessionId))
      .limit(1);
    // Renew/archive owns the parent lifecycle. Completion must never resurrect
    // or enqueue durable work against a task that is no longer active.
    if (
      parent?.status !== 'active'
      || parent.botId !== params.requestingBotId
      || (parent.role !== 'canonical' && parent.role !== 'route')
    ) return;
    const plan = parseBotDelegationPlanSnapshot(params.permissionSnapshotJson);
    const frozenTarget = plan?.completionTarget;
    if (frozenTarget && frozenTarget.parentSessionId !== params.parentSessionId) return;
    // Legacy canonical and delegation-child parents are still safe because
    // they target an exact task. A legacy IM Route lacks an ownership
    // generation and must not be redirected through the Route's current owner.
    if (
      !frozenTarget
      && parent.role === 'route'
      && !parent.routeKey?.startsWith('delegation:')
    ) return;
    const completionMessage = [
      `[Cindy Bot delegation ${params.id} ${params.status}]`,
      `Target Bot: ${params.targetBotId}`,
      `Objective: ${params.objective}`,
      params.resultSummary ? `Result:\n${params.resultSummary}` : '',
      params.lastError ? `Error: ${params.lastError}` : '',
      params.childSessionId ? `Child task: ${params.childSessionId}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const completionClientId = `bot-delegation-completion:${params.id}`;
    if (deps.enqueueDelivery) {
      await deps.enqueueDelivery({
        botId: params.requestingBotId,
        channelId: frozenTarget?.channelId ?? null,
        routeId: frozenTarget?.routeId ?? null,
        sessionId: params.parentSessionId,
        idempotencyKey: completionClientId,
        ownerGeneration: frozenTarget?.ownerGeneration ?? 0,
        payload: {
          version: 1,
          kind: 'session-message',
          targetSessionId: params.parentSessionId,
          fallbackBotId: params.requestingBotId,
          clientId: completionClientId,
          message: completionMessage,
          persistedContent: completionMessage,
        },
      });
      return;
    }
    await deps.dispatch({
      targetSessionId: params.parentSessionId,
      message: completionMessage,
      persistedContent: completionMessage,
      clientId: completionClientId,
    });
  };

  const updateTerminal = async (params: {
    delegationId: string;
    status: Extract<DelegationStatus, 'completed' | 'failed' | 'cancelled' | 'timed-out'>;
    resultSummary?: string | null;
    outputArtifactsJson?: string;
    lastError?: string | null;
    tokensUsed?: number;
    abortChild?: boolean;
  }): Promise<{
    id: string;
    parentSessionId: string | null;
    childSessionId: string | null;
    status: DelegationStatus;
  } | null> => {
    const db = getDbClient().drizzle;
    const at = now();
    const updated = await getDbClient().tx<BotsFinishDelegationResult | null>(
      'bots.finishDelegation',
      {
        delegationId: params.delegationId,
        status: params.status,
        resultSummary: params.resultSummary?.slice(0, MAX_RESULT_CHARS) ?? null,
        outputArtifactsJson: params.outputArtifactsJson ?? '[]',
        lastError: params.lastError?.slice(0, 4_000) ?? null,
        ...(typeof params.tokensUsed === 'number' ? { tokensUsed: params.tokensUsed } : {}),
        completedAt: at,
      },
    );
    if (updated) {
      clearTimer(params.delegationId);
      clearRetryTimer(params.delegationId);
      emitChanged({
        delegationId: updated.id,
        parentSessionId: updated.parentSessionId,
        childSessionId: updated.childSessionId,
        status: updated.status as DelegationStatus,
      });
      if (updated.childSessionId) {
        if (params.abortChild) {
          await deps.abortSession(updated.childSessionId).catch(() => undefined);
        }
        await (deps.archiveSession?.(updated.childSessionId) ?? db
          .update(sessions)
          .set({ status: 'archived', updatedAt: at })
          .where(eq(sessions.id, updated.childSessionId))
          .then(() => undefined))
          .catch(() => undefined);
        await deps.closeSession?.(updated.childSessionId).catch(() => undefined);
        schedulePerTaskWorkspaceReclaim(updated.childSessionId);
      }
      const [terminalRow] = await db
        .select()
        .from(botDelegations)
        .where(eq(botDelegations.id, updated.id))
        .limit(1);
      if (terminalRow) {
        await projectTargetResult(terminalRow).catch((error) => {
          log.warn('failed to project Bot delegation result into target canonical task', {
            delegationId: terminalRow.id,
            targetBotId: terminalRow.targetBotId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
    return updated;
  };

  const failBudgetSubtree = async (
    root: DelegationRow,
    graph: ReturnType<typeof buildDelegationGraph>,
    lastError: string,
  ): Promise<boolean> => {
    const affected = [root, ...descendantRows(root, graph)]
      .filter((row) => isActiveDelegation(row.status))
      .sort((a, b) => b.depth - a.depth);
    let rootChanged = false;
    for (const row of affected) {
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'failed',
        lastError,
        tokensUsed: row.tokensUsed,
        abortChild: true,
      });
      rootChanged ||= row.id === root.id && changed !== null;
    }
    if (rootChanged) {
      await deliverCompletion({
        ...root,
        status: 'failed',
        resultSummary: root.resultSummary,
        lastError,
      });
    }
    return rootChanged;
  };

  const readLatestAssistantText = async (sessionId: string): Promise<string | null> => {
    const db = getDbClient().drizzle;
    const [latest] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.role, 'assistant'),
          isNull(messages.rewindAt),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(1);
    const text = visibleMessageTextForConversationSearch('assistant', latest?.content ?? '').trim();
    return text || null;
  };

  const timeoutDelegation = async (delegationId: string): Promise<void> => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.id, delegationId))
      .limit(1);
    if (!row) return;
    const lastError = 'Bot delegation exceeded its configured timeout.';
    const changed = await updateTerminal({
      delegationId,
      status: 'timed-out',
      lastError,
      abortChild: true,
    });
    if (changed) {
      await deliverCompletion({
        ...row,
        status: 'timed-out',
        resultSummary: row.resultSummary,
        lastError,
      });
    }
  };

  const scheduleTimeout = (delegationId: string, deadlineAt: number): void => {
    clearTimer(delegationId);
    const delay = deadlineAt - now();
    if (delay <= 0) {
      void timeoutDelegation(delegationId);
      return;
    }
    const timer = setTimeout(() => void timeoutDelegation(delegationId), delay);
    timer.unref?.();
    timers.set(delegationId, timer);
  };

  const resolveCaller = async (callerSessionId: string) => {
    const db = getDbClient().drizzle;
    const [link] = await db
      .select({
        botId: botSessionLinks.botId,
        role: botSessionLinks.role,
        profileVersion: botSessionLinks.profileVersion,
        sessionStatus: sessions.status,
        permissionMode: sessions.permissionMode,
        workingDir: sessions.workingDir,
        remoteHostId: sessions.remoteHostId,
      })
      .from(botSessionLinks)
      .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(eq(botSessionLinks.sessionId, callerSessionId))
      .limit(1);
    if (
      !link
      || link.sessionStatus !== 'active'
      || (link.role !== 'canonical' && link.role !== 'route')
    ) return null;
    return link;
  };

  const resolveSessionProjectBinding = async (
    sessionId: string,
    botId: string,
  ): Promise<ProjectBindingRow | undefined> => {
    const db = getDbClient().drizzle;
    const [attached] = await db
      .select({ binding: botProjectBindings })
      .from(botWorkspaceAttachments)
      .innerJoin(botWorkspaceLeases, eq(botWorkspaceLeases.id, botWorkspaceAttachments.leaseId))
      .innerJoin(
        botProjectBindings,
        eq(botProjectBindings.id, botWorkspaceLeases.projectBindingId),
      )
      .where(
        and(
          eq(botWorkspaceAttachments.sessionId, sessionId),
          isNull(botWorkspaceAttachments.detachedAt),
          eq(botProjectBindings.botId, botId),
          eq(botProjectBindings.status, 'active'),
        ),
      )
      .limit(1);
    if (attached?.binding) return attached.binding;

    const [routed] = await db
      .select({ binding: botProjectBindings })
      .from(botRoutes)
      .innerJoin(botProjectBindings, eq(botProjectBindings.id, botRoutes.projectBindingId))
      .where(
        and(
          eq(botRoutes.currentSessionId, sessionId),
          eq(botRoutes.botId, botId),
          eq(botProjectBindings.status, 'active'),
        ),
      )
      .limit(1);
    if (routed?.binding) return routed.binding;

    const [fallback] = await db
      .select()
      .from(botProjectBindings)
      .where(
        and(
          eq(botProjectBindings.botId, botId),
          eq(botProjectBindings.status, 'active'),
          eq(botProjectBindings.isDefault, true),
        ),
      )
      .limit(1);
    return fallback;
  };

  const buildDelegationPrompt = (row: {
    id: string;
    requestingBotId: string;
    objective: string;
    contextRefsJson: string;
    artifactRefsJson: string;
  }): string => [
    `You are receiving a task delegated by Cindy Bot ${row.requestingBotId}.`,
    `Delegation ID: ${row.id}`,
    `Objective:\n${row.objective}`,
    parseStringArray(row.contextRefsJson).length
      ? `Context references:\n${parseStringArray(row.contextRefsJson).join('\n')}`
      : '',
    parseStringArray(row.artifactRefsJson).length
      ? `Artifacts:\n${parseStringArray(row.artifactRefsJson).join('\n')}`
      : '',
    'Work independently using your own Bot profile. Return a concise result and artifact references to the requesting Bot.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const validateDispatchPlan = async (
    row: DelegationRow,
  ): Promise<BotDelegationResult<{ plan: BotDelegationPlanSnapshot }>> => {
    const plan = parseBotDelegationPlanSnapshot(row.permissionSnapshotJson);
    if (!plan || plan.targetBotId !== row.targetBotId) {
      return {
        ok: false,
        errorCode: 'PLAN_SNAPSHOT_INVALID',
        message: 'Bot delegation 缺少有效的冻结执行计划',
      };
    }
    if (!row.childSessionId) {
      return { ok: false, errorCode: 'CHILD_SESSION_MISSING', message: 'Bot delegation 子任务不存在' };
    }
    const db = getDbClient().drizzle;
    const [[parent], [child], [profile], [version]] = await Promise.all([
      row.parentSessionId
        ? db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, row.parentSessionId)).limit(1)
        : Promise.resolve([]),
      db
        .select({
          status: sessions.status,
          source: sessions.source,
          botId: botSessionLinks.botId,
          role: botSessionLinks.role,
          profileVersion: botSessionLinks.profileVersion,
        })
        .from(sessions)
        .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .where(eq(sessions.id, row.childSessionId))
        .limit(1),
      db
        .select({ status: botProfiles.status })
        .from(botProfiles)
        .where(eq(botProfiles.id, row.targetBotId))
        .limit(1),
      db
        .select({
          capabilitiesJson: botProfileVersions.capabilitiesJson,
          identitySource: botProfileVersions.identitySource,
        })
        .from(botProfileVersions)
        .where(
          and(
            eq(botProfileVersions.botId, row.targetBotId),
            eq(botProfileVersions.version, row.targetProfileVersion),
          ),
        )
        .limit(1),
    ]);
    if (row.parentSessionId && parent?.status !== 'active') {
      return { ok: false, errorCode: 'PARENT_SESSION_INACTIVE', message: '委派来源任务已归档或删除' };
    }
    if (
      !child
      || child.status !== 'active'
      || child.source !== 'bot'
      || child.botId !== row.targetBotId
      || child.role !== 'route'
      || child.profileVersion !== row.targetProfileVersion
    ) {
      return { ok: false, errorCode: 'CHILD_SESSION_INVALID', message: 'Bot delegation 子任务归属已失效' };
    }
    if (profile?.status !== 'active') {
      return { ok: false, errorCode: 'TARGET_BOT_UNAVAILABLE', message: '目标 Bot 已暂停或归档' };
    }
    if (
      !version
      || sha256(version.capabilitiesJson) !== plan.target.capabilitiesSha256
      || sha256(version.identitySource) !== plan.target.identitySha256
    ) {
      return { ok: false, errorCode: 'PROFILE_SNAPSHOT_STALE', message: '目标 Bot 的冻结 Profile 已失效' };
    }
    if (plan.workspace) {
      const [binding] = await db
        .select()
        .from(botProjectBindings)
        .where(eq(botProjectBindings.id, plan.workspace.bindingId))
        .limit(1);
      if (
        !binding
        || binding.botId !== row.targetBotId
        || binding.status !== 'active'
        || binding.updatedAt !== plan.workspace.bindingUpdatedAt
        || binding.projectKey !== plan.workspace.projectKey
      ) {
        return {
          ok: false,
          errorCode: 'WORKSPACE_SNAPSHOT_STALE',
          message: '目标 Bot 的项目或路径授权在排队期间发生变化',
        };
      }
    }
    return { ok: true, plan };
  };

  const runtimeSnapshotUnavailable = async (
    childSessionId: string,
    plan: BotDelegationPlanSnapshot,
  ): Promise<string | null> => {
    const db = getDbClient().drizzle;
    const [runtime] = await db
      .select()
      .from(botRuntimeSnapshots)
      .where(eq(botRuntimeSnapshots.sessionId, childSessionId))
      .orderBy(desc(botRuntimeSnapshots.preparedAt))
      .limit(1);
    if (!runtime) {
      return deps.requireRuntimeSnapshot
        ? '目标 Bot runtime 未按冻结 Profile 准备完成'
        : null;
    }
    if (runtime.profileVersion !== plan.target.profileVersion) {
      return '目标 Bot runtime 未按冻结 Profile 准备完成';
    }
    if (runtime.status === 'failed') return '目标 Bot runtime 启动失败';
    const resolved = parseRecord(runtime.resolvedJson);
    const unavailable = [
      ...parseStringArray(JSON.stringify(resolved.unavailableSkills ?? [])),
      ...parseStringArray(JSON.stringify(resolved.unavailableMcpServers ?? [])),
      ...parseStringArray(JSON.stringify(resolved.unavailableToolsets ?? [])),
    ];
    const memoryRefs = Array.isArray(resolved.memoryRefs) ? resolved.memoryRefs : [];
    const memoryUnavailable = memoryRefs.some(
      (ref) => ref && typeof ref === 'object' && (ref as Record<string, unknown>).status === 'unavailable',
    );
    if (unavailable.length > 0 || memoryUnavailable) {
      return `目标 Bot 缺少冻结能力: ${unavailable.join(', ') || 'memory'}`;
    }
    return null;
  };

  function scheduleDispatchRetry(delegationId: string, attempt: number): void {
    clearRetryTimer(delegationId);
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 6));
    const timer = setTimeout(() => {
      retryTimers.delete(delegationId);
      void attemptDispatch(delegationId, attempt + 1);
    }, delay);
    timer.unref?.();
    retryTimers.set(delegationId, timer);
  }

  async function attemptDispatch(
    delegationId: string,
    attempt = 0,
  ): Promise<{ ok: boolean; status: 'queued' | 'waiting' | 'running'; error?: DispatchResult }> {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.id, delegationId))
      .limit(1);
    if (
      !row
      || !row.childSessionId
      || (row.status !== 'queued' && row.status !== 'waiting')
    ) {
      return { ok: true, status: row?.status === 'running' ? 'running' : 'queued' };
    }
    const deadlineAt = readDeadline(row.permissionSnapshotJson);
    if (deadlineAt !== null && deadlineAt <= now()) {
      await timeoutDelegation(delegationId);
      return { ok: false, status: 'waiting' };
    }
    const validation = await validateDispatchPlan(row);
    if (!validation.ok) {
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'failed',
        lastError: `${validation.errorCode}: ${validation.message}`,
        abortChild: true,
      });
      if (changed) {
        await deliverCompletion({
          ...row,
          status: 'failed',
          lastError: `${validation.errorCode}: ${validation.message}`,
        });
      }
      return { ok: false, status: 'waiting' };
    }
    const dispatched = await deps.dispatch({
      targetSessionId: row.childSessionId,
      message: buildDelegationPrompt(row),
      persistedContent: row.objective,
      clientId: `bot-delegation-start:${row.id}`,
      onAccepted: async () => {
        const unavailable = await runtimeSnapshotUnavailable(row.childSessionId!, validation.plan);
        if (unavailable) {
          const changed = await updateTerminal({
            delegationId: row.id,
            status: 'failed',
            lastError: `TARGET_CAPABILITY_UNAVAILABLE: ${unavailable}`,
            abortChild: true,
          });
          if (changed) {
            await deliverCompletion({
              ...row,
              status: 'failed',
              lastError: `TARGET_CAPABILITY_UNAVAILABLE: ${unavailable}`,
            });
          }
          return;
        }
        const acceptedAt = now();
        const [accepted] = await db
          .update(botDelegations)
          .set({ status: 'running', acceptedAt, lastError: null, updatedAt: acceptedAt })
          .where(
            and(
              eq(botDelegations.id, row.id),
              inArray(botDelegations.status, ['queued', 'waiting']),
            ),
          )
          .returning({
            id: botDelegations.id,
            parentSessionId: botDelegations.parentSessionId,
            childSessionId: botDelegations.childSessionId,
            status: botDelegations.status,
          });
        if (accepted) {
          clearRetryTimer(accepted.id);
          emitChanged({
            delegationId: accepted.id,
            parentSessionId: accepted.parentSessionId,
            childSessionId: accepted.childSessionId,
            status: accepted.status as DelegationStatus,
          });
        }
      },
    });
    if (dispatched.ok) {
      const [current] = await db
        .select({ status: botDelegations.status })
        .from(botDelegations)
        .where(eq(botDelegations.id, row.id))
        .limit(1);
      return {
        ok: true,
        status: current?.status === 'running'
          ? 'running'
          : current?.status === 'waiting'
            ? 'waiting'
            : 'queued',
      };
    }
    const failedAt = now();
    const [waiting] = await db
      .update(botDelegations)
      .set({
        status: 'waiting',
        lastError: `${dispatched.errorCode}: ${dispatched.message}`.slice(0, 4_000),
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(botDelegations.id, row.id),
          inArray(botDelegations.status, ['queued', 'waiting']),
        ),
      )
      .returning({
        id: botDelegations.id,
        parentSessionId: botDelegations.parentSessionId,
        childSessionId: botDelegations.childSessionId,
        status: botDelegations.status,
      });
    if (waiting) {
      emitChanged({
        delegationId: waiting.id,
        parentSessionId: waiting.parentSessionId,
        childSessionId: waiting.childSessionId,
        status: 'waiting',
      });
      scheduleDispatchRetry(waiting.id, attempt);
    }
    return { ok: false, status: 'waiting', error: dispatched };
  }

  async function resumeRunningDelegation(delegationId: string, attempt = 0): Promise<void> {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.id, delegationId))
      .limit(1);
    if (!row || row.status !== 'running') return;
    const deadlineAt = readDeadline(row.permissionSnapshotJson);
    if (deadlineAt !== null && deadlineAt <= now()) {
      await timeoutDelegation(row.id);
      return;
    }
    if (!row.childSessionId) {
      const lastError = 'Bot delegation child task is missing after restart.';
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'failed',
        lastError,
      });
      if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
      return;
    }
    const [child] = await db
      .select({
        status: sessions.status,
        activeTurnStartedAt: sessions.activeTurnStartedAt,
        lastTurnEndedAt: sessions.lastTurnEndedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, row.childSessionId))
      .limit(1);
    if (!child || child.status !== 'active') {
      const lastError = `Bot delegation child task is ${child?.status ?? 'missing'} after restart.`;
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'failed',
        lastError,
      });
      if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
      return;
    }

    if (
      child.activeTurnStartedAt !== null
      && child.lastTurnEndedAt !== null
      && child.lastTurnEndedAt >= child.activeTurnStartedAt
    ) {
      const resultText = await readLatestAssistantText(row.childSessionId);
      if (resultText) {
        await settleSession({
          childSessionId: row.childSessionId,
          outcome: 'done',
          resultText,
        });
      } else {
        const lastError = 'Bot delegation ended before restart without a recoverable result.';
        const changed = await updateTerminal({
          delegationId: row.id,
          status: 'failed',
          lastError,
        });
        if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
      }
      return;
    }

    const validation = await validateDispatchPlan(row);
    if (!validation.ok) {
      const lastError = `${validation.errorCode}: ${validation.message}`;
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'failed',
        lastError,
        abortChild: true,
      });
      if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
      return;
    }

    const resumeEpoch = child.activeTurnStartedAt ?? row.acceptedAt ?? row.createdAt;
    const clientId = `bot-delegation-resume:${row.id}:${resumeEpoch}`;
    const message = [
      'The previous delegated turn was interrupted by a Cindy host restart.',
      'Inspect the existing task history, continue the original objective, and return the final result.',
      `Delegation ID: ${row.id}`,
      `Objective:\n${row.objective}`,
    ].join('\n\n');
    const dispatched = await deps.dispatch({
      targetSessionId: row.childSessionId,
      message,
      persistedContent: row.objective,
      clientId,
    });
    if (dispatched.ok) {
      clearRetryTimer(row.id);
      await db
        .update(botDelegations)
        .set({ lastError: null, updatedAt: now() })
        .where(and(eq(botDelegations.id, row.id), eq(botDelegations.status, 'running')));
      return;
    }
    await db
      .update(botDelegations)
      .set({
        lastError: `${dispatched.errorCode}: ${dispatched.message}`.slice(0, 4_000),
        updatedAt: now(),
      })
      .where(and(eq(botDelegations.id, row.id), eq(botDelegations.status, 'running')));
    clearRetryTimer(row.id);
    const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 6));
    const timer = setTimeout(() => {
      retryTimers.delete(row.id);
      void resumeRunningDelegation(row.id, attempt + 1);
    }, delay);
    timer.unref?.();
    retryTimers.set(row.id, timer);
  }

  const listBots = async (
    callerSessionId: string,
  ): Promise<BotDelegationResult<{ bots: BotCapabilityCatalogEntry[] }>> => {
    const caller = await resolveCaller(callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于 Cindy Bot' };
    }
    const db = getDbClient().drizzle;
    const automationContext = await resolveAutomationContextForSession(callerSessionId);
    const automationTargets = automationContext?.plan.delegation.targets ?? [];
    if (automationContext && automationTargets.length === 0) {
      return { ok: true, bots: [] };
    }
    const automationTargetByBot = new Map(
      automationTargets.map((target) => [target.botId, target]),
    );
    const rows = await db
      .select({
        id: botProfiles.id,
        name: botProfiles.displayName,
        description: botProfiles.description,
        currentVersion: botProfiles.currentVersion,
        canonicalSessionId: botProfiles.canonicalSessionId,
        status: botProfiles.status,
      })
      .from(botProfiles)
      .where(
        automationContext
          ? inArray(botProfiles.id, automationTargets.map((target) => target.botId))
          : eq(botProfiles.status, 'active'),
      )
      .orderBy(desc(botProfiles.updatedAt));
    if (rows.length === 0) return { ok: true, bots: [] };

    const botIds = rows.map((row) => row.id);
    const [versions, runtimes, bindings, delegations, automations] = await Promise.all([
      db
        .select({
          botId: botProfileVersions.botId,
          version: botProfileVersions.version,
          capabilitiesJson: botProfileVersions.capabilitiesJson,
          identitySource: botProfileVersions.identitySource,
        })
        .from(botProfileVersions)
        .where(inArray(botProfileVersions.botId, botIds)),
      db
        .select()
        .from(botRuntimeSnapshots)
        .where(inArray(botRuntimeSnapshots.botId, botIds))
        .orderBy(desc(botRuntimeSnapshots.preparedAt)),
      db
        .select()
        .from(botProjectBindings)
        .where(
          and(
            inArray(botProjectBindings.botId, botIds),
            eq(botProjectBindings.status, 'active'),
          ),
        ),
      db
        .select({
          requestingBotId: botDelegations.requestingBotId,
          targetBotId: botDelegations.targetBotId,
        })
        .from(botDelegations)
        .where(inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES])),
      db
        .select({ botId: botAutomationLinks.botId })
        .from(botAutomationLinks)
        .where(
          and(
            inArray(botAutomationLinks.botId, botIds),
            eq(botAutomationLinks.status, 'active'),
          ),
        ),
    ]);

    const versionByBot = new Map(
      versions
        .filter((version) => rows.some(
          (row) => row.id === version.botId
            && version.version === (
              automationTargetByBot.get(row.id)?.profileVersion ?? row.currentVersion
            ),
        ))
        .map((version) => [version.botId, version]),
    );
    const runtimeByBot = new Map<string, (typeof runtimes)[number]>();
    for (const runtime of runtimes) {
      const profile = rows.find((row) => row.id === runtime.botId);
      const automationWorkspace = profile
        ? automationTargetByBot.get(profile.id)?.defaultWorkspace
        : null;
      if (
        profile
        && runtime.profileVersion === (
          automationTargetByBot.get(profile.id)?.profileVersion ?? profile.currentVersion
        )
        && isBotRuntimeSnapshotForCapabilityTarget({
          runtimeSessionId: runtime.sessionId,
          runtimeWorkingDir: runtime.workingDir,
          canonicalSessionId: profile.canonicalSessionId,
          automationWorkingDir: automationWorkspace?.workingDir,
        })
        && !runtimeByBot.has(runtime.botId)
      ) {
        runtimeByBot.set(runtime.botId, runtime);
      }
    }
    const projectsByBot = new Map<string, typeof bindings>();
    for (const binding of bindings) {
      const items = projectsByBot.get(binding.botId) ?? [];
      items.push(binding);
      projectsByBot.set(binding.botId, items);
    }
    const inboundCounts = new Map<string, number>();
    const outboundCounts = new Map<string, number>();
    for (const delegation of delegations) {
      inboundCounts.set(
        delegation.targetBotId,
        (inboundCounts.get(delegation.targetBotId) ?? 0) + 1,
      );
      outboundCounts.set(
        delegation.requestingBotId,
        (outboundCounts.get(delegation.requestingBotId) ?? 0) + 1,
      );
    }
    const automationCounts = new Map<string, number>();
    for (const automation of automations) {
      automationCounts.set(automation.botId, (automationCounts.get(automation.botId) ?? 0) + 1);
    }

    const automationAuthorizationByBot = new Map<string, {
      state: 'allowed' | 'stale';
      reason: string | null;
    }>();
    if (automationContext) {
      await Promise.all(automationTargets.map(async (target) => {
        const validation = await validateAutomationTargetSnapshot(target);
        automationAuthorizationByBot.set(
          target.botId,
          validation.ok
            ? { state: 'allowed', reason: null }
            : { state: 'stale', reason: validation.reason },
        );
      }));
    }

    const bots: BotCapabilityCatalogEntry[] = rows.flatMap((row) => {
      const version = versionByBot.get(row.id);
      if (!version) return [];
      const configured = configuredCapabilitySnapshot(version);
      const runtime = runtimeByBot.get(row.id);
      const resolved = runtime ? parseRecord(runtime.resolvedJson) : {};
      const failure = runtime ? parseRecord(runtime.failureJson) : {};
      const unavailableMemoryRefs = Array.isArray(resolved.memoryRefs)
        ? resolved.memoryRefs.flatMap((value) => {
            if (!value || typeof value !== 'object') return [];
            const ref = value as Record<string, unknown>;
            return ref.status === 'unavailable' && typeof ref.kind === 'string' ? [ref.kind] : [];
          })
        : [];
      const runtimeStatus = runtime?.status === 'applied'
        ? 'ready'
        : runtime?.status === 'degraded'
          ? 'degraded'
          : runtime?.status === 'failed'
            ? 'failed'
            : 'unverified';
      const runtimeReason = runtimeStatus === 'degraded'
        ? 'Some configured capabilities are unavailable in the current runtime'
        : runtimeStatus === 'failed'
          ? [failure.stage, failure.errorCode ?? failure.errorName]
              .filter((value): value is string => typeof value === 'string' && value.length > 0)
              .join(': ') || 'The current Profile failed to start'
          : runtimeStatus === 'unverified'
            ? runtime
              ? 'The current Profile runtime was prepared but has not completed startup'
              : 'The current Profile has not produced a native runtime snapshot yet'
            : null;
      const activeInboundDelegations = inboundCounts.get(row.id) ?? 0;
      const activeOutboundDelegations = outboundCounts.get(row.id) ?? 0;
      const activeAutomations = automationCounts.get(row.id) ?? 0;
      const resolvedSkills = unknownStringList(resolved.skills);
      const resolvedMcpServers = unknownStringList(resolved.mcpServers);
      const resolvedToolsets = unknownStringList(resolved.toolsets);
      const capabilityTags = [
        `harness:${configured.agentKind}`,
        `model:${configured.model}`,
        ...resolvedSkills.map((item) => `skill:${item}`),
        ...resolvedMcpServers.map((item) => `mcp:${item}`),
        ...resolvedToolsets.map((item) => `toolset:${item}`),
        ...(configured.memoryEnabled && unavailableMemoryRefs.length === 0 ? ['memory'] : []),
        ...(configured.automationEnabled ? ['automation'] : []),
        ...(
          automationTargetByBot.get(row.id)?.defaultWorkspace
            ? [`workspace:${automationTargetByBot.get(row.id)!.defaultWorkspace!.workspacePolicy}`]
            : (projectsByBot.get(row.id) ?? []).map(
                (binding) => `workspace:${binding.workspacePolicy}`,
              )
        ),
      ];
      const frozenWorkspace = automationTargetByBot.get(row.id)?.defaultWorkspace;
      return [{
        id: row.id,
        name: row.name,
        description: row.description,
        currentVersion: row.currentVersion,
        canonicalSessionId: row.canonicalSessionId,
        isCurrent: row.id === caller.botId,
        configured,
        runtime: {
          status: runtimeStatus,
          snapshotId: runtime?.id ?? null,
          sessionId: runtime?.sessionId ?? null,
          preparedAt: runtime?.preparedAt ?? null,
          reason: runtimeReason,
          resolvedSkills,
          unavailableSkills: unknownStringList(resolved.unavailableSkills),
          resolvedMcpServers,
          unavailableMcpServers: unknownStringList(resolved.unavailableMcpServers),
          resolvedToolsets,
          unavailableToolsets: unknownStringList(resolved.unavailableToolsets),
          unavailableMemoryRefs,
        },
        projects: automationContext
          ? frozenWorkspace
            ? [{ ...frozenWorkspace, isDefault: true }]
            : []
          : (projectsByBot.get(row.id) ?? []).map((binding) => ({
              bindingId: binding.id,
              projectKey: binding.projectKey,
              workingDir: binding.workingDir,
              remoteHostId: binding.remoteHostId,
              defaultBranch: binding.defaultBranch,
              workspacePolicy: binding.workspacePolicy,
              allowedPaths: parseAllowedPaths(binding.allowedPathsJson),
              isDefault: binding.isDefault,
            })),
        activeInboundDelegations,
        activeOutboundDelegations,
        activeAutomations,
        busy: activeInboundDelegations > 0 || activeOutboundDelegations > 0,
        capabilityTags: [...new Set(capabilityTags)],
        ...(automationContext
          ? { automationAuthorization: automationAuthorizationByBot.get(row.id) ?? {
              state: 'stale' as const,
              reason: '目标 Bot 不在本轮 Automation 的冻结协作计划中',
            } }
          : {}),
      }];
    });
    return {
      ok: true,
      bots,
    };
  };

  const delegateToBot = async (
    input: DelegateToBotInput,
  ): Promise<BotDelegationResult<{
    delegationId: string;
    childSessionId: string;
    status: 'queued' | 'waiting' | 'running';
    targetBotId: string;
    targetBotName: string;
    depth: number;
    deadlineAt: number;
  }>> => {
    const objective = input.objective.trim();
    if (!objective || objective.length > MAX_OBJECTIVE_CHARS) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: `objective 必须为 1-${MAX_OBJECTIVE_CHARS} 个字符`,
      };
    }
    const requestedMaxDepth = Math.min(
      HARD_MAX_DEPTH,
      Math.max(1, Math.floor(input.maxDepth ?? DEFAULT_MAX_DEPTH)),
    );
    const requestedTimeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1_000, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    );
    if (
      input.budgetTokens !== undefined
      && (!Number.isSafeInteger(input.budgetTokens) || input.budgetTokens <= 0)
    ) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: 'budget_tokens 必须是正整数' };
    }

    const db = getDbClient().drizzle;
    const caller = await resolveCaller(input.callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于 Cindy Bot' };
    }
    const automationContext = await resolveAutomationContextForSession(input.callerSessionId);
    if (automationContext && now() >= automationContext.plan.deadlineAt) {
      return {
        ok: false,
        errorCode: 'AUTOMATION_DEADLINE_EXPIRED',
        message: '本轮 Bot Automation 已超过冻结期限，不能再创建委派',
      };
    }
    const [parentDelegation] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.childSessionId, input.callerSessionId))
      .orderBy(desc(botDelegations.createdAt))
      .limit(1);
    if (parentDelegation && !isActiveDelegation(parentDelegation.status)) {
      return {
        ok: false,
        errorCode: 'PARENT_DELEGATION_TERMINAL',
        message: '当前 Bot 委派已经结束，不能继续创建子委派',
      };
    }
    const parentPlan = parentDelegation
      ? parseBotDelegationPlanSnapshot(parentDelegation.permissionSnapshotJson)
      : null;
    const legacyParentPermissionSnapshot = parentDelegation && !parentPlan
      ? parseRecord(parentDelegation.permissionSnapshotJson)
      : {};
    const configuredParentMaxDepth = parentPlan?.limits.maxDepth
      ?? legacyParentPermissionSnapshot.maxDepth;
    const parentMaxDepth = typeof configuredParentMaxDepth === 'number'
      && Number.isSafeInteger(configuredParentMaxDepth)
      ? Math.max(1, Math.min(HARD_MAX_DEPTH, configuredParentMaxDepth))
      : HARD_MAX_DEPTH;
    const automationMaxDepth = automationContext?.plan.limits.maxDelegationDepth ?? HARD_MAX_DEPTH;
    const maxDepth = Math.min(requestedMaxDepth, parentMaxDepth, automationMaxDepth);
    const parentDepth = parentDelegation?.depth ?? 0;
    if (parentDepth >= maxDepth) {
      return {
        ok: false,
        errorCode: 'MAX_DEPTH',
        message: `当前 Bot 委派深度 ${parentDepth} 已达到 max_depth=${maxDepth}`,
      };
    }
    const lineage = parentDelegation
      ? parseStringArray(parentDelegation.lineageJson)
      : [caller.botId];
    if (!lineage.includes(caller.botId)) lineage.push(caller.botId);
    if (lineage.includes(input.targetBotId)) {
      return {
        ok: false,
        errorCode: 'DELEGATION_CYCLE',
        message: '目标 Bot 已在当前委派链中，拒绝形成循环',
      };
    }

    const parentDeadlineAt = parentPlan?.limits.deadlineAt
      ?? (typeof legacyParentPermissionSnapshot.deadlineAt === 'number'
        ? legacyParentPermissionSnapshot.deadlineAt
        : null);
    const hardDeadlineAt = Math.min(
      automationContext?.plan.deadlineAt ?? Number.POSITIVE_INFINITY,
      typeof parentDeadlineAt === 'number' && Number.isFinite(parentDeadlineAt)
        ? parentDeadlineAt
        : Number.POSITIVE_INFINITY,
    );
    const remainingDeadlineMs = Number.isFinite(hardDeadlineAt)
      ? Math.max(0, hardDeadlineAt - now())
      : requestedTimeoutMs;
    if (remainingDeadlineMs < 1_000) {
      return {
        ok: false,
        errorCode: 'DELEGATION_DEADLINE_EXPIRED',
        message: '上级 Bot 任务或 Automation 的剩余时间不足以启动新委派',
      };
    }
    const timeoutMs = Math.min(requestedTimeoutMs, remainingDeadlineMs);

    let effectiveBudgetTokens = input.budgetTokens ?? null;
    if (parentDelegation) {
      const allDelegations = await db.select().from(botDelegations);
      const graph = buildDelegationGraph(allDelegations);
      const parent = graph.byId.get(parentDelegation.id) ?? parentDelegation;
      const ceilings: DelegationRow[] = [];
      const seen = new Set<string>();
      let cursor: DelegationRow | undefined = parent;
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        if (cursor.budgetTokens !== null) ceilings.push(cursor);
        cursor = cursor.parentSessionId
          ? graph.byChildSessionId.get(cursor.parentSessionId)
          : undefined;
      }
      if (ceilings.length > 0) {
        const available = Math.min(...ceilings.map((ceiling) =>
          Math.max(0, ceiling.budgetTokens! - committedSubtreeTokens(ceiling, graph))));
        if (available <= 0) {
          return {
            ok: false,
            errorCode: 'BUDGET_EXHAUSTED',
            message: '上级 Bot 委派的 token 预算已经用完',
          };
        }
        if (input.budgetTokens !== undefined && input.budgetTokens > available) {
          return {
            ok: false,
            errorCode: 'BUDGET_EXCEEDED',
            message: `子委派预算不能超过上级剩余额度 ${available}`,
          };
        }
        effectiveBudgetTokens = input.budgetTokens ?? available;
      }
    }
    if (automationContext && automationContext.plan.limits.budgetTokens !== null) {
      const automationBudget = automationContext.plan.limits.budgetTokens;
      const [rootSession] = await db
        .select({ tokensUsed: sessions.totalTokenUsage })
        .from(sessions)
        .where(eq(sessions.id, automationContext.rootSessionId))
        .limit(1);
      const graph = buildDelegationGraph(await db.select().from(botDelegations));
      const rootDelegations = graph.childrenByParentSessionId.get(
        automationContext.rootSessionId,
      ) ?? [];
      const committed = Math.max(0, rootSession?.tokensUsed ?? 0)
        + rootDelegations.reduce(
          (sum, delegation) => sum + committedSubtreeTokens(delegation, graph),
          0,
        );
      const available = Math.max(0, automationBudget - committed);
      if (available <= 0) {
        return {
          ok: false,
          errorCode: 'AUTOMATION_BUDGET_EXHAUSTED',
          message: '本轮 Bot Automation 的 token 预算已经用完',
        };
      }
      if (input.budgetTokens !== undefined && input.budgetTokens > available) {
        return {
          ok: false,
          errorCode: 'AUTOMATION_BUDGET_EXCEEDED',
          message: `子委派预算不能超过本轮 Automation 剩余额度 ${available}`,
        };
      }
      if (effectiveBudgetTokens !== null && effectiveBudgetTokens > available) {
        effectiveBudgetTokens = available;
      }
    }

    const active = await db
      .select({ id: botDelegations.id })
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.requestingBotId, caller.botId),
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
        ),
      );
    if (active.length >= maxActiveChildren) {
      return {
        ok: false,
        errorCode: 'CONCURRENCY_LIMIT',
        message: `当前 Bot 已有 ${active.length} 个进行中的委派，最多 ${maxActiveChildren} 个`,
      };
    }

    let target: typeof botProfiles.$inferSelect;
    let version: typeof botProfileVersions.$inferSelect;
    let binding: ProjectBindingRow | undefined;
    if (automationContext) {
      if (automationContext.plan.delegation.mode === 'none') {
        return {
          ok: false,
          errorCode: 'AUTOMATION_DELEGATION_DISABLED',
          message: '本轮 Bot Automation 的冻结计划不允许调用其它 Bot',
        };
      }
      const frozenTarget = automationContext.plan.delegation.targets.find(
        (candidate) => candidate.botId === input.targetBotId,
      );
      if (!frozenTarget) {
        return {
          ok: false,
          errorCode: 'AUTOMATION_TARGET_NOT_ALLOWED',
          message: '目标 Bot 不在本轮 Automation 的冻结协作名单中',
        };
      }
      const validation = await validateAutomationTargetSnapshot(frozenTarget);
      if (!validation.ok) {
        return {
          ok: false,
          errorCode: 'AUTOMATION_TARGET_STALE',
          message: validation.reason,
        };
      }
      ({ profile: target, version, binding } = validation);
    } else {
      const [currentTarget] = await db
        .select()
        .from(botProfiles)
        .where(and(eq(botProfiles.id, input.targetBotId), eq(botProfiles.status, 'active')))
        .limit(1);
      if (!currentTarget) {
        return { ok: false, errorCode: 'BOT_NOT_FOUND', message: '目标 Bot 不存在或已停用' };
      }
      const [currentVersion] = await db
        .select()
        .from(botProfileVersions)
        .where(
          and(
            eq(botProfileVersions.botId, currentTarget.id),
            eq(botProfileVersions.version, currentTarget.currentVersion),
          ),
        )
        .limit(1);
      if (!currentVersion) {
        return { ok: false, errorCode: 'PROFILE_NOT_FOUND', message: '目标 Bot Profile 版本不存在' };
      }
      [binding] = await db
        .select()
        .from(botProjectBindings)
        .where(
          and(
            eq(botProjectBindings.botId, currentTarget.id),
            eq(botProjectBindings.status, 'active'),
            eq(botProjectBindings.isDefault, true),
          ),
        )
        .limit(1);
      target = currentTarget;
      version = currentVersion;
    }
    const callerBinding = await resolveSessionProjectBinding(input.callerSessionId, caller.botId);
    const [callerRoute] = caller.role === 'route'
      ? await db
          .select({
            id: botRoutes.id,
            channelId: botRoutes.channelId,
            ownerGeneration: botRoutes.ownerGeneration,
          })
          .from(botRoutes)
          .where(
            and(
              eq(botRoutes.currentSessionId, input.callerSessionId),
              eq(botRoutes.botId, caller.botId),
            ),
          )
          .limit(1)
      : [];
    const contextRefs = normalizeDelegationReferences({
      refs: input.contextRefs,
      callerBinding,
      targetBinding: binding,
      field: 'context_refs',
    });
    if (!contextRefs.ok) return contextRefs;
    const artifactRefs = normalizeDelegationReferences({
      refs: input.artifactRefs,
      callerBinding,
      targetBinding: binding,
      field: 'artifact_refs',
    });
    if (!artifactRefs.ok) return artifactRefs;
    let targetCanonical: BotDelegationResult<{ sessionId: string }>;
    try {
      targetCanonical = await ensureTargetCanonicalSession(target);
    } catch (error) {
      return {
        ok: false,
        errorCode: 'TARGET_CANONICAL_UNAVAILABLE',
        message: error instanceof Error
          ? `无法准备目标 Bot 的主任务：${error.message}`
          : '无法准备目标 Bot 的主任务',
      };
    }
    if (!targetCanonical.ok) return targetCanonical;
    const delegationId = createId();
    const childSessionId = resolveBusinessSessionId(undefined);
    const createdAt = now();
    const deadlineAt = Math.min(createdAt + timeoutMs, hardDeadlineAt);
    const workspaceKind = binding ? 'project' : 'dialogue';
    const workingDir = binding?.workingDir ?? ensureDialogueWorkspaceDir(childSessionId, createdAt);
    const config = parseRecord(version.capabilitiesJson);
    const permissionMode = targetPermissionMode(config, caller.permissionMode);
    const skills = configStringList(config, 'skills');
    const mcpServers = configStringList(config, 'mcpServers');
    const toolsets = configStringList(config, 'toolsets').length > 0
      ? configStringList(config, 'toolsets')
      : configStringList(config, 'tools').filter((item) => !['files', 'browser', 'mcp'].includes(item));
    const plan: BotDelegationPlanSnapshot = {
      version: 1,
      createdAt,
      targetBotId: target.id,
      targetCanonicalSessionId: targetCanonical.sessionId,
      target: {
        profileVersion: target.currentVersion,
        agentKind: botAgentKind(config),
        model:
          typeof config.model === 'string' && config.model.trim()
            ? config.model.trim()
            : 'claude-sonnet-4-6',
        capabilitiesSha256: sha256(version.capabilitiesJson),
        identitySha256: sha256(version.identitySource),
        skills,
        skillMode: configuredMode(config.skillMode, skills),
        mcpServers,
        mcpMode: configuredMode(config.mcpMode, mcpServers),
        toolsets,
        toolsetMode: configuredMode(config.toolsetMode, toolsets),
        memoryEnabled: config.memory !== false,
        automationEnabled: config.automation === true,
      },
      workspace: workspaceSnapshot(binding),
      access: {
        callerProjectBindingId: callerBinding?.id ?? null,
        projectKey: binding?.projectKey ?? null,
        remoteHostId: binding?.remoteHostId ?? null,
        contextRefs: contextRefs.refs,
        artifactRefs: artifactRefs.refs,
      },
      completionTarget: {
        parentSessionId: input.callerSessionId,
        channelId: callerRoute?.channelId ?? null,
        routeId: callerRoute?.id ?? null,
        ownerGeneration: callerRoute?.ownerGeneration ?? 0,
      },
      limits: {
        maxDepth,
        budgetTokens: effectiveBudgetTokens,
        timeoutMs,
        deadlineAt,
      },
      permission: {
        mode: permissionMode,
        requesterMode: caller.permissionMode ?? null,
        targetConfigured: config.permissions === 'trusted' ? 'trusted' : 'ask',
      },
    };
    const permissionSnapshotJson = JSON.stringify(plan);
    const childRow = {
      ...sessionCreateToRow(
        childSessionId,
        {
          workspaceKind,
          workingDir,
          model:
            plan.target.model,
          agentKind: plan.target.agentKind,
          permissionMode,
          remoteHostId: binding?.remoteHostId ?? undefined,
          source: 'bot',
          parentSessionId: input.callerSessionId,
        },
        createdAt,
      ),
      title: `${target.displayName} · ${objective.split('\n')[0]!.slice(0, 60)}`,
    };

    try {
      await ensureProjectGitInitialized({
        workingDir,
        workspaceKind,
        remoteHostId: binding?.remoteHostId ?? null,
        sessionId: childSessionId,
        autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
        source: 'bot-delegation',
      });
      const localChannelId = `${target.id}:local`;
      await getDbClient().tx('bots.createDelegation', {
        maxActiveChildren,
        localChannelId,
        session: {
          id: childRow.id,
          title: childRow.title,
          workingDir: childRow.workingDir ?? null,
          workspaceKind: childRow.workspaceKind,
          model: childRow.model,
          effort: childRow.effort,
          permissionMode: childRow.permissionMode,
          agentKind: childRow.agentKind,
          remoteHostId: childRow.remoteHostId ?? null,
          providerId: childRow.providerId ?? null,
          parentSessionId: input.callerSessionId,
          extraDirs: childRow.extraDirs,
          source: childRow.source,
          createdAt: childRow.createdAt,
          updatedAt: childRow.updatedAt,
        },
        delegation: {
          id: delegationId,
          requestingBotId: caller.botId,
          targetBotId: target.id,
          parentSessionId: input.callerSessionId,
          childSessionId,
          objective,
          contextRefsJson: JSON.stringify(contextRefs.refs),
          artifactRefsJson: JSON.stringify(artifactRefs.refs),
          permissionSnapshotJson,
          lineageJson: JSON.stringify([...lineage, target.id]),
          targetProfileVersion: target.currentVersion,
          depth: parentDepth + 1,
          budgetTokens: effectiveBudgetTokens ?? null,
          createdAt,
        },
      });
      emitChanged({
        delegationId,
        parentSessionId: input.callerSessionId,
        childSessionId,
        status: 'queued',
      });
    } catch (error) {
      if (!binding) await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof Error && error.message === 'BOT_DELEGATION_CONCURRENCY_LIMIT') {
        return {
          ok: false,
          errorCode: 'CONCURRENCY_LIMIT',
          message: `当前 Bot 的进行中委派已达到 ${maxActiveChildren} 个`,
        };
      }
      throw error;
    }

    deps.broadcastSessionCreated?.(childSessionId);
    try {
      await projectTargetRequest({
        id: delegationId,
        requestingBotId: caller.botId,
        objective,
        permissionSnapshotJson,
        createdAt,
      });
    } catch (error) {
      const lastError = `TARGET_TIMELINE_PERSIST_FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`;
      const changed = await updateTerminal({
        delegationId,
        status: 'failed',
        lastError,
        abortChild: true,
      });
      if (changed) {
        await deliverCompletion({
          id: delegationId,
          requestingBotId: caller.botId,
          targetBotId: target.id,
          parentSessionId: input.callerSessionId,
          childSessionId,
          objective,
          status: 'failed',
          lastError,
          permissionSnapshotJson,
        });
      }
      return {
        ok: false,
        errorCode: 'TARGET_TIMELINE_PERSIST_FAILED',
        message: '委派未启动：无法把请求记录到目标 Bot 的主任务',
      };
    }
    scheduleTimeout(delegationId, deadlineAt);
    const dispatchResult = await attemptDispatch(delegationId);
    return {
      ok: true,
      delegationId,
      childSessionId,
      status: dispatchResult.status,
      targetBotId: target.id,
      targetBotName: target.displayName,
      depth: parentDepth + 1,
      deadlineAt,
    };
  };

  const listDelegations = async (
    callerSessionId: string,
    status?: DelegationStatus,
  ): Promise<BotDelegationResult<{ delegations: BotDelegationView[] }>> => {
    const caller = await resolveCaller(callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于 Cindy Bot' };
    }
    const db = getDbClient().drizzle;
    const rows = await db
      .select()
      .from(botDelegations)
      .where(
        status
          ? and(eq(botDelegations.requestingBotId, caller.botId), eq(botDelegations.status, status))
          : eq(botDelegations.requestingBotId, caller.botId),
      )
      .orderBy(desc(botDelegations.createdAt))
      .limit(100);
    const profiles = await db
      .select({ id: botProfiles.id, displayName: botProfiles.displayName })
      .from(botProfiles);
    const profileNames = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
    const deliveryKeys = rows.map((row) => `bot-delegation-completion:${row.id}`);
    const deliveryRows = deliveryKeys.length > 0
      ? await db
          .select({
            id: botDeliveryOutbox.id,
            idempotencyKey: botDeliveryOutbox.idempotencyKey,
            status: botDeliveryOutbox.status,
            attempts: botDeliveryOutbox.attempts,
            lastError: botDeliveryOutbox.lastError,
            deliveryReceiptJson: botDeliveryOutbox.deliveryReceiptJson,
          })
          .from(botDeliveryOutbox)
          .where(inArray(botDeliveryOutbox.idempotencyKey, deliveryKeys))
      : [];
    const completionDeliveryByKey = new Map(
      deliveryRows.map((delivery) => [delivery.idempotencyKey, delivery]),
    );
    return {
      ok: true,
      delegations: rows.map((row) => {
        const completionDelivery = completionDeliveryByKey.get(
          `bot-delegation-completion:${row.id}`,
        );
        return {
          ...row,
          targetBotName: profileNames.get(row.targetBotId) ?? row.targetBotId,
          contextRefs: parseStringArray(row.contextRefsJson),
          artifactRefs: parseStringArray(row.artifactRefsJson),
          outputArtifacts: parseBotOutputArtifacts(row.outputArtifactsJson),
          completionDelivery: completionDelivery
            ? {
                id: completionDelivery.id,
                status: completionDelivery.status,
                attempts: completionDelivery.attempts,
                lastError: completionDelivery.lastError,
                diagnostic: parseBotDeliveryDiagnostic(completionDelivery.deliveryReceiptJson),
              }
            : null,
          lineage: parseStringArray(row.lineageJson),
          permissionSnapshot: parseRecord(row.permissionSnapshotJson),
        };
      }) as BotDelegationView[],
    };
  };

  const cancelDelegationTree = async (
    root: DelegationRow,
    reason: string,
    deliverRoot: boolean,
  ): Promise<boolean> => {
    const db = getDbClient().drizzle;
    const graph = buildDelegationGraph(await db.select().from(botDelegations));
    const currentRoot = graph.byId.get(root.id) ?? root;
    const affected = [currentRoot, ...descendantRows(currentRoot, graph)]
      .filter((row) => isActiveDelegation(row.status))
      .sort((a, b) => b.depth - a.depth);
    let rootChanged = false;
    for (const row of affected) {
      const changed = await updateTerminal({
        delegationId: row.id,
        status: 'cancelled',
        lastError: reason,
        abortChild: true,
      });
      rootChanged ||= row.id === currentRoot.id && changed !== null;
    }
    if (deliverRoot && rootChanged) {
      await deliverCompletion({
        ...currentRoot,
        status: 'cancelled',
        resultSummary: currentRoot.resultSummary,
        lastError: reason,
      });
    }
    return rootChanged;
  };

  const cancelDelegationsForParentSession = async (
    parentSessionId: string,
    reason = 'Parent Bot task was renewed, archived, or deleted.',
  ): Promise<number> => {
    const db = getDbClient().drizzle;
    const roots = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.parentSessionId, parentSessionId),
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
        ),
      );
    let cancelled = 0;
    for (const root of roots) {
      if (await cancelDelegationTree(root, reason, false)) cancelled += 1;
    }
    return cancelled;
  };

  const cancelDelegationsForBot = async (
    botId: string,
    reason = 'The owning Bot was paused, archived, or deleted.',
  ): Promise<number> => {
    const db = getDbClient().drizzle;
    const rows = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
          or(
            eq(botDelegations.requestingBotId, botId),
            eq(botDelegations.targetBotId, botId),
          ),
        ),
      )
      .orderBy(desc(botDelegations.depth), desc(botDelegations.createdAt));
    let cancelled = 0;
    for (const row of rows) {
      if (await cancelDelegationTree(row, reason, false)) cancelled += 1;
    }
    return cancelled;
  };

  const cancelDelegation = async (
    callerSessionId: string,
    delegationId: string,
  ): Promise<BotDelegationResult<{ delegationId: string; childSessionId: string | null }>> => {
    const caller = await resolveCaller(callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于 Cindy Bot' };
    }
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.id, delegationId),
          eq(botDelegations.requestingBotId, caller.botId),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, errorCode: 'NOT_FOUND', message: 'Bot delegation 不存在' };
    if (!ACTIVE_DELEGATION_STATUSES.includes(row.status as (typeof ACTIVE_DELEGATION_STATUSES)[number])) {
      return {
        ok: false,
        errorCode: 'ALREADY_TERMINAL',
        message: `Bot delegation 已是终态 ${row.status}`,
      };
    }
    const changed = await cancelDelegationTree(
      row,
      'Cancelled by the requesting Bot.',
      true,
    );
    if (!changed) {
      return { ok: false, errorCode: 'ALREADY_TERMINAL', message: 'Bot delegation 已被另一操作收口' };
    }
    return { ok: true, delegationId, childSessionId: row.childSessionId };
  };

  const settleSession = async (params: {
    childSessionId: string;
    outcome: 'done' | 'error';
    resultText?: string;
    error?: string;
  }): Promise<void> => {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(eq(botDelegations.childSessionId, params.childSessionId))
      .orderBy(desc(botDelegations.createdAt))
      .limit(1);
    if (!row || !ACTIVE_DELEGATION_STATUSES.includes(row.status as (typeof ACTIVE_DELEGATION_STATUSES)[number])) return;
    const [child] = await db
      .select({ tokensUsed: sessions.totalTokenUsage })
      .from(sessions)
      .where(eq(sessions.id, params.childSessionId))
      .limit(1);
    const tokensUsed = child?.tokensUsed ?? 0;
    const overBudget = row.budgetTokens !== null && tokensUsed > row.budgetTokens;
    const status: Extract<DelegationStatus, 'completed' | 'failed'> =
      params.outcome === 'done' && !overBudget ? 'completed' : 'failed';
    const lastError = overBudget
      ? `Bot delegation token budget exceeded (${tokensUsed}/${row.budgetTokens}).`
      : params.error ?? null;
    const resultSummary = params.resultText?.trim().slice(0, MAX_RESULT_CHARS) || null;
    const outputArtifactsJson = JSON.stringify(collectBotOutputArtifacts(params.resultText));
    const changed = await updateTerminal({
      delegationId: row.id,
      status,
      resultSummary,
      outputArtifactsJson,
      lastError,
      tokensUsed,
    });
    if (!changed || !row.parentSessionId) return;
    await deliverCompletion({
      ...row,
      status,
      resultSummary,
      lastError,
    });
  };

  const enforceBudgetForSession = async (
    childSessionId: string,
    tokensUsed: number,
  ): Promise<boolean> => {
    const db = getDbClient().drizzle;
    let delegationBudgetFailed = false;
    const [row] = await db
      .select()
      .from(botDelegations)
      .where(
        and(
          eq(botDelegations.childSessionId, childSessionId),
          inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]),
        ),
      )
      .orderBy(desc(botDelegations.createdAt))
      .limit(1);
    if (row) {
      await db
        .update(botDelegations)
        .set({ tokensUsed: Math.max(0, Math.floor(tokensUsed)), updatedAt: now() })
        .where(eq(botDelegations.id, row.id));
    }

    const allDelegations = await db.select().from(botDelegations);
    const graph = buildDelegationGraph(allDelegations);
    const current = row ? graph.byId.get(row.id) : undefined;
    if (current) {
      const ancestry: DelegationRow[] = [];
      const seen = new Set<string>();
      let cursor: DelegationRow | undefined = current;
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        ancestry.push(cursor);
        cursor = cursor.parentSessionId
          ? graph.byChildSessionId.get(cursor.parentSessionId)
          : undefined;
      }
      const exceeded = ancestry
        .reverse()
        .find((candidate) =>
          candidate.budgetTokens !== null
          && committedSubtreeTokens(candidate, graph) > candidate.budgetTokens);
      if (exceeded?.budgetTokens !== null && exceeded !== undefined) {
        const committed = committedSubtreeTokens(exceeded, graph);
        const lastError = `Bot delegation subtree token budget exceeded (${committed}/${exceeded.budgetTokens}).`;
        delegationBudgetFailed = await failBudgetSubtree(exceeded, graph, lastError);
      }
    }

    const automationContext = await resolveAutomationContextForSession(childSessionId);
    const automationBudget = automationContext?.plan.limits.budgetTokens ?? null;
    if (!automationContext || automationBudget === null) return delegationBudgetFailed;

    const roots = graph.childrenByParentSessionId.get(automationContext.rootSessionId) ?? [];
    const automationDelegations = roots.flatMap((root) => [root, ...descendantRows(root, graph)]);
    const sessionIds = [
      automationContext.rootSessionId,
      ...automationDelegations.flatMap((delegation) => delegation.childSessionId
        ? [delegation.childSessionId]
        : []),
    ];
    const usageRows = await db
      .select({ id: sessions.id, tokensUsed: sessions.totalTokenUsage })
      .from(sessions)
      .where(inArray(sessions.id, [...new Set(sessionIds)]));
    const automationTokensUsed = usageRows.reduce(
      (sum, usage) => sum + Math.max(0, usage.tokensUsed),
      0,
    );
    if (automationTokensUsed <= automationBudget) return delegationBudgetFailed;

    const lastError = `Bot automation token budget exceeded (${automationTokensUsed}/${automationBudget}).`;
    for (const delegation of automationDelegations
      .filter((candidate) => isActiveDelegation(candidate.status))
      .sort((left, right) => right.depth - left.depth)) {
      await updateTerminal({
        delegationId: delegation.id,
        status: 'failed',
        lastError,
        tokensUsed: delegation.tokensUsed,
        abortChild: true,
      });
    }
    await db
      .update(botAutomationRuns)
      .set({
        status: 'failed',
        errorMessage: lastError,
        updatedAt: now(),
      })
      .where(
        and(
          eq(botAutomationRuns.id, automationContext.run.id),
          inArray(botAutomationRuns.status, ['claimed', 'running', 'completing']),
        ),
      );
    if (automationContext.run.scheduleRunId) {
      await db
        .update(scheduleRuns)
        .set({ errorMsg: lastError })
        .where(eq(scheduleRuns.id, automationContext.run.scheduleRunId));
    }
    await deps.abortSession(automationContext.rootSessionId).catch(() => undefined);
    return true;
  };

  const restore = async (): Promise<void> => {
    const db = getDbClient().drizzle;
    const rows = await db
      .select({
        id: botDelegations.id,
        status: botDelegations.status,
        requestingBotId: botDelegations.requestingBotId,
        targetBotId: botDelegations.targetBotId,
        parentSessionId: botDelegations.parentSessionId,
        childSessionId: botDelegations.childSessionId,
        objective: botDelegations.objective,
        contextRefsJson: botDelegations.contextRefsJson,
        artifactRefsJson: botDelegations.artifactRefsJson,
        permissionSnapshotJson: botDelegations.permissionSnapshotJson,
        createdAt: botDelegations.createdAt,
      })
      .from(botDelegations)
      .where(inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES]));
    for (const row of rows) {
      try {
        await projectTargetRequest(row);
      } catch (error) {
        const lastError = `TARGET_TIMELINE_PERSIST_FAILED: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const changed = await updateTerminal({
          delegationId: row.id,
          status: 'failed',
          lastError,
          abortChild: true,
        });
        if (changed) await deliverCompletion({ ...row, status: 'failed', lastError });
        continue;
      }
      const deadlineAt = readDeadline(row.permissionSnapshotJson);
      if (deadlineAt !== null) scheduleTimeout(row.id, deadlineAt);
      if (row.status === 'queued' || row.status === 'waiting') {
        if (row.childSessionId) await attemptDispatch(row.id);
        continue;
      }
      if (row.status === 'running') await resumeRunningDelegation(row.id);
    }
    const terminalRows = await db
      .select({ delegation: botDelegations })
      .from(botDelegations)
      .leftJoin(
        messages,
        and(
          eq(
            messages.sessionId,
            sql<string>`json_extract(${botDelegations.permissionSnapshotJson}, '$.targetCanonicalSessionId')`,
          ),
          eq(
            messages.clientId,
            sql<string>`'bot-delegation-target-result:' || ${botDelegations.id}`,
          ),
        ),
      )
      .where(
        and(
          inArray(botDelegations.status, ['completed', 'failed', 'cancelled', 'timed-out']),
          isNull(messages.id),
          sql`json_type(${botDelegations.permissionSnapshotJson}, '$.targetCanonicalSessionId') = 'text'`,
        ),
      );
    for (const { delegation: row } of terminalRows) {
      await projectTargetResult(row).catch((error) => {
        log.warn('failed to restore Bot delegation result in target canonical task', {
          delegationId: row.id,
          targetBotId: row.targetBotId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (deps.enqueueDelivery) {
      const missingCompletions = await db
        .select()
        .from(botDelegations)
        .leftJoin(
          botDeliveryOutbox,
          eq(
            botDeliveryOutbox.idempotencyKey,
            sql<string>`'bot-delegation-completion:' || ${botDelegations.id}`,
          ),
        )
        .where(
          and(
            inArray(botDelegations.status, ['completed', 'failed', 'cancelled', 'timed-out']),
            isNotNull(botDelegations.parentSessionId),
            isNull(botDeliveryOutbox.id),
          ),
        );
      for (const item of missingCompletions) {
        const delegation = item.bot_delegations;
        await deliverCompletion({
          ...delegation,
          status: delegation.status as Extract<
            DelegationStatus,
            'completed' | 'failed' | 'cancelled' | 'timed-out'
          >,
          resultSummary: delegation.resultSummary,
          lastError: delegation.lastError,
        });
      }
    }
  };

  const unregisterParentCancellation = registerBotDelegationParentCancellation(
    cancelDelegationsForParentSession,
  );

  const dispose = (): void => {
    unregisterParentCancellation();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
  };

  return {
    listBots,
    delegateToBot,
    listDelegations,
    cancelDelegation,
    cancelDelegationsForParentSession,
    cancelDelegationsForBot,
    enforceBudgetForSession,
    settleSession,
    restore,
    dispose,
  };
}

export type BotDelegationService = ReturnType<typeof createBotDelegationService>;
