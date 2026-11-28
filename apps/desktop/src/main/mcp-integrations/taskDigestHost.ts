import { remotePrStatuses, prStatusQuery, type PrIdentity } from '@cindy/maker-shared';
/**
 * get_task_digest 的 Desktop 数据源:把 `taskDigest.ts` 的纯组装接到本机数据库、会话控制、
 * 观察层与跨电脑只读通路上。跨电脑只走已有、已在被控端白名单里的读通道
 * (local-db:sessions:get / maker:list-active / 历史消息 / PR 引用与状态),不新增 wire 协议。
 */
import { and, eq, isNull } from 'drizzle-orm';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';
import type { InvokeResultPayload } from '@cindy/device-link';
import type { HistoryDevice, TaskDigestCurrentRoute, TaskDigestRoute } from '@cindy/mcps';
import { isProviderSafetyRefusalError, PROVIDER_SAFETY_REFUSAL_REASON } from '@cindy/maker-shared/error-redaction';
import type { AgentKind } from '@cindy/model-providers';

import { getDbClient } from '../localDb/client/current.js';
import { botProfileVersions, botSessionLinks, sessions } from '../localDb/schema.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { readEffectiveBotModelChain } from '../maker-host/bot-model-chain-settings-store.js';
import { resolveConfiguredContextWindow } from '../maker-host/model-context-settings.js';
import { lookupVerifiedContextWindow } from '../maker-ipc/contextOverflowRollover.js';
import { readLatestWorkerTurnError } from '../maker-ipc/orcaTurnErrorQuery.js';
import { getSessionRuntimeControlSnapshot } from '../maker-ipc/sessionRuntimeControl.js';
import { backgroundTurnPredatesSessionClear } from '../messagePersistBroadcaster.desktop.js';
import { lastExchange, readSessionLastExchange } from '../maker-ipc/sessionLastExchange.js';
import type { BotHarness } from '../../shared/botModelChain.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import { deriveFollowUpUsage, suggestFollowUpRoute } from './followUpRoute.js';
import { readChatHistoryMessages } from './remoteChatHistory.js';
import { parseActiveSessionList } from './taskPhase.js';
import {
  formatPrStatuses,
  historyContentText,
  parseTaskDigestRouteChange,
  sessionFactsFromRow,
  type TaskDigestActivity,
  type TaskDigestDeps,
} from './taskDigest.js';

type Invoke = (deviceId: string, channel: string, args: unknown[]) => Promise<InvokeResultPayload>;

interface RuntimeLike {
  phase?: unknown;
  source?: unknown;
  interactionKind?: unknown;
  startedAtMs?: unknown;
  lastActivityAtMs?: unknown;
  runtimeGeneration?: unknown;
  effectiveProfile?: {
    agentDeviceId?: unknown;
    agentKind?: unknown;
    model?: unknown;
    providerId?: unknown;
    effort?: unknown;
    fastMode?: unknown;
  };
  routeSource?: {
    kind?: unknown;
    providerDeviceId?: unknown;
    providerDeviceName?: unknown;
  };
  lastRouteChange?: unknown;
}

export interface DesktopTaskDigestHost {
  invokeRemote: Invoke;
  listDevices?: () => Promise<HistoryDevice[]>;
  /** Privacy-safe display name for a local/own-device provider location; strictly null for share:. */
  describeAgentDevice?: (deviceId: string | null) => string | null;
  /** Fallback persisted route-change reader (used when runtime details are unavailable, e.g. ACP tasks). */
  readPersistedRouteChange?: (sessionId: string) => Promise<unknown>;
  getSessionRuntime(sessionId: string): Promise<{ ok: true; runtime: RuntimeLike } | { ok: false }>;
  listSessionQueuedCounts(sessionIds: string[]): Promise<{ ok: true; counts: Record<string, number> } | { ok: false }>;
  readLocalQueuePaused?(sessionId: string): boolean | undefined;
  /** 本机任务的 PR 状态(git-context 同一服务与缓存)。 */
  readSessionPrStatuses(sessionId: string): Promise<Parameters<typeof formatPrStatuses>[0]>;
  /**
   * 运行时对这件任务的读数:当前 runtime 的上下文用量(没有在跑为 null)、上一段 runtime 关闭那一刻
   * 固化的用量(没有为 null),与本轮终态错误的结构化字段(摘要投影里没有 sdkError / errorStatus / codexErrorInfo)。
   */
  readRuntimeFacts?(sessionId: string): Promise<{
    live: { contextTokens: number; contextWindow: number } | null;
    closed: { contextTokens: number; contextWindow: number } | null;
    terminalError: { message?: string; sdkError?: string; errorStatus?: number; codexErrorInfo?: string } | null;
  }>;
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function visibleLocalRouteChange(sessionId: string, value: unknown, clearedAt?: number | null) {
  const change = parseTaskDigestRouteChange(value);
  if (!change) return null;
  const at = Date.parse(change.at);
  return (clearedAt != null && at <= clearedAt) || backgroundTurnPredatesSessionClear(sessionId, at)
    ? null : change;
}

function routeFromProfile(
  profile: RuntimeLike['effectiveProfile'],
  routeSource?: RuntimeLike['routeSource'],
  describeAgentDevice?: DesktopTaskDigestHost['describeAgentDevice'],
): TaskDigestCurrentRoute | null {
  if (!profile || typeof profile.model !== 'string' || !profile.model) return null;
  const kind = profile.agentKind;
  const hasDeviceInfo =
    ('agentDeviceId' in profile && profile.agentDeviceId !== undefined) || routeSource !== undefined;
  const rawDeviceId =
    typeof profile.agentDeviceId === 'string' && profile.agentDeviceId.trim()
      ? profile.agentDeviceId.trim()
      : null;
  const providerDeviceId =
    typeof routeSource?.providerDeviceId === 'string' && routeSource.providerDeviceId.trim()
      ? routeSource.providerDeviceId.trim()
      : (rawDeviceId ?? 'local');
  const sourceKind: 'local' | 'device' | 'share' =
    routeSource?.kind === 'local' || routeSource?.kind === 'device' || routeSource?.kind === 'share'
      ? routeSource.kind
      : !rawDeviceId
        ? 'local'
        : isProviderShareAgentDeviceId(rawDeviceId)
          ? 'share'
          : 'device';
  const providerDeviceName =
    sourceKind === 'share'
      ? null
      : typeof routeSource?.providerDeviceName === 'string'
        ? routeSource.providerDeviceName
        : routeSource?.providerDeviceName === null
          ? null
          : describeAgentDevice
            ? describeAgentDevice(rawDeviceId)
            : undefined;
  return {
    harness: kind === 'codex' || kind === 'pi' || kind === 'acp' ? kind : 'claude-code',
    model: profile.model,
    provider_id: typeof profile.providerId === 'string' ? profile.providerId : null,
    effort: typeof profile.effort === 'string' ? profile.effort : null,
    fast: (profile.fastMode === 'ultrafast' ? 'ultrafast' : profile.fastMode === true),
    ...(hasDeviceInfo
      ? {
          provider_device_id: providerDeviceId,
          source_kind: sourceKind,
          ...(providerDeviceName !== undefined ? { provider_device_name: providerDeviceName } : {}),
        }
      : {}),
  };
}

type BuiltinBotHarness = Exclude<BotHarness, 'acp'>;
const toBotHarness = (harness: TaskDigestRoute['harness']): BuiltinBotHarness => (harness === 'claude-code' ? 'claude' : harness);
const toDigestHarness = (harness: BuiltinBotHarness): TaskDigestRoute['harness'] => (harness === 'claude' ? 'claude-code' : harness);
const toAgentKind = (harness: BuiltinBotHarness): AgentKind => (harness === 'claude' ? 'claude-code' : harness);

/** 目录里核实过的窗口(与主机切换闸门同一口径);查不到返回 null。 */
function verifiedRouteWindow(harness: BotHarness, model: string, providerId: string | null): number | null {
  if (harness === 'acp') return null;
  const catalog = getActiveCatalog();
  return lookupVerifiedContextWindow(
    (agentKind, modelId, pid) => resolveConfiguredContextWindow(catalog, agentKind as AgentKind, pid, modelId),
    model,
    providerId,
    toAgentKind(harness),
  );
}

/** 调用方伙伴(主任务)的有效候选链。非伙伴调用方返回 null。 */
async function readCallerBotChain(callerSessionId: string) {
  const [row] = await getDbClient()
    .drizzle.select({ capabilitiesJson: botProfileVersions.capabilitiesJson })
    .from(botSessionLinks)
    .innerJoin(
      botProfileVersions,
      and(
        eq(botProfileVersions.botId, botSessionLinks.botId),
        eq(botProfileVersions.version, botSessionLinks.profileVersion),
      ),
    )
    .where(and(eq(botSessionLinks.sessionId, callerSessionId), isNull(botSessionLinks.archivedAt)))
    .limit(1);
  if (!row) return null;
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.capabilitiesJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return readEffectiveBotModelChain(config);
}

async function unwrap(invoke: Invoke, deviceId: string, channel: string, args: unknown[]): Promise<unknown> {
  const response = await invoke(deviceId, channel, args);
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result;
}

async function readRemoteMessageItems(invoke: Invoke, deviceId: string, sessionId: string, limit: number) {
  const result = await readChatHistoryMessages(
    {
      sessionIds: [`${deviceId}::${sessionId}`],
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: ['user', 'assistant'],
      includeRewound: false,
      limit,
      cursor: null,
      order: 'desc',
    },
    {
      readLocal: async () => {
        throw new Error('local read not expected');
      },
      invokeRemote: invoke,
    },
  );
  if (!result.ok) return result;
  return {
    ok: true as const,
    items: result.page.items
      .slice()
      .reverse()
      .map((message) => ({
        role: (message.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        text: historyContentText(message.content),
        at: message.createdAt,
      })),
  };
}

export function createDesktopTaskDigestDeps(host: DesktopTaskDigestHost): TaskDigestDeps {
  return {
    now: () => Date.now(),
    // The V1 follow-up watch is gone: the digest derives the phase from live activity.
    watched: () => null,
    local: {
      readSession: async (sessionId) => {
        const [row] = await getDbClient()
          .drizzle.select({
            title: sessions.title,
            pinnedAt: sessions.pinnedAt,
            clearedAt: sessions.clearedAt,
            activeTurnStartedAt: sessions.activeTurnStartedAt,
            lastTurnEndedAt: sessions.lastTurnEndedAt,
            status: sessions.status,
            source: sessions.source,
            agentKind: sessions.agentKind,
            agentDeviceId: sessions.agentDeviceId,
            model: sessions.model,
            providerId: sessions.providerId,
            effort: sessions.effort,
            fastMode: sessions.fastMode,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!row) return null;
        const facts = sessionFactsFromRow(row);
        if (!facts) return null;
        if (!facts.shared && facts.route?.provider_device_id && facts.route.provider_device_name === undefined) {
          if (facts.route.source_kind === 'share') {
            facts.route = { ...facts.route, provider_device_name: null };
          } else if (host.describeAgentDevice) {
            const rawId = facts.route.provider_device_id === 'local' ? null : facts.route.provider_device_id;
            facts.route = { ...facts.route, provider_device_name: host.describeAgentDevice(rawId) };
          }
        }
        if (!facts.shared && !facts.lastRouteChange) {
          const inMemory = getSessionRuntimeControlSnapshot(sessionId).lastRouteChange;
          const persisted = inMemory ?? (host.readPersistedRouteChange
            ? await host.readPersistedRouteChange(sessionId).catch(() => null)
            : null);
          const visible = visibleLocalRouteChange(sessionId, persisted, facts.clearedAt);
          if (visible) facts.lastRouteChange = visible;
        }
        return facts;
      },
      readActivity: async (sessionId): Promise<TaskDigestActivity | null> => {
        const result = await host.getSessionRuntime(sessionId);
        if (!result.ok) return null;
        const runtime = result.runtime;
        const candidateRouteChange = runtime.lastRouteChange === undefined
          ? getSessionRuntimeControlSnapshot(sessionId).lastRouteChange
          : runtime.lastRouteChange;
        const lastRouteChange = visibleLocalRouteChange(sessionId, candidateRouteChange);
        return {
          phase: typeof runtime.phase === 'string' ? runtime.phase : 'idle',
          source: typeof runtime.source === 'string' ? runtime.source : undefined,
          interactionKind: typeof runtime.interactionKind === 'string' ? runtime.interactionKind : null,
          startedAtMs: num(runtime.startedAtMs),
          lastActivityAtMs: num(runtime.lastActivityAtMs),
          runtimeGeneration: num(runtime.runtimeGeneration),
          route: routeFromProfile(runtime.effectiveProfile, runtime.routeSource, host.describeAgentDevice),
          ...(lastRouteChange || runtime.lastRouteChange === null || candidateRouteChange != null
            ? { lastRouteChange }
            : {}),
        };
      },
      readError: async (sessionId, activity, facts) => {
        if (activity?.phase !== 'error') return null;
        const runtime = await host.readRuntimeFacts?.(sessionId).catch(() => null);
        const terminal = runtime?.terminalError;
        if (terminal) {
          const detail = [
            typeof terminal.errorStatus === 'number' ? `HTTP ${terminal.errorStatus}` : '',
            terminal.message,
            terminal.sdkError,
            terminal.codexErrorInfo,
          ].filter(Boolean).join(':\n');
          // Preserve line boundaries until the reader's final redaction/bounding pass.
          if (detail.trim()) return detail;
        }
        // This reader already enforces the tail, rewind and /clear boundaries.
        const stored = await readLatestWorkerTurnError(sessionId);
        if (!stored) return null;
        const startedAt = Math.max(facts.startedAtMs ?? 0, activity.startedAtMs ?? 0);
        if (stored.createdAt < startedAt) {
          // An immediate failure can be ordered after the input but dated before the
          // turn marker. Only the confirmed persisted terminal of a settled turn can
          // supply a safety reason here. Never return its provider text on this path.
          const matchesSettledTerminal =
            activity.source === 'persisted'
            && activity.lastActivityAtMs === stored.createdAt
            && facts.startedAtMs === activity.startedAtMs
            && (facts.endedAtMs ?? 0) >= startedAt;
          return matchesSettledTerminal && isProviderSafetyRefusalError(stored.message, stored.reason)
            ? PROVIDER_SAFETY_REFUSAL_REASON
            : null;
        }
        return [stored.message, stored.sdkError].filter(Boolean).join(':\n').trim() || null;
      },
      readLastExchange: readSessionLastExchange,
      queuedCount: async (sessionId) => {
        const result = await host.listSessionQueuedCounts([sessionId]);
        return result.ok ? (result.counts[sessionId] ?? 0) : null;
      },
      queuePaused: (sessionId) => host.readLocalQueuePaused?.(sessionId),
      prStatus: async (sessionId) => formatPrStatuses(await host.readSessionPrStatuses(sessionId)),
      suggestRoute: async ({ callerSessionId, targetSessionId, current, failure }) => {
        if (!callerSessionId) return null;
        const chain = await readCallerBotChain(callerSessionId);
        if (!chain?.length) return null;
        const builtinChain = chain.filter((candidate) => candidate.harness !== 'acp');
        if (!builtinChain.length) return null;
        const [target] = await getDbClient()
          .drizzle.select({ remoteHostId: sessions.remoteHostId, contextTokens: sessions.contextTokens })
          .from(sessions)
          .where(eq(sessions.id, targetSessionId))
          .limit(1);
        const harness = toBotHarness(current.harness);
        const runtime = (await host.readRuntimeFacts?.(targetSessionId)) ?? null;
        const usage = deriveFollowUpUsage({
          live: runtime?.live,
          closed: runtime?.closed,
          dbContextTokens: target?.contextTokens,
        });
        const next = suggestFollowUpRoute({
          chain: builtinChain,
          current: { harness, model: current.model, providerId: current.provider_id },
          failure: { ...failure, ...(failure.phase === 'errored' ? runtime?.terminalError ?? {} : {}) },
          visitedRoutes: getSessionRuntimeControlSnapshot(targetSessionId).visitedRoutes,
          sameHarnessOnly: !!target?.remoteHostId,
          contextTokens: usage.contextTokens,
          currentContextWindow: usage.contextWindow ?? verifiedRouteWindow(harness, current.model, current.provider_id),
          windowOf: (candidate) => verifiedRouteWindow(candidate.harness, candidate.model, candidate.providerId),
        });
        return next && next.harness !== 'acp'
          ? {
              harness: toDigestHarness(next.harness),
              model: next.model,
              provider_id: next.providerId,
              effort: next.effort || null,
              fast: next.fastMode,
            }
          : null;
      },
    },
    remote: {
      deviceName: async (deviceId) =>
        (await host.listDevices?.())?.find((device) => device.deviceId === deviceId)?.deviceName ?? null,
      readSession: async (deviceId, sessionId) => {
        try {
          return sessionFactsFromRow(await unwrap(host.invokeRemote, deviceId, 'local-db:sessions:get', [sessionId]));
        } catch (error) {
          if (/NOT_FOUND/.test(error instanceof Error ? error.message : '')) return null;
          throw error;
        }
      },
      readActivity: async (deviceId, sessionId) => {
        const list = parseActiveSessionList(await unwrap(host.invokeRemote, deviceId, 'maker:list-active', [
          { summary: true, snapshotVersion: 2 },
        ]));
        // 认不出的格式按读取失败：摘要退回保守推断，不报成「空闲」。
        if (!list) throw Object.assign(new Error('Unexpected active session list'), { code: 'REMOTE_SHAPE' });
        const row = (list as Array<{ sessionId?: unknown; isTurnRunning?: unknown; activityPhase?: unknown } | null>)
          .find((item) => item?.sessionId === sessionId);
        if (!row) return { phase: 'idle' };
        return { phase: typeof row.activityPhase === 'string' ? row.activityPhase : row.isTurnRunning === true ? 'running' : 'idle' };
      },
      readError: async (deviceId, sessionId, activity, facts) => {
        if (activity?.phase !== 'error' && activity?.phase !== 'idle') return null;
        // One bounded read, using the same authorized history channel as the UI.
        // The terminal marker must refer to this exact error row, not a newer turn.
        const page = await unwrap(host.invokeRemote, deviceId, DL_HISTORY_MESSAGES_CHANNEL, [{
          sessionId, workdir: null,
          fromMs: Math.max((facts.clearedAt ?? 0) + 1, facts.startedAtMs ?? 0),
          toMs: null, agentKind: null, roles: ['error'], includeRewound: false,
          limit: 1, cursor: null, order: 'desc', contentCharLimit: 8000,
        }]) as { items?: Array<{ sessionId?: unknown; role?: unknown; content?: unknown; createdAt?: unknown }>; terminal?: { status?: unknown; createdAt?: unknown } | null };
        const row = page?.items?.[0];
        if (page?.terminal?.status !== 'error' || !row || row.role !== 'error'
          || row.sessionId !== sessionId || typeof row.createdAt !== 'number'
          || row.createdAt !== page.terminal.createdAt
          || row.createdAt <= (facts.clearedAt ?? 0)
          || row.createdAt < (facts.startedAtMs ?? 0)) return null;
        let content = row.content;
        if (typeof content === 'string') {
          try { content = JSON.parse(content); } catch { return null; }
        }
        if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
        const error = content as Record<string, unknown>;
        if (error.dismissed === true) return null;
        return [error.message, error.sdkError]
          .filter((value): value is string => typeof value === 'string').join(':\n').trim() || null;
      },
      readLastExchange: async (deviceId, sessionId) => {
        const result = await readRemoteMessageItems(host.invokeRemote, deviceId, sessionId, 20);
        return result.ok ? lastExchange(result.items) : { lastUserAsk: null, lastAssistantLine: null };
      },
      prStatus: async (deviceId, sessionId) => {
        const refs = (await unwrap(host.invokeRemote, deviceId, 'git-context:pr-refs:list', [
          sessionId,
        ])) as Array<{
          provider?: unknown;
          host?: unknown;
          owner?: unknown;
          repo?: unknown;
          prNumber?: unknown;
        }> | null;
        const queries = (Array.isArray(refs) ? refs : [])
          .filter((ref) => typeof ref.owner === 'string' && typeof ref.repo === 'string' && typeof ref.prNumber === 'number')
          .slice(0, 3)
          .map((ref) => prStatusQuery(ref as PrIdentity));
        if (queries.length === 0) return null;
        const statuses = await remotePrStatuses(queries, sessionId, (channel, args) =>
          unwrap(host.invokeRemote, deviceId, channel, args),
        );
        return Array.isArray(statuses)
          ? formatPrStatuses(statuses as Parameters<typeof formatPrStatuses>[0])
          : null;
      },
    },
  };
}
