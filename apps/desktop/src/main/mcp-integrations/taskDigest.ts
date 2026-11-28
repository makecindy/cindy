/**
 * get_task_digest 的宿主侧组装(纯逻辑,依赖全部注入,便于单测)。
 *
 * 优先用观察层的状态行(phase / 等什么 / 错误 / 谁开的 / 谁在跟,与工作台和事件同一口径);
 * 观察层没有这一行时按活动快照推一个保守的 phase。其余字段各自尽力读取,读不到就是 null,
 * 不因 PR、队列、候选链任一项失败而让整份摘要失败。输出合同(≤300 字 / ≤2KB)由工具层的
 * boundTaskDigest 保证;这里只负责事实。
 */
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { redactLocalPathText } from '../maker-ipc/coldPiRehydrationFailure.js';
import type {
  TaskDigestCurrentRoute,
  TaskDigestPhase,
  TaskDigestRoute,
  TaskDigestRouteChange,
  TaskDigestRouteEndpoint,
  TaskDigestWire,
} from '@cindy/mcps';
import type { WatchedSession } from '../../shared/botAutonomy.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';

type Failure = { ok: false; errorCode: 'NOT_FOUND' | 'REMOTE_UNAVAILABLE' | 'INVALID_ARGS' | 'HOST_NOT_READY' | 'INTERNAL'; message: string };

export interface TaskDigestSessionFacts {
  pinned?: boolean;
  title: string;
  status: string;
  route: TaskDigestCurrentRoute | null;
  lastRouteChange?: TaskDigestRouteChange | null;
  /** 共享给访客的任务(来源 shared):摘要不带对话原文与宿主来源细节。 */
  shared?: boolean;
  clearedAt?: number | null;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
}

export interface TaskDigestActivity {
  phase: string;
  source?: string;
  interactionKind?: string | null;
  startedAtMs?: number | null;
  lastActivityAtMs?: number | null;
  runtimeGeneration?: number | null;
  route?: TaskDigestCurrentRoute | null;
  lastRouteChange?: TaskDigestRouteChange | null;
}

export interface TaskDigestExchange {
  lastUserAsk: string | null;
  lastAssistantLine: string | null;
}

/** 要换模型的那次失败:相位与观察层记下的错误(摘要文案 + 稳定原因)。 */
export interface TaskDigestFailure {
  phase: 'errored' | 'usage-limit';
  error: string | null;
  errorReason: string | null;
}

export interface TaskDigestDeps {
  now(): number;
  /** 观察层状态行;本机裸 id,另一台电脑 deviceId::sessionId。 */
  watched(sessionKey: string): WatchedSession | null;
  local: {
    readSession(sessionId: string): Promise<TaskDigestSessionFacts | null>;
    readActivity(sessionId: string): Promise<TaskDigestActivity | null>;
    readLastExchange(sessionId: string): Promise<TaskDigestExchange>;
    readError?(sessionId: string, activity: TaskDigestActivity | null, facts: TaskDigestSessionFacts): Promise<string | null>;
    queuedCount(sessionId: string): Promise<number | null>;
    queuePaused?(sessionId: string): boolean | undefined;
    prStatus(sessionId: string): Promise<string | null>;
    /**
     * 出错 / 撞上用量上限时,调用方伙伴候选链里下一条可用路线(跳过当前与已试过的)。
     * 换模型解决不了这次失败、任务当前路线不在候选链里、或换过去装不下当前上下文时返回 null;
     * 非伙伴调用方返回 null。
     */
    suggestRoute(params: {
      callerSessionId?: string;
      targetSessionId: string;
      current: TaskDigestRoute;
      failure: TaskDigestFailure;
    }): Promise<TaskDigestRoute | null>;
  };
  remote?: {
    deviceName(deviceId: string): Promise<string | null>;
    /** 读不到(离线 / 未授权)时抛错 → REMOTE_UNAVAILABLE;任务不存在返回 null。 */
    readSession(deviceId: string, sessionId: string): Promise<TaskDigestSessionFacts | null>;
    readActivity(deviceId: string, sessionId: string): Promise<TaskDigestActivity | null>;
    readLastExchange(deviceId: string, sessionId: string): Promise<TaskDigestExchange>;
    readError?(deviceId: string, sessionId: string, activity: TaskDigestActivity | null, facts: TaskDigestSessionFacts): Promise<string | null>;
    prStatus(deviceId: string, sessionId: string): Promise<string | null>;
  };
}

/** 观察层没有状态行时的保守推断:与 phase.ts 同一方向,不猜 usage-limit。 */
export function fallbackDigestPhase(activity: TaskDigestActivity | null): TaskDigestPhase {
  switch (activity?.phase) {
    case 'running':
      return 'running';
    case 'needs-interaction':
      return /permission|approval/i.test(activity.interactionKind ?? '') ? 'waiting-permission' : 'waiting-answer';
    case 'error':
      return 'errored';
    case 'completed':
      return 'finished';
    default:
      return 'idle';
  }
}

/**
 * 观察层是否看到有前台工具调用在途(长时间构建 / 测试时任务看起来像卡住)。观察层只对本机任务
 * 掌握这个事实(另一台电脑的行缺省为 false,并不代表没有),所以只有本机且字段存在时才给出;
 * 否则返回 undefined,摘要里不出现 tool_in_flight,伙伴按「不确定」处理。
 */
export function watchedToolInFlight(watched: WatchedSession | null, local: boolean): boolean | undefined {
  return local && typeof watched?.toolInFlight === 'boolean' ? watched.toolInFlight : undefined;
}

function minutesSince(now: number, since: number | null | undefined): number | null {
  if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) return null;
  return Math.max(0, Math.floor((now - since) / 60_000));
}

/** 一句 PR 状态:最多三个,「PR #12 open,3 条评审未解决」。 */
export function formatPrStatuses(
  results: ReadonlyArray<
    | {
        ok: true;
        provider?: 'github' | 'gitlab';
        host?: string;
        owner?: string;
        prNumber: number;
        repo: string;
        status: string;
        unresolvedCount: number | null;
        checks?: {
          total: number;
          failed: number;
          pending: number;
          passed: number;
          skipped: number;
        } | null;
        observedAt?: number;
      }
    | {
        ok: false;
        provider?: 'github' | 'gitlab';
        host?: string;
        owner?: string;
        prNumber: number;
        repo: string;
      }
  >,
): string | null {
  const parts = results.slice(0, 3).map((pr) => {
    const label =
      pr.provider === 'gitlab'
        ? `MR ${pr.host}/${pr.owner ? `${pr.owner}/` : ''}${pr.repo}!${pr.prNumber}`
        : `PR ${pr.repo}#${pr.prNumber}`;
    if (!pr.ok) return `${label} 状态未知`;
    const unresolved = pr.unresolvedCount ? `,${pr.unresolvedCount} 条评审未解决` : '';
    const c = pr.checks;
    const ci = !c
      ? 'CI 未知'
      : c.failed
        ? `CI ${c.failed} 失败`
        : c.pending
          ? `CI ${c.pending} 进行中`
          : !c.total
            ? '无检查'
            : c.passed === c.total
              ? 'CI 通过'
              : `CI ${c.passed} 通过/${c.skipped} 跳过`;
    const age = pr.observedAt
      ? `,${Math.max(0, Math.floor((Date.now() - pr.observedAt) / 60000))} 分钟前`
      : '';
    return `${label} ${pr.status}${unresolved},${ci}${age}`;
  });
  return parts.length ? parts.join(';') : null;
}

const settle = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await read();
  } catch {
    return fallback;
  }
};

export function createTaskDigestReader(deps: TaskDigestDeps) {
  return async (args: { sessionId: string; callerSessionId?: string }): Promise<
    { ok: true; digest: TaskDigestWire } | Failure
  > => {
    const key = args.sessionId.trim();
    const parts = key.split('::');
    if (!key || parts.length > 2 || parts.some((part) => !part)) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: '任务 id 格式不对:本机写 id,另一台电脑写 deviceId::sessionId' };
    }
    const watched = deps.watched(key);
    const now = deps.now();

    if (parts.length === 2) {
      const [deviceId, sessionId] = parts as [string, string];
      const remote = deps.remote;
      if (!remote) return { ok: false, errorCode: 'REMOTE_UNAVAILABLE', message: '这台电脑没有开启跨电脑读取' };
      let facts: TaskDigestSessionFacts | null;
      try {
        facts = await remote.readSession(deviceId, sessionId);
      } catch (error) {
        return {
          ok: false,
          errorCode: 'REMOTE_UNAVAILABLE',
          message: `读不到那台电脑上的任务(可能离线或未允许远程控制):${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!facts || facts.status === 'deleted') return { ok: false, errorCode: 'NOT_FOUND', message: '那台电脑上没有这件任务' };
      const [activity, exchange, prStatus, deviceName] = await Promise.all([
        settle(() => remote.readActivity(deviceId, sessionId), null),
        settle(() => remote.readLastExchange(deviceId, sessionId), { lastUserAsk: null, lastAssistantLine: null }),
        settle(() => remote.prStatus(deviceId, sessionId), null),
        settle(() => remote.deviceName(deviceId), null),
      ]);
      const phase = watched?.phase ?? fallbackDigestPhase(activity);
      const error = !facts.shared && (phase === 'errored' || (activity?.phase === 'idle' && !watched))
        ? await settle(() => remote.readError?.(deviceId, sessionId, activity, facts) ?? Promise.resolve(null), null)
        : null;
      const remoteRoute = facts.route ? { ...facts.route } : null;
      if (remoteRoute && !facts.shared && remoteRoute.provider_device_id && remoteRoute.provider_device_name === undefined) {
        if (remoteRoute.source_kind === 'share') {
          remoteRoute.provider_device_name = null;
        } else if (remoteRoute.source_kind === 'local') {
          remoteRoute.provider_device_name = watched?.deviceName ?? deviceName ?? null;
        } else if (remoteRoute.source_kind === 'device') {
          remoteRoute.provider_device_name = remoteRoute.provider_device_id === deviceId
            ? (watched?.deviceName ?? deviceName ?? null)
            : await settle(() => remote.deviceName(remoteRoute.provider_device_id!), null);
        }
      }
      const remoteFacts = remoteRoute === facts.route ? facts : { ...facts, route: remoteRoute };
      return {
        ok: true,
        digest: assemble({
          key, now, watched, facts: remoteFacts,
          activity: error && activity?.phase === 'idle' ? { ...activity, phase: 'error' } : activity,
          exchange, prStatus, error,
          local: false,
          device: watched?.deviceName ?? deviceName ?? deviceId,
          queuedCount: null,
          // 跨电脑换模型没有 expected_generation,set_session_runtime 只支持本机:不给建议。
          suggestedRoute: null,
          runtimeGeneration: null,
        }),
      };
    }

    const facts = await deps.local.readSession(key);
    if (!facts || facts.status === 'deleted') return { ok: false, errorCode: 'NOT_FOUND', message: '找不到这件任务,它可能已被删除' };
    const [activity, exchange, prStatus, queuedCount] = await Promise.all([
      settle(() => deps.local.readActivity(key), null),
      settle(() => deps.local.readLastExchange(key), { lastUserAsk: null, lastAssistantLine: null }),
      settle(() => deps.local.prStatus(key), null),
      settle(() => deps.local.queuedCount(key), null),
    ]);
    const current = activity?.route ?? facts.route;
    const phase = watched?.phase ?? fallbackDigestPhase(activity);
    const error = !facts.shared && phase === 'errored'
      ? await settle(() => deps.local.readError?.(key, activity, facts) ?? Promise.resolve(null), null)
      : null;
    // 换模型只用来救出错和用量上限(跟进规则也只在这两种相位用它);其余相位不给建议。
    const suggestedRoute = current && current.harness !== 'acp' && (phase === 'errored' || phase === 'usage-limit')
      ? await settle(() => deps.local.suggestRoute({
        callerSessionId: args.callerSessionId,
        targetSessionId: key,
        current,
        failure: { phase, error: watched?.error ?? null, errorReason: watched?.errorReason ?? null },
      }), null)
      : null;
    return {
      ok: true,
      digest: assemble({
        key, now, watched, facts, activity, exchange, prStatus, queuedCount, suggestedRoute, error,
        queuePaused: facts.shared ? undefined : deps.local.queuePaused?.(key),
        local: true,
        device: null,
        runtimeGeneration: activity?.runtimeGeneration ?? null,
      }),
    };
  };
}

function assemble(input: {
  key: string;
  error: string | null;
  now: number;
  watched: WatchedSession | null;
  facts: TaskDigestSessionFacts;
  activity: TaskDigestActivity | null;
  exchange: TaskDigestExchange;
  prStatus: string | null;
  queuedCount: number | null;
  queuePaused?: boolean;
  suggestedRoute: TaskDigestRoute | null;
  runtimeGeneration: number | null;
  /** 本机任务;另一台电脑上的任务为 false。 */
  local: boolean;
  device: string | null;
}): TaskDigestWire {
  const { watched, activity } = input;
  const phase: TaskDigestPhase = watched?.phase ?? fallbackDigestPhase(activity);
  const toolInFlight = watchedToolInFlight(watched, input.local);
  const since = watched
    ? watched.phaseSince
    : phase === 'running'
      ? (activity?.startedAtMs ?? activity?.lastActivityAtMs)
      : activity?.lastActivityAtMs;
  const rawRoute = activity?.route ?? input.facts.route;
  const currentRoute = rawRoute && input.facts.shared && 'provider_device_name' in rawRoute
    ? (() => {
        const { provider_device_name: _omitted, ...safeRoute } = rawRoute;
        return safeRoute;
      })()
    : rawRoute;
  const lastRouteChange = input.facts.shared
    ? null
    : (activity && 'lastRouteChange' in activity
      ? activity.lastRouteChange ?? null
      : input.facts.lastRouteChange ?? null);
  return {
    session_id: input.key,
    device: input.device,
    ...(input.facts.pinned !== undefined && { pinned: input.facts.pinned }),
    title: watched?.title || input.facts.title,
    phase,
    elapsed_minutes: minutesSince(input.now, since),
    idle_minutes: minutesSince(input.now, watched?.lastActivityAt ?? activity?.lastActivityAtMs),
    // 共享任务里最近一句「用户」可能是访客写的:不交给伙伴当指令看。
    last_user_ask: input.facts.shared ? null : input.exchange.lastUserAsk,
    last_assistant_line: input.facts.shared ? null : input.exchange.lastAssistantLine,
    pending_question: watched?.pendingQuestion ?? null,
    error: input.facts.shared ? null : taskDigestErrorSummary(watched?.error ?? input.error),
    current_route: currentRoute,
    ...(lastRouteChange ? { last_route_change: lastRouteChange } : {}),
    runtime_generation: input.runtimeGeneration,
    suggested_route: input.suggestedRoute,
    pr_status: input.prStatus,
    queued_count: input.queuedCount,
    ...(input.queuePaused === undefined ? {} : { queue_paused: input.queuePaused }),
    follower_bot_id: watched?.followerBotId ?? null,
    creator_bot_id: watched?.creatorBotId ?? null,
    ...(toolInFlight === undefined ? {} : { tool_in_flight: toolInFlight }),
    ...(input.facts.shared ? { shared_task: true } : {}),
  };
}

/** 历史消息 content(已 JSON 解析)里的纯文字。 */
export function historyContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const record = content as { text?: unknown; content?: unknown };
    if (typeof record.text === 'string') return record.text;
    if (record.content !== undefined) return historyContentText(record.content);
  }
  return '';
}

const VALID_ROUTE_CHANGE_ACTORS = new Set<TaskDigestRouteChange['by']>([
  'user',
  'agent',
  'fallback',
  'model-group',
  'provider-group',
  'config-sync',
  'scheduler',
  'unknown',
]);
const SAFE_DIGEST_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Parse internal or wire route-change attribution into the bounded digest shape. */
export function parseTaskDigestRouteChange(value: unknown): TaskDigestRouteChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const at = typeof record.at === 'string' && Number.isFinite(Date.parse(record.at)) ? record.at : null;
  const by = typeof record.by === 'string' && VALID_ROUTE_CHANGE_ACTORS.has(record.by as TaskDigestRouteChange['by'])
    ? (record.by as TaskDigestRouteChange['by'])
    : null;
  if (!at || !by) return null;
  const parseEndpoint = (raw: unknown): TaskDigestRouteEndpoint | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ep = raw as Record<string, unknown>;
    const rawKind = typeof ep.agentKind === 'string' ? ep.agentKind : typeof ep.harness === 'string' ? ep.harness : null;
    const harness: TaskDigestRouteEndpoint['harness'] | null =
      rawKind === 'codex' || rawKind === 'pi' || rawKind === 'acp' || rawKind === 'claude-code'
        ? rawKind
        : rawKind === 'cc'
          ? 'claude-code'
          : null;
    if (!harness) return null;
    const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const device = opt(ep.provider_device_id) ?? opt(ep.agentDeviceId) ?? 'local';
    return {
      harness,
      model: opt(ep.model),
      provider_id: opt(ep.provider_id) ?? opt(ep.providerId),
      provider_device_id: device,
    };
  };
  const from = parseEndpoint(record.from);
  const to = parseEndpoint(record.to);
  if (!from || !to) return null;
  const rawReason = typeof record.reason === 'string' ? record.reason.trim() : null;
  const reason = rawReason && SAFE_DIGEST_REASON.test(rawReason) ? rawReason : null;
  return { at, by, reason, from, to };
}

/** RendererSession(本机或跨电脑 local-db:sessions:get)→ 摘要用的任务事实。 */
export function sessionFactsFromRow(row: unknown): TaskDigestSessionFacts | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const agentKind = text(record.agentKind);
  const harness = agentKind === 'codex' || agentKind === 'pi' || agentKind === 'acp'
    ? agentKind
    : agentKind ? 'claude-code' : null;
  const model = text(record.model);
  const hasAgentDevice = 'agentDeviceId' in record && record.agentDeviceId !== undefined;
  const rawAgentDeviceId = hasAgentDevice ? text(record.agentDeviceId) : undefined;
  const sourceKind: 'local' | 'device' | 'share' | undefined = !hasAgentDevice
    ? undefined
    : !rawAgentDeviceId
      ? 'local'
      : isProviderShareAgentDeviceId(rawAgentDeviceId)
        ? 'share'
        : 'device';
  const shared = text(record.source) === 'shared';
  const lastRouteChange = shared ? null : parseTaskDigestRouteChange(record.runtimeLastRouteChange);
  // local DB rows use unix ms; the existing remote session mapper returns ISO.
  const clearedAt = typeof record.clearedAt === 'number' ? record.clearedAt
    : typeof record.clearedAt === 'string' ? Date.parse(record.clearedAt) : NaN;
  return {
    ...(record.pinnedAt !== undefined && { pinned: record.pinnedAt !== null }),
    title: text(record.title) ?? '',
    status: text(record.status) ?? 'active',
    ...(Number.isFinite(clearedAt) ? { clearedAt } : {}),
    ...(typeof record.activeTurnStartedAt === 'number' && Number.isFinite(record.activeTurnStartedAt) ? { startedAtMs: record.activeTurnStartedAt } : {}),
    ...(typeof record.lastTurnEndedAt === 'number' && Number.isFinite(record.lastTurnEndedAt) ? { endedAtMs: record.lastTurnEndedAt } : {}),
    ...(shared ? { shared: true } : {}),
    ...(lastRouteChange ? { lastRouteChange } : {}),
    route: harness && model
      ? {
          harness,
          model,
          provider_id: text(record.providerId),
          effort: text(record.effort),
          fast: (record.fastMode === 'ultrafast' ? 'ultrafast' : record.fastMode === true),
          ...(hasAgentDevice
            ? {
                provider_device_id: rawAgentDeviceId ?? 'local',
                source_kind: sourceKind,
              }
            : {}),
        }
      : null,
  };
}

/** Redact before bounding: a truncated credential must never become unrecognizable. */
export function taskDigestErrorSummary(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = redactLocalPathText(redactSensitiveText(value));
  return text ? Array.from(text).slice(0, 300).join('') : null;
}
