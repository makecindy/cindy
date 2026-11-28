/**
 * 任务中间撞配额或来源不可用时的「换到下一个来源继续」提议与自动接替候选计算(model-groups.md §4、§6.1)。
 * 2026-11-27 升级：覆盖所有可绑定智能路由的任务形态(含 Orca、目标、伙伴、IM/Hook、插件任务、远程 Agent、
 * 宿主权下的共享任务、SSH)，并支持跨运行位置(本机 ↔ 分享 ↔ 另一台电脑)交接；仅排除 `review` 锁定任务，
 * SSH 任务强制锁定本机直传/SSH 原生源，不跨运行位置。
 * 纯函数，所有事实由调用方注入。
 */
import {
  modelGroupAutoSwitchFor,
  type ModelGroupResolveRequest,
  modelGroupCandidateKey,
  type ModelGroupAgentKind,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupSwitchOffer,
} from '../../shared/modelGroups.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from './pick.js';
import { modelGroupRouteFor } from './routeFor.js';
import type { ModelGroupSessionBinding } from './sessionBindings.js';

/** 会话行里判断任务归属、运行位置与当前来源所需的字段。 */
export interface ModelGroupSwitchOfferSessionRow {
  source?: string | null;
  agentKind?: string | null;
  providerId?: string | null;
  model?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  orcaRole?: string | null;
}

export interface ModelGroupSwitchOfferDeps {
  readBinding(sessionId: string): ModelGroupSessionBinding | null;
  readSession(sessionId: string): Promise<ModelGroupSwitchOfferSessionRow | null>;
  /** 正在共享给别的账号。 */
  isShared(sessionId: string): boolean;
  /** 这个任务有目标。 */
  hasGoal(sessionId: string): Promise<boolean>;
  config(): ModelGroupsConfig;
  candidateFacts(
    route: ModelGroupRoute,
    context?: ModelGroupResolveRequest['context'],
    options?: { sshHostId?: string; cachedQuota?: boolean },
  ): Promise<ModelGroupCandidateFacts[]>;
  now(): number;
}

function isModelGroupAgentKind(value: unknown): value is ModelGroupAgentKind {
  return value === 'cc' || value === 'codex' || value === 'pi' || value === 'acp';
}

/**
 * 哪些来源的任务参与智能路由持续托管与接替(2026-11-27 全面放开)：
 * 除复核(`review`，锁定源任务配置)外，所有落成任务的入口(desktop、scheduler、bot、IM、hook、plugin、orca 等)
 * 统一按绑定路由接替。
 */
export function isModelGroupRecoverySource(source: string | null | undefined): boolean {
  return source !== 'review';
}

export interface ModelGroupRecoveryRequest {
  scheduled?: boolean;
  visited: ReadonlySet<string>;
  accountUnavailable: boolean;
  hasImages?: boolean;
  /** 允许在已有独立覆盖选择(如伙伴 profile modelGroup)时无需 sessionBindings 直接解析。 */
  overrideSelection?: ModelGroupSessionBinding['selection'];
  recordUnavailable(candidate: ModelGroupRoute['candidates'][number]): void;
  current: {
    agentKind: ModelGroupAgentKind;
    providerId: string;
    model: string;
    agentDeviceId?: string | null;
    effort?: string | null;
    fastMode?: boolean | 'ultrafast' | null;
  };
}

export async function computeModelGroupSwitchOffer(
  deps: ModelGroupSwitchOfferDeps,
  sessionId: string,
  recovery?: ModelGroupRecoveryRequest,
): Promise<(ModelGroupSwitchOffer & { effort?: string; fastMode?: true | 'ultrafast'; fromLabel?: string }) | null> {
  const storedBinding = deps.readBinding(sessionId);
  if (!storedBinding && !recovery?.overrideSelection) return null;
  const row = await deps.readSession(sessionId);
  if (!row || !isModelGroupRecoverySource(row.source)) return null;
  if (!isModelGroupAgentKind(row.agentKind) || !row.providerId || !row.model) return null;

  const rowLocation = row.agentDeviceId || undefined;
  const currentLocation = recovery?.current.agentDeviceId !== undefined
    ? (recovery.current.agentDeviceId || undefined)
    : rowLocation;
  const current = recovery?.current
    ? { ...recovery.current, agentDeviceId: currentLocation }
    : { agentKind: row.agentKind, providerId: row.providerId, model: row.model, agentDeviceId: rowLocation };
  const currentKey = modelGroupCandidateKey(current);

  const bindingMatchesCurrent = !!storedBinding && (
    currentKey === storedBinding.pickedKey || !!recovery?.visited.has(storedBinding.pickedKey)
  );
  const selection = bindingMatchesCurrent
    ? storedBinding.selection
    : recovery?.overrideSelection ?? null;
  if (!selection) {
    // 模型或来源此刻不是记下的这个(用户自己换了，或别处换了)：不提议。记录不删 —— 跨引擎的换模型
    // 可能只是登记了「下一条消息再换」，任务还在旧模型上跑；等真换过去时记录要照样有效。
    return null;
  }
  const lastPickedKey = bindingMatchesCurrent ? storedBinding.pickedKey : currentKey;

  const now = deps.now();
  const config = deps.config();
  if (recovery && !modelGroupAutoSwitchFor(config, selection)) return null;
  const target = modelGroupRouteFor(config, selection, now);
  if (target.outcome === 'missing') return null;
  const { route } = target;

  const sshHostId = row.remoteHostId || undefined;
  const accountUnavailable = recovery?.accountUnavailable ?? true;
  // 同一运行位置上的同一个供应商连接是同一个账号、同一份配额：一并跳过，连同正在用的这个。
  // 不同电脑或不同分享上即使 providerId 同名，也不是同一份额度，保留为可用接替候选。
  // SSH 任务不能跨 agentDeviceId，仅允许本机直传/SSH 原生候选。
  const eligible: ModelGroupRoute = {
    ...route,
    candidates: route.candidates.map((candidate) => {
      const key = modelGroupCandidateKey(candidate);
      const sameLocation = (candidate.agentDeviceId || undefined) === currentLocation;
      const failed = key === currentKey || (accountUnavailable && sameLocation && candidate.providerId === current.providerId);
      if (failed) recovery?.recordUnavailable(candidate);
      const locationBlocked = (!!sshHostId || recovery?.scheduled === true) && !!candidate.agentDeviceId;
      return locationBlocked || failed || recovery?.visited.has(key)
        ? { ...candidate, off: true }
        : candidate;
    }),
  };
  if (!eligible.candidates.some((candidate) => !candidate.off)) return null;

  // 供应商路由下的任务：接替到另一个成员时沿用任务此刻的思考深度与 Fast(那个成员支持时)，不退回模型默认档。
  const wanted = recovery?.current;
  const facts = await deps.candidateFacts(
    eligible,
    wanted ? {
      ...(recovery?.scheduled ? { scheduled: true } : {}),
      ...(wanted.effort ? { effort: wanted.effort } : {}),
      ...(wanted.fastMode ? { fastMode: wanted.fastMode } : {}),
    } : undefined,
    sshHostId ? { sshHostId } : undefined,
  );

  // 「轮流」从正在用的这个往后数；不读也不改新任务用的轮流位置。
  const pickFrom = (candidates: ModelGroupRoute) => pickModelGroupCandidate(candidates, facts, {
    now,
    lastPickedKey,
    needsImage: recovery?.hasImages === true && (
      !!route.exceptions?.some((item) => item.when.type === 'image')
      || route.candidates.some((item, index) => !item.off && facts[index]?.acceptsImage === true)
    ),
  });
  // 能用的都撞了上限时 pick 仍会选最早恢复的那个(带 limitedUntilMs)；换过去一样要等，不算选到。
  const usablePick = (pick: ReturnType<typeof pickFrom>) =>
    pick.index !== null && !('limitedUntilMs' in pick.trace[pick.index]) ? pick : null;
  const isSameEngine = (
    a: { agentKind: ModelGroupAgentKind; providerId: string },
    b: { agentKind: ModelGroupAgentKind; providerId: string },
  ) => a.agentKind === b.agentKind && (a.agentKind !== 'acp' || a.providerId === b.providerId);

  const filterRoute = (predicate: (candidate: ModelGroupRoute['candidates'][number]) => boolean): ModelGroupRoute => ({
    ...eligible,
    candidates: eligible.candidates.map((candidate) => (predicate(candidate) ? candidate : { ...candidate, off: true })),
  });
  const tryBucket = (bucket: ModelGroupRoute) =>
    (bucket.candidates.some((candidate) => !candidate.off) ? usablePick(pickFrom(bucket)) : null);

  let picked: ReturnType<typeof pickFrom> | null = null;
  if (recovery) {
    // 自动接替梯度：
    // 1. 同引擎 + 同位置(零上下文损失、免交接；不同插件引擎 providerId 视为跨引擎)
    // 2. 同引擎 + 跨位置(自有电脑可原生迁移历史，分享走有界交接)
    // 3. 跨引擎 + 同位置
    // 4. 跨引擎 + 跨位置
    picked =
      tryBucket(filterRoute((c) => isSameEngine(c, current) && (c.agentDeviceId || undefined) === currentLocation))
      ?? tryBucket(filterRoute((c) => isSameEngine(c, current)))
      ?? tryBucket(filterRoute((c) => (c.agentDeviceId || undefined) === currentLocation))
      ?? usablePick(pickFrom(eligible));
  } else {
    // 手动横幅提议：按路由自身顺序优先本位置，没有才跨位置，由用户点击确认。
    picked =
      tryBucket(filterRoute((c) => (c.agentDeviceId || undefined) === currentLocation))
      ?? usablePick(pickFrom(eligible));
  }
  if (!picked || picked.index === null) return null;
  const entry = picked.trace[picked.index];
  const candidate = route.candidates[picked.index];
  // 正在用的那个来源的名字(活动行「{from} …，已换到 {to} 继续」)，在 trace 里与其他候选一起算好了。
  const currentIndex = route.candidates.findIndex((item) => modelGroupCandidateKey(item) === currentKey);
  const fromEntry = currentIndex >= 0 ? picked.trace[currentIndex] : undefined;
  const crossLocation = (candidate.agentDeviceId || undefined) !== currentLocation;
  return {
    ...(fromEntry ? { fromLabel: `${fromEntry.modelName} · ${fromEntry.sourceName}` } : {}),
    groupName: target.groupName,
    selection,
    agentKind: candidate.agentKind,
    providerId: candidate.providerId,
    model: candidate.model,
    ...(candidate.agentDeviceId ? { agentDeviceId: candidate.agentDeviceId } : {}),
    modelName: entry.modelName,
    sourceName: entry.sourceName,
    ...(recovery && facts[picked.index].effort ? { effort: facts[picked.index].effort } : {}),
    ...(recovery && facts[picked.index].fastMode ? { fastMode: facts[picked.index].fastMode } : {}),
    crossEngine: !isSameEngine(candidate, current),
    ...(crossLocation ? { crossLocation: true } : {}),
  };
}
