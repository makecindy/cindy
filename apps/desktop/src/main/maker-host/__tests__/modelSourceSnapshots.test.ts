import { describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig, DiscoveredModel } from '@cindy/model-providers';
import { createModelSourceRevalidator } from '../model-source-revalidation';
import { acceptsModelSourceSnapshot, bindModelSourceSnapshot, issueModelSourceSnapshot, modelSourceRequestSignature } from '../model-source-snapshots';

const issue = () => issueModelSourceSnapshot([{ id: 'a/foo', name: 'Foo', discoveredSource: { kind: 'magpie', providerId: 'A' } }], 'pi', 'signature');

describe('model source receipts', () => {
  it('binds new connection sources to the exact outbound request, engine, model ID and returned data', () => {
    const source = issue()[0].discoveredSource!;
    expect(acceptsModelSourceSnapshot('a/foo', source, 'new', 'pi', 'signature')).toBe(true);
    expect(acceptsModelSourceSnapshot('foo', source, 'new', 'pi', 'signature')).toBe(false);
    expect(acceptsModelSourceSnapshot('a/foo', source, 'new', 'codex', 'signature')).toBe(false);
    expect(acceptsModelSourceSnapshot('a/foo', source, 'new', 'pi', 'new-context')).toBe(false);
    expect(acceptsModelSourceSnapshot('a/foo', { ...source, providerId: 'B' }, 'new', 'pi', 'signature')).toBe(false);
  });
  it('rejects receipts after configuration, owner or request generations change, including ABA', () => {
    const rows = issue(); let current = true;
    bindModelSourceSnapshot(rows, 'saved', () => current);
    const source = rows[0].discoveredSource!;
    expect(acceptsModelSourceSnapshot('a/foo', source, 'saved', 'pi')).toBe(true);
    expect(acceptsModelSourceSnapshot('a/foo', source, 'saved', 'pi', 'different-credential')).toBe(false);
    expect(acceptsModelSourceSnapshot('a/foo', { snapshotId: source.snapshotId, providerId: source.providerId, kind: 'magpie' }, 'saved', 'pi', 'signature')).toBe(true);
    expect(acceptsModelSourceSnapshot('a/foo', source, 'other', 'pi')).toBe(false);
    current = false;
    expect(acceptsModelSourceSnapshot('a/foo', source, 'saved', 'pi')).toBe(false);
  });
  it('canonicalizes header casing/order, while binding every endpoint and credential change', () => {
    const sig = (url: string, headers: Record<string, string>) => modelSourceRequestSignature(url, { headers });
    const url = 'https://gateway.test/v1/models';
    expect(sig(url, { Authorization: 'fake-A', 'X-Agent': 'cindy' })).toBe(sig(url, { 'x-agent': 'cindy', authorization: 'fake-A' }));
    expect(sig(url, { Authorization: 'fake-A' })).not.toBe(sig(url, { Authorization: 'fake-B' }));
    expect(sig(url, {})).not.toBe(sig(url + '?account=B', {}));
  });
});

// Unit regressions for the reported restart label loss. The catalog integration
// checks automatic recovery; these deferred responses cover the missing owner,
// credential, edit and offline timing branches through the production revalidator.
// Standalone Vitest duration: 1.13s on 2026-11-10 (10 tests).
const savedGateway = (): CustomProviderConfig => ({
  id: 'saved-gateway', name: 'Magpie', auth: { method: 'none' }, runtimes: { pi: {
    baseUrl: 'http://127.0.0.1:3425/v1', wireProtocol: 'openai-chat', models: [{
      id: 'a/foo', name: 'My name', nameExplicit: true, contextWindow: 123456, opaqueModelId: true,
      discoveredSource: { kind: 'magpie', providerId: 'Old account', snapshotId: 'previous-process:receipt' },
    }],
  } },
});

describe('model source automatic revalidation', () => {
  // #9882, unit: generation repair must not erase server cooldown, whereas
  // real owner/credential/endpoint changes must not inherit another connection's deadline.
  it.each(['owner', 'credential', 'endpoint', 'deadline'] as const)('preserves repaired-owner cooldown until %s changes', async change => {
    const config = savedGateway();
    let now = 0;
    let revision = 0;
    const fetchModels = vi.fn(async () => ({ retryAt: 900_000 }));
    const revalidate = createModelSourceRevalidator({ fetchModels, save: async () => false, now: () => now,
      credentialRevision: () => revision, isMutating: () => false });
    await revalidate([config], 'generation-1', () => true, 'owner-A');
    now = 300_000;
    await revalidate([config], 'generation-2', () => true, 'owner-A');
    expect(fetchModels).toHaveBeenCalledTimes(1);
    if (change === 'credential') revision++;
    if (change === 'endpoint') config.runtimes.pi!.baseUrl += '/new';
    if (change === 'deadline') now = 900_000;
    await revalidate([config], 'generation-3', () => true, change === 'owner' ? 'owner-B' : 'owner-A');
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  // #9882, unit: deferred network reads measure real fetch concurrency across
  // overlapping loads; queued old-owner work must not issue requests after a switch.
  it.each([false, true])('bounds overlapping reads with queued owner invalidation %s', async invalidate => {
    const configs = Array.from({ length: 8 }, (_, i) => ({ ...savedGateway(), id: `gateway-${i}` }));
    const releases: Array<() => void> = [];
    let active = 0; let peak = 0; let current = true; let released = false;
    const fetchModels = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      if (!released) await new Promise<void>(resolve => releases.push(resolve));
      active--; return null;
    });
    const revalidate = createModelSourceRevalidator({ fetchModels, save: async () => false, now: () => 0,
      credentialRevision: () => 0, isMutating: () => false });
    const first = revalidate(configs, 'scope', () => current);
    const shared = revalidate(configs, 'scope', () => current);
    await Promise.resolve(); await Promise.resolve();
    expect(fetchModels).toHaveBeenCalledTimes(4);
    current = !invalidate; released = true;
    releases.splice(0).forEach(release => release());
    await Promise.all([first, shared]);
    expect(fetchModels).toHaveBeenCalledTimes(invalidate ? 4 : 8);
    expect(peak).toBe(4);
  });

  // #9882, unit: production revalidator must retain a server deadline while
  // releasing successful rows; old tests covered only the fixed failure cooldown.
  it('retains the server deadline after a different runtime succeeds', async () => {
    let saved = savedGateway();
    saved.runtimes.codex = structuredClone(saved.runtimes.pi!);
    let now = 0;
    const fetchModels = vi.fn(async (_config: CustomProviderConfig, agent: string) =>
      agent === 'pi' || now >= 900_000 ? issue() : { retryAt: 900_000 });
    const revalidate = createModelSourceRevalidator({
      fetchModels, now: () => now, credentialRevision: () => 0, isMutating: () => false,
      save: async (_id, _previous, next) => { saved = next; return true; },
    });
    expect(await revalidate([saved], 'owner', () => true)).toBe(true);
    now = 300_000;
    expect(await revalidate([saved], 'owner', () => true)).toBe(false);
    expect(fetchModels).toHaveBeenCalledTimes(2);
    now = 900_000;
    expect(await revalidate([saved], 'owner', () => true)).toBe(true);
    expect(fetchModels).toHaveBeenCalledTimes(3);
    expect(saved.runtimes.codex!.models[0].discoveredSource?.providerId).toBe('A');
  });

  // Unit: after releasing a successful discovery, a CAS miss must not pin an
  // unusable settled result forever; retry only after the normal cooldown.
  it('retries a failed source write without retaining the successful catalog', async () => {
    const config = savedGateway();
    let now = 0;
    const fetchModels = vi.fn(async () => issue());
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const revalidate = createModelSourceRevalidator({ fetchModels, save, now: () => now, credentialRevision: () => 0, isMutating: () => false });
    expect(await revalidate([config], 'owner', () => true)).toBe(false);
    expect(await revalidate([config], 'owner', () => true)).toBe(false);
    expect(fetchModels).toHaveBeenCalledTimes(1);
    now = 300_000;
    expect(await revalidate([config], 'owner', () => true)).toBe(true);
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it.each(['none', 'owner', 'credential', 'mutation', 'edit'] as const)(
    'shares concurrent discovery and respects %s changes before saving', async change => {
      const config = savedGateway();
      let saved = config;
      let current = true;
      let revision = 0;
      let mutating = false;
      let reply!: (models: DiscoveredModel[]) => void;
      const fetching = new Promise<DiscoveredModel[]>(resolve => { reply = resolve; });
      const fetchModels = vi.fn(async () => fetching);
      const revalidate = createModelSourceRevalidator({
        fetchModels, credentialRevision: () => revision, isMutating: () => mutating, now: () => 0,
        save: async (_id, expected, next) => {
          if (JSON.stringify(saved) !== JSON.stringify(expected)) return false;
          saved = next;
          return true;
        },
      });
      const first = revalidate([config], 'owner-A', () => current);
      const second = revalidate([config], 'owner-A', () => current);
      await Promise.resolve();
      expect(fetchModels).toHaveBeenCalledTimes(1);
      if (change === 'owner') current = false;
      if (change === 'credential') revision++;
      if (change === 'mutation') mutating = true;
      if (change === 'edit') saved = { ...config, name: 'Edited by user' };
      reply(issue());
      const outcomes = await Promise.all([first, second]);
      if (change === 'none') {
        expect(outcomes.some(Boolean)).toBe(true);
        expect(saved.runtimes.pi!.models[0].discoveredSource?.providerId).toBe('A');
      } else {
        expect(outcomes).toEqual([false, false]);
        expect(saved.runtimes.pi!.models[0].discoveredSource?.providerId).toBe('Old account');
      }
      expect(saved.name).toBe(change === 'edit' ? 'Edited by user' : 'Magpie');
    },
  );

  it('keeps failed discovery hidden, throttles retries and clears sources absent from a successful response', async () => {
    let saved = savedGateway();
    const config = saved;
    let now = 0;
    const fetchModels = vi.fn<() => Promise<DiscoveredModel[] | null>>()
      .mockResolvedValueOnce(null).mockResolvedValueOnce([]);
    const save = vi.fn(async (_id: string, _previous: CustomProviderConfig, next: CustomProviderConfig) => { saved = next; return true; });
    const revalidate = createModelSourceRevalidator({
      fetchModels, save, credentialRevision: () => 0, isMutating: () => false, now: () => now,
    });
    expect(await revalidate([config], 'owner-A', () => true)).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(await revalidate([config], 'owner-A', () => true)).toBe(false);
    expect(fetchModels).toHaveBeenCalledTimes(1);
    now += 5 * 60_000;
    expect(await revalidate([config], 'owner-A', () => true)).toBe(true);
    const { discoveredSource: _old, ...original } = config.runtimes.pi!.models[0];
    expect(saved.runtimes.pi!.models).toEqual([original]);
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it('keeps the failure cooldown when another engine successfully recovers its sources', async () => {
    let saved = savedGateway();
    saved.runtimes.codex = structuredClone(saved.runtimes.pi!);
    const fetchModels = vi.fn(async (_config: CustomProviderConfig, agent: string) => agent === 'pi' ? issue() : null);
    const save = vi.fn(async (_id: string, _previous: CustomProviderConfig, next: CustomProviderConfig) => { saved = next; return true; });
    const revalidate = createModelSourceRevalidator({
      fetchModels, save, credentialRevision: () => 0, isMutating: () => false, now: () => 0,
    });
    expect(await revalidate([saved], 'owner-A', () => true)).toBe(true);
    expect(saved.runtimes.pi!.models[0].discoveredSource?.providerId).toBe('A');
    expect(await revalidate([saved], 'owner-A', () => true)).toBe(false);
    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
