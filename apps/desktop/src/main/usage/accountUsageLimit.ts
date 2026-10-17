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
} from '@cindy/maker-shared/subscription-usage';
import {
  NATIVE_SUBSCRIPTION_DEFAULT_PROVIDER_IDS,
  type NativeSubscriptionAuth,
} from '@cindy/model-providers';
import {
  accountUsageLimitFromWindows as fromWindows,
  claudeAccountUsageLimit,
  type AccountUsageLimit,
  type UsageWindow,
} from '../../shared/accountUsageLimit.js';
export { claudeAccountUsageLimit, type AccountUsageLimit } from '../../shared/accountUsageLimit.js';
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
 * 会话的模型请求是否用另一台机器的登录发出：SSH 远程工作区用远端主机的登录，远程 Agent 用
 * Agent 所在电脑的登录。此时本机订阅快照属于另一个账号，不能拿来推算重置时刻；报错原文里不带
 * 时区的钟点也是那台的本地时间，不按本机时区理解。
 */
export function sessionUsesOtherMachineAccount(
  row: { remoteHostId?: string | null; agentDeviceId?: string | null } | null | undefined,
): boolean {
  return Boolean(row?.remoteHostId || row?.agentDeviceId);
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
