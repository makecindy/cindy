import { net } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

import {
  CodexWebUsageUnauthorizedError,
  codexWebUsageResponseToSnapshot,
  fetchCodexWebUsageSnapshot,
} from '../codexWebUsage';

describe('codexWebUsageResponseToSnapshot', () => {
  beforeEach(() => {
    vi.mocked(net.fetch).mockReset();
  });

  it('maps ChatGPT wham usage into the shared Codex account snapshot shape', () => {
    const snapshot = codexWebUsageResponseToSnapshot({
      plan_type: 'pro',
      credits: { balance: 3545 },
      rate_limit: {
        limit_reached: false,
        primary_window: {
          limit_window_seconds: 18_000,
          used_percent: 19,
          reset_at: 1_781_425_380,
        },
        secondary_window: {
          limit_window_seconds: 604_800,
          used_percent: 23,
          reset_at: 1_781_755_297,
        },
      },
    }, 1_781_416_000_000);

    expect(snapshot).toMatchObject({
      source: 'openai-web',
      updatedAt: 1_781_416_000_000,
      planType: 'pro',
      rateLimitReachedType: null,
      primary: {
        usedPercent: 19,
        windowMinutes: 300,
        resetsAt: 1_781_425_380,
      },
      secondary: {
        usedPercent: 23,
        windowMinutes: 10080,
        resetsAt: 1_781_755_297,
      },
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: '3545',
      },
    });
  });

  it('preserves explicit depleted credits even when the balance is absent', () => {
    const snapshot = codexWebUsageResponseToSnapshot({
      credits: {
        has_credits: false,
      },
    }, 1_781_416_000_000);

    expect(snapshot).toMatchObject({
      source: 'openai-web',
      updatedAt: 1_781_416_000_000,
      credits: {
        hasCredits: false,
        unlimited: false,
      },
    });
    expect(snapshot?.credits?.balance).toBeUndefined();
  });

  it('preserves explicit unlimited credits even when the balance is absent', () => {
    const snapshot = codexWebUsageResponseToSnapshot({
      credits: {
        unlimited: true,
      },
    }, 1_781_416_000_000);

    expect(snapshot).toMatchObject({
      source: 'openai-web',
      updatedAt: 1_781_416_000_000,
      credits: {
        hasCredits: true,
        unlimited: true,
      },
    });
    expect(snapshot?.credits?.balance).toBeUndefined();
  });

  it('drops rate-limit windows when the used percent is absent', () => {
    const snapshot = codexWebUsageResponseToSnapshot({
      plan_type: 'business',
      rate_limit: {
        primary_window: {
          limit_window_seconds: 18_000,
          reset_at: 1_781_425_380,
        },
        secondary_window: {
          limit_window_seconds: 604_800,
          used_percent: 23,
          reset_at: 1_781_755_297,
        },
      },
    }, 1_781_416_000_000);

    expect(snapshot?.primary).toBeNull();
    expect(snapshot?.secondary).toMatchObject({
      usedPercent: 23,
      windowMinutes: 10080,
    });
  });

  it('throws a distinct error for unauthorized WHAM responses', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    await expect(fetchCodexWebUsageSnapshot({
      accessToken: 'expired-token',
      fetchFn,
      timeoutMs: 1000,
    })).rejects.toBeInstanceOf(CodexWebUsageUnauthorizedError);
  });

  it('keeps non-auth HTTP failures as empty snapshots', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    await expect(fetchCodexWebUsageSnapshot({
      accessToken: 'token',
      fetchFn,
      timeoutMs: 1000,
    })).resolves.toBeNull();
  });

  it('uses Electron net.fetch by default so system proxy settings are honored', async () => {
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            limit_window_seconds: 604_800,
            used_percent: 14,
          },
        },
      }),
    } as unknown as Response);

    await expect(fetchCodexWebUsageSnapshot({
      accessToken: 'token',
      accountId: 'account-1',
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      source: 'openai-web',
      accountId: 'account-1',
      primary: {
        usedPercent: 14,
        windowMinutes: 10080,
      },
    });

    expect(net.fetch).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'ChatGPT-Account-Id': 'account-1',
        }),
      }),
    );
  });
});
