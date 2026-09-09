// @vitest-environment jsdom

/**
 * ErrorBanner — LiteLLM / Responses 流中断展示不变量：
 *   1. 命中 in-stream 空壳 → 人话文案，不显示 OpenAI 协议外壳。
 *   2. 有 retryText 时 Retry 仍在（不自动续跑，但用户可点重试）。
 *   3. 「查看原始错误」展开的是未改写的 `error` 原文。
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
import { UPSTREAM_STREAM_INTERRUPTED_REASON } from '@/utils/streamInterruptError';

const STREAM_RAW =
  'OpenAI API error (500): {"message":"litellm.APIError: Response API in-stream error","type":null,"param":null,"code":"500"}';

beforeEach(() => {
  useCodexRuntimeRouteMock.mockReturnValue({ authInjection: 'env-key' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ErrorBanner — LiteLLM 流中断', () => {
  it('有 retryText 时用人话、保留 Retry、展开仍是未改写原文', () => {
    const onRetry = vi.fn();

    render(
      createElement(ErrorBanner, {
        error: STREAM_RAW,
        errorReason: UPSTREAM_STREAM_INTERRUPTED_REASON,
        retryText: 'retry-token',
        onRetry,
        agentKind: 'pi',
      }),
    );

    expect(screen.getByText('chat.errorBanner.streamInterrupted')).toBeTruthy();
    expect(screen.queryByText(STREAM_RAW)).toBeNull();

    fireEvent.click(screen.getByTitle('chat.errorBanner.retryTitle'));
    expect(onRetry).toHaveBeenCalledWith('retry-token');

    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(STREAM_RAW)).toBeTruthy();
  });

  it('没有 retryText 时用人话且不显示 Retry', () => {
    render(
      createElement(ErrorBanner, {
        error: STREAM_RAW,
        onRetry: vi.fn(),
        agentKind: 'pi',
      }),
    );

    expect(screen.getByText('chat.errorBanner.streamInterruptedNoRetry')).toBeTruthy();
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
  });
});

describe('runtime-selection-cancelled 本地化', () => {
  const fallback =
    'Deferred model switch was cancelled because safe context rebuild is unsupported. The previous model remains active.';
  const reason = 'runtime-selection-cancelled';
  const key = 'newChat.chatInput.switchFailed';

  it('live ErrorBanner uses the stable localized reason instead of the English fallback', () => {
    render(
      createElement(ErrorBanner, {
        error: fallback,
        errorReason: reason,
        onRetry: vi.fn(),
        agentKind: 'pi',
      }),
    );

    expect(screen.getByText(key)).toBeTruthy();
    expect(screen.queryByText(fallback)).toBeNull();
  });

  it('persisted ErrorMessageCard uses the same localized reason instead of the English fallback', () => {
    render(createElement(ErrorMessageCard, { message: fallback, reason }));

    expect(screen.getByText(key)).toBeTruthy();
    expect(screen.queryByText(fallback)).toBeNull();
  });
});

describe('ErrorBanner — Codex oversized history', () => {
  it('hides Retry locally and does not show a strip-fork button', () => {
    render(
      createElement(ErrorBanner, {
        error: 'oversized',
        errorReason: 'codex_history_oversized',
        retryText: 'retry-token',
        onRetry: vi.fn(),
        onForkStripEncrypted: vi.fn(),
        agentKind: 'codex',
      }),
    );
    expect(screen.getByText('logic.errors.codexHistoryOversized')).toBeTruthy();
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.forkStripOversizedHistoryTitle')).toBeNull();
  });

  it('hides Retry on SSH sessions and does not offer a local strip-fork', () => {
    render(
      createElement(ErrorBanner, {
        error: 'oversized',
        errorReason: 'codex_history_oversized',
        retryText: 'retry-token',
        onRetry: vi.fn(),
        onForkStripEncrypted: vi.fn(),
        agentKind: 'codex',
        remoteHostId: 'ssh-1',
      }),
    );
    expect(screen.getByText('logic.errors.codexHistoryOversizedRemote')).toBeTruthy();
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.forkStripOversizedHistoryTitle')).toBeNull();
  });

  it('hides Retry on device-link and does not show a strip-fork button', () => {
    render(
      createElement(ErrorBanner, {
        error: 'oversized',
        errorReason: 'codex_history_oversized',
        retryText: 'retry-token',
        onRetry: vi.fn(),
        onForkStripEncrypted: vi.fn(),
        agentKind: 'codex',
        deviceLinkDeviceId: 'device-1',
      }),
    );
    expect(screen.getByText('logic.errors.codexHistoryOversized')).toBeTruthy();
    expect(screen.queryByText('logic.errors.codexHistoryOversizedRemote')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.retryTitle')).toBeNull();
    expect(screen.queryByTitle('chat.errorBanner.forkStripOversizedHistoryTitle')).toBeNull();
  });
});

const XAI_REJECTED_RAW = `OpenAI API error (400): ${JSON.stringify({
  message: `litellm.BadRequestError: XaiException - ${JSON.stringify({
    error: { message: 'Upstream rejected the request!', type: 'invalid_request_error' },
  })}`,
  type: null,
  param: null,
  code: '400',
})}`;


describe('ErrorBanner — LiteLLM 外壳拆封', () => {
  it('展示上游内层原文，协议外壳可展开', () => {
    render(
      createElement(ErrorBanner, {
        error: XAI_REJECTED_RAW,
        retryText: 'retry-token',
        onRetry: vi.fn(),
        agentKind: 'pi',
      }),
    );

    expect(screen.getByText('Upstream rejected the request!')).toBeTruthy();
    expect(screen.queryByText(XAI_REJECTED_RAW)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(XAI_REJECTED_RAW)).toBeTruthy();
  });
});
