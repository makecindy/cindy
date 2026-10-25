import assert from 'node:assert/strict';

export default {
  name: 'organization-quota',
  entry: './quota-fixture.tsx',
  viewport: { width: 560, height: 440 },
  real: 'TodaySpendChip, QuotaHoverCard, useClaudeAccountUsage, translations and themes',
  notCovered: 'Server reads, menu bar, device-link transport, subscription providers and the unmounted home dashboard',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ dataOwnerId: "fixture", dataOwnerGeneration: 1, mode: "cloud", user: { membershipKind: "org" } });',
    'src/renderer/hooks/useApiKey': 'export const useApiKey = () => ({ hasSavedKey: true, isReconciling: false });',
    'src/renderer/hooks/useProviders': 'export const useProviders = () => ({ providers: [] });',
    'src/renderer/hooks/useDeviceProviders': 'export const useDeviceProviders = () => ({ providers: [] });',
    'src/renderer/hooks/useClaudeOAuthConnected': 'export const useClaudeOAuthConnected = () => false;',
    'src/renderer/hooks/useClaudeSessionRoute': 'export const useClaudeSessionRoute = () => null;',
    'src/renderer/hooks/useSessionUsageMoney': 'export const useSessionUsageMoney = () => ({ actualMoney: null, estimatedValueMoney: null, totalMoney: null });',
    'src/renderer/hooks/useSessionTokens': 'export const useSessionTokens = () => null;',
    'src/renderer/hooks/useAccountUsage': 'export const useAccountUsage = () => null; export const requestCodexAccountRefresh = () => {};',
    'src/renderer/hooks/useModelAccessCreditUsage': 'export const useModelAccessCreditUsage = () => null;',
    'src/renderer/hooks/useClaudeSubscriptionUsage': 'export const useClaudeSubscriptionUsage = () => null; export const requestClaudeSubscriptionRefresh = () => {};',
    'src/renderer/hooks/useCodexRuntimeRoute': 'export const useCodexRuntimeRoute = () => ({ authInjection: null });',
    'src/renderer/hooks/useCodexRateLimits': 'export const useCodexRateLimits = () => ({ snapshot: null, refresh: () => {} });',
    'src/renderer/hooks/useRemoteDeviceUsage': 'export const useRemoteClaudeAccountUsage = () => null; export const useRemoteCodexAccountUsage = () => null; export const useRemoteXaiSubscriptionUsage = () => null; export const useRemoteXaiRateLimit = () => null; export const selectRemoteCodexAccountUsage = () => null; export const requestRemoteCodexAccountRefresh = () => {}; export const requestRemoteXaiSubscriptionRefresh = () => {};',
    'src/renderer/hooks/useRemoteClaudeSubscriptionUsage': 'export const useRemoteClaudeSubscriptionUsage = () => null; export const requestRemoteClaudeSubscriptionRefresh = () => {};',
    'src/renderer/hooks/useRemoteClaudeSessionRoute': 'export const useRemoteClaudeSessionRoute = () => null;',
    'src/renderer/hooks/useXaiSubscriptionUsage': 'export const useXaiSubscriptionUsage = () => null; export const requestXaiSubscriptionRefresh = () => {};',
    'src/renderer/hooks/useXaiRateLimit': 'export const useXaiRateLimit = () => null;',
    'src/renderer/components/chat/ChatDisplaySnapshotContext': 'export const useChatDisplaySnapshot = () => null;',
    'src/renderer/lib/makerChatStore': 'export const makerChatStore = { getSnapshot: () => ({ messages: [] }), subscribe: () => () => {} };',
  },
  cases: {
    default: { about: 'Daily limit enabled with a valid spend', data: { dailyLimitEnabled: true, todaySpend: 3 } },
    unavailable: { about: 'Daily limit enabled but daily spend unavailable', data: { dailyLimitEnabled: true, todaySpend: null } },
    disabled: { about: 'Daily limit disabled: monthly quota without a warning', data: { dailyLimitEnabled: false, todaySpend: null } },
    legacy: { about: 'Legacy gateway snapshot without the optional flag', data: { todaySpend: 3 } },
  },
  async ready(page) {
    const trigger = page.getByRole('button', { name: /./ });
    await trigger.waitFor();
    await trigger.focus();
    await page.getByTestId('quota-hover-card').getByRole('progressbar').first().waitFor();
  },
  async check(page, ui) {
    const card = page.getByTestId('quota-hover-card');
    assert.equal(await card.getByText(await ui.t('quotaCard.monthlyLabel'), { exact: true }).count(), 1);
    assert.equal(await card.getByText(await ui.t('quotaCard.dailyLabel'), { exact: true }).count(), ['default', 'legacy'].includes(ui.case) ? 1 : 0);
    assert.equal(await card.getByText(await ui.t('todaySpend.tooltip.dailyUnavailable'), { exact: true }).count(), ui.case === 'unavailable' ? 1 : 0);
  },
};
