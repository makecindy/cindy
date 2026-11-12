/**
 * 模型组选路：一条路线里这次用哪个来源。纯函数，不读任何状态。
 * 「快作废的先用」直接复用供应商组的排序(provider-group/scheduler.ts 与 usage.ts)，两处不会各算各的。
 */
import type {
  ModelGroupRoute,
  ModelGroupTraceEntry,
  ModelGroupTraceQuota,
  ModelGroupTraceWhy,
} from '../../shared/modelGroups.js';
import { modelGroupCandidateKey } from '../../shared/modelGroups.js';
import { pickProviderGroupMember } from '../provider-group/scheduler.js';
import { quotaWindowsScheduleState } from '../provider-group/usage.js';

/** 一个候选此刻的事实，顺序与 route.candidates 一致。 */
export interface ModelGroupCandidateFacts {
  /**
   * 供应商已连接、模型现在可为新任务选用、对应引擎已安装；不在本机的来源还要求那个位置此刻能选、
   * 模型在那里允许远程调用。
   */
  available: boolean;
  modelName: string;
  sourceName: string;
  /** 订阅额度窗口；读不到(API 密钥、尚未读到)为 null。 */
  windows: readonly ModelGroupTraceQuota[] | null;
  /**
   * 「最省钱」用的标价：每百万输出 token 的美元价(人民币报价已折算)。订阅来源、没有标价时为 null。
   * 只在选法是 cheapest 时才读取，其余选法可省略。
   */
  price?: number | null;
  /** 这个模型能不能看图；读不到按不能。 */
  acceptsImage?: boolean;
}

export interface ModelGroupPick {
  index: number | null;
  trace: ModelGroupTraceEntry[];
  /** 要求能看图时：applied = 只在能看图的来源里选了；fallback = 一个能看图的都没有，照常选。 */
  image?: 'applied' | 'fallback';
}

/** 还有配额的订阅不另外花钱；其余按标价，没有标价的排在有标价的后面。 */
function costOf(fact: ModelGroupCandidateFacts | undefined): number {
  if (fact?.windows) return 0;
  return typeof fact?.price === 'number' && Number.isFinite(fact.price) && fact.price >= 0
    ? fact.price
    : Number.POSITIVE_INFINITY;
}

export function pickModelGroupCandidate(
  route: ModelGroupRoute,
  facts: readonly ModelGroupCandidateFacts[],
  options: { now: number; lastPickedKey?: string | null; needsImage?: boolean },
): ModelGroupPick {
  const { now } = options;
  const anyVision = !!options.needsImage && route.candidates.some((candidate, index) =>
    !candidate.off && facts[index]?.available === true && facts[index]?.acceptsImage === true);
  const rows = route.candidates.map((candidate, index) => {
    const fact = facts[index];
    const state = fact?.windows ? quotaWindowsScheduleState(fact.windows, now) : null;
    return {
      candidate, index, key: modelGroupCandidateKey(candidate),
      noVision: anyVision && fact?.acceptsImage !== true,
      usable: !candidate.off && fact?.available === true && !(anyVision && fact?.acceptsImage !== true),
      limited: state?.limited ?? false,
      limitedUntilMs: state?.resetAtMs ?? null,
      tight: state?.fiveHourTight ?? false,
      urgency: state?.urgency ?? null,
      quota: state?.quota ?? null,
    };
  });
  const usable = rows.filter((row) => row.usable);
  const ready = usable.filter((row) => !row.limited);

  let picked: (typeof rows)[number] | null = null;
  let why: ModelGroupTraceWhy = 'only';
  if (ready.length > 0) {
    if (route.strategy === 'order') {
      picked = ready[0];
    } else if (route.strategy === 'rotate') {
      const last = rows.findIndex((row) => row.key === options.lastPickedKey);
      picked = ready.find((row) => row.index > last) ?? ready[0];
    } else if (route.strategy === 'cheapest') {
      // 严格小于才换：一样便宜时保留列表里靠前的。
      picked = ready.reduce((best, row) => (costOf(facts[row.index]) < costOf(facts[best.index]) ? row : best));
    } else {
      const key = pickProviderGroupMember(ready.map((row) => ({
        key: row.key, usable: true, paused: false, running: 0, limit: 1, weight: 1,
        urgency: row.urgency, fiveHourTight: row.tight,
      })), 'order');
      picked = ready.find((row) => row.key === key) ?? ready[0];
    }
    why = usable.length === 1 ? 'only' : route.strategy;
    if (why === 'cheapest') {
      const cost = costOf(facts[picked.index]);
      // 谁都没有标价时只是按列表顺序取了第一个，不说它最省钱。
      why = cost === 0 && facts[picked.index]?.windows ? 'cheapestFree' : Number.isFinite(cost) ? 'cheapest' : 'order';
    }
  } else if (usable.length > 0) {
    // 全都撞了上限：选最早恢复的那个，任务照常建立，由现有的「等额度恢复后自动继续」接手。
    picked = usable.reduce((best, row) =>
      (row.limitedUntilMs ?? Number.POSITIVE_INFINITY) < (best.limitedUntilMs ?? Number.POSITIVE_INFINITY) ? row : best);
    why = usable.length === 1 ? 'only' : 'soonest';
  }

  const trace = rows.map((row): ModelGroupTraceEntry => {
    const fact = facts[row.index];
    const base = {
      agentKind: row.candidate.agentKind, providerId: row.candidate.providerId, model: row.candidate.model,
      ...(row.candidate.agentDeviceId ? { agentDeviceId: row.candidate.agentDeviceId } : {}),
      modelName: fact?.modelName || row.candidate.model, sourceName: fact?.sourceName || row.candidate.providerId,
      quota: row.quota,
    };
    if (row === picked) return { ...base, state: 'picked', why, ...(row.limited ? { limitedUntilMs: row.limitedUntilMs } : {}) };
    if (row.candidate.off) return { ...base, state: 'skipped', why: 'off' };
    if (fact?.available !== true) return { ...base, state: 'skipped', why: 'unavailable' };
    if (row.noVision) return { ...base, state: 'skipped', why: 'noVision' };
    if (row.limited) return { ...base, state: 'skipped', why: 'limited', limitedUntilMs: row.limitedUntilMs };
    // 只有按额度排时，5 小时快满才是没选它的原因；别的选法下它只是没轮到。
    if (row.tight && route.strategy === 'expiring' && ready.some((other) => !other.tight)) return { ...base, state: 'skipped', why: 'tight' };
    return { ...base, state: 'standby', why: 'standby' };
  });
  return {
    index: picked?.index ?? null,
    trace,
    ...(options.needsImage ? { image: anyVision ? 'applied' as const : 'fallback' as const } : {}),
  };
}
