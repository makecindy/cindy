import { describe, expect, it, vi } from 'vitest';
import { cliProxyManagementBase, parseCliProxyQuota } from '../../../shared/cliProxyQuota.js';
import { isRendererAccessibleSafeStorageKey } from '../../../shared/providerSecrets.js';
import { fetchCliProxyQuota } from '../cliProxyQuota.js';

describe('CLI proxy Antigravity quota', () => {
  it('accepts explicit loopback providers, rejects remote destinations and URL credentials', () => {
    expect(cliProxyManagementBase('http://127.0.0.1:8317/v1')).toBe(
      'http://127.0.0.1:8317/v8/management',
    );
    expect(cliProxyManagementBase('http://[::1]:8317/v1/')).not.toBeNull();
    for (const url of [
      'https://example.com/v1',
      'http://user:pass@localhost/v1',
      'file:///tmp',
      'http://localhost/v1?url=x',
      'http://localhost/other',
    ])
      expect(cliProxyManagementBase(url)).toBeNull();
  });
  it('keeps disabled windows distinct from full available quota, rejects invalid fractions', () => {
    const groups = parseCliProxyQuota({
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { window: 'weekly', remainingFraction: 0, resetTime: '2026-11-05T00:00:00Z' },
            { window: '5h', remainingFraction: 1, disabled: true },
            { remainingFraction: -1 },
            { remainingFraction: 2 },
            { remainingFraction: '0.9' },
            null,
          ],
        },
      ],
    });
    expect(groups[0].buckets).toHaveLength(2);
    expect(groups[0].buckets[0].remainingFraction).toBe(0);
    expect(groups[0].buckets[1].disabled).toBe(true);
  });
  it('blocks generic Renderer access to management keys', () => {
    expect(isRendererAccessibleSafeStorageKey('provider_quota_account')).toBe(false);
    expect(isRendererAccessibleSafeStorageKey('PROVIDER_QUOTA_account')).toBe(false);
  });
  it('isolates accounts and returns no credential tokens', async () => {
    const payloads = [
      {
        files: [
          { name: 'a.json', provider: 'antigravity', auth_index: 'a' },
          { name: 'disabled.json', provider: 'antigravity', disabled: true },
          { name: 'bad.json', provider: 'antigravity', auth_index: 'b' },
          { provider: 'codex' },
        ],
      },
      { project_id: 'project', access_token: 'private-credential' },
      {
        status_code: 200,
        body: JSON.stringify({
          groups: [
            { displayName: 'Gemini', buckets: [{ window: 'weekly', remainingFraction: 0.9 }] },
          ],
        }),
      },
      { project_id: 'project' },
      { status_code: 403, body: 'private-upstream-error' },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payloads.shift())));
    const result = await fetchCliProxyQuota('http://localhost:8317/v1', 'management-secret', {
      fetch: fetcher,
      isCurrent: () => true,
    });
    expect(result.accounts).toHaveLength(3);
    expect(result.accounts[0].groups[0].buckets[0].remainingFraction).toBe(0.9);
    expect(result.accounts[1].disabled).toBe(true);
    expect(result.accounts[2].unavailable).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private|management-secret/);
    const call = fetcher.mock.calls[2] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toMatchObject({
      authIndex: 'a',
      header: { Authorization: 'Bearer $TOKEN$' },
    });
  });
  it('stops after an owner switch without further requests', async () => {
    let current = true;
    const fetcher = vi.fn(async () => {
      current = false;
      return new Response('{}');
    });
    await expect(
      fetchCliProxyQuota('http://localhost:8317', 'key', {
        fetch: fetcher,
        isCurrent: () => current,
      }),
    ).rejects.toThrow('Account changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
