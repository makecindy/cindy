// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

const { useCodexRuntimeRouteMock } = vi.hoisted(() => ({
  useCodexRuntimeRouteMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
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
