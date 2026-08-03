// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

const { useCodexRuntimeRouteMock } = vi.hoisted(() => ({
  useCodexRuntimeRouteMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
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
import { CONTEXT_OVERFLOW_REASON } from '@/utils/contextOverflowError';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useCodexRuntimeRouteMock.mockReturnValue({ authInjection: 'oauth-bearer' });
});

// #1429 实踩的 litellm/Azure 原文(经 xd 网关)。
const OVERFLOW_ERROR =
  'API Error: 400 litellm.BadRequestError: AzureException BadRequestError - { "error": { "message": "Your input exceeds the context window of this model.", "code": "context_length_exceeded" } }';

describe('ErrorBanner context-overflow guidance (#1429)', () => {
  it('hides Retry and shows the compact action for a reason-tagged overflow error', () => {
    const onCompactContext = vi.fn();

    render(
      createElement(ErrorBanner, {
        error: 'opaque upstream failure',
        errorReason: CONTEXT_OVERFLOW_REASON,
        retryText: 'retry-token',
        onRetry: vi.fn(),
        agentKind: 'cc',
        onCompactContext,
      }),
    );

    // 重试必败 → Retry 必须隐藏(原样重发同一份超长 payload)
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
    expect(screen.getByText('chat.errorBanner.contextOverflow')).toBeTruthy();

    const compact = screen.getByTitle('chat.errorBanner.compactContextTitle');
    fireEvent.click(compact);
    expect(onCompactContext).toHaveBeenCalledTimes(1);
  });

  it('classifies persisted rows by message pattern when no reason survived', () => {
    render(
      createElement(ErrorBanner, {
        error: OVERFLOW_ERROR,
        retryText: 'retry-token',
        onRetry: vi.fn(),
        agentKind: 'cc',
        onCompactContext: vi.fn(),
      }),
    );

    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
    expect(screen.getByText('chat.errorBanner.contextOverflow')).toBeTruthy();
  });

  it('offers a real new-session action without compact support (codex sessions)', () => {
    const onNewSession = vi.fn();
    render(
      createElement(ErrorBanner, {
        error: OVERFLOW_ERROR,
        retryText: 'retry-token',
        onRetry: vi.fn(),
        agentKind: 'codex',
        onNewSession,
      }),
    );

    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.compactContextTitle')).toBeNull();
    expect(screen.getByText('chat.errorBanner.contextOverflowNoCompact')).toBeTruthy();
    fireEvent.click(screen.getByTitle('chat.errorBanner.newSessionTitle'));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the raw error inspectable behind the collapse toggle', () => {
    render(
      createElement(ErrorBanner, {
        error: OVERFLOW_ERROR,
        retryText: 'retry-token',
        onRetry: vi.fn(),
        agentKind: 'cc',
        onCompactContext: vi.fn(),
      }),
    );

    // 友好文案替换了原文,但排障需要原文 —— 折叠可查(与网络/过载类同款控件)
    const toggle = screen.getByText('chat.errorBanner.networkShowRaw');
    fireEvent.click(toggle);
    expect(screen.getByText(OVERFLOW_ERROR)).toBeTruthy();
  });

  it('does not hijack ordinary errors (Retry stays)', () => {
    const onRetry = vi.fn();
    render(
      createElement(ErrorBanner, {
        error: 'Internal server error, please retry later.',
        retryText: 'retry-token',
        onRetry,
        agentKind: 'cc',
        onCompactContext: vi.fn(),
      }),
    );

    expect(screen.queryByTitle('chat.errorBanner.compactContextTitle')).toBeNull();
    const retry = screen.getByTitle('chat.errorBanner.retryTitle');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith('retry-token');
  });
});
