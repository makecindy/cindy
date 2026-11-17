// tier: unit. OAuth rotation/account boundaries; production store entry with encrypted IO ports.
import { describe, expect, it, vi } from 'vitest';
import { createGithubAppAuthorization, type GithubUserGrant } from '../git-context/githubAppAuthorization';

const grant: GithubUserGrant = { userId: '12', login: 'example', accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh', expiresAt: 500_000, refreshExpiresAt: 10_000_000 };
function fixture() {
  let raw: string | null = null;
  let scope = 'owner-a';
  let now = 0;
  let queue = Promise.resolve();
  const refresh = vi.fn<() => Promise<GithubUserGrant | null>>(async () => ({ ...grant, accessToken: 'synthetic-renewed', refreshToken: 'synthetic-rotated', expiresAt: 900_000 }));
  const write = vi.fn((value: string) => { raw = value; return true; });
  const changed = vi.fn();
  const store = createGithubAppAuthorization({ scope: () => scope, read: () => raw, write,
    remove: () => { raw = null; return true; }, refresh, changed, now: () => now,
    lock<T>(work: () => Promise<T>) {
      const pending = queue.then(work); queue = pending.then(() => undefined, () => undefined); return pending;
    },
  });
  return { store, refresh, write, changed, raw: () => raw,
    expire: () => { now = 400_000; }, switchOwner: () => { scope = 'owner-b'; raw = null; } };
}

describe('GitHub App user authorization', () => {
  it('rotates once for simultaneous requests and saves the new refresh token before use', async () => {
    const f = fixture(); await f.store.save(grant);
    expect(await f.store.readToken()).toBe('synthetic-access');
    f.expire();
    expect(await Promise.all([f.store.readToken(), f.store.readToken()])).toEqual(['synthetic-renewed', 'synthetic-renewed']);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(JSON.parse(f.raw()!).refreshToken).toBe('synthetic-rotated');
    await f.store.clear();
    expect(await f.store.readToken()).toBeNull();
  });
  it('does not commit or return a token after an owner switch during refresh', async () => {
    const f = fixture(); await f.store.save(grant); f.expire();
    f.refresh.mockImplementation(async () => { f.switchOwner(); return grant; });
    await expect(f.store.readToken()).rejects.toThrow('GITHUB_ACCOUNT_CHANGED');
    expect(f.raw()).toBeNull();
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('serializes disconnect behind refresh, so a late result cannot restore the deleted grant', async () => {
    const f = fixture(); await f.store.save(grant); f.expire();
    await Promise.all([f.store.readToken(), f.store.clear()]);
    expect(await f.store.readToken()).toBeNull();
  });
  it('rejects a different GitHub identity and never uses an unpersisted rotated token', async () => {
    const f = fixture(); await f.store.save(grant); f.expire();
    f.refresh.mockResolvedValueOnce({ ...grant, userId: '99' });
    await expect(f.store.readToken()).rejects.toThrow('GITHUB_INVALID_USER_GRANT');
    f.write.mockReturnValueOnce(false);
    await expect(f.store.readToken()).rejects.toThrow('GITHUB_CREDENTIAL_STORAGE_UNAVAILABLE');
  });
  it('clears a revoked grant and asks for sign-in again instead of retrying its refresh token', async () => {
    const f = fixture(); await f.store.save(grant); f.expire();
    f.refresh.mockResolvedValueOnce(null);
    expect(await f.store.readToken()).toBeNull();
    expect(await f.store.readToken()).toBeNull();
    expect(f.raw()).toBeNull();
    expect(f.refresh).toHaveBeenCalledOnce();
  });
  it('keeps stored authorization on a transient failure without exposing upstream secrets', async () => {
    const f = fixture(); await f.store.save(grant); f.expire();
    f.refresh.mockRejectedValueOnce(new Error('private upstream response synthetic-refresh'));
    const attempts = await Promise.allSettled([f.store.readToken(), f.store.readToken()]);
    expect(attempts).toEqual([1, 2].map(() => ({ status: 'rejected', reason: new Error('GITHUB_AUTHORIZATION_REFRESH_FAILED') })));
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(JSON.parse(f.raw()!).refreshToken).toBe(grant.refreshToken);
  });
});
