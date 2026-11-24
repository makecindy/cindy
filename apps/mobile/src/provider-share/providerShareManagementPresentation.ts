/**
 * 手机「我分享的供应商」界面的纯函数：哪些分享列出来、能不能生成链接、状态词与倒计时。
 * 不读设备互联、不碰 i18n 实例，便于单测。产品规则见 docs/product-rules/provider-sharing.md §7.6。
 */
import { PROVIDER_SHARE_LINK_TTL_MS } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers/registry';

import { PLUGIN_ENGINE_PROVIDER_PREFIX } from '@/session/pluginEngines';

import type { ShareGroupMember, ShareManagementShare } from './providerShareManagement';

/**
 * 生成链接后关注申请的时长：链接 5 分钟有效，再给申请到达留 2 分钟。与供应商所在电脑为这条链接静默本机
 * 审批弹窗的窗口同长(Desktop `PROVIDER_SHARE_REMOTE_LINK_WINDOW_MS`)，窗口内由手机这一页显示申请。
 */
export const SHARE_LINK_WATCH_MS = PROVIDER_SHARE_LINK_TTL_MS + 2 * 60_000;

/**
 * 插件提供的供应商不在手机上管理：同意前要核对那台电脑上的插件是否支持分享，手机没有这份信息
 * (Desktop 审批弹窗的同一道核对)。它们的申请仍在电脑上处理。
 */
export function isPhoneManageableProvider(providerId: string): boolean {
  return !providerId.startsWith(PLUGIN_ENGINE_PROVIDER_PREFIX);
}

/**
 * 「我分享的供应商」里列出的分享：已经有人在用，或有申请等着处理。只生成过链接、还没有人申请的不算已分享
 * (与 Desktop 设置页同口径)。有待处理申请的排在前面。
 */
export function sharedProviderRows(shares: readonly ShareManagementShare[]): ShareManagementShare[] {
  return shares
    .filter((share) => isPhoneManageableProvider(share.providerId)
      && (share.members.length > 0 || share.requests.length > 0))
    .sort((a, b) => Number(b.requests.length > 0) - Number(a.requests.length > 0)
      || a.providerLabel.localeCompare(b.providerLabel)
      || a.providerId.localeCompare(b.providerId));
}

/** 目录里一个供应商现在能不能分享：已连接、没被停用或移除，并且那台电脑对它打开了「允许被远程调用」。 */
export type ShareLinkGate = 'ready' | 'checking' | 'missing' | 'disconnected' | 'invocation-off';

export function shareLinkGate(input: { catalogReady: boolean; provider: ProviderView | undefined }): ShareLinkGate {
  if (!input.catalogReady) return 'checking';
  const provider = input.provider;
  if (!provider || provider.removed) return 'missing';
  if (!provider.connected || provider.suspended) return 'disconnected';
  return provider.remoteInvocationEnabled === true ? 'ready' : 'invocation-off';
}

/** 一台电脑上可以从手机发起分享的供应商(已并进账号池的旧连接跟随账号池，不单独列出)。 */
export function shareableProviders(providers: readonly ProviderView[]): ProviderView[] {
  return providers.filter((provider) => isPhoneManageableProvider(provider.id)
    && !provider.subscriptionPoolAlias
    && shareLinkGate({ catalogReady: true, provider }) === 'ready');
}

/**
 * 分享的是 Claude 订阅登录：Claude Code 会把登录账号的邮箱交给模型，受邀者的 Agent 能看到，
 * 同意前要告诉分享者(provider-sharing.md §4.1 第 4 步；判定与 Desktop `sharesClaudeLoginEmail` 相同)。
 */
export function sharesClaudeLoginEmail(provider: Pick<ProviderView, 'id' | 'source' | 'auth'> | undefined): boolean {
  if (!provider || provider.auth?.method !== 'oauth') return false;
  return provider.auth.native === 'claude' || (provider.source === 'builtin' && provider.id === 'anthropic');
}

/** 这个供应商在那台电脑上建了组(目录里带组摘要)：同意说明要写「由供应商组选一台电脑运行」。 */
export function providerHasGroup(provider: ProviderView | undefined): boolean {
  const group = (provider as { group?: unknown } | undefined)?.group;
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
  const members = (group as { members?: unknown }).members;
  return Array.isArray(members) && members.length > 0;
}

/** 剩余毫秒 → `m:ss`。不足 1 秒向上取整，倒计时不提前显示 0:00。 */
export function formatShareCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

export type ShareMemberStatusTone = 'ready' | 'busy' | 'muted' | 'off';

/**
 * 组内一台电脑的状态词(与 Desktop `memberStatusText` 同口径)：能用时直接报负载，跑 0 个说「空闲」；
 * 可信快照确认配额耗尽时说「配额已用完」并带重置时刻，普通冷却不猜恢复时间。
 */
export function shareMemberStatus(member: ShareGroupMember, nowMs: number): {
  key: string;
  count?: number;
  resetAtMs?: number;
  tone: ShareMemberStatusTone;
} {
  switch (member.state) {
    case 'available':
      return member.running > 0
        ? { key: 'runningCount', count: member.running, tone: 'busy' }
        : { key: 'status.idle', tone: 'ready' };
    case 'full':
      return { key: 'status.full', tone: 'busy' };
    case 'paused':
      return { key: 'status.paused', tone: 'muted' };
    case 'cooling':
      if (!member.quotaExhausted) return { key: 'status.cooling', tone: 'muted' };
      return member.quotaResetAtMs !== null && member.quotaResetAtMs > nowMs
        ? { key: 'status.quotaExhausted', resetAtMs: member.quotaResetAtMs, tone: 'muted' }
        : { key: 'status.quotaExhausted', tone: 'muted' };
    case 'offline':
      return { key: 'status.offline', tone: 'off' };
    default:
      return { key: `status.unavailable.${member.reason ?? 'disconnected'}`, tone: 'off' };
  }
}
