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

vi.mock('../toast', () => ({ toast: toastMocks }));

import { formatDiagnostics, handleProviderUpstreamError } from '../providerUpstreamErrorToast';

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

  it('adds actionable diagnostics controls only to unknown errors', () => {
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
  });

  it('excludes raw upstream detail from shareable diagnostics (prompt-leak guard)', () => {
    const occurredAt = new Date('2026-08-18T12:00:00.000Z');
    const diag = formatDiagnostics(
      {
        agent: 'pi',
        providerId: 'provider-abc',
        code: 'UNKNOWN',
        retryable: false,
        status: 400,
        // Even though main-side redaction strips credentials, upstream message
        // may still echo prompt fragments — must not reach the clipboard.
        detail: 'invalid request: please summarize the following prompt: ...',
      },
      occurredAt,
    );
    expect(diag).not.toContain('detail');
    expect(diag).not.toContain('invalid request');
    expect(diag).not.toContain('prompt');
  });

  it('includes errorType and reqId in diagnostics when present', () => {
    const occurredAt = new Date('2026-08-18T12:00:00.000Z');
    const diag = formatDiagnostics(
      {
        agent: 'claude-code',
        providerId: 'provider-abc',
        code: 'UNKNOWN',
        retryable: false,
        status: 400,
        errorType: 'invalid_request_error',
        reqId: 42,
      },
      occurredAt,
    );
    expect(diag).toContain('Error type: invalid_request_error');
    expect(diag).toContain('Request ID: 42');
    expect(diag).toContain('Time: 2026-08-18T12:00:00.000Z');
  });

  it('omits errorType and reqId lines when absent', () => {
    const occurredAt = new Date('2026-08-18T12:00:00.000Z');
    const diag = formatDiagnostics(
      {
        agent: 'codex',
        providerId: 'provider-xyz',
        code: 'RATE_LIMITED',
        retryable: true,
        status: 429,
      },
      occurredAt,
    );
    expect(diag).not.toContain('Error type');
    expect(diag).not.toContain('Request ID');
  });

  it('uses the event-time timestamp, not copy time', () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const diag = formatDiagnostics(
      {
        agent: 'pi',
        providerId: 'p',
        code: 'UNKNOWN',
        retryable: false,
        status: 500,
      },
      occurredAt,
    );
    expect(diag).toContain('Time: 2026-01-01T00:00:00.000Z');
  });
});
