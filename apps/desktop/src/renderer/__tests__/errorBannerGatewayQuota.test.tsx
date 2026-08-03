// @vitest-environment jsdom

/**
 * ErrorBanner — Cindy AI 网关余额耗尽的导流不变量：
 *   1. 来源确定是 xd 且计费面可见（父组件传了 onViewBalance）→ 文案换成「余额不足，
 *      请充值后继续」并给出右端内联「查看余额」。
 *   2. 来源是其它供应商 → 一个字都不改，也不加按钮（没有可跳的地方）。
 *   3. 来源是 xd 但计费面不可见（org / local，父组件不传回调）→ 同样不改、不加按钮。
 *   4. 非余额类错误不被这条分支吃掉。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

const { useCodexRuntimeRouteMock } = vi.hoisted(() => ({
  useCodexRuntimeRouteMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => true }),
}));

vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: useCodexRuntimeRouteMock,
}));

vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({
  isCodexSessionExpiredError: () => false,
  useCodexSessionExpiredPrompt: () => vi.fn(),
}));

import { ErrorBanner } from '@/components/chat/ErrorBanner';

const QUOTA_ERROR = 'litellm.BadRequestError: insufficient_quota for this key';

beforeEach(() => {
  useCodexRuntimeRouteMock.mockReturnValue({ authInjection: 'env-key' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ErrorBanner — Cindy AI 余额不足导流', () => {
  it('来源是 xd 且计费面可见时换文案并给「查看余额」出口', () => {
    const onViewBalance = vi.fn();

    render(
      createElement(ErrorBanner, {
        error: QUOTA_ERROR,
        onRetry: vi.fn(),
        agentKind: 'cc',
        providerId: 'xd',
        errorSourceProviderId: 'xd',
        onViewBalance,
      }),
    );

    expect(screen.getByText('chat.errorBanner.gatewayQuotaExhausted')).toBeTruthy();
    expect(screen.queryByText(QUOTA_ERROR)).toBeNull();
    fireEvent.click(screen.getByTitle('chat.errorBanner.viewBalanceTitle'));
    expect(onViewBalance).toHaveBeenCalledOnce();
  });

  it('余额不足不隐藏 Retry —— 充值后原样重试就该成功', () => {
    const onRetry = vi.fn();

    render(
      createElement(ErrorBanner, {
        error: QUOTA_ERROR,
        retryText: 'retry-token',
        onRetry,
        agentKind: 'cc',
        providerId: 'xd',
        errorSourceProviderId: 'xd',
        onViewBalance: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByTitle('chat.errorBanner.retryTitle'));
    expect(onRetry).toHaveBeenCalledWith('retry-token');
  });

  it('其它供应商保持现状：不改文案、不加按钮', () => {
    render(
      createElement(ErrorBanner, {
        error: QUOTA_ERROR,
        onRetry: vi.fn(),
        agentKind: 'cc',
        providerId: 'anthropic',
        errorSourceProviderId: 'anthropic',
        onViewBalance: vi.fn(),
      }),
    );

    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.gatewayQuotaExhausted')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.viewBalanceTitle')).toBeNull();
  });

  it('错误来源不明(无 errorSourceProviderId)时不启用余额分类 —— 即使会话当前是 xd', () => {
    render(
      createElement(ErrorBanner, {
        error: QUOTA_ERROR,
        onRetry: vi.fn(),
        agentKind: 'cc',
        // 会话当前 provider 是 xd,但这条错误的来源快照缺失(老数据):fail-closed。
        providerId: 'xd',
        onViewBalance: vi.fn(),
      }),
    );

    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
    expect(screen.queryByTitle('chat.errorBanner.viewBalanceTitle')).toBeNull();
  });

  it('计费面对当前账号不可见（org / local，父组件不传回调）时不给点不出结果的按钮', () => {
    render(
      createElement(ErrorBanner, {
        error: QUOTA_ERROR,
        onRetry: vi.fn(),
        agentKind: 'cc',
        providerId: 'xd',
        errorSourceProviderId: 'xd',
      }),
    );

    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.gatewayQuotaExhausted')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.viewBalanceTitle')).toBeNull();
  });

  it('非余额类错误不被这条分支吃掉', () => {
    render(
      createElement(ErrorBanner, {
        error: 'Selected model is at capacity. Please try a different model.',
        onRetry: vi.fn(),
        agentKind: 'cc',
        providerId: 'xd',
        errorSourceProviderId: 'xd',
        onViewBalance: vi.fn(),
      }),
    );

    expect(screen.queryByText('chat.errorBanner.gatewayQuotaExhausted')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.viewBalanceTitle')).toBeNull();
  });

  it('持久化错误行(ErrorTailErrorBanner)同样透传「查看余额」—— 重载后恢复的历史余额错误不退化', async () => {
    const { ErrorTailErrorBanner } = await import('@/components/chat/InterruptedTurnBanner');
    const onViewBalance = vi.fn();

    render(
      createElement(ErrorTailErrorBanner, {
        errorText: QUOTA_ERROR,
        onContinue: vi.fn(),
        onDismiss: vi.fn(),
        agentKind: 'cc',
        providerId: 'xd',
        errorSourceProviderId: 'xd',
        onViewBalance,
      }),
    );

    expect(screen.getByText('chat.errorBanner.gatewayQuotaExhausted')).toBeTruthy();
    fireEvent.click(screen.getByTitle('chat.errorBanner.viewBalanceTitle'));
    expect(onViewBalance).toHaveBeenCalledTimes(1);
  });

  it('报错后切换 provider:来源快照是 xd、会话已切到 openai → 充值入口不丢', () => {
    const onViewBalance = vi.fn();
    render(
      createElement(ErrorBanner, {
        error: QUOTA_ERROR,
        onRetry: vi.fn(),
        agentKind: 'cc',
        // 会话当前 provider 已经切走,但错误发生在 xd 上 —— 分类跟来源走。
        providerId: 'openai',
        errorSourceProviderId: 'xd',
        onViewBalance,
      }),
    );

    expect(screen.getByText('chat.errorBanner.gatewayQuotaExhausted')).toBeTruthy();
    fireEvent.click(screen.getByTitle('chat.errorBanner.viewBalanceTitle'));
    expect(onViewBalance).toHaveBeenCalledOnce();
  });

  it('报错后切换 provider:来源快照是 openai、会话切到 xd → 不误挂 Cindy AI 充值入口', () => {
    render(
      createElement(ErrorBanner, {
        error: QUOTA_ERROR,
        onRetry: vi.fn(),
        agentKind: 'cc',
        providerId: 'xd',
        errorSourceProviderId: 'openai',
        onViewBalance: vi.fn(),
      }),
    );

    expect(screen.getByText(QUOTA_ERROR)).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.gatewayQuotaExhausted')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.viewBalanceTitle')).toBeNull();
  });
});
