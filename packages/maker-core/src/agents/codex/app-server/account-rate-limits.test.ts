import { describe, expect, it, vi } from 'vitest';
import { readAccountRateLimitsWithRefresh } from './account-rate-limits.js';
import { Method } from './protocol.js';

const expired = new Error('codex app-server account/rateLimits/read error -32603: 401 Unauthorized; {"code":"token_expired"}');

describe('native account rate limit renewal', () => {
  it('refreshes a recoverable expired access token before retrying the read once', async () => {
    const result = { rateLimits: { planType: 'pro' } };
    const request = vi.fn().mockRejectedValueOnce(expired).mockResolvedValueOnce({}).mockResolvedValueOnce(result);
    await expect(readAccountRateLimitsWithRefresh(request)).resolves.toEqual(result);
    expect(request.mock.calls).toEqual([
      [Method.AccountRateLimitsRead],
      ['account/read', { refreshToken: true }, { timeoutMs: 8_000 }],
      [Method.AccountRateLimitsRead],
    ]);
  });

  it.each([
    '401 token_expired',
    'codex app-server model/list error: 401 token_expired',
    'codex app-server account/rateLimits/read error: 401 token_revoked',
    'codex app-server account/rateLimits/read error: 429',
    'codex app-server account/rateLimits/read error: 502 upstream unreachable',
  ])('does not refresh unrelated or permanent errors: %s', message => {
    const error = new Error(message);
    const request = vi.fn().mockRejectedValue(error);
    return expect(readAccountRateLimitsWithRefresh(request)).rejects.toBe(error).then(() => {
      expect(request).toHaveBeenCalledOnce();
    });
  });

  it('does not loop when renewal fails or the renewed token is still rejected', async () => {
    const refreshFailed = new Error('network unavailable');
    const failed = vi.fn().mockRejectedValueOnce(expired).mockRejectedValueOnce(refreshFailed);
    await expect(readAccountRateLimitsWithRefresh(failed)).rejects.toBe(refreshFailed);
    expect(failed).toHaveBeenCalledTimes(2);
    const rejected = vi.fn().mockRejectedValueOnce(expired).mockResolvedValueOnce({}).mockRejectedValueOnce(expired);
    await expect(readAccountRateLimitsWithRefresh(rejected)).rejects.toBe(expired);
    expect(rejected).toHaveBeenCalledTimes(3);
  });
});
