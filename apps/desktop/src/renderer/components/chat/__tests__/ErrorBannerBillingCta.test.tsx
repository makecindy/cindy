// @vitest-environment jsdom

/**
 * ErrorBanner 点数耗尽引导(购买点数直达)的门控契约:
 *  - 命中 = quota 措辞 + 账号可进计费页(cloud+personal) + 花费走 XD 网关;
 *  - 三重门任一不满足都不得出现按钮,显式第三方来源(自定义供应商)的余额
 *    问题绝不指向 Cindy 计费页。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBanner } from '../ErrorBanner';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  auth: vi.fn(() => ({
    mode: 'cloud' as 'cloud' | 'local' | 'signed-out',
    user: { membershipKind: 'personal' } as { membershipKind: 'personal' | 'org' } | null,
  })),
  claudeRoute: vi.fn((): 'gateway' | 'subscription' | null => null),
  runtimeRoute: vi.fn(() => ({ authInjection: 'env-key' as const, resolved: true })),
  apiKey: vi.fn(() => ({ hasSavedKey: false, isReconciling: false })),
  claudeOAuthConnected: vi.fn((): boolean | null => null),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: mocks.auth,
}));

vi.mock('@/hooks/useClaudeSessionRoute', () => ({
  useClaudeSessionRoute: mocks.claudeRoute,
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: mocks.apiKey,
}));

vi.mock('@/hooks/useClaudeOAuthConnected', () => ({
  useClaudeOAuthConnected: mocks.claudeOAuthConnected,
}));

vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: mocks.runtimeRoute,
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  useCodexAuth: () => ({ state: null }),
  isChatGptConnectionConnected: () => false,
}));

vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({
  useCodexSessionExpiredPrompt: () => vi.fn(),
  isCodexSessionExpiredError: () => false,
}));

const QUOTA_ERROR =
  'litellm.BudgetExceededError: ExceededBudget: Budget has been exceeded! Current cost: 12.3';

function renderBanner(props: Partial<React.ComponentProps<typeof ErrorBanner>> = {}) {
  return render(
    <ErrorBanner
      error={QUOTA_ERROR}
      retryText="retry me"
      onRetry={vi.fn()}
      agentKind="cc"
      providerId="xd"
      sessionId="s1"
      {...props}
    />,
  );
}

describe('ErrorBanner billing CTA', () => {
  beforeEach(() => {
    mocks.navigate.mockClear();
    mocks.auth.mockReturnValue({ mode: 'cloud', user: { membershipKind: 'personal' } });
    mocks.claudeRoute.mockReturnValue(null);
    mocks.apiKey.mockReturnValue({ hasSavedKey: false, isReconciling: false });
    mocks.claudeOAuthConnected.mockReturnValue(null);
    mocks.runtimeRoute.mockReturnValue({ authInjection: 'env-key', resolved: true });
  });

  it('shows CTA for implicit codex sessions once the runtime route resolves to env-key', () => {
    renderBanner({ providerId: null, agentKind: 'codex', modelId: 'gpt-5.5' });
    expect(screen.getByText('chat.errorBanner.openBilling')).toBeTruthy();
  });

  it('stays silent for implicit codex sessions while the runtime route is unresolved (placeholder env-key)', () => {
    mocks.runtimeRoute.mockReturnValue({ authInjection: 'env-key', resolved: false });
    renderBanner({ providerId: null, agentKind: 'codex', modelId: 'gpt-5.5' });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
  });

  it('shows friendly copy + buy-credits button for xd-source quota errors and navigates to billing', () => {
    renderBanner();
    expect(screen.getByText('chat.errorBanner.gatewayQuotaExceeded')).toBeTruthy();
    const cta = screen.getByText('chat.errorBanner.openBilling');
    fireEvent.click(cta);
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=billing');
    // Retry 保留:补点后原文重试即可继续。
    expect(screen.getByText('chat.errorBanner.retry')).toBeTruthy();
  });

  it('keeps raw error and hides CTA when the account has no billing page (org membership)', () => {
    mocks.auth.mockReturnValue({ mode: 'cloud', user: { membershipKind: 'org' } });
    renderBanner();
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
  });

  it('never points explicit third-party provider quota errors at Cindy billing', () => {
    renderBanner({ providerId: 'my-custom-provider' });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
  });

  it('shows CTA for cc default-route sessions only when the observed billing route is gateway', () => {
    mocks.claudeRoute.mockReturnValue('gateway');
    renderBanner({ providerId: null });
    expect(screen.getByText('chat.errorBanner.openBilling')).toBeTruthy();
  });

  it('hides CTA for cc default-route sessions on the subscription route', () => {
    mocks.claudeRoute.mockReturnValue('subscription');
    renderBanner({ providerId: null });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
  });

  it('keeps subscription-bridge models off Cindy billing even under an explicit xd provider', () => {
    // 路由层的 bridge 分流优先于会话来源:xd 会话里的 chatgpt/ 模型花的是个人订阅额度。
    renderBanner({ providerId: 'xd', modelId: 'chatgpt/gpt-5.5' });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
  });

  it('never relabels subscription-bridge (chatgpt/) quota errors even with a stale gateway route', () => {
    // bridge 请求在 proxy 提前分流、不更新会话路由观察值:残留的 gateway 观察值
    // 不得把 ChatGPT 的配额错误贴成 Cindy 点数耗尽。
    mocks.claudeRoute.mockReturnValue('gateway');
    renderBanner({ providerId: null, modelId: 'chatgpt/gpt-5.5' });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
  });

  it('falls back to the gateway-key heuristic when the route observation is gone (app restart)', () => {
    // 会话路由观察值是纯内存的:重启后持久化错误尾部拿不到,存有网关 key 时
    // 回落判 gateway,引导保留。
    mocks.claudeRoute.mockReturnValue(null);
    mocks.apiKey.mockReturnValue({ hasSavedKey: true, isReconciling: false });
    renderBanner({ providerId: null });
    expect(screen.getByText('chat.errorBanner.openBilling')).toBeTruthy();
  });

  it('stays silent while the gateway key is still reconciling (form undecided)', () => {
    mocks.claudeRoute.mockReturnValue(null);
    mocks.apiKey.mockReturnValue({ hasSavedKey: false, isReconciling: true });
    renderBanner({ providerId: null });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
  });

  it('keeps budget-prefixed (codex/) models from explicit custom providers off Cindy billing', () => {
    renderBanner({
      providerId: 'my-custom-provider',
      agentKind: 'codex',
      modelId: 'codex/gpt-5.5',
    });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
  });

  it('uses the no-retry copy when there is no safe retry target (scheduler/goal turns)', () => {
    renderBanner({ retryText: null });
    expect(screen.getByText('chat.errorBanner.gatewayQuotaExceededNoRetry')).toBeTruthy();
    expect(screen.getByText('chat.errorBanner.openBilling')).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.retry')).toBeNull();
  });

  it('hides CTA for non-quota errors', () => {
    renderBanner({ error: 'fetch failed: ECONNREFUSED' });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
  });

  it('hides CTA on remote sessions (billing facts live on the peer)', () => {
    renderBanner({ deviceLinkDeviceId: 'peer-device' });
    expect(screen.queryByText('chat.errorBanner.openBilling')).toBeNull();
  });
});
