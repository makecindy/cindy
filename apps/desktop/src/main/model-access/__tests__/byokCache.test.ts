import { describe, expect, it, vi } from 'vitest';
import { createByokCache } from '../byokCache.js';
import { createByokSync } from '../byokSync.js';
const owner = { scope: 'generation-1', cacheScope: 'member-a:cn:org-a', organizationId: 'org-a' };
const provider = {
  id: 'byok-a',
  name: 'Enterprise',
  connectionRevision: 1,
  models: [
    {
      id: 'byok/a/chat',
      name: 'Chat',
      agents: ['pi'] as const,
      mode: 'chat',
      currency: 'CNY',
      contextWindow: 128000,
      perAgent: { pi: { wireProtocol: 'openai-completions' } },
    },
  ],
};
const directory = {
  schemaVersion: 1,
  organizationId: 'org-a',
  revision: '1',
  providers: [provider],
};
const credentials = {
  schemaVersion: 1,
  organizationId: 'org-a',
  credentials: [
    {
      providerId: 'byok-a',
      connectionRevision: 1,
      status: 'ready',
      endpoint: 'https://gateway.example.invalid/v1',
      apiKey: 'invalid-test-key',
    },
  ],
};
function fixture() {
  const values = new Map<string, string>();
  let now = 100000;
  const io = {
    read: (key: string) => values.get(key) ?? null,
    write: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return true;
    }),
  };
  const cache = createByokCache(io, () => now);
  const fetch = vi.fn().mockResolvedValueOnce(directory).mockResolvedValueOnce(credentials);
  const sync = createByokSync({ fetch, replace: vi.fn(), cache });
  sync.setOwner(owner);
  return {
    values,
    io,
    cache,
    sync,
    advance: () => {
      now += 86400001;
    },
  };
}
describe('encrypted BYOK snapshot contract', () => {
  it('restores matching keys across process generations, but never across identities or regions', async () => {
    const h = fixture();
    await h.sync.sync();
    expect(h.cache.load({ ...owner, scope: 'generation-2' })?.connections).toHaveLength(1);
    expect(h.cache.load({ ...owner, cacheScope: 'member-b:cn:org-a' })).toBeNull();
    expect(h.cache.load({ ...owner, cacheScope: 'member-a:global:org-a' })).toBeNull();
    expect(h.cache.load({ ...owner, organizationId: 'org-b' })).toBeNull();
  });
  it('does not extend offline validity on restart', async () => {
    const h = fixture();
    await h.sync.sync();
    const writes = h.io.write.mock.calls.length;
    const runtime = createByokSync({
      cache: h.cache,
      replace: vi.fn(),
      fetch: vi.fn().mockRejectedValue(new Error('offline')),
    });
    runtime.setOwner({ ...owner, scope: 'generation-2' });
    expect(h.io.write).toHaveBeenCalledTimes(writes);
    h.advance();
    expect(h.cache.load(owner)).toBeNull();
  });
  it('ignores corrupt snapshots and removes cached routes after an authoritative empty directory', async () => {
    const h = fixture();
    await h.sync.sync();
    const runtime = createByokSync({
      cache: h.cache,
      replace: vi.fn(),
      fetch: vi.fn().mockResolvedValue({ ...directory, revision: '2', providers: [] }),
    });
    runtime.setOwner(owner);
    await runtime.sync();
    expect(h.cache.load(owner)?.catalog.providers).toEqual([]);
    for (const key of h.values.keys()) h.values.set(key, '{bad');
    expect(h.cache.load(owner)).toBeNull();
  });
});
