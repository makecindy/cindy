import { getActiveCatalog } from './active-catalog.js';

/**
 * 独立 Claude 账号已停用的归因。它的凭证是 Cindy 自己跑 OAuth 登录后保存的,而 Claude 订阅
 * 只允许经官方 Claude Code CLI 自己的登录使用(见 claude-native-cli);已有条目保留在设置里
 * 供用户查看 / 删除,不再参与任何会话。
 */
export const CLAUDE_ACCOUNT_RETIRED_REASON = 'claude_account_retired';

export function subscriptionAccountKind(providerId?: string | null): 'claude' | 'xai' | null {
  const native = getActiveCatalog().providers.find((p) => p.id === providerId)?.auth.native;
  return native === 'claude' || native === 'xai' ? native : null;
}

export function isClaudeSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'anthropic' || subscriptionAccountKind(providerId) === 'claude';
}

export function isXaiSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'xai' || subscriptionAccountKind(providerId) === 'xai';
}
