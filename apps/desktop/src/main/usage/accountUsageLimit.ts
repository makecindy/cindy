/**
 * 按会话所用订阅账号读「是否已用满 / 何时重置」—— 目标模式与普通任务的限额自动续跑共用。
 *
 * 订阅家族由会话 provider 的 `auth.native` 决定（ChatGPT 订阅不论跑在 Codex、Claude Code
 * bridge 还是 Pi 上都读同一份 ChatGPT 额度）。不是订阅家族的 provider（API key、Coding Plan、
 * Cindy 网关等）返回 `undefined`，由调用方决定是否另有来源；本模块不猜。
 *
 * 快照只是兜底：限额错误自带或文案里写明的重置时刻更准，调用方应优先用那个。
 */

import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import {
  isXaiWeeklyUsageCurrent,
  matchScopedWindowForModel,
} from '@cindy/maker-shared/subscription-usage';
import {
  NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS,
  type NativeSubscriptionAuth,
} from '@cindy/model-providers';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';
import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import {
  readClaudeSubscriptionUsageSnapshot,
  readCodexAccountUsageSnapshot,
  readXaiSubscriptionUsageSnapshot,
  type CodexAccountUsagePayload,
  type RateLimitSnapshot,
} from '../usageBroadcaster.js';
import { readSubscriptionAccountUsage } from './subscriptionAccountUsage.js';

export interface AccountUsageLimit {
  /** 快照里有仍在有效期内的窗口显示已用满。 */
  limited: boolean;
  /**
   * 受限时的重置时刻（unix ms）：用满窗口里最晚的（宁晚勿早）；任一用满窗口缺重置时刻
   * 则为 null（拿别的窗口顶替会提前醒来）。未受限时恒为 null——未用满窗口的重置与限流无关。
   */
  resetAtMs: number | null;
}

interface UsageWindow {
  usedPercent: number;
  resetsAtSec: number | null | undefined;
}

function hasReset(w: UsageWindow): w is UsageWindow & { resetsAtSec: number } {
  return typeof w.resetsAtSec === 'number' && Number.isFinite(w.resetsAtSec) && w.resetsAtSec > 0;
}

/**
 * 只认具体窗口显示用满，不认快照级「已触顶」标记（Codex `rateLimitReachedType` 等）：
 * 标记说不清由哪个窗口触发，还混有余额耗尽（`credits_depleted`，要充值、不会重置）。
 */
function fromWindows(windows: readonly UsageWindow[], nowMs: number): AccountUsageLimit {
  // 已过重置点的窗口在快照之后已经翻篇，快照里的用量不再成立。
  const live = windows.filter((w) => !hasReset(w) || w.resetsAtSec * 1000 > nowMs);
  const exhausted = live.filter((w) => w.usedPercent >= 100);
  if (exhausted.length === 0) return { limited: false, resetAtMs: null };
  if (exhausted.some((w) => !hasReset(w))) return { limited: true, resetAtMs: null };
  return { limited: true, resetAtMs: Math.max(...exhausted.map((w) => w.resetsAtSec as number)) * 1000 };
}

function codexWindows(snapshot: RateLimitSnapshot | null | undefined): UsageWindow[] {
  if (!snapshot) return [];
  return [snapshot.primary, snapshot.secondary]
    .filter((w): w is NonNullable<typeof w> => !!w && typeof w.usedPercent === 'number')
    .map((w) => ({ usedPercent: w.usedPercent, resetsAtSec: w.resetsAt }));
}

/**
 * ChatGPT 订阅：只看当前会话实际消耗的那一份额度，别的模型桶用满不影响本会话。
 *  - Codex 原生会话：按模型匹配 app-server 桶（没有桶表时退回顶层兼容位）；
 *  - Claude Code bridge / Pi：走 ChatGPT web 额度（WHAM 槽）。
 */
export function codexAccountUsageLimit(
  payload: CodexAccountUsagePayload | null,
  session: { agentKind: string; modelId?: string | null },
  nowMs = Date.now(),
): AccountUsageLimit | null {
  if (!payload) return null;
  let snapshot: RateLimitSnapshot | null;
  if (session.agentKind === 'codex') {
    const buckets = payload.appServerBuckets;
    snapshot =
      buckets && Object.keys(buckets).length > 0
        ? matchCodexBucketForModel(buckets, session.modelId, nowMs)
        : payload;
  } else {
    snapshot = payload.webSnapshot ?? null;
  }
  const windows = codexWindows(snapshot);
  if (!snapshot || windows.length === 0) return null;
  return fromWindows(windows, nowMs);
}

const CLAUDE_REJECTED_CLAIM_TO_WINDOW = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
} as const;

/** Claude 订阅：总窗口 + 仅当前模型的专属周窗口（别的模型的专属窗口用满不影响本会话）。 */
export function claudeAccountUsageLimit(
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  modelId?: string | null,
  nowMs = Date.now(),
): AccountUsageLimit | null {
  if (!snapshot) return null;
  const scoped = matchScopedWindowForModel(snapshot.scoped, modelId);
  const windows: UsageWindow[] = [snapshot.fiveHour, snapshot.sevenDay, scoped]
    .filter((w): w is NonNullable<typeof w> => !!w && typeof w.utilization === 'number')
    .map((w) => ({ usedPercent: w.utilization, resetsAtSec: w.resetsAt }));
  // headers 源被拒时只报状态和「最紧窗口」名，不带用量；把那个窗口视为已用满。
  const rejectedKey =
    snapshot.rateLimitStatus === 'rejected' && snapshot.representativeClaim
      ? CLAUDE_REJECTED_CLAIM_TO_WINDOW[
          snapshot.representativeClaim as keyof typeof CLAUDE_REJECTED_CLAIM_TO_WINDOW
        ]
      : undefined;
  const rejectedWindow = rejectedKey ? snapshot[rejectedKey] : null;
  if (rejectedWindow) windows.push({ usedPercent: 100, resetsAtSec: rejectedWindow.resetsAt });
  if (windows.length === 0) return null;
  return fromWindows(windows, nowMs);
}

/**
 * SuperGrok 只有周窗口。快照是 cached-first、后台刷新，超过有效期（或已过重置点）的不用，
 * 与用量面板同一判定。
 */
export function xaiAccountUsageLimit(
  snapshot: XaiSubscriptionUsageSnapshot | null,
  nowMs = Date.now(),
): AccountUsageLimit | null {
  if (!snapshot || !isXaiWeeklyUsageCurrent(snapshot, nowMs)) return null;
  return fromWindows(
    [{ usedPercent: snapshot.creditUsagePercent as number, resetsAtSec: snapshot.resetsAt }],
    nowMs,
  );
}

/**
 * 会话所用 provider 属于哪个订阅家族。providerId 缺省（旧会话的隐式默认来源）时只有
 * Codex 能确定是 ChatGPT 默认账号；其它 agent 的默认来源可能是 Cindy 网关，不猜。
 */
export function subscriptionFamilyOf(
  agentKind: string,
  providerId: string | null | undefined,
): NativeSubscriptionAuth | null {
  if (!providerId) return agentKind === 'codex' ? 'codex' : null;
  // 内置默认账号(openai / anthropic / xai)不带 auth.native,按固定 id 识别;独立账号才带。
  for (const [family, id] of Object.entries(NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS)) {
    if (id === providerId) return family as NativeSubscriptionAuth;
  }
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  return provider?.auth.native ?? null;
}

/**
 * @returns `undefined` = 不是订阅家族（调用方另找来源）；`null` = 是订阅家族但暂无可用快照。
 */
export async function readAccountUsageLimit(
  agentKind: string,
  providerId: string | null | undefined,
  modelId?: string | null,
): Promise<AccountUsageLimit | null | undefined> {
  const family = subscriptionFamilyOf(agentKind, providerId);
  switch (family) {
    case 'codex':
      return codexAccountUsageLimit(await readCodexAccountUsageSnapshot(providerId ?? undefined), {
        agentKind,
        modelId,
      });
    case 'claude':
      // 独立 Claude 账号已停用，只有内置默认账号有快照。
      return providerId === 'anthropic' || !providerId
        ? claudeAccountUsageLimit(await readClaudeSubscriptionUsageSnapshot(), modelId)
        : null;
    case 'xai':
      return xaiAccountUsageLimit(
        !providerId || providerId === 'xai'
          ? await readXaiSubscriptionUsageSnapshot()
          : ((await readSubscriptionAccountUsage(
              providerId,
            )) as XaiSubscriptionUsageSnapshot | null),
      );
    default:
      return undefined;
  }
}
