import { describe, expect, it, vi } from 'vitest';

import { XAI_GROK_CLIENT_VERSION } from '../../maker-host/model-discovery/xai';
import {
  fetchXaiSubscriptionUsageSnapshot,
  fingerprintXaiSubject,
  XaiSubscriptionUsageRateLimitedError,
  XaiSubscriptionUsageUnauthorizedError,
} from '../xaiSubscriptionUsage';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchXaiSubscriptionUsageSnapshot', () => {
  it('sends grok-cli headers, optional x-userid, and hashes only the OIDC subject', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer tok');
      expect(headers.get('X-XAI-Token-Auth')).toBe('xai-grok-cli');
      expect(headers.get('x-grok-client-version')).toBe(XAI_GROK_CLIENT_VERSION);
      expect(headers.get('x-grok-client-mode')).toBe('interactive');
      if (url.includes('/user?')) {
        return jsonResponse(200, { userId: 'user-1', unknownField: 'keep-out' });
      }
      if (url.includes('/settings')) {
        expect(headers.get('x-userid')).toBeNull();
        return jsonResponse(200, { subscription_tier_display: 'SuperGrok Heavy' });
      }
      if (url.includes('format=credits')) {
        expect(headers.get('x-userid')).toBeNull();
        return jsonResponse(200, {
          config: {
            creditUsagePercent: 2,
            currentPeriod: { end: '2026-08-18T09:53:45.527500+00:00' },
            productUsage: [{ product: 'GrokBuild', usagePercent: 2 }],
            prepaidBalance: { val: 0 },
          },
        });
      }
      if (url.includes('/userinfo')) {
        return jsonResponse(200, {
          sub: '9098ceb0-3131-495a-a957-fe40a8891014',
          unknownField: 'keep-out',
        });
      }
      return jsonResponse(404, {});
    });

    const snapshot = await fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: 100,
    });
    expect(snapshot).toMatchObject({
      planLabel: 'SuperGrok Heavy',
      creditUsagePercent: 2,
      productUsage: [{ product: 'GrokBuild', usagePercent: 2 }],
      prepaidBalance: 0,
      accountFingerprint: fingerprintXaiSubject('9098ceb0-3131-495a-a957-fe40a8891014'),
      updatedAt: 100,
    });
    expect(JSON.stringify(snapshot)).not.toContain('keep-out');
  });

  it('still returns weekly data when userinfo fails', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/user?')) return jsonResponse(200, { userId: 'user-1' });
      if (url.includes('/settings')) {
        return jsonResponse(200, { subscription_tier_display: 'SuperGrok' });
      }
      if (url.includes('format=credits')) {
        return jsonResponse(200, { config: { creditUsagePercent: 2 } });
      }
      if (url.includes('/userinfo')) return jsonResponse(500, {});
      return jsonResponse(404, {});
    });
    const snapshot = await fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(snapshot).toMatchObject({
      planLabel: 'SuperGrok',
      creditUsagePercent: 2,
      accountFingerprint: null,
    });
  });

  it('does not replace cache with plan-only data when billing is unparseable', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/settings')) {
        return jsonResponse(200, { subscription_tier_display: 'SuperGrok Heavy' });
      }
      if (url.includes('format=credits')) return jsonResponse(200, { config: {} });
      if (url.includes('/user?') || url.includes('/userinfo')) return jsonResponse(200, {});
      return jsonResponse(404, {});
    });
    await expect(fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeNull();
  });

  it('does not replace cache when billing 200 only has a reset time', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/settings')) {
        return jsonResponse(200, { subscription_tier_display: 'SuperGrok Heavy' });
      }
      if (url.includes('format=credits')) {
        return jsonResponse(200, { config: { currentPeriod: { end: 1_800_000_000 } } });
      }
      if (url.includes('/user?') || url.includes('/userinfo')) return jsonResponse(200, {});
      return jsonResponse(404, {});
    });
    await expect(fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeNull();
  });

  it('does not replace cache when settings fails but billing has weekly data', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/settings')) return jsonResponse(503, {});
      if (url.includes('format=credits')) {
        return jsonResponse(200, { config: { creditUsagePercent: 2 } });
      }
      if (url.includes('/user?') || url.includes('/userinfo')) return jsonResponse(200, {});
      return jsonResponse(404, {});
    });
    await expect(fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeNull();
  });

  it('does not replace cache with plan-only data when billing fails', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/settings')) {
        return jsonResponse(200, { subscription_tier_display: 'SuperGrok Heavy' });
      }
      if (url.includes('format=credits')) return jsonResponse(503, {});
      if (url.includes('/user?') || url.includes('/userinfo')) return jsonResponse(200, {});
      return jsonResponse(404, {});
    });
    await expect(fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeNull();
  });

  it('keeps quota when identity endpoints fail', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/user?')) return jsonResponse(401, { error: 'nope' });
      if (url.includes('/userinfo')) return jsonResponse(429, { error: 'slow' });
      if (url.includes('/settings')) {
        return jsonResponse(200, { subscription_tier_display: 'SuperGrok Heavy' });
      }
      if (url.includes('format=credits')) {
        return jsonResponse(200, { config: { creditUsagePercent: 2 } });
      }
      return jsonResponse(404, {});
    });
    const snapshot = await fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(snapshot).toMatchObject({
      planLabel: 'SuperGrok Heavy',
      creditUsagePercent: 2,
      accountFingerprint: null,
    });
  });

  it('does not let a hung identity request abort quota', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/user?')) {
        return await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      if (url.includes('/userinfo')) return jsonResponse(200, { sub: 'abc' });
      if (url.includes('/settings')) {
        return jsonResponse(200, { subscription_tier_display: 'SuperGrok Heavy' });
      }
      if (url.includes('format=credits')) {
        return jsonResponse(200, { config: { creditUsagePercent: 2 } });
      }
      return jsonResponse(404, {});
    });
    const snapshot = await fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
      identityTimeoutMs: 20,
    });
    expect(snapshot).toMatchObject({
      planLabel: 'SuperGrok Heavy',
      creditUsagePercent: 2,
    });
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/settings'))).toBe(true);
  });

  it('keeps cache on partial quota failure instead of treating it as empty', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/settings')) return jsonResponse(503, {});
      if (url.includes('format=credits')) return jsonResponse(200, { config: {} });
      if (url.includes('/user?') || url.includes('/userinfo')) return jsonResponse(200, {});
      return jsonResponse(404, {});
    });
    await expect(fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeNull();
  });

  it('treats quota 5xx as a transient miss instead of empty', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/user?')) return jsonResponse(200, { userId: 'user-1' });
      if (url.includes('/settings') || url.includes('format=credits') || url.includes('/userinfo')) {
        return jsonResponse(503, {});
      }
      return jsonResponse(404, {});
    });
    await expect(fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: fetchFn as unknown as typeof fetch,
    })).resolves.toBeNull();
  });

  it('throws unauthorized/rate-limited without logging response bodies', async () => {
    await expect(fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: vi.fn(async (url: string) => {
        if (url.includes('/user?') || url.includes('/userinfo')) return jsonResponse(200, {});
        return jsonResponse(401, { error: 'nope' });
      }) as unknown as typeof fetch,
    })).rejects.toBeInstanceOf(XaiSubscriptionUsageUnauthorizedError);

    await expect(fetchXaiSubscriptionUsageSnapshot({
      accessToken: 'tok',
      fetchFn: vi.fn(async () => jsonResponse(429, { error: 'slow' })) as unknown as typeof fetch,
    })).rejects.toBeInstanceOf(XaiSubscriptionUsageRateLimitedError);
  });
});
