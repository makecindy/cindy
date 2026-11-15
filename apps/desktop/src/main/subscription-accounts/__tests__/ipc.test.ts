/** Standard tier: owner-only account management, wire validation and path confinement.
 * Native process calls and metadata persistence are replaced; the production parser/path builder run unchanged.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionPoolConfig } from '../../../shared/subscriptionAccounts.js';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg: unknown, model?: unknown) => Promise<unknown>>(),
  context: null as null | { sharedTask?: object; controllerDeviceId?: string },
  trusted: true,
  execute: vi.fn(),
  availability: vi.fn(),
  sessionRead: vi.fn(),
  owner: 'owner-a',
  generation: 1,
  bindings: {} as Record<string, { providerId: 'anthropic' | 'openai'; accountId: string; via?: string }>,
  pools: {} as Partial<Record<'anthropic' | 'openai', SubscriptionPoolConfig>>,
  beforeWrite: undefined as (() => void) | undefined,
  access: { disabledModels: {}, disabledProviders: {} } as { disabledModels: Record<string, true>; disabledProviders: Record<string, true> },
  remoteAllowed: new Set<string>(),
  ownComputers: false,
  remoteModels: null as string[] | null,
  placement: {} as Record<string, string>,
  created: {} as Record<string, import('../placement.js').CreatedSubscriptionProvider>,
  placementUnreadable: false,
  poolUnreadable: false,
  placementWriteFails: false,
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, arg: unknown) => Promise<unknown>) =>
      h.handlers.set(name, handler),
  },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!h.trusted) throw new Error('untrusted');
  },
}));
vi.mock('../../device-link/invoke-context.js', () => ({
  getDeviceLinkInvokeContext: () => h.context,
}));
vi.mock('../../device-link/index.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../device-link/dispatch.desktop.js', () => ({ setRemoteSubscriptionPoolQuotaReader: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${h.owner}:${h.generation}`,
  getActiveAppSession: () => ({ dataOwnerId: h.owner }),
  ownerScopedUserDataPath: vi.fn(),
}));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: {} }));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: (options: { label: string }) => options.label === 'subscription-account-placement'
    ? {
        invalidateIfChanged: () => {},
        isUnreadable: () => h.placementUnreadable,
        read: () => ({ accounts: h.placement, providers: h.created, strategies: {} }),
        updateAtomic: async (edit: (input: { value: { accounts: typeof h.placement; providers: typeof h.created; strategies: Record<string, never> } }) => { accounts?: typeof h.placement; providers?: typeof h.created }) => {
          h.beforeWrite?.();
          const next = edit({ value: { accounts: h.placement, providers: h.created, strategies: {} } });
          if (h.placementWriteFails) throw new Error('placement write unavailable');
          if (next.accounts) h.placement = next.accounts;
          if (next.providers) h.created = next.providers;
        },
      }
    : {
        invalidateIfChanged: () => {},
        isUnreadable: () => h.poolUnreadable,
        read: () => ({ bindings: h.bindings, pools: h.pools }),
        updateAtomic: async (edit: (input: { value: { pools: typeof h.pools; bindings: typeof h.bindings } }) => { pools?: typeof h.pools; bindings?: typeof h.bindings }) => {
          h.beforeWrite?.();
          const next = edit({ value: { pools: h.pools, bindings: h.bindings } });
          if (next.pools) h.pools = next.pools;
          if (next.bindings) h.bindings = next.bindings;
        },
      },
}));
vi.mock('../../userDataPath.js', () => ({
  getUserDataDir: () => path.join(homedir(), 'fake-cindy-data'),
}));
vi.mock('../../maker-host/model-disable-store.js', () => ({
  readModelDisableOverrides: () => h.access,
  setProviderDisabled: (id: string, paused: boolean) => {
    if (paused) h.access.disabledProviders[id] = true;
    else delete h.access.disabledProviders[id];
  },
}));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({
  isRemoteProviderInvocationAllowed: (id: string) => h.remoteAllowed.has(id),
  isRemoteProviderOpenToOwnComputers: (id: string) => h.remoteAllowed.has(id) || h.ownComputers,
}));
vi.mock('../../device-link/remoteModelAccess.js', () => ({
  remoteModelAccess: { allows: (_id: string, model: string) => !!model && (h.remoteModels === null || h.remoteModels.includes(model)) },
}));
vi.mock('../service.js', () => ({ executeSubscriptionAccountCommand: h.execute }));
vi.mock('../runtime.js', () => ({
  onSubscriptionAccountsChanged: vi.fn(),
  readSubscriptionPoolUsage: vi.fn(async () => undefined),
  readSubscriptionPoolModelAvailability: h.availability,
  readLegacySubscriptionPoolUsage: vi.fn(async () => undefined),
  readSubscriptionSessionUsage: vi.fn(async () => undefined),
  readSubscriptionSessionAccount: h.sessionRead,
}));
import { registerSubscriptionAccountsIpc } from '../ipc.js';
import { onSubscriptionAccountsChanged } from '../runtime.js';
import { broadcast } from '../../device-link/index.js';
import { accountDirectory, accountOwnerPrefix, migrateLegacyCodexAccounts, readBoundClaudeConfigDir, readLegacyCodexAccountId, normalizePoolFile,
  readProviderBoundAccountIds, writeAccountBindings } from '../store.js';
import { SUBSCRIPTION_ACCOUNTS_CHANNEL } from '../../../shared/subscriptionAccounts.js';
import { mapIpcErrorToI18nKey } from '../../../shared/ipcError.js';
import { legacyCodexAccountCanRun, openAiRouteAllowsModel, setLegacyCodexAccountPaused } from '../legacyAccountAccess.js';
import {
  normalizePlacementFile,
  readMergedLegacyCodexAccountId,
  readOpenAiMergedLegacyAccountsIfReadable,
  restoreAutoMergedLegacyCodexAccounts,
  restoreUnplacedSubscriptionAccounts,
} from '../placement.js';
registerSubscriptionAccountsIpc();
const invoke = (command: unknown) => h.handlers.get(SUBSCRIPTION_ACCOUNTS_CHANNEL)!({}, command);

// #10286 review: preserve the exact reset target through the real owner push
// adapter; ordinary pool/load events retain their original payload.
it('forwards scoped reset invalidation without marking ordinary pool changes', () => {
  const listener = vi.mocked(onSubscriptionAccountsChanged).mock.calls[0][0];
  listener('openai', 'second');
  expect(broadcast).toHaveBeenLastCalledWith('subscription-accounts:changed', { providerId: 'openai', resetAccountId: 'second' });
  listener('openai');
  expect(broadcast).toHaveBeenLastCalledWith('subscription-accounts:changed', { providerId: 'openai' });
});
beforeEach(() => {
  h.context = null;
  h.trusted = true;
  h.owner = 'owner-a';
  h.generation = 1;
  h.bindings = {};
  h.pools = {};
  h.beforeWrite = undefined;
  h.access = { disabledModels: {}, disabledProviders: {} };
  h.remoteAllowed.clear();
  h.ownComputers = false;
  h.remoteModels = null;
  h.placement = {};
  h.created = {};
  h.placementUnreadable = false;
  h.poolUnreadable = false;
  h.placementWriteFails = false;
  h.execute.mockReset().mockResolvedValue({ accounts: [] });
  h.availability.mockReset().mockResolvedValue(true);
  h.sessionRead.mockReset().mockResolvedValue({ providerId: 'anthropic', state: 'legacy' });
});

describe('legacy Codex account upgrade', () => {
  // PR #10405, unit: full routing derives historical model membership from the persisted source;
  // an update must invalidate that index without admitting bindings from another provider kind.
  it('indexes persisted historical accounts by their actual source and follows binding writes', async () => {
    expect([...readProviderBoundAccountIds('openai', 'openai-sub-12345678')]).toEqual([]);
    await writeAccountBindings(['native:first'], 'openai', 'second', 'openai-sub-12345678');
    await writeAccountBindings(['native:other'], 'anthropic', 'third', 'anthropic-sub-12345678');
    expect([...readProviderBoundAccountIds('openai', 'openai-sub-12345678')]).toEqual(['second']);
    await writeAccountBindings(['native:first'], 'openai', 'third', 'openai-sub-12345678');
    expect([...readProviderBoundAccountIds('openai', 'openai-sub-12345678')]).toEqual(['third']);
    expect([...readProviderBoundAccountIds('anthropic', 'openai-sub-12345678')]).toEqual([]);
  });
  // PR #10271, unit: moving a remote legacy task must not bypass the destination's own grants.
  it('checks the merged route model and remote grants independently of the old connection', () => {
    expect(openAiRouteAllowsModel('gpt-model', { remote: true, ownComputer: true })).toBe(false);
    h.ownComputers = true;
    expect(openAiRouteAllowsModel('gpt-model', { remote: true, ownComputer: true })).toBe(true);
    expect(openAiRouteAllowsModel('gpt-model', { remote: true })).toBe(false);
    h.remoteModels = ['other-model'];
    expect(openAiRouteAllowsModel('gpt-model', { remote: true, ownComputer: true })).toBe(false);
    h.remoteModels = null;
    h.access.disabledModels['openai:chatgpt/gpt-model'] = true;
    expect(openAiRouteAllowsModel('gpt-model', { remote: true, ownComputer: true })).toBe(false);
    h.access.disabledModels = {};
    h.access.disabledProviders.openai = true;
    expect(openAiRouteAllowsModel('gpt-model', { remote: true, ownComputer: true })).toBe(false);
  });
  it('keeps original model exclusions and remote permission after folding a connection', () => {
    h.access.disabledModels['openai-a:chatgpt/gpt-model'] = true;
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: false, newRoute: true })).toBe(false);
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: false, newRoute: false })).toBe(true);
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: false, newRoute: false, modelSwitch: true })).toBe(false);
    expect(legacyCodexAccountCanRun('openai-a', undefined, { remote: true, newRoute: false })).toBe(false);
    h.remoteAllowed.add('openai-a');
    expect(legacyCodexAccountCanRun('openai-a', 'other-model', { remote: true, newRoute: true })).toBe(true);
    h.access.disabledProviders['openai-a'] = true;
    // Pausing allocation must not block a bound task switching to an allowed model.
    expect(legacyCodexAccountCanRun('openai-a', 'other-model', { remote: false, newRoute: false, modelSwitch: true })).toBe(true);
    expect(legacyCodexAccountCanRun('openai-a', undefined, { remote: false, newRoute: true })).toBe(false);
    setLegacyCodexAccountPaused('openai-a', false);
    expect(legacyCodexAccountCanRun('openai-a', undefined, { remote: false, newRoute: true })).toBe(true);
  });

  // PR #10150 review: with 「让我的其他电脑用本机模型」 on, an imported account serves the owner's other
  // computers, but a provider-share guest still needs the per-provider grant.
  it('admits imported accounts for own computers through the own-computer switch, never for guests', () => {
    h.ownComputers = true;
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: true, ownComputer: true, newRoute: true })).toBe(true);
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: true, newRoute: true })).toBe(false);
    h.ownComputers = false;
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: true, ownComputer: true, newRoute: true })).toBe(false);
  });

  // PR #9900, standard: a provider switch alone must not bypass the imported
  // connection's per-model remote grant, including revalidation of an existing route.
  it('keeps remote model exclusions when an imported account joins the pool', () => {
    h.remoteAllowed.add('openai-a');
    h.remoteModels = ['model-b'];
    for (const newRoute of [true, false]) {
      expect(legacyCodexAccountCanRun('openai-a', 'model-a', { remote: true, newRoute })).toBe(false);
      expect(legacyCodexAccountCanRun('openai-a', 'model-b', { remote: true, newRoute })).toBe(true);
    }
    expect(legacyCodexAccountCanRun('openai-a', 'model-a', { remote: false, newRoute: true })).toBe(true);
  });

  it('leaves excess and invalid connections unmapped instead of hiding accounts it cannot import', async () => {
    h.pools.openai = { strategy: 'least', accounts: Array.from({ length: 32 }, (_, i) => ({
      id: `fixture-${i}`, paused: false, limit: 4, weight: 1,
    })) };
    await migrateLegacyCodexAccounts([{ providerId: 'openai-excess' }, { providerId: '../escape' }], {
      preserveDefault: false, legacyDefault: false,
    });
    expect(h.pools.openai.accounts).toHaveLength(32);
    expect(readLegacyCodexAccountId('openai-excess')).toBeUndefined();
    expect(readLegacyCodexAccountId('../escape')).toBeUndefined();
  });
  // User regression 2026-11-11, standard: the real metadata/path entry must import
  // two old connections without moving credentials. Existing IPC tests only covered new profiles.
  it('imports old connections once, preserves preferences and resolves their original homes', async () => {
    await migrateLegacyCodexAccounts([{ providerId: 'openai-a' }, { providerId: 'openai-b', paused: true }], {
      preserveDefault: false, legacyDefault: false,
    });
    const pool = h.pools.openai!;
    expect(pool.accounts).toHaveLength(2);
    const firstId = readLegacyCodexAccountId('openai-a')!;
    const secondId = readLegacyCodexAccountId('openai-b')!;
    expect(firstId).not.toBe(secondId);
    expect(accountDirectory('openai', firstId)).toBe(path.join(homedir(), 'fake-cindy-data', 'codex-accounts', createHash('sha256').update(h.owner).digest('hex'), 'openai-a'));
    expect(pool.accounts.find(account => account.id === secondId)?.paused).toBe(true);
    pool.strategy = 'round';
    pool.accounts = pool.accounts.filter(account => account.id !== firstId);
    await migrateLegacyCodexAccounts([{ providerId: 'openai-a' }, { providerId: 'openai-b' }], {
      preserveDefault: true, legacyDefault: true,
    });
    expect(h.pools.openai?.strategy).toBe('round');
    expect(h.pools.openai?.accounts.map(account => account.id)).toEqual([secondId]);
    expect(readLegacyCodexAccountId('openai-a')).toBe(firstId);
  });

  it('preserves a bound private default and refuses an owner change while waiting to write', async () => {
    await migrateLegacyCodexAccounts([{ providerId: 'openai-a' }], { preserveDefault: true, legacyDefault: true });
    expect(h.pools.openai).toMatchObject({ legacyCodexDefault: true, accounts: [{ id: 'default' }, {}] });
    const before = JSON.stringify(h.pools);
    h.beforeWrite = () => { h.owner = 'owner-b'; };
    await expect(migrateLegacyCodexAccounts([{ providerId: 'openai-b' }], { preserveDefault: false, legacyDefault: false })).rejects.toThrow('owner');
    expect(JSON.stringify(h.pools)).toBe(before);
  });

  // 2026-11-13 user decision (subscription-account-pools.md 合并与拿出由用户决定), standard: the
  // v0.1.135 upgrade merged connections without asking (reproduced with its real metadata writer).
  // Restoring through the real placement entry must keep homes and pool accounts, turn a pause or
  // removal into a disabled connection, keep a merge the user chose, wait while placement cannot be
  // read, and undo an older client merging again after a downgrade.
  it('restores upgrade-merged connections to their own accounts and keeps merges the user chose', async () => {
    await migrateLegacyCodexAccounts(
      ['openai-a', 'openai-b', 'openai-c', 'openai-d'].map((providerId) => ({ providerId })),
      { preserveDefault: true, legacyDefault: false },
    );
    const ids = Object.fromEntries(['a', 'b', 'c', 'd'].map((key) => [key, readLegacyCodexAccountId(`openai-${key}`)!]));
    h.pools.openai!.accounts = h.pools.openai!.accounts
      .filter((account) => account.id !== ids.c)
      .map((account) => (account.id === ids.b ? { ...account, paused: true } : account));
    h.placement = { [`openai:${ids.d}`]: 'openai' };
    const connections = new Set(['openai-a', 'openai-b', 'openai-c', 'openai-d', 'openai-e']);
    const disable = (providerId: string) => { h.access.disabledProviders[providerId] = true; };
    const isDisabled = (providerId: string) => h.access.disabledProviders[providerId] === true;

    h.placementUnreadable = true;
    expect(await restoreAutoMergedLegacyCodexAccounts(connections, { disable, isDisabled })).toBe(false);
    expect(readMergedLegacyCodexAccountId('openai-a')).toBe(ids.a);
    h.placementUnreadable = false;

    expect(await restoreAutoMergedLegacyCodexAccounts(connections, { disable, isDisabled })).toBe(true);
    expect(h.placement).toEqual({
      [`openai:${ids.a}`]: 'openai-a', [`openai:${ids.b}`]: 'openai-b', [`openai:${ids.d}`]: 'openai',
    });
    expect(readMergedLegacyCodexAccountId('openai-a')).toBeUndefined();
    expect(readOpenAiMergedLegacyAccountsIfReadable()).toEqual({ 'openai-d': ids.d });
    expect(h.pools.openai!.accounts.map((account) => [account.id, account.paused])).toEqual([
      ['default', false], [ids.a, false], [ids.b, false], [ids.d, false],
    ]);
    expect(readLegacyCodexAccountId('openai-c')).toBeUndefined();
    expect(h.access.disabledProviders).toEqual({ 'openai-b': true, 'openai-c': true });
    expect(accountDirectory('openai', ids.a)).toBe(path.join(homedir(), 'fake-cindy-data', 'codex-accounts', createHash('sha256').update(h.owner).digest('hex'), 'openai-a'));
    const settled = JSON.stringify([h.pools, h.placement]);
    expect(await restoreAutoMergedLegacyCodexAccounts(connections, { disable, isDisabled })).toBe(false);
    expect(JSON.stringify([h.pools, h.placement])).toBe(settled);
    // Review regression: a pause the user sets in a restored connection's account list stays a pause;
    // only a leftover pause on a connection already turned off (an interrupted restore) is converted.
    const pause = (accountId: string) => { h.pools.openai!.accounts = h.pools.openai!.accounts
      .map((account) => (account.id === accountId ? { ...account, paused: true } : account)); };
    pause(ids.a);
    expect(await restoreAutoMergedLegacyCodexAccounts(connections, { disable, isDisabled })).toBe(false);
    expect(h.access.disabledProviders['openai-a']).toBeUndefined();
    pause(ids.b);
    expect(await restoreAutoMergedLegacyCodexAccounts(connections, { disable, isDisabled })).toBe(true);
    expect(h.pools.openai!.accounts.map((account) => [account.id, account.paused])).toEqual([
      ['default', false], [ids.a, true], [ids.b, false], [ids.d, false],
    ]);

    // An older client merges a connection again after a downgrade; the next load restores it.
    await migrateLegacyCodexAccounts([{ providerId: 'openai-e' }], { preserveDefault: true, legacyDefault: false });
    expect(readMergedLegacyCodexAccountId('openai-e')).toBeDefined();
    await restoreAutoMergedLegacyCodexAccounts(connections, { disable, isDisabled });
    expect(readMergedLegacyCodexAccountId('openai-e')).toBeUndefined();
    expect(readMergedLegacyCodexAccountId('openai-d')).toBe(ids.d);
    // Persisted placement never moves the CLI default account or accepts a malformed entry.
    expect(normalizePlacementFile({ accounts: {
      'openai:default': 'openai-a', 'openai:../escape': 'openai-a', [`openai:${ids.a}`]: 'Not An Id',
      [`anthropic:${ids.a}`]: 'claude-work',
    } })).toEqual({ accounts: { [`anthropic:${ids.a}`]: 'claude-work' }, providers: {}, strategies: {} });
  });
});
describe('old automatically pooled account restoration', () => {
  const account = (id: string) => ({ id, paused: false, limit: 4, weight: 1 });
  const pooledId = () => `cindy-${accountOwnerPrefix()}-12345678-1234-1234-1234-123456789abc`;
  const options = () => ({ prepare: vi.fn(), disable: vi.fn() });

  // 2026-11-14 user correction, unit: real restoration/path/binding entries. Prior coverage only
  // restored old independent Codex connections, leaving wizard/pool additions merged forever.
  // Minimal input: one unplaced non-default account; both kinds must split without moving homes,
  // changing bindings/settings, re-enabling a disconnected pool or undoing a recorded user merge.
  it.each(['openai', 'anthropic'] as const)('splits old %s additions while preserving explicit merges, bindings and account settings', async kind => {
    const id = pooledId();
    const chosen = id.replace('123456789abc', '123456789abd');
    const legacy = id.replace('123456789abc', '123456789abe');
    h.pools[kind] = { strategy: 'round', disconnected: true, accounts: [account('default'),
      { ...account(id), paused: true, limit: 2, weight: 3 }, account(chosen)],
    };
    if (kind === 'openai') {
      h.pools.openai!.accounts.push(account(legacy));
      h.pools.openai!.legacyCodexAccounts = { 'openai-missing-connection': legacy };
    }
    h.placement[`${kind}:${chosen}`] = kind;
    await writeAccountBindings(['task:saved', 'native:saved'], kind, id);
    const before = JSON.stringify([h.pools, h.bindings]);
    const directory = accountDirectory(kind, id);
    const callbacks = options();

    expect(await restoreUnplacedSubscriptionAccounts(callbacks)).toBe(true);
    const providerId = h.placement[`${kind}:${id}`];
    expect(providerId).toMatch(new RegExp(`^${kind}-sub-[a-f0-9]{8}$`));
    expect(h.created[providerId]).toMatchObject({ kind, account: id });
    expect(Object.keys(h.created)).toEqual([providerId]);
    expect(h.placement[`${kind}:${chosen}`]).toBe(kind);
    expect(h.placement[`${kind}:default`]).toBeUndefined();
    expect(callbacks.prepare).toHaveBeenCalledExactlyOnceWith(kind, providerId);
    expect(callbacks.disable).toHaveBeenCalledExactlyOnceWith(providerId);
    expect(JSON.stringify([h.pools, h.bindings])).toBe(before);
    expect(accountDirectory(kind, id)).toBe(directory);
    const settled = JSON.stringify([h.placement, h.created]);
    expect(await restoreUnplacedSubscriptionAccounts(callbacks)).toBe(false);
    expect(JSON.stringify([h.placement, h.created])).toBe(settled);
  });

  it.each(['placement', 'pool'] as const)('leaves accounts untouched while the %s file is unreadable and retries later', async file => {
    h.pools.openai = { strategy: 'least', accounts: [account(pooledId())] };
    if (file === 'placement') h.placementUnreadable = true; else h.poolUnreadable = true;
    const callbacks = options();
    expect(await restoreUnplacedSubscriptionAccounts(callbacks)).toBe(false);
    expect(callbacks.prepare).not.toHaveBeenCalled();
    expect(h.placement).toEqual({});
    h.placementUnreadable = false; h.poolUnreadable = false;
    expect(await restoreUnplacedSubscriptionAccounts(callbacks)).toBe(true);
  });

  // PR #10461 review, unit: a failed batch previously retried with random target IDs, so persisted
  // model settings accumulated under orphan IDs. Two accounts, two failed attempts, then success
  // must reuse the prepared targets, for both second-account preparation and placement-write errors.
  it.each(['prepare', 'write'] as const)('reuses prepared provider settings after repeated %s failures', async failure => {
    const first = pooledId();
    const second = first.replace('123456789abc', '123456789abd');
    h.pools.openai = { strategy: 'least', accounts: [account(first), account(second)] };
    const prepared = new Set<string>();
    let fail = true;
    let inAttempt = 0;
    const prepare = vi.fn((_kind: string, providerId: string) => {
      if (fail && failure === 'prepare' && ++inAttempt === 2) throw new Error('settings unavailable');
      prepared.add(providerId);
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      inAttempt = 0;
      h.placementWriteFails = failure === 'write';
      await expect(restoreUnplacedSubscriptionAccounts({ prepare, disable: vi.fn() })).rejects.toThrow('unavailable');
      expect(prepared.size).toBe(failure === 'prepare' ? 1 : 2);
      expect(h.created).toEqual({});
      expect(h.placement).toEqual({});
      // Pool enumeration order cannot change targets between failed attempts.
      h.pools.openai!.accounts.reverse();
    }
    fail = false; h.placementWriteFails = false;
    expect(await restoreUnplacedSubscriptionAccounts({ prepare, disable: vi.fn() })).toBe(true);
    expect([...prepared].sort()).toEqual(Object.keys(h.created).sort());
    expect(prepared.size).toBe(2);
  });

  it.each(['owner', 'generation', 'move', 'remove', 'settings'] as const)('does not publish a stale or incomplete restoration after %s changes', async change => {
    const id = pooledId();
    h.pools.openai = { strategy: 'least', accounts: [account(id)] };
    const callbacks = options();
    let current = true;
    h.beforeWrite = () => {
      if (change === 'owner') h.owner = 'owner-b';
      if (change === 'generation') current = false;
      if (change === 'move') h.placement[`openai:${id}`] = 'openai';
      if (change === 'remove') h.pools.openai!.accounts = [];
    };
    if (change === 'settings') callbacks.prepare.mockImplementation(() => { throw Error('settings unavailable'); });
    const pending = restoreUnplacedSubscriptionAccounts({ ...callbacks, isCurrent: () => current });
    if (change === 'move' || change === 'remove') expect(await pending).toBe(false);
    else await expect(pending).rejects.toThrow();
    expect(h.created).toEqual({});
    expect(h.placement).toEqual(change === 'move' ? { [`openai:${id}`]: 'openai' } : {});
  });
});

describe('subscription management boundary', () => {
  // #9833, unit: new optional model query keeps old caller shape and the
  // owner-only boundary. An aggregate/guest reply cannot authorize recovery.
  // PR #9837 review: local grants cannot authorize a remote cooldown recovery.
  it('supports model availability without changing old quota replies or admitting guests', async () => {
    const quota = h.handlers.get('maker:subscription-pool:quota')!;
    expect(await quota({}, 'anthropic')).toEqual({ providerId: 'anthropic', pooled: false, usage: null });
    h.availability.mockImplementation(async (_provider, _model, options) => options?.remote !== true);
    expect(await quota({}, 'openai', 'gpt-model')).toEqual({ providerId: 'openai', model: 'gpt-model', available: true });
    h.context = { controllerDeviceId: 'own-mac' };
    expect(await quota({}, 'openai', 'gpt-model')).toEqual({ providerId: 'openai', model: 'gpt-model', available: false });
    expect(h.availability).toHaveBeenLastCalledWith('openai', 'gpt-model', { remote: true, ownComputer: true });
    for (const model of ['', ' ', 1, {}, 'x'.repeat(513)])
      await expect(quota({}, 'anthropic', model)).rejects.toThrow('INVALID_PARAMS');
    h.context = { sharedTask: {} };
    await expect(quota({}, 'anthropic', 'sonnet')).rejects.toThrow('PERMISSION_DENIED');
    h.context = null;
    h.trusted = false;
    await expect(quota({}, 'anthropic', 'sonnet')).rejects.toThrow('untrusted');
    expect(h.availability).toHaveBeenCalledTimes(2);
  });

  // Standard: a wrong browser account must survive IPC as an actionable error,
  // and its original identity guard must survive metadata normalization/restart.
  it.each([
    ['account_mismatch', 'SUBSCRIPTION_CLAUDE_ACCOUNT_MISMATCH'],
    ['account_identity_unknown', 'SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN'],
  ])('preserves Claude identity metadata and the owner-facing %s error', async (reason, code) => {
    const account = { id: 'default', paused: false, limit: 4, weight: 1,
      reloginIdentity: 'original@example.test', lastConfirmedIdentity: 'original@example.test' };
    const normalized = normalizePoolFile({ pools: { anthropic: { strategy: 'least', accounts: [account] } } });
    expect(normalized.pools.anthropic?.accounts[0]).toEqual(account);
    h.execute.mockRejectedValue(new Error(reason));
    const error = await invoke({ action: 'login', providerId: 'anthropic', accountId: 'default', loginKey: 'renew' }).catch(error => error);
    expect(mapIpcErrorToI18nKey(error)).toBe(`ipcError.${code}`);
  });

  // #9517, unit: CLI provider-managed auth must survive the real handler and
  // renderer decoder as actionable copy, not the generic CLI/network failure.
  it('reports provider-managed authentication through the owner IPC error protocol', async () => {
    h.execute.mockRejectedValue(new Error('codex_provider_managed_auth'));
    const error = await invoke({ action: 'connect', target: 'default', providerId: 'openai', loginKey: 'login' }).catch(error => error);
    expect(mapIpcErrorToI18nKey(error)).toBe('ipcError.SUBSCRIPTION_CODEX_PROVIDER_AUTH');
  });
  it('admits the trusted owner and paired owner remote context, never an untrusted frame or shared-task guest', async () => {
    const command = { action: 'read', providerId: 'anthropic', taskId: 'task-one' };
    await invoke(command);
    expect(h.execute).toHaveBeenLastCalledWith(command);
    h.trusted = false;
    await expect(invoke(command)).rejects.toThrow('untrusted');
    h.context = {};
    await invoke(command);
    h.context = { sharedTask: {} };
    await expect(invoke(command)).rejects.toThrow('PERMISSION_DENIED');
    expect(h.execute).toHaveBeenCalledTimes(2);
  });
  // 2026-11-11 (unit, protocol): the read-only task-account query shares the owner channel. It
  // must keep that gate (identity is owner-only), validate ids, and never reach the management
  // executor; older hosts reject the unknown action, which callers treat as "keep old readers".
  it('serves the task-account read to the owner only, with validated ids', async () => {
    const query = { action: 'session', providerId: 'openai', sessionId: 'task-1', nativeSessionId: 'sdk-1' };
    await expect(invoke(query)).resolves.toEqual({ providerId: 'anthropic', state: 'legacy' });
    expect(h.sessionRead).toHaveBeenCalledExactlyOnceWith('openai', query, { remote: false, ownComputer: false });
    h.context = { controllerDeviceId: 'own-mac' };
    const remoteQuery = { action: 'session', providerId: 'anthropic', nativeSessionId: 'sdk-1', model: 'claude-sonnet' };
    await invoke(remoteQuery);
    // PR #10150 review: the account-switch probe for the owner's other computer honours the own-computer switch.
    expect(h.sessionRead).toHaveBeenLastCalledWith('anthropic', remoteQuery, { remote: true, ownComputer: true });
    const legacyQuery = { ...query, model: 'gpt-model', legacyProviderId: 'old-codex' };
    await invoke(legacyQuery);
    expect(h.sessionRead).toHaveBeenLastCalledWith('openai', legacyQuery, { remote: true, ownComputer: true });
    const freshLegacyQuery = { action: 'session', providerId: 'openai', legacyProviderId: 'old-codex', model: 'gpt-model' };
    await invoke(freshLegacyQuery);
    expect(h.sessionRead).toHaveBeenLastCalledWith('openai', freshLegacyQuery, { remote: true, ownComputer: true });
    // PR #10405: a route-aware query keeps the owner boundary and cannot mix both source forms.
    const routeQuery = { ...remoteQuery, routeProviderId: 'anthropic-sub-12345678' };
    await invoke(routeQuery);
    expect(h.sessionRead).toHaveBeenLastCalledWith('anthropic', routeQuery, { remote: true, ownComputer: true });
    h.context = { sharedTask: {} };
    await expect(invoke(query)).rejects.toThrow('PERMISSION_DENIED');
    await expect(invoke(routeQuery)).rejects.toThrow('PERMISSION_DENIED');
    h.context = null;
    for (const bad of [
      { action: 'session', providerId: 'anthropic' },
      { action: 'session', providerId: 'anthropic', sessionId: '' },
      { action: 'session', providerId: 'anthropic', sessionId: 'x'.repeat(257) },
      { action: 'session', providerId: 'anthropic-second', sessionId: 'task-1' },
      ...['', ' ', 1, {}, 'x'.repeat(513)].map(model => ({ ...query, model })),
      ...['', ' ', 1, {}, 'x'.repeat(257)].map(legacyProviderId => ({ ...query, legacyProviderId })),
      { ...remoteQuery, legacyProviderId: 'old-codex' },
      { ...legacyQuery, routeProviderId: 'openai-sub-12345678' },
      ...['', '../outside', {}, 1].map(routeProviderId => ({ ...query, routeProviderId })),
    ])
      await expect(invoke(bad)).rejects.toThrow('INVALID_PARAMS');
    h.sessionRead.mockRejectedValue(new Error('fixture-private-path'));
    await expect(invoke(query)).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_FAILED]');
    expect(h.sessionRead).toHaveBeenCalledTimes(6);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('rejects invalid account paths, settings and login keys before any native operation', async () => {
    for (const command of [
      { action: 'login', accountId: '../credentials', loginKey: 'login' },
      { action: 'add', loginKey: '../callback' },
      { action: 'connect', target: '../credentials', loginKey: 'login' },
      { action: 'connect', target: 'new', loginKey: '../callback' },
      { action: 'connect', loginKey: 'login' },
      { action: 'configure', accountId: 'default', limit: 0 },
      { action: 'configure', accountId: 'default', limit: 'unlimited' },
      { action: 'configure', limit: null },
      { action: 'configure', paused: false },
      { action: 'configure', strategy: 'unknown' },
      { action: 'read', taskId: '../other-owner' },
      { action: 'read', taskId: 42 },
    ])
      await expect(invoke({ providerId: 'anthropic', ...command })).rejects.toThrow(
        'INVALID_PARAMS',
      );
    expect(h.execute).not.toHaveBeenCalled();
  });
  // Unit, 2026-11-11: "No limit" clears the account setting; null must survive the owner parser.
  it('passes a cleared concurrency limit and a chosen limit through to the account service', async () => {
    for (const limit of [null, 16]) {
      const command = { action: 'configure', providerId: 'anthropic', accountId: 'default', limit };
      await expect(invoke(command)).resolves.toEqual({ accounts: [] });
      expect(h.execute).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'configure', accountId: 'default', limit }));
    }
  });
  // The new intent must survive the real owner IPC parser. An old "add" fallback
  // could silently attach the detected default instead of opening another login.
  it.each(['anthropic', 'openai'])(
    'preserves explicit %s preview/default/new intent across owner IPC',
    async (providerId) => {
      for (const command of [
        { action: 'preview', providerId },
        { action: 'connect', target: 'default', providerId, loginKey: 'existing' },
        { action: 'connect', target: 'new', providerId, loginKey: 'another' },
      ]) {
        await expect(invoke(command)).resolves.toEqual({ accounts: [] });
        expect(h.execute).toHaveBeenLastCalledWith(command);
      }
    },
  );
  it('derives stable directories from the owner, refusing another owner’s account id', () => {
    const id = `cindy-${accountOwnerPrefix()}-12345678-1234-4123-8123-123456789abc`;
    const directory = accountDirectory('anthropic', id);
    h.bindings = {
      'anthropic:native:secondary': { providerId: 'anthropic', accountId: id },
      'anthropic:native:default': { providerId: 'anthropic', accountId: 'default' },
      'openai:native:codex': { providerId: 'openai', accountId: id },
    };
    expect(readBoundClaudeConfigDir('secondary')).toBe(directory);
    expect(readBoundClaudeConfigDir('default')).toBeUndefined();
    expect(readBoundClaudeConfigDir('unbound')).toBeUndefined();
    expect(readBoundClaudeConfigDir('codex')).toBeUndefined();
    expect(accountDirectory('anthropic', 'default')).toBe(path.join(homedir(), '.claude'));
    expect(accountDirectory('openai', 'default')).toBe(path.join(homedir(), '.codex'));
    expect(directory).toBe(path.join(homedir(), `.claude-${id}`));
    h.generation++;
    expect(accountDirectory('anthropic', id)).toBe(directory);
    h.owner = 'owner-b';
    expect(() => readBoundClaudeConfigDir('secondary')).toThrow('unavailable');
    expect(() => accountDirectory('anthropic', id)).toThrow('unavailable');
    expect(() => accountDirectory('openai', '../../other')).toThrow('unavailable');
  });
  it('returns only a stable error code when a native process includes private details', async () => {
    h.execute.mockRejectedValue(new Error('fixture-private-auth-detail'));
    await expect(
      invoke({ action: 'add', providerId: 'openai', loginKey: 'login' }),
    ).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_FAILED]');
    h.execute.mockRejectedValue(new Error('login_cancelled'));
    await expect(
      invoke({ action: 'add', providerId: 'openai', loginKey: 'login' }),
    ).rejects.toThrow('[SUBSCRIPTION_LOGIN_CANCELLED]');
  });
});
