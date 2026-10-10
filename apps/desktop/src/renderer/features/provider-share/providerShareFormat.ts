/**
 * 供应商分享界面的纯函数：倒计时、用量合计、头像首字、错误归类与已收到分享的变化比对。
 * 不读 window、不碰 i18n，便于单测。
 */
import type { ProviderShareReceived, ProviderShareRequestItem } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers';

import { formatCompactTokens, formatTurnCostMoney } from '@/lib/usageFormat';

import {
  PROVIDER_SHARE_AGENT_DEVICE_PREFIX,
  type ProviderShareModelUsageView,
  type ProviderShareMoney,
  type ProviderShareOwnedView,
} from '../../../shared/providerShare';

/** 分享入口的能力门：允许远程控制 → 允许被远程调用 → 分享(产品规则 §3)。 */
export type ProviderShareGate = 'on' | 'remote-off' | 'invocation-off';

/**
 * 当前该卡在哪一级。远程控制状态还没读到(null)时不按「未开启」处理，避免说明闪一下；
 * main 在生成链接时仍会再校验一次。
 */
export function providerShareGate(input: {
  remoteControlEnabled: boolean | null;
  invocationEnabled: boolean;
}): ProviderShareGate {
  if (input.remoteControlEnabled === false) return 'remote-off';
  return input.invocationEnabled ? 'on' : 'invocation-off';
}

/**
 * 分享的是 Claude 订阅登录：Claude Code 会把登录账号的邮箱交给模型，受邀者的 Agent 能看到。
 * 挡不住(只有改掉整条连接方式的开关)，审批时告诉分享者(2026-10-10 用户裁决)。
 */
export function sharesClaudeLoginEmail(provider: Pick<ProviderView, 'id' | 'source' | 'auth'> | undefined): boolean {
  if (!provider || provider.auth.method !== 'oauth') return false;
  return provider.auth.native === 'claude' || (provider.source === 'builtin' && provider.id === 'anthropic');
}

/** 任务记录里「Agent 在某个分享者的电脑上」的设备 id(与 main 的 providerShareAgentDeviceId 同构)。 */
export function providerShareAgentDeviceId(shareId: string): string {
  return `${PROVIDER_SHARE_AGENT_DEVICE_PREFIX}${shareId}`;
}

/** 剩余毫秒 → `m:ss`。负数按 0 处理，不足 1 秒向上取整(倒计时不提前显示 0:00)。 */
export function formatShareCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 链接剩余有效时间(毫秒)；时间解析失败按已过期处理。 */
export function shareLinkRemainingMs(expiresAt: string, nowMs: number): number {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return 0;
  return Math.max(0, expires - nowMs);
}

/** token 数的紧凑写法(K / M)，与用量页同一口径。 */
export function formatShareTokens(tokens: number): string {
  return formatCompactTokens(Math.max(0, Math.round(tokens)));
}

/** 估算金额，固定两位小数；与每轮金额同一写法。 */
export function formatShareMoney(money: ProviderShareMoney): string {
  return formatTurnCostMoney({
    amount: money.amount,
    currency: money.currency,
    approximate: true,
    kind: 'value-estimate',
  });
}

export interface ProviderShareUsageTotals {
  /** 输入 + 输出 token。 */
  tokens: number;
  /** 所选时间段内的估算金额；没有可估算的行、或币种不一致时为 null。 */
  amount: ProviderShareMoney | null;
}

/** 一个人在所选时间段内的用量合计。不同币种不换算、不伪造合计。 */
export function summarizeShareUsage(
  models: readonly ProviderShareModelUsageView[],
): ProviderShareUsageTotals {
  let tokens = 0;
  let amount: ProviderShareMoney | null = null;
  let mixedCurrency = false;
  for (const model of models) {
    tokens += Math.max(0, model.inputTokens) + Math.max(0, model.outputTokens);
    if (!model.amount) continue;
    if (!amount) {
      amount = { amount: model.amount.amount, currency: model.amount.currency };
    } else if (amount.currency === model.amount.currency) {
      amount = { amount: amount.amount + model.amount.amount, currency: amount.currency };
    } else {
      mixedCurrency = true;
    }
  }
  return { tokens, amount: mixedCurrency ? null : amount };
}

/** 头像缺省时显示的首字：取第一个字符(含 emoji / 汉字)，英文转大写。 */
export function shareAvatarInitial(displayName: string): string {
  const first = Array.from(displayName.trim())[0];
  return first ? first.toLocaleUpperCase() : '?';
}

/** 待审批申请按供应商计数(设置页入口的提示点)。 */
export function pendingRequestCountByProvider(
  requests: readonly { providerId: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const request of requests) {
    counts.set(request.providerId, (counts.get(request.providerId) ?? 0) + 1);
  }
  return counts;
}

export interface ProviderSharePendingRequest {
  request: ProviderShareRequestItem;
  share: { shareId: string; providerId: string; providerLabel: string };
}

/** owned 快照 → 待审批申请列表(按申请时间先后)。 */
export function pendingRequestsFromOwned(
  shares: readonly ProviderShareOwnedView[],
): ProviderSharePendingRequest[] {
  const items: ProviderSharePendingRequest[] = [];
  for (const share of shares) {
    for (const request of share.requests) {
      items.push({
        request,
        share: { shareId: share.shareId, providerId: share.providerId, providerLabel: share.providerLabel },
      });
    }
  }
  return items.sort((a, b) => Date.parse(a.request.createdAt) - Date.parse(b.request.createdAt));
}

/** 受邀者打开链接时，错误码对应的弹窗状态。 */
export type ProviderShareJoinErrorKind = 'used' | 'self' | 'member' | 'region' | 'invalid' | 'error';

export function providerShareJoinErrorKind(code: string | null | undefined): ProviderShareJoinErrorKind {
  switch (code) {
    case 'PROVIDER_SHARE_LINK_USED':
    case 'PROVIDER_SHARE_LINK_EXPIRED':
    case 'NOT_FOUND':
      return 'used';
    case 'PROVIDER_SHARE_SELF':
      return 'self';
    case 'PROVIDER_SHARE_ALREADY_MEMBER':
      return 'member';
    case 'REGION_MISMATCH':
    case 'PROVIDER_SHARE_CROSS_REGION_DISABLED':
      return 'region';
    case 'INVALID_PARAMS':
      return 'invalid';
    default:
      return 'error';
  }
}

/**
 * 已收到的分享前后两份快照的差异：状态、在线或所在电脑变了的分享要刷新它的模型目录；
 * 消失的分享(被删除或已退出)要作废缓存。新出现的分享按需再取，这里不预取。
 */
export function diffReceivedShares(
  previous: readonly ProviderShareReceived[],
  next: readonly ProviderShareReceived[],
): { changed: string[]; removed: string[] } {
  const nextById = new Map(next.map((share) => [share.shareId, share]));
  const changed: string[] = [];
  const removed: string[] = [];
  for (const before of previous) {
    const after = nextById.get(before.shareId);
    if (!after) {
      removed.push(before.shareId);
      continue;
    }
    if (
      after.status !== before.status ||
      after.hostOnline !== before.hostOnline ||
      after.hostCapable !== before.hostCapable ||
      after.hostDeviceId !== before.hostDeviceId
    ) {
      changed.push(after.shareId);
    }
  }
  return { changed, removed };
}
