/**
 * 任务中间持续托管发前评估引擎(纯 Node，Desktop 与 Node Host 共用)。
 *
 * 每一轮发消息前在发送锁内调用：
 * 1. 发前预检(model-groups.md §4.4)：当前来源已停用、断开、不可用、SSH 不支持或已知配额用满 → 立刻换到可用来源；
 * 2. 带图自动换(model-groups.md §7.3)：当前消息带图片、当前来源不能看图且路由内有可用视觉来源 → 换到视觉来源并留在该来源上；
 * 3. 缓存过期重选(model-groups.md §7.1)：上一轮已结束且超过供应商提示缓存有效期(默认 5 分钟)、非故障重试轮 →
 *    按当下生效的路由(含时段例外)与策略重新评估，若最佳可用来源不同则交接切换；缓存仍热则留在原来源保缓存。
 * 支持本机、分享来源(`share:<id>`)与另一台电脑之间无缝交接；SSH 任务自动限制在本机直传/SSH 原生来源。
 */
import {
  DEFAULT_PROMPT_CACHE_TTL_MS,
  modelGroupAutoSwitchFor,
  modelGroupCandidateKey,
  promptCacheTtlMsForProvider,
  type ModelGroupAgentKind,
  type ModelGroupCandidate,
  type ModelGroupResolveRequest,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupSelection,
} from '../../shared/modelGroups.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from './pick.js';
import { modelGroupRouteFor } from './routeFor.js';
import type { ModelGroupSessionBinding } from './sessionBindings.js';
import { isModelGroupRecoverySource } from './switchOffer.js';

export type ModelGroupTurnSwitchCause =
  | 'preflight-unavailable'
  | 'image-input'
  | 'cache-expired';

export interface ModelGroupTurnCurrentRoute {
  source?: string | null;
  agentKind: ModelGroupAgentKind;
  providerId: string;
  model: string;
  agentDeviceId?: string | null;
  effort?: string | null;
  fastMode?: boolean | 'ultrafast' | null;
  remoteHostId?: string | null;
  /** 上一轮结束时间(Unix ms)；首轮尚未跑完时为 null/undefined，不触发缓存过期重选。 */
  lastTurnEndedAt?: number | null;
  /** 当前已知上下文 token 数；用于尽量避免切到装不下的小窗口模型。 */
  contextTokens?: number | null;
}

export interface ModelGroupTurnContext {
  hasImages?: boolean;
  autoResume?: boolean;
  /** 如伙伴 profile 里配了 modelGroup，可作为会话无显式绑定时的托管来源。 */
  overrideSelection?: ModelGroupSelection | null;
}

export interface ModelGroupTurnDecisionKeep {
  action: 'keep';
  reason: 'unbound' | 'excluded-source' | 'route-missing' | 'auto-switch-off' | 'cache-warm' | 'current-optimal' | 'no-alternative';
}

export interface ModelGroupTurnDecisionSwitch {
  action: 'switch';
  cause: ModelGroupTurnSwitchCause;
  selection: ModelGroupSelection;
  groupName: string;
  fromLabel: string;
  toLabel: string;
  target: {
    agentKind: ModelGroupAgentKind;
    providerId: string;
    model: string;
    agentDeviceId: string | null;
    effort?: string;
    fastMode?: true | 'ultrafast';
  };
  crossEngine: boolean;
  crossLocation: boolean;
  /** 目标窗口装不下已知上下文时标记，提示执行方优先走有界交接而非阻塞确认弹窗。 */
  requiresHandoffForWindow?: boolean;
}

export type ModelGroupTurnDecision = ModelGroupTurnDecisionKeep | ModelGroupTurnDecisionSwitch;

export interface ModelGroupTurnRoutingDeps {
  readBinding(sessionId: string): Promise<ModelGroupSessionBinding | null> | ModelGroupSessionBinding | null;
  config(): ModelGroupsConfig;
  candidateFacts(
    route: ModelGroupRoute,
    context?: ModelGroupResolveRequest['context'],
    options?: { sshHostId?: string; cachedQuota?: boolean },
  ): Promise<ModelGroupCandidateFacts[]>;
  now(): number;
}

function isLimitedInTrace(traceEntry: { state: string; why: string; limitedUntilMs?: number | null } | undefined): boolean {
  if (!traceEntry) return false;
  return traceEntry.why === 'limited' || ('limitedUntilMs' in traceEntry && traceEntry.limitedUntilMs !== undefined);
}

/**
 * 评估当前任务在发下一轮消息前是否应由智能路由切换来源。
 * 不执行实际切换、不推进「轮流」游标；由调用方在真正切源落盘后更新 session binding。
 */
export async function evaluateModelGroupBeforeSend(
  deps: ModelGroupTurnRoutingDeps,
  sessionId: string,
  current: ModelGroupTurnCurrentRoute,
  turn: ModelGroupTurnContext = {},
): Promise<ModelGroupTurnDecision> {
  if (!isModelGroupRecoverySource(current.source)) {
    return { action: 'keep', reason: 'excluded-source' };
  }
  const currentLocation = current.agentDeviceId || undefined;
  const currentKey = modelGroupCandidateKey({
    agentKind: current.agentKind,
    providerId: current.providerId,
    model: current.model,
    agentDeviceId: currentLocation,
  });

  const storedBinding = await deps.readBinding(sessionId);
  const bindingActive = !!storedBinding && storedBinding.pickedKey === currentKey;
  const selection = bindingActive ? storedBinding.selection : (turn.overrideSelection ?? null);
  if (!selection) {
    return { action: 'keep', reason: 'unbound' };
  }

  const now = deps.now();
  const config = deps.config();
  const target = modelGroupRouteFor(config, selection, now);
  if (target.outcome === 'missing') {
    return { action: 'keep', reason: 'route-missing' };
  }

  const autoSwitchOn = modelGroupAutoSwitchFor(config, selection);
  const sshHostId = current.remoteHostId || undefined;
  const route: ModelGroupRoute = sshHostId
    ? {
        ...target.route,
        candidates: target.route.candidates.map((c) => (c.agentDeviceId ? { ...c, off: true } : c)),
      }
    : target.route;

  const facts = await deps.candidateFacts(
    route,
    {
      ...(turn.hasImages ? { hasImages: true } : {}),
      ...(current.effort ? { effort: current.effort } : {}),
      ...(current.fastMode ? { fastMode: current.fastMode } : {}),
    },
    { ...(sshHostId ? { sshHostId } : {}), cachedQuota: true },
  );

  // 用全量候选先跑一次只读 trace，精确判定当前来源是否不可用或已满额。
  const fullPick = pickModelGroupCandidate(route, facts, {
    now,
    lastPickedKey: currentKey,
    needsImage: false,
  });

  const currentIdx = route.candidates.findIndex((c) => modelGroupCandidateKey(c) === currentKey);
  const currentCandidate = currentIdx >= 0 ? route.candidates[currentIdx] : undefined;
  const currentFact = currentIdx >= 0 ? facts[currentIdx] : undefined;
  const currentTrace = currentIdx >= 0 ? fullPick.trace[currentIdx] : undefined;

  // 若时段例外把原路由改走了，当前来源可能不在目标路由中：只在缓存过期时才按新时段切走；
  // 还在当前路由内时，检查是否被停用 / 不可用 / 配额用满。
  const hoursRedirected = target.via.some((e) => e.type === 'hours');
  const currentInRoute = currentIdx >= 0;
  const currentUnavailable = currentInRoute
    ? (currentCandidate?.off === true || currentFact?.available !== true || isLimitedInTrace(currentTrace))
    : !hoursRedirected;

  // 1) 不可用预检(仅当 autoSwitch 开启时自动换源)
  const triggerUnavailable = autoSwitchOn && currentUnavailable;

  // 2) 带图自动换：本轮带图，当前来源不能看图，且路由内存在可用且未满额的视觉来源
  const hasUsableVision = route.candidates.some((c, idx) =>
    !c.off
    && facts[idx]?.available === true
    && facts[idx]?.acceptsImage === true
    && !isLimitedInTrace(fullPick.trace[idx]),
  );
  const triggerImage = turn.hasImages === true
    && currentFact?.acceptsImage === false
    && hasUsableVision;

  // 3) 缓存过期后按策略重选(非故障重试轮，且上一轮已结束超过供应商缓存有效期)
  const cacheTtlMs = promptCacheTtlMsForProvider({
    type: currentFact?.providerType ?? null,
    id: current.providerId,
    model: current.model,
  }) || DEFAULT_PROMPT_CACHE_TTL_MS;
  const cacheExpired = !turn.autoResume
    && typeof current.lastTurnEndedAt === 'number'
    && Number.isFinite(current.lastTurnEndedAt)
    && current.lastTurnEndedAt > 0
    && (now - current.lastTurnEndedAt) >= cacheTtlMs;

  if (!triggerUnavailable && !triggerImage && !cacheExpired) {
    return { action: 'keep', reason: !autoSwitchOn && currentUnavailable ? 'auto-switch-off' : 'cache-warm' };
  }

  const cause: ModelGroupTurnSwitchCause = triggerUnavailable
    ? 'preflight-unavailable'
    : triggerImage
      ? 'image-input'
      : 'cache-expired';

  const contextTokens = typeof current.contextTokens === 'number' && Number.isFinite(current.contextTokens) && current.contextTokens > 0
    ? current.contextTokens
    : 0;

  const usablePick = (pick: ReturnType<typeof pickModelGroupCandidate>) =>
    pick.index !== null && !('limitedUntilMs' in pick.trace[pick.index]) ? pick : null;

  const makeFilteredRoute = (predicate: (c: ModelGroupCandidate, index: number) => boolean): ModelGroupRoute => ({
    ...route,
    candidates: route.candidates.map((c, idx) => (predicate(c, idx) ? c : { ...c, off: true })),
  });

  const fitsContext = (idx: number): boolean => {
    if (contextTokens <= 0) return true;
    const win = facts[idx]?.contextWindow;
    // 未知窗口不误杀；已知窗口需留 10% 余量以免立刻触发缩容确认。
    return !win || win >= Math.ceil(contextTokens * 1.1);
  };

  let picked: ReturnType<typeof pickModelGroupCandidate> | null = null;
  if (cause === 'preflight-unavailable') {
    const sameExhaustedSource = isLimitedInTrace(currentTrace)
      ? (c: ModelGroupCandidate) => c.providerId === current.providerId && (c.agentDeviceId || undefined) === currentLocation
      : () => false;
    const eligible = (c: ModelGroupCandidate) =>
      modelGroupCandidateKey(c) !== currentKey && !sameExhaustedSource(c);
    const tryBucket = (pred: (c: ModelGroupCandidate, idx: number) => boolean) => {
      const filtered = makeFilteredRoute((c, idx) => eligible(c) && pred(c, idx));
      if (!filtered.candidates.some((c) => !c.off)) return null;
      return usablePick(pickModelGroupCandidate(filtered, facts, {
        now,
        lastPickedKey: currentKey,
        needsImage: turn.hasImages === true && hasUsableVision,
      }));
    };
    // 先保上下文窗口 + 同引擎同位置 → 同引擎跨位置 → 跨引擎同位置 → 跨引擎跨位置，最后允许带 handoff 的小窗口
    picked =
      tryBucket((c, i) => fitsContext(i) && c.agentKind === current.agentKind && (c.agentDeviceId || undefined) === currentLocation)
      ?? tryBucket((c, i) => fitsContext(i) && c.agentKind === current.agentKind)
      ?? tryBucket((c, i) => fitsContext(i) && (c.agentDeviceId || undefined) === currentLocation)
      ?? tryBucket((_c, i) => fitsContext(i))
      ?? tryBucket((c) => c.agentKind === current.agentKind)
      ?? tryBucket(() => true);
  } else if (cause === 'image-input') {
    const visionOnly = (c: ModelGroupCandidate, idx: number) =>
      modelGroupCandidateKey(c) !== currentKey && facts[idx]?.acceptsImage === true;
    const tryBucket = (pred: (c: ModelGroupCandidate, idx: number) => boolean) => {
      const filtered = makeFilteredRoute((c, idx) => visionOnly(c, idx) && pred(c, idx));
      if (!filtered.candidates.some((c) => !c.off)) return null;
      return usablePick(pickModelGroupCandidate(filtered, facts, { now, lastPickedKey: currentKey, needsImage: true }));
    };
    picked =
      tryBucket((c, i) => fitsContext(i) && c.agentKind === current.agentKind && (c.agentDeviceId || undefined) === currentLocation)
      ?? tryBucket((c, i) => fitsContext(i) && c.agentKind === current.agentKind)
      ?? tryBucket((_c, i) => fitsContext(i))
      ?? tryBucket(() => true);
  } else {
    // 缓存已过期：在所有可用(且装得下已知上下文)的候选中按路由策略重新挑；
    // 若策略结果就是当前来源，保持不动。
    const fitting = makeFilteredRoute((_c, i) => fitsContext(i));
    const pool = fitting.candidates.some((c) => !c.off) ? fitting : route;
    // 缓存过期重选时，对于 `rotate` / `drain` 这类记忆型策略，保留当前来源不无故跳来跳去，
    // 除非有明确更优(如 expiring/headroom/cheapest/order/weighted 或 hours 时段切走)；
    // 对 `drain` 而言当前仍可用就不换；对 `expiring`/`headroom`/`cheapest`/`order`/`weighted`/`rotate` 按策略算。
    picked = usablePick(pickModelGroupCandidate(pool, facts, {
      now,
      lastPickedKey: currentKey,
      needsImage: turn.hasImages === true && hasUsableVision,
    }));
  }

  if (!picked || picked.index === null) {
    return { action: 'keep', reason: 'no-alternative' };
  }
  const chosen = route.candidates[picked.index];
  const chosenKey = modelGroupCandidateKey(chosen);
  if (chosenKey === currentKey) {
    return { action: 'keep', reason: 'current-optimal' };
  }

  const chosenFact = facts[picked.index];
  const chosenTrace = picked.trace[picked.index];
  const fromLabel = currentTrace
    ? `${currentTrace.modelName} · ${currentTrace.sourceName}`
    : `${current.model} · ${current.providerId}`;
  const toLabel = `${chosenTrace.modelName} · ${chosenTrace.sourceName}`;
  const crossEngine = chosen.agentKind !== current.agentKind;
  const crossLocation = (chosen.agentDeviceId || undefined) !== currentLocation;
  const requiresHandoffForWindow = !fitsContext(picked.index);

  return {
    action: 'switch',
    cause,
    selection,
    groupName: target.groupName,
    fromLabel,
    toLabel,
    target: {
      agentKind: chosen.agentKind,
      providerId: chosen.providerId,
      model: chosen.model,
      agentDeviceId: chosen.agentDeviceId ?? null,
      ...(chosenFact?.effort ? { effort: chosenFact.effort } : {}),
      ...(chosenFact?.fastMode ? { fastMode: chosenFact.fastMode } : {}),
    },
    crossEngine,
    crossLocation,
    ...(requiresHandoffForWindow ? { requiresHandoffForWindow: true } : {}),
  };
}
