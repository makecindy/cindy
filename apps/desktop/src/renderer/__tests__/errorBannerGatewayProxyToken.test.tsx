// @vitest-environment jsdom

/**
 * ErrorBanner — LiteLLM 网关 token 失效:
 *   原文(VerificationTokenTable / Invalid proxy server token)不得直接展示;
 *   换成可读提示,原文折叠在「查看原始错误」。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

const { useCodexRuntimeRouteMock } = vi.hoisted(() => ({
  useCodexRuntimeRouteMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
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
import { ErrorMessageCard } from '@/components/chat/ErrorMessageCard';

const LITELLM_401 =
  'Failed to authenticate. API Error: 401 Authentication Error, Invalid proxy server token passed. Received API Key = [REDACTED], Key Hash (Token) =[REDACTED] Unable to find token in cache or `LiteLLM_VerificationTokenTable`';

beforeEach(() => {
  useCodexRuntimeRouteMock.mockReturnValue({ authInjection: 'env-key' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ErrorBanner — LiteLLM 网关凭据失效', () => {
  it('replaces LiteLLM verification-table copy and does not offer Retry', () => {
    const onRetry = vi.fn();
    render(
      createElement(ErrorBanner, {
        error: LITELLM_401,
        errorReason: 'gateway-proxy-token-invalid',
        retryText: 'retry-token',
        onRetry,
        agentKind: 'cc',
        providerId: 'xd',
        errorSourceProviderId: 'xd',
      }),
    );

    expect(screen.getByText('chat.errorBanner.gatewayProxyTokenInvalidNoRetry')).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.gatewayProxyTokenInvalid')).toBeNull();
    expect(screen.queryByText(/LiteLLM_VerificationTokenTable/)).toBeNull();
    expect(screen.queryByText(/Invalid proxy server token/)).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('still classifies by message when reason is missing', () => {
    render(
      createElement(ErrorBanner, {
        error: LITELLM_401,
        onRetry: vi.fn(),
        agentKind: 'cc',
        errorSourceProviderId: 'xd',
      }),
    );

    expect(screen.getByText('chat.errorBanner.gatewayProxyTokenInvalidNoRetry')).toBeTruthy();
  });

  it('keeps a custom LiteLLM provider error as provider-owned raw text', () => {
    render(
      createElement(ErrorBanner, {
        error: LITELLM_401,
        onRetry: vi.fn(),
        agentKind: 'cc',
        providerId: 'custom-litellm',
        errorSourceProviderId: 'custom-litellm',
      }),
    );

    expect(screen.queryByText('chat.errorBanner.gatewayProxyTokenInvalid')).toBeNull();
    expect(screen.getByText(LITELLM_401)).toBeTruthy();
  });

  it('folds the original LiteLLM text behind show-raw', () => {
    render(
      createElement(ErrorBanner, {
        error: LITELLM_401,
        errorReason: 'gateway-proxy-token-invalid',
        onRetry: vi.fn(),
        agentKind: 'cc',
      }),
    );

    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(LITELLM_401)).toBeTruthy();
  });
});

describe('ErrorMessageCard — LiteLLM 网关凭据失效', () => {
  it('uses history copy that does not ask the user to click Retry', () => {
    render(
      createElement(ErrorMessageCard, {
        message: LITELLM_401,
        reason: 'gateway-proxy-token-invalid',
        providerId: 'xd',
      }),
    );

    expect(screen.getByText('chat.errorBanner.gatewayProxyTokenInvalidNoRetry')).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.gatewayProxyTokenInvalid')).toBeNull();
    expect(screen.queryByText(/LiteLLM_VerificationTokenTable/)).toBeNull();
  });
});
