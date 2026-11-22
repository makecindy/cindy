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
  useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => false, language: 'en' } }),
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

  it('keeps a custom LiteLLM provider error in details without Gateway attribution', () => {
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
    expect(screen.getByText('chat.errorBanner.replyFailed')).toBeTruthy();
    expect(screen.queryByText(LITELLM_401)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
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

describe('provider-supplied error guidance', () => {
  const applyUrl = 'https://console.example.com/#/work-orders/apply/22';
  const nested = JSON.stringify({ error: { code: 'ACCOUNT_SHARING_ACCESS_DENIED', message: '尚未开通。申请地址：' + applyUrl } });
  const error = 'unexpected status 407 Proxy Authentication Required: ' +
    JSON.stringify({ error: { message: 'VendorException - ' + nested, code: '407' } }) +
    ', url: http://127.0.0.1/responses';

  it.each(['live', 'history'])('shows the nested explanation and its link before details in %s', (surface) => {
    render(surface === 'live'
      ? createElement(ErrorBanner, { error, retryText: 'hi', onRetry: vi.fn() })
      : createElement(ErrorMessageCard, { message: error }));
    expect(screen.getByText('尚未开通。申请地址：')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe(applyUrl);
    expect(screen.queryByText(error)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(error)).toBeTruthy();
  });

  it('accepts new codes, languages and multiple links without promoting diagnostics', () => {
    const message = JSON.stringify({ error: { code: 'FUTURE', message: 'technical diagnostic',
      user_message: 'Read https://docs.example.com or visit https://help.example.com. token=secret-value' } });
    render(createElement(ErrorMessageCard, { message }));
    expect(screen.getAllByRole('link').map(link => link.getAttribute('href')))
      .toEqual(['https://docs.example.com/', 'https://help.example.com/']);
    expect(screen.queryByText(/technical diagnostic|secret-value/)).toBeNull();
  });

  it('handles a text-only problem detail and keeps local file references inert', () => {
    render(createElement(ErrorMessageCard, { message: JSON.stringify({ detail: 'Try a smaller file. See file:///private' }) }));
    expect(screen.getByText('Try a smaller file. See file:///private')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('leaves malformed envelopes and unrelated response fields in details', () => {
    const error = '502: {"input":{"message":"request body"},"url":"https://debug.example.com"}';
    const { rerender } = render(createElement(ErrorMessageCard, { message: error }));
    expect(screen.queryByText(/request body/)).toBeNull();
    rerender(createElement(ErrorMessageCard, { message: '502: {"message":' }));
    expect(screen.queryByText(/502/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
