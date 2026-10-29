/**
 * get_task_digest 的 Desktop 数据源:把 `taskDigest.ts` 的纯组装接到本机数据库、会话控制、
 * 观察层与跨电脑只读通路上。跨电脑只走已有、已在被控端白名单里的读通道
 * (local-db:sessions:get / maker:list-active / 历史消息 / PR 引用与状态),不新增 wire 协议。
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { InvokeResultPayload } from '@cindy/device-link';
import type { HistoryDevice, TaskDigestRoute } from '@cindy/mcps';
import type { AgentKind } from '@cindy/model-providers';

import { deriveFollowUpUsage, suggestFollowUpRoute } from '../bot-autonomy/followUpRoute.js';
import { parseActiveSessionList } from '../bot-autonomy/phase.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfileVersions, botSessionLinks, sessions } from '../localDb/schema.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { readEffectiveBotModelChain } from '../maker-host/bot-model-chain-settings-store.js';
import { resolveConfiguredContextWindow } from '../maker-host/model-context-settings.js';
import { lookupVerifiedContextWindow } from '../maker-ipc/contextOverflowRollover.js';
import { getSessionRuntimeControlSnapshot } from '../maker-ipc/sessionRuntimeControl.js';
import { readWatchedSession } from '../maker-ipc/botWorkbenchAutonomyBridge.js';
import { lastExchange, readSessionLastExchange } from '../maker-ipc/botWorkbenchTranscripts.js';
import type { BotHarness } from '../../shared/botModelChain.js';
import { readChatHistoryMessages } from './remoteChatHistory.js';
import {
  formatPrStatuses,
  historyContentText,
  sessionFactsFromRow,
  type TaskDigestActivity,
  type TaskDigestDeps,
} from './taskDigest.js';

type Invoke = (deviceId: string, channel: string, args: unknown[]) => Promise<InvokeResultPayload>;

interface RuntimeLike {
  phase?: unknown;
  interactionKind?: unknown;
  startedAtMs?: unknown;
  lastActivityAtMs?: unknown;
  runtimeGeneration?: unknown;
  effectiveProfile?: { agentKind?: unknown; model?: unknown; providerId?: unknown; effort?: unknown; fastMode?: unknown };
}

export interface DesktopTaskDigestHost {
  invokeRemote: Invoke;
  listDevices?: () => Promise<HistoryDevice[]>;
  getSessionRuntime(sessionId: string): Promise<{ ok: true; runtime: RuntimeLike } | { ok: false }>;
  listSessionQueuedCounts(sessionIds: string[]): Promise<{ ok: true; counts: Record<string, number> } | { ok: false }>;
  /** 本机任务的 PR 状态(git-context 同一服务与缓存)。 */
  readSessionPrStatuses(sessionId: string): Promise<Parameters<typeof formatPrStatuses>[0]>;
  /**
   * 运行时对这件任务的读数:当前 runtime 的上下文用量(没有在跑为 null)、上一段 runtime 关闭那一刻
   * 固化的用量(没有为 null),与本轮终态错误的结构化字段(摘要投影里没有 sdkError / errorStatus / codexErrorInfo)。
   */
  readRuntimeFacts?(sessionId: string): Promise<{
    live: { contextTokens: number; contextWindow: number } | null;
    closed: { contextTokens: number; contextWindow: number } | null;
    terminalError: { sdkError?: string; errorStatus?: number; codexErrorInfo?: string } | null;
  }>;
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function routeFromProfile(profile: RuntimeLike['effectiveProfile']): TaskDigestRoute | null {
  if (!profile || typeof profile.model !== 'string' || !profile.model) return null;
  const kind = profile.agentKind;
  return {
    harness: kind === 'codex' || kind === 'pi' ? kind : 'claude-code',
    model: profile.model,
    provider_id: typeof profile.providerId === 'string' ? profile.providerId : null,
    effort: typeof profile.effort === 'string' ? profile.effort : null,
    fast: (profile.fastMode === 'ultrafast' ? 'ultrafast' : profile.fastMode === true),
  };
}

const toBotHarness = (harness: TaskDigestRoute['harness']): BotHarness => (harness === 'claude-code' ? 'claude' : harness);
const toDigestHarness = (harness: BotHarness): TaskDigestRoute['harness'] => (harness === 'claude' ? 'claude-code' : harness);
const toAgentKind = (harness: BotHarness): AgentKind => (harness === 'claude' ? 'claude-code' : harness);

/** 目录里核实过的窗口(与主机切换闸门同一口径);查不到返回 null。 */
function verifiedRouteWindow(harness: BotHarness, model: string, providerId: string | null): number | null {
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

/** 工作台跨电脑读取用:那台电脑上一件任务最近的用户 / 助手文字(时间正序)。 */
export function createRemoteWorkbenchMessageReader(invoke: Invoke) {
  return async (deviceId: string, sessionId: string) => {
    const result = await readRemoteMessageItems(invoke, deviceId, sessionId, 60);
    return result.ok ? result : { ok: false as const, errorCode: result.errorCode, message: result.message };
  };
}

export function createDesktopTaskDigestDeps(host: DesktopTaskDigestHost): TaskDigestDeps {
  return {
    now: () => Date.now(),
    watched: readWatchedSession,
    local: {
      readSession: async (sessionId) => {
        const [row] = await getDbClient()
          .drizzle.select({
            title: sessions.title,
            status: sessions.status,
            source: sessions.source,
            agentKind: sessions.agentKind,
            model: sessions.model,
            providerId: sessions.providerId,
            effort: sessions.effort,
            fastMode: sessions.fastMode,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        return row ? sessionFactsFromRow(row) : null;
      },
      readActivity: async (sessionId): Promise<TaskDigestActivity | null> => {
        const result = await host.getSessionRuntime(sessionId);
        if (!result.ok) return null;
        const runtime = result.runtime;
        return {
          phase: typeof runtime.phase === 'string' ? runtime.phase : 'idle',
          interactionKind: typeof runtime.interactionKind === 'string' ? runtime.interactionKind : null,
          startedAtMs: num(runtime.startedAtMs),
          lastActivityAtMs: num(runtime.lastActivityAtMs),
          runtimeGeneration: num(runtime.runtimeGeneration),
          route: routeFromProfile(runtime.effectiveProfile),
        };
      },
      readLastExchange: readSessionLastExchange,
      queuedCount: async (sessionId) => {
        const result = await host.listSessionQueuedCounts([sessionId]);
        return result.ok ? (result.counts[sessionId] ?? 0) : null;
      },
      prStatus: async (sessionId) => formatPrStatuses(await host.readSessionPrStatuses(sessionId)),
      suggestRoute: async ({ callerSessionId, targetSessionId, current, failure }) => {
        if (!callerSessionId) return null;
        const chain = await readCallerBotChain(callerSessionId);
        if (!chain?.length) return null;
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
          chain,
          current: { harness, model: current.model, providerId: current.provider_id },
          failure: { ...failure, ...(failure.phase === 'errored' ? runtime?.terminalError ?? {} : {}) },
          visitedRoutes: getSessionRuntimeControlSnapshot(targetSessionId).visitedRoutes,
          sameHarnessOnly: !!target?.remoteHostId,
          contextTokens: usage.contextTokens,
          currentContextWindow: usage.contextWindow ?? verifiedRouteWindow(harness, current.model, current.provider_id),
          windowOf: (candidate) => verifiedRouteWindow(candidate.harness, candidate.model, candidate.providerId),
        });
        return next
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
      readLastExchange: async (deviceId, sessionId) => {
        const result = await readRemoteMessageItems(host.invokeRemote, deviceId, sessionId, 20);
        return result.ok ? lastExchange(result.items) : { lastUserAsk: null, lastAssistantLine: null };
      },
      prStatus: async (deviceId, sessionId) => {
        const refs = (await unwrap(host.invokeRemote, deviceId, 'git-context:pr-refs:list', [sessionId])) as Array<{
          owner?: unknown;
          repo?: unknown;
          prNumber?: unknown;
        }> | null;
        const queries = (Array.isArray(refs) ? refs : [])
          .filter((ref) => typeof ref.owner === 'string' && typeof ref.repo === 'string' && typeof ref.prNumber === 'number')
          .slice(0, 3)
          .map((ref) => ({ owner: ref.owner, repo: ref.repo, prNumber: ref.prNumber }));
        if (queries.length === 0) return null;
        const statuses = await unwrap(host.invokeRemote, deviceId, 'git-context:pr-status', [{ sessionId, queries }]);
        return Array.isArray(statuses) ? formatPrStatuses(statuses as Parameters<typeof formatPrStatuses>[0]) : null;
      },
    },
  };
}
