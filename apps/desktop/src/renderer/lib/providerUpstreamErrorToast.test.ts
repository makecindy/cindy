import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  i18n: {
    t: vi.fn((key: string, options?: { provider?: string; message?: string }) =>
      key === 'providerError.upstreamToast'
        ? `${options?.provider}: ${options?.message}`
        : key,
    ),
  },
}));

vi.mock('./toast', () => ({ toast: toastMocks }));

import { formatDiagnostics, handleProviderUpstreamError } from './providerUpstreamErrorToast';

describe('handleProviderUpstreamError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the configured provider display name instead of the internal id', async () => {
    handleProviderUpstreamError({
      agent: 'claude-code',
      providerId: 'provider-abc',
      providerName: '测试网关',
      code: 'AUTH_INVALID',
      retryable: false,
      status: 401,
    });

    expect(toastMocks.error).toHaveBeenCalledWith('测试网关: providerError.AUTH_INVALID');
    expect(toastMocks.error.mock.calls[0]?.[0]).not.toContain('provider-abc');
  });

  it('adds actionable, redacted diagnostics controls only to unknown errors', () => {
    handleProviderUpstreamError({
      agent: 'pi',
      providerId: 'provider-abc',
      providerName: '测试网关',
      code: 'UNKNOWN',
      retryable: false,
      status: 400,
      detail: 'request failed: Bearer [REDACTED]',
    });

    const options = toastMocks.error.mock.calls[0]?.[1];
    expect(options.actions).toHaveLength(2);
    expect(options.actions.map((action: { label: string }) => action.label)).toEqual([
      'providerError.openLogs',
      'providerError.copyDiagnostics',
    ]);
    expect(formatDiagnostics({
      agent: 'pi',
      providerId: 'provider-abc',
      providerName: '测试网关',
      code: 'UNKNOWN',
      retryable: false,
      status: 400,
      detail: 'request failed: Bearer [REDACTED]',
    })).toContain('Detail: request failed: Bearer [REDACTED]');
  });
});
