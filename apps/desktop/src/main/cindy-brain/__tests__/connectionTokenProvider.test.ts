import { describe, expect, it, vi } from 'vitest';
import { ConnectionTokenProvider } from '../connectionTokenProvider.js';

describe('ConnectionTokenProvider', () => {
  it('caches per membership/audience and single-flights concurrent issuance', async () => {
    let now = 1_000_000;
    const issue = vi.fn(async (audience: string) => ({
      token: `token-for-${audience}`,
      expiresIn: 1_800,
      audience,
    }));
    const provider = new ConnectionTokenProvider({ issue, now: () => now });
    const input = { membershipId: 'membership-1', audience: 'org-example:plugin-a' };

    const tokens = await Promise.all([
      provider.getToken(input),
      provider.getToken(input),
      provider.getToken(input),
    ]);
    expect(tokens).toEqual(Array(3).fill('token-for-org-example:plugin-a'));
    expect(issue).toHaveBeenCalledTimes(1);
    await provider.getToken(input);
    expect(issue).toHaveBeenCalledTimes(1);

    await provider.getToken({ ...input, audience: 'org-example:plugin-b' });
    await provider.getToken({ ...input, membershipId: 'membership-2' });
    expect(issue).toHaveBeenCalledTimes(3);

    now += 1_741_000;
    await provider.getToken(input);
    expect(issue).toHaveBeenCalledTimes(4);
  });

  it('invalidate and clearAll force re-issuance without persisting tokens', async () => {
    let serial = 0;
    const provider = new ConnectionTokenProvider({
      issue: async (audience) => ({ token: `token-${++serial}`, expiresIn: 1_800, audience }),
    });
    const a = { membershipId: 'membership-1', audience: 'org-example:plugin-a' };
    const b = { membershipId: 'membership-1', audience: 'org-example:plugin-b' };
    expect(await provider.getToken(a)).toBe('token-1');
    expect(await provider.getToken(b)).toBe('token-2');
    provider.invalidate(a);
    expect(await provider.getToken(a)).toBe('token-3');
    provider.clearAll();
    expect(await provider.getToken(a)).toBe('token-4');
    expect(await provider.getToken(b)).toBe('token-5');
  });

  it('rejects malformed issuer responses and does not cache them', async () => {
    const issue = vi
      .fn()
      .mockResolvedValueOnce({ token: '', expiresIn: 1_800, audience: 'org-example:plugin-a' })
      .mockResolvedValue({ token: 'valid', expiresIn: 1_800, audience: 'org-example:plugin-a' });
    const provider = new ConnectionTokenProvider({ issue });
    const input = { membershipId: 'membership-1', audience: 'org-example:plugin-a' };
    await expect(provider.getToken(input)).rejects.toThrow(/invalid response/);
    await expect(provider.getToken(input)).resolves.toBe('valid');
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('rejects an old in-flight result after an account boundary', async () => {
    let resolveFirst!: (value: {
      token: string;
      expiresIn: number;
      audience: string;
    }) => void;
    const issue = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(async (audience: string) => ({
        token: 'new-token',
        expiresIn: 1_800,
        audience,
      }));
    const provider = new ConnectionTokenProvider({ issue });
    const input = { membershipId: 'membership-1', audience: 'org-example:plugin-a' };

    const stale = provider.getToken(input);
    provider.clearAll();
    await expect(provider.getToken(input)).resolves.toBe('new-token');
    resolveFirst({ token: 'old-token', expiresIn: 1_800, audience: input.audience });
    await expect(stale).rejects.toThrow(/account change/);
    await expect(provider.getToken(input)).resolves.toBe('new-token');
    expect(issue).toHaveBeenCalledTimes(2);
  });
});
