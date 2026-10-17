import { describe, expect, it, vi } from 'vitest';
import { companionAvatarKey, createCompanionAvatarCache, type CompanionAvatarCacheDeps } from '../avatarCache.js';

const HASH = 'a'.repeat(64);
const BLOB = `cindy-media://blobs/${HASH}.png`;
const CLOUD = 'https://cdn.example.com/cindy/public/avatar/owner/793983c0.png';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function setup(overrides: Partial<CompanionAvatarCacheDeps> = {}) {
  const store = new Map<string, string>();
  let clock = 0;
  const account = { key: 'owner-a', current: true };
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const put = vi.fn(async (key: string, _bytes: Uint8Array, _mimeType: string) => { const url = `cindy-media://blobs/${'b'.repeat(64)}.png`; store.set(key, url); return url; });
  const deps = {
    localBlob: vi.fn(async (_url: string): Promise<string | null> => null),
    get, put,
    scope: vi.fn(() => {
      const captured = account.key;
      const check = () => { if (account.key !== captured) throw new Error('OWNER_CHANGED'); };
      return { key: captured, get: async (key: string) => { check(); return get(key); },
        put: async (key: string, bytes: Uint8Array, mimeType: string) => { check(); return put(key, bytes, mimeType); } };
    }),
    fetchFromDevice: vi.fn(async () => ({ buffer: PNG })),
    fetchPublic: vi.fn(async () => ({ buffer: PNG })),
    sniff: vi.fn((bytes: Uint8Array) => (bytes[0] === 0x89 ? 'image/png' : null)),
    now: () => clock,
    ...overrides,
  };
  return { cache: createCompanionAvatarCache(deps), deps, store, account, tick: (ms: number) => { clock += ms; } };
}

describe('companion avatar cache', () => {
  it('keys only avatars held elsewhere', () => {
    expect(companionAvatarKey(CLOUD)).toBe(`companion-avatar:${CLOUD}`);
    expect(companionAvatarKey(BLOB, 'laptop')).toBe(`companion-avatar:blob:${HASH}`);
    // A local blob needs no copy; emoji and presets are not addresses.
    expect(companionAvatarKey(BLOB)).toBeNull();
    expect(companionAvatarKey('🦊')).toBeNull();
    expect(companionAvatarKey('http://insecure.example/a.png')).toBeNull();
  });

  it('only looks unless asked to fetch, then keeps the copy and answers from it', async () => {
    const t = setup();
    expect(await t.cache.resolve({ avatar: CLOUD })).toBeNull();
    expect(t.deps.fetchPublic).not.toHaveBeenCalled();
    const copy = await t.cache.resolve({ avatar: CLOUD, fetch: true });
    expect(copy).toMatch(/^cindy-media:\/\/blobs\//);
    expect(t.deps.put).toHaveBeenCalledWith(`companion-avatar:${CLOUD}`, PNG, 'image/png');
    // Offline from now on: the copy still answers, nothing is fetched again.
    vi.mocked(t.deps.fetchPublic).mockRejectedValue(new Error('offline'));
    expect(await t.cache.resolve({ avatar: CLOUD, fetch: true })).toBe(copy);
    expect(t.deps.fetchPublic).toHaveBeenCalledTimes(1);
  });

  it('uses content already in the local store before asking the other computer', async () => {
    const t = setup({ localBlob: vi.fn(async () => BLOB) });
    expect(await t.cache.resolve({ avatar: BLOB, deviceId: 'laptop', fetch: true })).toBe(BLOB);
    expect(t.deps.fetchFromDevice).not.toHaveBeenCalled();
  });

  it('copies another computer\'s avatar through device-link', async () => {
    const t = setup();
    expect(await t.cache.resolve({ avatar: BLOB, deviceId: 'laptop', fetch: true })).toMatch(/^cindy-media:/);
    expect(t.deps.fetchFromDevice).toHaveBeenCalledWith('laptop', BLOB);
  });

  it('keeps only image bytes and backs off after a failure', async () => {
    const t = setup({ fetchPublic: vi.fn(async () => ({ buffer: new Uint8Array([1, 2, 3]) })) });
    expect(await t.cache.resolve({ avatar: CLOUD, fetch: true })).toBeNull();
    expect(t.deps.put).not.toHaveBeenCalled();
    await t.cache.resolve({ avatar: CLOUD, fetch: true });
    expect(t.deps.fetchPublic).toHaveBeenCalledTimes(1);
    t.tick(61_000);
    await t.cache.resolve({ avatar: CLOUD, fetch: true });
    expect(t.deps.fetchPublic).toHaveBeenCalledTimes(2);
  });

  it('shares one download between concurrent requests', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.cache.resolve({ avatar: CLOUD, fetch: true }), t.cache.resolve({ avatar: CLOUD, fetch: true })]);
    expect(a).toBe(b);
    expect(t.deps.fetchPublic).toHaveBeenCalledTimes(1);
  });

  it('never keeps a copy for the next account when the account changes during the download', async () => {
    const finish: Array<() => void> = [];
    const t = setup({ fetchPublic: vi.fn(() => new Promise<{ buffer: Uint8Array }>((resolve) => { finish.push(() => resolve({ buffer: PNG })); })) });
    const first = t.cache.resolve({ avatar: CLOUD, fetch: true });
    await vi.waitFor(() => expect(t.deps.fetchPublic).toHaveBeenCalledOnce());
    t.account.key = 'owner-b';
    // The new account does not join the old account's download.
    const second = t.cache.resolve({ avatar: CLOUD, fetch: true });
    await vi.waitFor(() => expect(t.deps.fetchPublic).toHaveBeenCalledTimes(2));
    finish[0]!();
    expect(await first).toBeNull();
    finish[1]!();
    expect(await second).toMatch(/^cindy-media:\/\/blobs\//);
    expect(t.deps.put).toHaveBeenCalledOnce();
  });
});
