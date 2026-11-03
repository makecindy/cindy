/**
 * get_task_digest 的宿主侧组装(纯逻辑,依赖全部注入,便于单测)。
 *
 * 优先用观察层的状态行(phase / 等什么 / 错误 / 谁开的 / 谁在跟,与工作台和事件同一口径);
 * 观察层没有这一行时按活动快照推一个保守的 phase。其余字段各自尽力读取,读不到就是 null,
 * 不因 PR、队列、候选链任一项失败而让整份摘要失败。输出合同(≤300 字 / ≤2KB)由工具层的
 * boundTaskDigest 保证;这里只负责事实。
 */
import type { TaskDigestPhase, TaskDigestRoute, TaskDigestWire } from '@cindy/mcps';
import type { WatchedSession } from '../../shared/botAutonomy.js';

type Failure = { ok: false; errorCode: 'NOT_FOUND' | 'REMOTE_UNAVAILABLE' | 'INVALID_ARGS' | 'HOST_NOT_READY' | 'INTERNAL'; message: string };

export interface TaskDigestSessionFacts {
  title: string;
  status: string;
  route: TaskDigestRoute | null;
  /** 共享给访客的任务(来源 shared):摘要不带对话原文。 */
  shared?: boolean;
}

export interface TaskDigestActivity {
  phase: string;
  interactionKind?: string | null;
  startedAtMs?: number | null;
  lastActivityAtMs?: number | null;
  runtimeGeneration?: number | null;
  route?: TaskDigestRoute | null;
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
    queuedCount(sessionId: string): Promise<number | null>;
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
    | { ok: true; prNumber: number; repo: string; status: string; unresolvedCount: number | null; checks?: { total: number; failed: number; pending: number; passed: number; skipped: number } | null; observedAt?: number }
    | { ok: false; prNumber: number; repo: string }
  >,
): string | null {
  const parts = results.slice(0, 3).map((pr) => {
    if (!pr.ok) return `PR ${pr.repo}#${pr.prNumber} 状态未知`;
    const unresolved = pr.unresolvedCount ? `,${pr.unresolvedCount} 条评审未解决` : '';
    const c = pr.checks;
    const ci = !c ? 'CI 未知' : c.failed ? `CI ${c.failed} 失败` : c.pending ? `CI ${c.pending} 进行中` : !c.total ? '无检查' : c.passed === c.total ? 'CI 通过' : `CI ${c.passed} 通过/${c.skipped} 跳过`;
    const age = pr.observedAt ? `,${Math.max(0, Math.floor((Date.now() - pr.observedAt) / 60000))} 分钟前` : '';
    return `PR ${pr.repo}#${pr.prNumber} ${pr.status}${unresolved},${ci}${age}`;
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
      return {
        ok: true,
        digest: assemble({
          key, now, watched, facts, activity, exchange, prStatus,
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
    // 换模型只用来救出错和用量上限(跟进规则也只在这两种相位用它);其余相位不给建议。
    const suggestedRoute = current && (phase === 'errored' || phase === 'usage-limit')
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
        key, now, watched, facts, activity, exchange, prStatus, queuedCount, suggestedRoute,
        local: true,
        device: null,
        runtimeGeneration: activity?.runtimeGeneration ?? null,
      }),
    };
  };
}

function assemble(input: {
  key: string;
  now: number;
  watched: WatchedSession | null;
  facts: TaskDigestSessionFacts;
  activity: TaskDigestActivity | null;
  exchange: TaskDigestExchange;
  prStatus: string | null;
  queuedCount: number | null;
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
  return {
    session_id: input.key,
    device: input.device,
    title: watched?.title || input.facts.title,
    phase,
    elapsed_minutes: minutesSince(input.now, since),
    idle_minutes: minutesSince(input.now, watched?.lastActivityAt ?? activity?.lastActivityAtMs),
    // 共享任务里最近一句「用户」可能是访客写的:不交给伙伴当指令看。
    last_user_ask: input.facts.shared ? null : input.exchange.lastUserAsk,
    last_assistant_line: input.facts.shared ? null : input.exchange.lastAssistantLine,
    pending_question: watched?.pendingQuestion ?? null,
    error: watched?.error ?? null,
    current_route: activity?.route ?? input.facts.route,
    runtime_generation: input.runtimeGeneration,
    suggested_route: input.suggestedRoute,
    pr_status: input.prStatus,
    queued_count: input.queuedCount,
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

/** RendererSession(本机或跨电脑 local-db:sessions:get)→ 摘要用的任务事实。 */
export function sessionFactsFromRow(row: unknown): TaskDigestSessionFacts | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const agentKind = text(record.agentKind);
  const harness = agentKind === 'codex' || agentKind === 'pi' ? agentKind : agentKind ? 'claude-code' : null;
  const model = text(record.model);
  return {
    title: text(record.title) ?? '',
    status: text(record.status) ?? 'active',
    ...(text(record.source) === 'shared' ? { shared: true } : {}),
    route: harness && model
      ? {
          harness,
          model,
          provider_id: text(record.providerId),
          effort: text(record.effort),
          fast: (record.fastMode === 'ultrafast' ? 'ultrafast' : record.fastMode === true),
        }
      : null,
  };
}
