import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { app } from 'electron';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { ensureProjectGitInitialized } from '../git-snapshot/projectGitBootstrap.js';
import { getDbClient } from '../localDb/client/current.js';
import type { BotsFinishDelegationResult } from '../localDb/client/tx/types.js';
import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure.js';
import {
  createBotCanonicalSession,
  resolveBotCanonicalSessionForUse,
} from '../localDb/ipc/bots.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { sessionCreateToRow } from '../localDb/mapper.js';
import {
  botDelegations,
  botProfileVersions,
  botProfiles,
  botRuntimeSnapshots,
  botSessionLinks,
  messages,
  sessions,
} from '../localDb/schema.js';
import { readGitSafetySettings } from '../maker-host/git-safety-settings-store.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { deriveAvailableModels } from '../maker-host/catalog-to-descriptors.js';
import type { AgentKind } from '@cindy/maker-core';
import { UI_ACTION_TRIGGER_PREFIX } from '../../shared/interruptedTurn.js';
import { createLogger } from '../logger.js';
import { resolveBusinessSessionId } from '../sessionIds.js';
import { registerBotDelegationParentCancellation } from './botDelegationLifecycle.js';
import { classifyBotDelegationDispatchFailure } from './botDelegationDispatchOutcome.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';
import type {
  BotCapabilityCatalogEntry,
  BotDelegationChangedPayload,
  BotDelegationCapabilitySnapshot,
  BotDelegationPlanSnapshot,
  BotDelegationStatus,
  BotDelegationView,
} from '../../shared/botDelegation.js';
import { parseBotDelegationPlanSnapshot } from '../../shared/botDelegation.js';
import type {
  BotCollaborationMeta,
  BotCollaborationRole,
  BotDelegationInterjectResult,
} from '../../shared/botCollaboration.js';
import { BOT_DELEGATION_CLIENT_ID } from '../../shared/botCollaboration.js';
import { ensureBotWorkspaceDir } from './botProfileFolder.js';
import { readEffectiveBotModelChain } from '../maker-host/bot-model-chain-settings-store.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const ACTIVE_DELEGATION_STATUSES = ['queued', 'running', 'waiting'] as const;
/** 一条插话的正文上限：够写清「先别做 X，改做 Y」，又不至于变成第二次委派。 */
const MAX_INTERJECTION_CHARS = 4_000;
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

type DelegationStatus = BotDelegationStatus;
type DelegationRow = typeof botDelegations.$inferSelect;

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
  abortSession: (sessionId: string) => Promise<void>;
  closeSession?: (sessionId: string) => Promise<void>;
  broadcastSessionCreated?: (sessionId: string) => void;
  persistTimelineMessage?: (params: {
    sessionId: string;
    clientId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt?: number;
    /**
     * 只增不改的呈现标记（写进 `messages.agent_meta`）。renderer 据此把镜像消息
     * 升级成协作卡 / 客座气泡；不带标记的老行继续按普通文本渲染。
     */
    agentMeta?: Record<string, unknown>;
  }) => Promise<void>;
  onChanged?: (payload: BotDelegationChangedPayload) => void;
  now?: () => number;
  createId?: () => string;
  maxActiveChildren?: number;
  /** Production requires the native runtime snapshot before accepting work. */
  requireRuntimeSnapshot?: boolean;
  /** Host-owned canonical turn state used by the lightweight roster/status view. */
  isSessionTurnRunning?: (sessionId: string) => boolean;
}

export function isBotRuntimeSnapshotForCapabilityTarget(input: {
  runtimeSessionId: string;
  canonicalSessionId: string | null;
}): boolean {
  return Boolean(input.canonicalSessionId)
    && input.runtimeSessionId === input.canonicalSessionId;
}

/**
 * Return only capabilities that the Profile explicitly froze as requirements.
 * Inherited catalogs are opportunistic: a Skill installed for the caller or a
 * different machine must not become a hidden hard dependency of every task.
 */
export function unavailableRequiredBotCapabilities(
  target: Pick<BotDelegationCapabilitySnapshot,
    'skillMode' | 'skills' | 'mcpMode' | 'mcpServers' | 'toolsetMode' | 'toolsets'
  >,
  resolved: {
    unavailableSkills?: unknown;
    unavailableMcpServers?: unknown;
    unavailableToolsets?: unknown;
  },
): string[] {
  const requiredUnavailable = (
    mode: 'inherit' | 'allowlist',
    configured: readonly string[],
    unavailable: unknown,
    prefix: string,
  ): string[] => {
    if (mode !== 'allowlist' || !Array.isArray(unavailable)) return [];
    const required = new Set(configured);
    return unavailable
      .filter((name): name is string => typeof name === 'string' && required.has(name))
      .map((name) => `${prefix}:${name}`);
  };
  return [
    ...requiredUnavailable(target.skillMode, target.skills, resolved.unavailableSkills, 'skill'),
    ...requiredUnavailable(target.mcpMode, target.mcpServers, resolved.unavailableMcpServers, 'mcp'),
    ...requiredUnavailable(
      target.toolsetMode,
      target.toolsets,
      resolved.unavailableToolsets,
      'toolset',
    ),
  ];
}

export interface DelegateToBotInput {
  callerSessionId: string;
  targetBotId: string;
  objective: string;
  contextRefs?: string[];
  maxDepth?: number;
  timeoutMs?: number;
}

export interface DelegateToCindyInput {
  callerSessionId: string;
  objective: string;
  /** 子任务标题;缺省取 objective 首行。 */
  title?: string;
  /**
   * 子任务工作目录。必须是已存在的绝对路径;缺省用发起 Bot 的 Home workspace。
   * 子任务是一条普通 Cindy 任务,自己的权限门照常生效,这里不做授权扩张。
   */
  workingDir?: string;
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
  const primary = readEffectiveBotModelChain(config)[0] ?? null;
  const harness = primary?.harness ?? config.harness;
  return harness === 'codex' ? 'codex' : harness === 'pi' ? 'pi' : 'cc';
}

/**
 * 配置里没有 model 时,快照该记哪个模型。
 *
 * 这里**不写死型号**:取目录里标了「新对话默认」的那个,也就是模型选择器给新对话
 * 用的同一个值;没有标记就取该 agent 的首个可用模型。目录未加载时 `getActiveCatalog`
 * 会回落 bundled 目录(它保证不抛、不为空),所以这条路不会产出空串。
 *
 * 曾经这里(两处)各写死一个型号当兜底 —— 那是与选择器打架的第三份默认口径,
 * 已删除。要调默认档位去改目录,不在这里分叉。
 */
function catalogDefaultModelId(kind: 'cc' | 'codex' | 'pi'): string {
  const agent: AgentKind = kind === 'cc' ? 'claude-code' : kind;
  const models = deriveAvailableModels(getActiveCatalog(), agent);
  return (
    models.find((m) => m.newSessionDefault?.includes(agent))?.id ?? models[0]?.id ?? ''
  );
}

/** 读配置里的 model;缺失或空白时按目录默认补齐(见 catalogDefaultModelId)。 */
function configuredModelId(config: Record<string, unknown>): string {
  const raw = readEffectiveBotModelChain(config)[0]?.model ?? config.model;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return catalogDefaultModelId(botAgentKind(config));
}

/**
 * 目标 Bot 的执行配置 → 子任务 session 行字段。
 *
 * 与 `createBotCanonicalSession` 读同一份 `capabilities_json`，口径必须一致：委派子任务
 * 是目标 Bot 的另一个运行时，不是一个「默认配置的新会话」。尤其是 `providerId` ——
 * 它是模型路由的唯一依据，缺省(null)意味着回落该 harness 的隐式默认来源；目标 Bot 连
 * 的是自定义 / 订阅来源时，这条子任务会直接以 AGENT_NOT_READY 起不来。
 */
function botExecutionRowFields(config: Record<string, unknown>): {
  providerId?: string | null;
  effort?: string;
  fastMode: boolean;
} {
  const primary = readEffectiveBotModelChain(config)[0] ?? null;
  const configuredProvider = primary ? primary.providerId : config.providerId;
  const providerId = typeof configuredProvider === 'string' && configuredProvider.trim()
    ? configuredProvider.trim()
    : configuredProvider === null
      ? null
      : undefined;
  const configuredEffort = primary?.effort || config.effort;
  const effort = typeof configuredEffort === 'string' && configuredEffort.trim()
    ? configuredEffort.trim()
    : undefined;
  return {
    ...(providerId !== undefined ? { providerId } : {}),
    ...(effort !== undefined ? { effort } : {}),
    fastMode: primary?.fastMode ?? config.fastMode === true,
  };
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
    model: configuredModelId(config),
    capabilitiesSha256: sha256(input.capabilitiesJson),
    identitySha256: sha256(input.identitySource),
    skills,
    skillMode: configuredMode(config.skillMode, skills),
    mcpServers,
    mcpMode: configuredMode(config.mcpMode, mcpServers),
    toolsets,
    toolsetMode: configuredMode(config.toolsetMode, toolsets),
    memoryEnabled: config.memory !== false,
  };
}

function configuredMode(
  value: unknown,
  configured: string[],
): 'inherit' | 'allowlist' {
  if (value === 'allowlist' || value === 'inherit') return value;
  return configured.length > 0 ? 'allowlist' : 'inherit';
}

/**
 * 上下文引用是纯文本指针（文件名、链接、一句背景）,随目标事项进入子任务提示词。
 * 项目绑定退出 v1 后它不再承载路径授权语义:子任务的实际可读写面由它自己的
 * 工作目录与权限门决定,这里只挡注入类噪音。
 */
function normalizeDelegationReferences(
  refs: string[] | undefined,
): BotDelegationResult<{ refs: string[] }> {
  const bounded = boundedStringList(refs);
  for (const ref of bounded) {
    if (ref.includes('\0') || ref.includes('\n') || ref.includes('\r') || ref.length > 512) {
      return {
        ok: false,
        errorCode: 'INVALID_REFERENCE',
        message: 'context_refs 只接受不含换行的短文本引用',
      };
    }
  }
  return { ok: true, refs: [...new Set(bounded)] };
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
      ...(params.agentMeta
        ? { agentMeta: params.agentMeta as Parameters<typeof createMessage>[1]['agentMeta'] }
        : {}),
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
  }): Promise<BotDelegationResult<{ sessionId: string }>> => {
    const db = getDbClient().drizzle;
    const renewal = await resolveBotCanonicalSessionForUse(target.id);
    if (renewal.renewed && renewal.canonicalSessionId) {
      deps.broadcastSessionCreated?.(renewal.canonicalSessionId);
    }
    const registered = await resolveBotCanonicalSession(target.id);
    let expectedCanonicalSessionId = registered.status === 'resolved'
      ? registered.sessionId
      : null;
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

  /**
   * 冻结这次协作双方的展示身份。名字后来改了不回填历史消息——消息流讲的是
   * 「当时谁把活交给了谁」，不是「他们现在叫什么」。
   */
  const collaborationMeta = async (
    row: Pick<DelegationRow,
      'id' | 'requestingBotId' | 'targetBotId' | 'objective' | 'parentSessionId' | 'childSessionId'
    >,
    role: BotCollaborationRole,
  ): Promise<BotCollaborationMeta> => {
    const db = getDbClient().drizzle;
    const ids = [...new Set([row.requestingBotId, ...(row.targetBotId ? [row.targetBotId] : [])])];
    const profiles = await db
      .select({ id: botProfiles.id, displayName: botProfiles.displayName })
      .from(botProfiles)
      .where(inArray(botProfiles.id, ids));
    const nameOf = (botId: string): string =>
      profiles.find((profile) => profile.id === botId)?.displayName || botId;
    return {
      v: 1,
      role,
      delegationId: row.id,
      fromBotId: row.requestingBotId,
      fromBotName: nameOf(row.requestingBotId),
      toBotId: row.targetBotId,
      // 空目标 = 普通 Cindy 任务;卡片上的对方就叫 Cindy。
      toBotName: row.targetBotId ? nameOf(row.targetBotId) : 'Cindy',
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      objective: row.objective.slice(0, 400),
    };
  };

  /**
   * 父任务里的协作卡锚点：空正文 + `botCollaboration` 标记，只为在发起方的消息流
   * **原位**留下一个位置（「<目标> 加入了对话」）。卡片的实时状态、秒数与终态战报
   * 都由 delegation 行推送驱动，锚点本身不需要更新。
   *
   * 刻意与 `projectTargetRequest` 分开：目标侧那条镜像是真实工作交接，写不进去就
   * 必须让委派失败；这一条只是发起方视角的呈现，写不进去只降级成「没有卡」。
   */
  const projectParentRequest = async (row: Pick<DelegationRow,
    | 'id'
    | 'requestingBotId'
    | 'targetBotId'
    | 'objective'
    | 'parentSessionId'
    | 'childSessionId'
    | 'createdAt'
  >): Promise<void> => {
    if (!row.parentSessionId) return;
    await persistTimelineMessage({
      sessionId: row.parentSessionId,
      clientId: BOT_DELEGATION_CLIENT_ID.parentRequest(row.id),
      role: 'assistant',
      content: '',
      createdAt: row.createdAt,
      agentMeta: {
        botCollaboration: await collaborationMeta(row, 'delegation-request'),
      },
    });
  };

  const projectTargetRequest = async (row: Pick<DelegationRow,
    | 'id'
    | 'requestingBotId'
    | 'targetBotId'
    | 'objective'
    | 'parentSessionId'
    | 'childSessionId'
    | 'permissionSnapshotJson'
    | 'createdAt'
  >): Promise<void> => {
    const plan = parseBotDelegationPlanSnapshot(row.permissionSnapshotJson);
    if (!plan?.targetCanonicalSessionId) return;
    await persistTimelineMessage({
      sessionId: plan.targetCanonicalSessionId,
      clientId: BOT_DELEGATION_CLIENT_ID.targetRequest(row.id),
      // 目标主任务里只留协作卡锚点:真正干活的是子任务,这里再复读一遍任务全文
      // 既不会叫醒目标主线程,还会把对话变成废话墙。卡上的「看工作过程」才是入口。
      role: 'assistant',
      content: '',
      createdAt: row.createdAt,
      agentMeta: {
        botCollaboration: await collaborationMeta(row, 'guest-request'),
      },
    });
  };

  const projectTargetResult = async (row: Pick<DelegationRow,
    | 'id'
    | 'requestingBotId'
    | 'targetBotId'
    | 'objective'
    | 'parentSessionId'
    | 'childSessionId'
    | 'status'
    | 'resultSummary'
    | 'lastError'
    | 'permissionSnapshotJson'
    | 'completedAt'
  >): Promise<void> => {
    const plan = parseBotDelegationPlanSnapshot(row.permissionSnapshotJson);
    if (!plan?.targetCanonicalSessionId || isActiveDelegation(row.status)) return;
    await persistTimelineMessage({
      sessionId: plan.targetCanonicalSessionId,
      clientId: BOT_DELEGATION_CLIENT_ID.targetResult(row.id),
      // 终态同样只留卡:结论和交付物走委派行上的结构化字段,不在这里复读任务全文,
      // 也不把子任务 id 裸丢进对话。
      role: 'assistant',
      content: '',
      createdAt: row.completedAt ?? undefined,
      agentMeta: {
        botCollaboration: await collaborationMeta(row, 'result-mirror'),
      },
    });
  };

  /**
   * 完成信号:对模型是一条内部指令,对用户不可见。
   *
   * 用户可见的终态由发起方消息流里的协作卡承载(delegation 行推送驱动),不再
   * 往时间线里落一条机读文本。指令行带 UI_ACTION_TRIGGER_PREFIX,与既有的
   * 合成 UI 指令共用同一条「渲染隐藏 / 预览排除 / 搜索排除」判定链。
   *
   * 投递目标:优先冻结的父任务;父卷已被每日换卷替换时,改投发起 Bot 当前的
   * canonical 卷 —— 完成信号属于 Bot 本人,不属于某一卷。两者都不在(Bot 已
   * 暂停/归档)才放弃投递,此时卡片终态仍然可见,不算静默丢失。
   */
  const deliverCompletion = async (params: {
    id: string;
    requestingBotId: string;
    targetBotId: string | null;
    parentSessionId: string | null;
    childSessionId: string | null;
    objective: string;
    status: Extract<DelegationStatus, 'completed' | 'failed' | 'cancelled' | 'timed-out'>;
    resultSummary?: string | null;
    lastError?: string | null;
  }): Promise<void> => {
    const db = getDbClient().drizzle;
    const liveRequesterTask = async (sessionId: string): Promise<boolean> => {
      const [parent] = await db
        .select({
          status: sessions.status,
          role: botSessionLinks.role,
          botId: botSessionLinks.botId,
        })
        .from(sessions)
        .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return (
        parent?.status === 'active'
        && parent.botId === params.requestingBotId
        && (parent.role === 'canonical' || parent.role === 'delegation')
      );
    };
    let targetSessionId: string | null = null;
    if (params.parentSessionId && (await liveRequesterTask(params.parentSessionId))) {
      targetSessionId = params.parentSessionId;
    } else {
      // 每日换卷会归档父卷;完成信号跟着 Bot 走,投它当前的 canonical 卷。
      const current = await resolveBotCanonicalSessionForUse(params.requestingBotId)
        .catch(() => null);
      if (current?.canonicalSessionId && (await liveRequesterTask(current.canonicalSessionId))) {
        if (current.renewed) deps.broadcastSessionCreated?.(current.canonicalSessionId);
        targetSessionId = current.canonicalSessionId;
      }
    }
    if (!targetSessionId) {
      log.warn('skip Bot delegation completion: requester has no live task', {
        delegationId: params.id,
        requestingBotId: params.requestingBotId,
        parentSessionId: params.parentSessionId,
      });
      return;
    }
    const targetName = params.targetBotId
      ? await requesterDisplayName(params.targetBotId)
      : 'Cindy 任务';
    const statusLine =
      params.status === 'completed'
        ? '已完成'
        : params.status === 'timed-out'
          ? '已超时'
          : params.status === 'cancelled'
            ? '已取消'
            : '失败了';
    const completionMessage = [
      `${UI_ACTION_TRIGGER_PREFIX}[协作回执] 你委派给「${targetName}」的工作${statusLine}。`,
      `目标事项: ${params.objective.slice(0, 400)}`,
      params.resultSummary ? `结果:\n${params.resultSummary}` : '',
      params.lastError ? `失败原因: ${params.lastError}` : '',
      '对话里的协作卡已更新到终态。直接依据结果接手继续当前工作;回复用户时不要复述本条回执,也不要提及任何内部编号。',
    ]
      .filter(Boolean)
      .join('\n\n');
    await deps.dispatch({
      targetSessionId,
      message: completionMessage,
      persistedContent: completionMessage,
      clientId: BOT_DELEGATION_CLIENT_ID.completion(params.id),
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
        // 子任务归档由 bots.finishDelegation 在同一事务内完成(见该 tx op 的注释),
        // 不再另走通用 sessions.setStatus —— 那条通道对 source='bot' 的行会拒单,
        // 归档失败也不会被吞掉:任何失败都会让整个终态事务回滚并往上抛。
        await deps.closeSession?.(updated.childSessionId).catch(() => undefined);
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
          // 协作卡锚点(空正文)与插话留痕也是 assistant 行,但它们是这个任务**自己
          // 派活**留下的注解,不是它交出的答复。嵌套委派下不排除会直接选错:上一层
          // 拿到的"结果"会变成一句催促,或干脆是空的。
          sql`(
            ${messages.agentMeta} IS NULL
            OR json_extract(${messages.agentMeta}, '$.botCollaboration.role') IS NULL
            OR json_extract(${messages.agentMeta}, '$.botCollaboration.role')
               NOT IN ('delegation-request', 'interjection')
          )`,
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
      || (link.role !== 'canonical' && link.role !== 'delegation')
    ) return null;
    return link;
  };

  const buildDelegationPrompt = (row: {
    id: string;
    requestingBotId: string;
    targetBotId: string | null;
    objective: string;
    contextRefsJson: string;
  }): string => [
    `You are receiving a task delegated by Cindy Bot ${row.requestingBotId}.`,
    `Delegation ID: ${row.id}`,
    `Objective:\n${row.objective}`,
    parseStringArray(row.contextRefsJson).length
      ? `Context references:\n${parseStringArray(row.contextRefsJson).join('\n')}`
      : '',
    row.targetBotId
      ? 'Work independently using your own Bot profile and workspace.'
      : 'Work independently in this task\'s own workspace.',
    'Return a concise conclusion. Do not write files into the requester\'s directory and do not ask the user to copy a local path.',
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
    const [parent] = row.parentSessionId
      ? await db
          .select({ status: sessions.status })
          .from(sessions)
          .where(eq(sessions.id, row.parentSessionId))
          .limit(1)
      : [];
    if (row.parentSessionId && parent?.status !== 'active') {
      return { ok: false, errorCode: 'PARENT_SESSION_INACTIVE', message: '委派来源任务已归档或删除' };
    }
    if (row.targetBotId === null) {
      // 普通 Cindy 任务:没有目标 Profile 可冻结,只要子任务还活着就能投递。
      const [child] = await db
        .select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, row.childSessionId))
        .limit(1);
      if (child?.status !== 'active') {
        return { ok: false, errorCode: 'CHILD_SESSION_INVALID', message: '委派的 Cindy 任务已归档或删除' };
      }
      return { ok: true, plan };
    }
    if (!plan.target || row.targetProfileVersion === null) {
      return {
        ok: false,
        errorCode: 'PLAN_SNAPSHOT_INVALID',
        message: 'Bot delegation 缺少有效的冻结执行计划',
      };
    }
    const [[child], [profile], [version]] = await Promise.all([
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
    if (
      !child
      || child.status !== 'active'
      || child.source !== 'bot'
      || child.botId !== row.targetBotId
      || child.role !== 'delegation'
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
    if (!plan.target) return null;
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
    // `inherit` means "use what this runtime currently has", not "freeze the
    // caller's entire ambient catalog as a hard dependency". Treating every
    // unavailable inherited Skill/plugin as fatal made unrelated local Skills
    // (for example Git or social integrations) block all Bot delegation. Only
    // an explicit allowlist is a frozen requirement.
    const unavailable = unavailableRequiredBotCapabilities(plan.target, resolved);
    const memoryRefs = Array.isArray(resolved.memoryRefs) ? resolved.memoryRefs : [];
    const memoryUnavailable = memoryRefs.some(
      (ref) => ref && typeof ref === 'object' && (ref as Record<string, unknown>).status === 'unavailable',
    );
    if (unavailable.length > 0 || (plan.target.memoryEnabled && memoryUnavailable)) {
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

  /**
   * 去程投递失败到无法自愈时的收口：委派立刻变成 `failed`，并把人话原因送回发起方。
   *
   * 单独抽出来是因为这条路径有三件事必须一起发生，缺一件就退化成「静默挂起」：
   * 收口 delegation 行（协作卡据此翻终态）、中止并归档子任务、把失败当作一次结果
   * 回传（发起方的对话里必须出现这句话，而不是只在日志里）。
   */
  async function failDelegationDispatch(
    row: DelegationRow,
    lastError: string,
  ): Promise<void> {
    clearRetryTimer(row.id);
    const changed = await updateTerminal({
      delegationId: row.id,
      status: 'failed',
      lastError,
      abortChild: true,
    });
    if (changed) {
      await deliverCompletion({ ...row, status: 'failed', lastError });
    }
  }

  async function attemptDispatch(
    delegationId: string,
    attempt = 0,
  ): Promise<{
    ok: boolean;
    status: 'queued' | 'waiting' | 'running' | 'failed';
    error?: DispatchResult;
  }> {
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
      return { ok: false, status: 'failed' };
    }
    const validation = await validateDispatchPlan(row);
    if (!validation.ok) {
      await failDelegationDispatch(row, `${validation.errorCode}: ${validation.message}`);
      return { ok: false, status: 'failed' };
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
    // 去程没送出去。**不能**一律标 waiting 然后永远重试下去：没登录、子任务已归档
    // 这类原因不会自愈，无限退避只会让协作卡永远转圈、发起方永远等不到任何交代。
    const verdict = classifyBotDelegationDispatchFailure({
      errorCode: dispatched.errorCode,
      message: dispatched.message,
      attempt,
    });
    if (verdict.kind === 'fatal') {
      log.warn('Bot delegation dispatch gave up', {
        delegationId: row.id,
        targetBotId: row.targetBotId,
        attempt,
        errorCode: verdict.errorCode,
        dispatchErrorCode: dispatched.errorCode,
      });
      await failDelegationDispatch(row, `${verdict.errorCode}: ${verdict.message}`);
      return { ok: false, status: 'failed', error: dispatched };
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
    // 重启续跑与首次投递同一条纪律：不会自愈的原因要立刻说出来，别把「running」
    // 挂到超时（默认 30 分钟）才收口——那半小时里用户看到的只有一个转圈的卡片。
    const verdict = classifyBotDelegationDispatchFailure({
      errorCode: dispatched.errorCode,
      message: dispatched.message,
      attempt,
    });
    if (verdict.kind === 'fatal') {
      log.warn('Bot delegation resume gave up', {
        delegationId: row.id,
        targetBotId: row.targetBotId,
        attempt,
        errorCode: verdict.errorCode,
        dispatchErrorCode: dispatched.errorCode,
      });
      await failDelegationDispatch(row, `${verdict.errorCode}: ${verdict.message}`);
      return;
    }
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
    const rows = await db
      .select({
        id: botProfiles.id,
        name: botProfiles.displayName,
        description: botProfiles.description,
        currentVersion: botProfiles.currentVersion,
        status: botProfiles.status,
      })
      .from(botProfiles)
      .where(eq(botProfiles.status, 'active'))
      .orderBy(desc(botProfiles.updatedAt));
    if (rows.length === 0) return { ok: true, bots: [] };

    const botIds = rows.map((row) => row.id);
    const [versions, runtimes, delegations, canonicalLinks] = await Promise.all([
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
        .select({
          requestingBotId: botDelegations.requestingBotId,
          targetBotId: botDelegations.targetBotId,
        })
        .from(botDelegations)
        .where(inArray(botDelegations.status, [...ACTIVE_DELEGATION_STATUSES])),
      db
        .select({ botId: botSessionLinks.botId, sessionId: botSessionLinks.sessionId })
        .from(botSessionLinks)
        .where(
          and(
            inArray(botSessionLinks.botId, botIds),
            eq(botSessionLinks.role, 'canonical'),
          ),
        ),
    ]);

    const canonicalByBot = new Map(canonicalLinks.map((row) => [row.botId, row.sessionId]));

    const versionByBot = new Map(
      versions
        .filter((version) => rows.some(
          (row) => row.id === version.botId && version.version === row.currentVersion,
        ))
        .map((version) => [version.botId, version]),
    );
    const runtimeByBot = new Map<string, (typeof runtimes)[number]>();
    for (const runtime of runtimes) {
      const profile = rows.find((row) => row.id === runtime.botId);
      if (
        profile
        && runtime.profileVersion === profile.currentVersion
        && isBotRuntimeSnapshotForCapabilityTarget({
          runtimeSessionId: runtime.sessionId,
          canonicalSessionId: canonicalByBot.get(profile.id) ?? null,
        })
        && !runtimeByBot.has(runtime.botId)
      ) {
        runtimeByBot.set(runtime.botId, runtime);
      }
    }
    const inboundCounts = new Map<string, number>();
    const outboundCounts = new Map<string, number>();
    for (const delegation of delegations) {
      if (delegation.targetBotId) {
        inboundCounts.set(
          delegation.targetBotId,
          (inboundCounts.get(delegation.targetBotId) ?? 0) + 1,
        );
      }
      outboundCounts.set(
        delegation.requestingBotId,
        (outboundCounts.get(delegation.requestingBotId) ?? 0) + 1,
      );
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
      const canonicalSessionId = canonicalByBot.get(row.id) ?? null;
      const canonicalTurnRunning = canonicalSessionId
        ? deps.isSessionTurnRunning?.(canonicalSessionId) === true
        : false;
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
      ];
      return [{
        id: row.id,
        name: row.name,
        description: row.description,
        currentVersion: row.currentVersion,
        canonicalSessionId,
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
        activeInboundDelegations,
        activeOutboundDelegations,
        busy:
          canonicalTurnRunning
          || activeInboundDelegations > 0
          || activeOutboundDelegations > 0,
        capabilityTags: [...new Set(capabilityTags)],
      }];
    });
    return {
      ok: true,
      bots,
    };
  };

  /**
   * 两种委派共用的链路前置检查:调用方身份、父委派状态、深度上限、截止时间与并发额度。
   */
  const resolveDelegationPreflight = async (input: {
    callerSessionId: string;
    maxDepth?: number;
    timeoutMs?: number;
  }): Promise<BotDelegationResult<{
    caller: NonNullable<Awaited<ReturnType<typeof resolveCaller>>>;
    parentDelegation: DelegationRow | null;
    parentDepth: number;
    maxDepth: number;
    lineage: string[];
    timeoutMs: number;
    hardDeadlineAt: number;
  }>> => {
    const db = getDbClient().drizzle;
    const caller = await resolveCaller(input.callerSessionId);
    if (!caller) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于 Cindy Bot' };
    }
    const requestedTimeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1_000, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    );
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
    const configuredParentMaxDepth = parentPlan?.limits.maxDepth;
    const parentMaxDepth = typeof configuredParentMaxDepth === 'number'
      && Number.isSafeInteger(configuredParentMaxDepth)
      ? Math.max(1, Math.min(HARD_MAX_DEPTH, configuredParentMaxDepth))
      : HARD_MAX_DEPTH;
    // 上层已经把 max_depth 抬到 2+ 时,子层默认继承那条链的上限,而不是再裁回扁平 1。
    // 否则 A 明确授权连环编排,B 一转手就被默认值卡死,A→B→C 永远建不起来。
    const requestedMaxDepth = Math.min(
      HARD_MAX_DEPTH,
      Math.max(1, Math.floor(input.maxDepth ?? (parentDelegation ? parentMaxDepth : DEFAULT_MAX_DEPTH))),
    );
    const maxDepth = Math.min(requestedMaxDepth, parentMaxDepth);
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
    const parentDeadlineAt = parentPlan?.limits.deadlineAt ?? null;
    const hardDeadlineAt = typeof parentDeadlineAt === 'number' && Number.isFinite(parentDeadlineAt)
      ? parentDeadlineAt
      : Number.POSITIVE_INFINITY;
    const remainingDeadlineMs = Number.isFinite(hardDeadlineAt)
      ? Math.max(0, hardDeadlineAt - now())
      : requestedTimeoutMs;
    if (remainingDeadlineMs < 1_000) {
      return {
        ok: false,
        errorCode: 'DELEGATION_DEADLINE_EXPIRED',
        message: '上级 Bot 任务的剩余时间不足以启动新委派',
      };
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
    return {
      ok: true,
      caller,
      parentDelegation: parentDelegation ?? null,
      parentDepth,
      maxDepth,
      lineage,
      timeoutMs: Math.min(requestedTimeoutMs, remainingDeadlineMs),
      hardDeadlineAt,
    };
  };

  /**
   * 创建委派行 + 子任务,并完成锚点投影、超时排程与首次投递。两种目标共用同一收口。
   */
  const startDelegation = async (input: {
    caller: NonNullable<Awaited<ReturnType<typeof resolveCaller>>>;
    callerSessionId: string;
    targetBotId: string | null;
    targetProfileVersion: number | null;
    targetDisplayName: string;
    objective: string;
    contextRefs: string[];
    lineage: string[];
    parentDepth: number;
    plan: BotDelegationPlanSnapshot;
    session: {
      workingDir: string;
      model: string;
      effort?: string;
      fastMode?: boolean;
      providerId?: string | null;
      agentKind: 'cc' | 'codex' | 'pi';
      permissionMode: string;
      title: string;
    };
  }): Promise<BotDelegationResult<{
    delegationId: string;
    childSessionId: string;
    status: 'queued' | 'waiting' | 'running' | 'failed';
    deadlineAt: number;
  }>> => {
    const { plan } = input;
    const delegationId = createId();
    const childSessionId = resolveBusinessSessionId(undefined);
    const createdAt = plan.createdAt;
    const permissionSnapshotJson = JSON.stringify(plan);
    const childRow = {
      ...sessionCreateToRow(
        childSessionId,
        {
          workspaceKind: 'dialogue',
          workingDir: input.session.workingDir,
          model: input.session.model,
          // 执行配置必须与目标的主任务同源:来源(providerId)决定这条子任务能不能
          // 解析出模型路由。漏掉它 = 子任务回落到「隐式默认路由」,目标明明连了
          // 自定义来源 / 订阅来源也会以 AGENT_NOT_READY 起不来。effort / fastMode
          // 同理:派出去的活必须按目标自己的档位跑,不能悄悄换成缺省。
          ...(input.session.effort !== undefined ? { effort: input.session.effort } : {}),
          ...(input.session.fastMode !== undefined ? { fastMode: input.session.fastMode } : {}),
          ...(input.session.providerId !== undefined
            ? { providerId: input.session.providerId }
            : {}),
          agentKind: input.session.agentKind,
          permissionMode: input.session.permissionMode,
          source: 'bot',
          parentSessionId: input.callerSessionId,
        },
        createdAt,
      ),
      title: input.session.title,
    };
    try {
      await ensureProjectGitInitialized({
        workingDir: input.session.workingDir,
        workspaceKind: 'dialogue',
        remoteHostId: null,
        sessionId: childSessionId,
        autoSnapshotEnabled: readGitSafetySettings().autoSnapshotEnabled,
        source: 'bot-delegation',
      });
      await getDbClient().tx('bots.createDelegation', {
        maxActiveChildren,
        session: {
          id: childRow.id,
          title: childRow.title,
          workingDir: childRow.workingDir ?? null,
          workspaceKind: childRow.workspaceKind,
          model: childRow.model,
          effort: childRow.effort,
          fastMode: childRow.fastMode,
          permissionMode: childRow.permissionMode,
          agentKind: childRow.agentKind,
          remoteHostId: null,
          providerId: childRow.providerId ?? null,
          parentSessionId: input.callerSessionId,
          extraDirs: childRow.extraDirs,
          source: childRow.source,
          createdAt: childRow.createdAt,
          updatedAt: childRow.updatedAt,
        },
        delegation: {
          id: delegationId,
          requestingBotId: input.caller.botId,
          targetBotId: input.targetBotId,
          parentSessionId: input.callerSessionId,
          childSessionId,
          objective: input.objective,
          contextRefsJson: JSON.stringify(input.contextRefs),
          permissionSnapshotJson,
          lineageJson: JSON.stringify(
            input.targetBotId ? [...input.lineage, input.targetBotId] : input.lineage,
          ),
          targetProfileVersion: input.targetProfileVersion,
          depth: input.parentDepth + 1,
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
      // The Profile workspace is durable and shared across the Bot's Sessions.
      // A failed child creation never owns it and must not compensate by deleting it.
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
    const mirrorRow = {
      id: delegationId,
      requestingBotId: input.caller.botId,
      targetBotId: input.targetBotId,
      objective: input.objective,
      parentSessionId: input.callerSessionId,
      childSessionId,
      permissionSnapshotJson,
      createdAt,
    };
    if (input.targetBotId) {
      try {
        await projectTargetRequest(mirrorRow);
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
            requestingBotId: input.caller.botId,
            targetBotId: input.targetBotId,
            parentSessionId: input.callerSessionId,
            childSessionId,
            objective: input.objective,
            status: 'failed',
            lastError,
          });
        }
        return {
          ok: false,
          errorCode: 'TARGET_TIMELINE_PERSIST_FAILED',
          message: '委派未启动：无法把请求记录到目标 Bot 的主任务',
        };
      }
    }
    await projectParentRequest(mirrorRow).catch((error) => {
      log.warn('failed to anchor the Bot collaboration card in the requesting task', {
        delegationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    scheduleTimeout(delegationId, plan.limits.deadlineAt);
    const dispatchResult = await attemptDispatch(delegationId);
    return {
      ok: true,
      delegationId,
      childSessionId,
      status: dispatchResult.status,
      deadlineAt: plan.limits.deadlineAt,
    };
  };

  const delegateToBot = async (
    input: DelegateToBotInput,
  ): Promise<BotDelegationResult<{
    delegationId: string;
    childSessionId: string;
    /**
     * `failed` 也是一个合法的即时结果：去程遇到不会自愈的原因（最典型是没登录）时，
     * 委派在返回前就已经收口。发起方的模型据此当场知道「这活没派出去」，而不是拿到
     * 一个「排队中」的假承诺再永远等下去。
     */
    status: 'queued' | 'waiting' | 'running' | 'failed';
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
    const db = getDbClient().drizzle;
    const preflight = await resolveDelegationPreflight(input);
    if (!preflight.ok) return preflight;
    const { caller, parentDepth, maxDepth, lineage, timeoutMs, hardDeadlineAt } = preflight;
    if (lineage.includes(input.targetBotId)) {
      return {
        ok: false,
        errorCode: 'DELEGATION_CYCLE',
        message: '目标 Bot 已在当前委派链中，拒绝形成循环',
      };
    }
    const [target] = await db
      .select()
      .from(botProfiles)
      .where(and(eq(botProfiles.id, input.targetBotId), eq(botProfiles.status, 'active')))
      .limit(1);
    if (!target) {
      return { ok: false, errorCode: 'BOT_NOT_FOUND', message: '目标 Bot 不存在或已停用' };
    }
    const [version] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, target.id),
          eq(botProfileVersions.version, target.currentVersion),
        ),
      )
      .limit(1);
    if (!version) {
      return { ok: false, errorCode: 'PROFILE_NOT_FOUND', message: '目标 Bot Profile 版本不存在' };
    }
    const contextRefs = normalizeDelegationReferences(input.contextRefs);
    if (!contextRefs.ok) return contextRefs;
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
    const createdAt = now();
    const deadlineAt = Math.min(createdAt + timeoutMs, hardDeadlineAt);
    const workingDir = await ensureBotWorkspaceDir(
      ownerScopedUserDataPath(),
      target.id,
      app.getPath('userData'),
    );
    const config = parseRecord(version.capabilitiesJson);
    const permissionMode = targetPermissionMode(config, caller.permissionMode);
    const plan: BotDelegationPlanSnapshot = {
      version: 1,
      createdAt,
      targetBotId: target.id,
      targetCanonicalSessionId: targetCanonical.sessionId,
      target: configuredCapabilitySnapshot({
        version: target.currentVersion,
        capabilitiesJson: version.capabilitiesJson,
        identitySource: version.identitySource,
      }),
      access: { contextRefs: contextRefs.refs },
      completionTarget: { parentSessionId: input.callerSessionId },
      limits: { maxDepth, timeoutMs, deadlineAt },
      permission: {
        mode: permissionMode,
        requesterMode: caller.permissionMode ?? null,
        targetConfigured: config.permissions === 'trusted' ? 'trusted' : 'ask',
      },
    };
    const execution = botExecutionRowFields(config);
    const started = await startDelegation({
      caller,
      callerSessionId: input.callerSessionId,
      targetBotId: target.id,
      targetProfileVersion: target.currentVersion,
      targetDisplayName: target.displayName,
      objective,
      contextRefs: contextRefs.refs,
      lineage,
      parentDepth,
      plan,
      session: {
        workingDir,
        model: plan.target!.model,
        ...execution,
        agentKind: plan.target!.agentKind,
        permissionMode,
        title: `${target.displayName} · ${objective.split('\n')[0]!.slice(0, 60)}`,
      },
    });
    if (!started.ok) return started;
    return {
      ok: true,
      delegationId: started.delegationId,
      childSessionId: started.childSessionId,
      status: started.status,
      targetBotId: target.id,
      targetBotName: target.displayName,
      depth: parentDepth + 1,
      deadlineAt: started.deadlineAt,
    };
  };

  /**
   * 把一件大活开成一条**普通 Cindy 任务**。子任务出现在用户的主任务列表里,
   * 有完整的 Cindy 能力面与自己的权限门;发起方拿到同一张协作卡与同一条完成
   * 信号 —— 伙伴自己保持轻量,重活交给真正的 Cindy 会话。
   */
  const delegateToCindy = async (
    input: DelegateToCindyInput,
  ): Promise<BotDelegationResult<{
    delegationId: string;
    childSessionId: string;
    status: 'queued' | 'waiting' | 'running' | 'failed';
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
    const db = getDbClient().drizzle;
    const preflight = await resolveDelegationPreflight(input);
    if (!preflight.ok) return preflight;
    const { caller, parentDepth, maxDepth, lineage, timeoutMs, hardDeadlineAt } = preflight;
    // 子任务是普通 Cindy 任务,执行路由沿用发起方会话当前的运行配置 ——
    // 这是用户为这个伙伴选过的模型面,不引入任何隐藏的额外模型依赖。
    const [callerSession] = await db
      .select({
        model: sessions.model,
        agentKind: sessions.agentKind,
        providerId: sessions.providerId,
        effort: sessions.effort,
        fastMode: sessions.fastMode,
      })
      .from(sessions)
      .where(eq(sessions.id, input.callerSessionId))
      .limit(1);
    if (!callerSession) {
      return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于 Cindy Bot' };
    }
    let workingDir = input.workingDir?.trim() || '';
    if (workingDir) {
      const isDirectory = (() => {
        try {
          return statSync(workingDir).isDirectory();
        } catch {
          return false;
        }
      })();
      if (!path.isAbsolute(workingDir) || !existsSync(workingDir) || !isDirectory) {
        return {
          ok: false,
          errorCode: 'INVALID_WORKING_DIR',
          message: 'working_dir 必须是已存在的绝对路径',
        };
      }
    } else {
      workingDir = await ensureBotWorkspaceDir(
        ownerScopedUserDataPath(),
        caller.botId,
        app.getPath('userData'),
      );
    }
    const createdAt = now();
    const deadlineAt = Math.min(createdAt + timeoutMs, hardDeadlineAt);
    const plan: BotDelegationPlanSnapshot = {
      version: 1,
      createdAt,
      targetBotId: null,
      access: { contextRefs: [] },
      completionTarget: { parentSessionId: input.callerSessionId },
      limits: { maxDepth, timeoutMs, deadlineAt },
      permission: {
        mode: 'ask',
        requesterMode: caller.permissionMode ?? null,
        targetConfigured: 'ask',
      },
    };
    const title = input.title?.trim() || objective.split('\n')[0]!.slice(0, 60);
    const started = await startDelegation({
      caller,
      callerSessionId: input.callerSessionId,
      targetBotId: null,
      targetProfileVersion: null,
      targetDisplayName: 'Cindy',
      objective,
      contextRefs: [],
      lineage,
      parentDepth,
      plan,
      session: {
        workingDir,
        model: callerSession.model,
        ...(callerSession.effort ? { effort: callerSession.effort } : {}),
        ...(callerSession.fastMode !== null && callerSession.fastMode !== undefined
          ? { fastMode: callerSession.fastMode }
          : {}),
        ...(callerSession.providerId ? { providerId: callerSession.providerId } : {}),
        agentKind: callerSession.agentKind as 'cc' | 'codex' | 'pi',
        // 普通任务的默认权限门:每一步该问的照问,不继承伙伴的信任档。
        permissionMode: 'ask',
        title,
      },
    });
    if (!started.ok) return started;
    return {
      ok: true,
      delegationId: started.delegationId,
      childSessionId: started.childSessionId,
      status: started.status,
      depth: parentDepth + 1,
      deadlineAt: started.deadlineAt,
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
    return {
      ok: true,
      delegations: rows.map((row) => ({
        ...row,
        targetBotName: row.targetBotId
          ? profileNames.get(row.targetBotId) ?? row.targetBotId
          : 'Cindy',
        contextRefs: parseStringArray(row.contextRefsJson),
        lineage: parseStringArray(row.lineageJson),
        permissionSnapshot: parseRecord(row.permissionSnapshotJson),
      })) as BotDelegationView[],
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

  /**
   * 向一个**仍在进行**的委派补一句话：催促、补充条件、修正方向。
   *
   * 为什么需要单独的通道：子任务本身早就支持排队输入，缺的是「从发起方那一侧」
   * 合法地投进去的入口——直接按 sessionId 发消息会绕开归属校验，把任意会话变成
   * 任意 Bot 子任务的输入源。这里把三件事一次做完：
   *  - **归属**：委派必须由调用会话发起（parentSessionId 命中），且属于调用者这个
   *    Bot。两条都查，任一不符按 NOT_FOUND 处理，不泄露「有这么个委派」。
   *  - **状态**：只接受 queued / running / waiting。终态明确报错，绝不复活已收口的
   *    委派，也不会让插话变成「给已归档子任务发消息」。
   *  - **幂等**：clientId 决定去重。同一 token 重发落到同一条消息上（dispatch 侧按
   *    clientId 查已落库行），重试不会催两遍。
   *
   * 权限边界不放宽：投递复用发起委派时冻结的子任务，不新建会话、不改权限档、不碰
   * 目标 Bot 的任何配置。子任务正忙时按会话既有语义入队，当前回合结束后被读到。
   */
  const interjectDelegation = async (
    callerSessionId: string,
    delegationId: string,
    text: string,
    idempotencyToken?: string,
  ): Promise<BotDelegationInterjectResult> => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: '插话内容不能为空' };
    }
    if (trimmed.length > MAX_INTERJECTION_CHARS) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: `插话内容超过 ${MAX_INTERJECTION_CHARS} 字，请改用新的委派`,
      };
    }
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
          eq(botDelegations.parentSessionId, callerSessionId),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, errorCode: 'NOT_FOUND', message: 'Bot delegation 不存在' };
    if (!isActiveDelegation(row.status as DelegationStatus)) {
      return {
        ok: false,
        errorCode: 'ALREADY_TERMINAL',
        message: `Bot delegation 已是终态 ${row.status}，无法再插话`,
      };
    }
    if (!row.childSessionId) {
      return {
        ok: false,
        errorCode: 'CHILD_SESSION_MISSING',
        message: 'Bot delegation 子任务尚未就绪',
      };
    }
    // token 只做幂等键，不进正文；限死字符集免得脏值污染 clientId 空间。
    const token = (idempotencyToken ?? createId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
      || createId();
    const requesterName = await requesterDisplayName(caller.botId);
    const dispatched = await deps.dispatch({
      targetSessionId: row.childSessionId,
      message: [`[来自 ${requesterName} 的补充]`, trimmed].join('\n\n'),
      persistedContent: [`[来自 ${requesterName} 的补充]`, trimmed].join('\n\n'),
      clientId: BOT_DELEGATION_CLIENT_ID.interjection(delegationId, token),
    });
    if (!dispatched?.ok) {
      return {
        ok: false,
        errorCode: dispatched?.errorCode ?? 'DISPATCH_FAILED',
        message: dispatched?.message ?? '插话未能送达子任务',
      };
    }
    // 发起方视角的留痕：催过什么、催过几次，重开会话仍在。写不进去不回滚投递
    // ——话已经送到了，回滚只会让两边记账不一致。
    await persistTimelineMessage({
      sessionId: callerSessionId,
      clientId: BOT_DELEGATION_CLIENT_ID.interjectionMirror(delegationId, token),
      role: 'assistant',
      content: trimmed,
      createdAt: now(),
      agentMeta: {
        botCollaboration: await collaborationMeta(row, 'interjection'),
      },
    }).catch((error) => {
      log.warn('failed to mirror a Bot delegation interjection into the requesting task', {
        delegationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    emitChanged({
      delegationId: row.id,
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      status: row.status as DelegationStatus,
    });
    return {
      ok: true,
      delegationId,
      childSessionId: row.childSessionId,
      queued: dispatched.wakeKind === 'queued',
    };
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
    const status: Extract<DelegationStatus, 'completed' | 'failed'> =
      params.outcome === 'done' ? 'completed' : 'failed';
    const lastError = params.error ?? null;
    // done.result 不是字符串时(部分 Pi / 订阅档位只把终答写进消息行)不能把空结果
    // 当成「对方什么都没说」——发起方会被叫醒,但手里是一段没 Result 的废话墙。
    const recoveredText = params.resultText?.trim()
      || (params.outcome === 'done'
        ? (await readLatestAssistantText(params.childSessionId))?.trim() ?? ''
        : '');
    const resultSummary = recoveredText.slice(0, MAX_RESULT_CHARS) || null;
    const changed = await updateTerminal({
      delegationId: row.id,
      status,
      resultSummary,
      lastError,
      tokensUsed,
    });
    if (!changed) return;
    await deliverCompletion({
      ...row,
      status,
      resultSummary,
      lastError,
    });
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
    ensureCanonicalSession: async (botId: string) => {
      const [profile] = await getDbClient().drizzle
        .select({ id: botProfiles.id, currentVersion: botProfiles.currentVersion, status: botProfiles.status })
        .from(botProfiles)
        .where(eq(botProfiles.id, botId))
        .limit(1);
      if (!profile || profile.status !== 'active') {
        return { ok: false as const, errorCode: 'TARGET_BOT_INACTIVE', message: '目标 Bot 已暂停或归档' };
      }
      return ensureTargetCanonicalSession({ id: profile.id, currentVersion: profile.currentVersion });
    },
    listDelegations,
    delegateToCindy,
    cancelDelegation,
    interjectDelegation,
    cancelDelegationsForParentSession,
    cancelDelegationsForBot,
    settleSession,
    restore,
    dispose,
  };
}

export type BotDelegationService = ReturnType<typeof createBotDelegationService>;
