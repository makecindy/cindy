// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

const { useCodexRuntimeRouteMock } = vi.hoisted(() => ({
  useCodexRuntimeRouteMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 插值参数拼进返回值，让进度类文案能断言实际传入的 attempt/maxAttempts。
    t: (key: string, options?: { attempt?: number; maxAttempts?: number }) =>
      options?.attempt && options.maxAttempts
        ? `${key}:${options.attempt}/${options.maxAttempts}`
        : key,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  useCodexRuntimeRouteMock.mockReturnValue({ authInjection: 'oauth-bearer' });
});

describe('ErrorBanner Codex xAI auth classification', () => {
  it('keeps Retry visible for xAI Codex 401 errors on an oauth-bearer host', () => {
    const onRetry = vi.fn();

    render(createElement(ErrorBanner, {
      error: '401 Unauthorized from xAI',
      retryText: 'retry-token',
      onRetry,
      agentKind: 'codex',
      modelId: 'xai/grok-4.3',
    }));

    const retry = screen.getByTitle('chat.errorBanner.retryTitle');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledWith('retry-token');
    expect(screen.queryByText('chat.errorBanner.codexAuthMissingLocal')).toBeNull();
  });

  it('still hides Retry for native Codex OAuth 401 errors', () => {
    render(createElement(ErrorBanner, {
      error: '401 Unauthorized from Codex',
      retryText: 'retry-token',
      onRetry: vi.fn(),
      agentKind: 'codex',
      modelId: 'gpt-5.4',
    }));

    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
    expect(screen.getByText('chat.errorBanner.codexAuthMissingLocal')).toBeTruthy();
  });
});

describe('ErrorBanner network retry guidance', () => {
  it('shows Codex reconnect progress while the turn keeps running', () => {
    render(createElement(ErrorBanner, {
      error: 'Reconnecting... 3/5',
      onRetry: vi.fn(),
      isRecoverable: true,
    }));

    expect(screen.getByText('chat.errorBanner.networkReconnecting:3/5')).toBeTruthy();
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
  });

  it('does not tell the user to click Retry when no safe retry target exists', () => {
    render(createElement(ErrorBanner, {
      error: 'Request timed out.',
      onRetry: vi.fn(),
    }));

    expect(screen.getByText('chat.errorBanner.networkUnreachableNoRetry')).toBeTruthy();
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
  });

  it('keeps the actionable guidance and button when a retry target exists', () => {
    render(createElement(ErrorBanner, {
      error: 'Request timed out.',
      retryText: 'retry-token',
      onRetry: vi.fn(),
    }));

    expect(screen.getByText('chat.errorBanner.networkUnreachable')).toBeTruthy();
    expect(screen.getByTitle('chat.errorBanner.retryTitle')).toBeTruthy();
  });
});

describe('ErrorBanner overload guidance', () => {
  const CAPACITY = 'Selected model is at capacity. Please try a different model.';

  it('shows retry progress while the overload retry is still pending', () => {
    render(createElement(ErrorBanner, {
      error: `${CAPACITY} (auto-retry 2/4)`,
      onRetry: vi.fn(),
      isRecoverable: true,
    }));

    expect(screen.getByText('chat.errorBanner.overloadRetrying:2/4')).toBeTruthy();
    // 仍在自动重试 → 不该同时催用户点重试。
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
  });

  it('switches to switch-model guidance for a terminal capacity error', () => {
    // 文案刻意不声称"重试多次": 终态也可能来自"本 turn 已有产出所以不重投"或
    // 接管条件不满足, 那时一次自动重试都没发生(review #844 codex P1)。
    render(createElement(ErrorBanner, {
      error: CAPACITY,
      retryText: 'retry-token',
      onRetry: vi.fn(),
    }));

    expect(screen.getByText('chat.errorBanner.overloadBusy')).toBeTruthy();
    expect(screen.getByTitle('chat.errorBanner.retryTitle')).toBeTruthy();
  });

  it('drops the retry prompt when no safe retry target exists', () => {
    // scheduler / goal 发起的 turn 没有安全的 recovery target。
    render(createElement(ErrorBanner, {
      error: CAPACITY,
      onRetry: vi.fn(),
    }));

    expect(screen.getByText('chat.errorBanner.overloadBusyNoRetry')).toBeTruthy();
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
  });

  it('does not fall back to the network copy for a capacity error', () => {
    // 把容量问题说成"网络异常"会让用户白折腾自己的网络。
    render(createElement(ErrorBanner, {
      error: CAPACITY,
      onRetry: vi.fn(),
    }));

    expect(screen.queryByText('chat.errorBanner.networkUnreachableNoRetry')).toBeNull();
  });

  it('keeps the raw upstream error available for overload errors', () => {
    render(createElement(ErrorBanner, {
      error: CAPACITY,
      onRetry: vi.fn(),
    }));

    const toggle = screen.getByText('chat.errorBanner.networkShowRaw');
    fireEvent.click(toggle);
    expect(screen.getByText(CAPACITY)).toBeTruthy();
  });

  it('treats an Anthropic 529 retry as an overload, not a plain network error', () => {
    render(createElement(ErrorBanner, {
      error: 'SDK API request failed: overloaded_error (HTTP 529) (auto-retry 3/10)',
      onRetry: vi.fn(),
      isRecoverable: true,
    }));

    expect(screen.getByText('chat.errorBanner.overloadRetrying:3/10')).toBeTruthy();
  });
});
