/** Standard tier: owner-only account management, wire validation and path confinement.
 * Native process calls and metadata persistence are replaced; the production parser/path builder run unchanged.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { providerShareGuestPeer } from '@cindy/device-link';
import type { SubscriptionPoolConfig } from '../../../shared/subscriptionAccounts.js';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg: unknown, model?: unknown, scope?: unknown) => Promise<unknown>>(),
  context: null as null | { sharedTask?: object; controllerDeviceId?: string },
  trusted: true,
  execute: vi.fn(),
  availability: vi.fn(),
  scheduling: vi.fn(),
  sessionRead: vi.fn(),
  owner: 'owner-a',
  generation: 1,
  bindings: {} as Record<string, { providerId: 'anthropic' | 'openai'; accountId: string; via?: string }>,
  pools: {} as Partial<Record<'anthropic' | 'openai', SubscriptionPoolConfig>>,
  beforeWrite: undefined as (() => void) | undefined,
  access: { disabledModels: {}, disabledProviders: {} } as { disabledModels: Record<string, true>; disabledProviders: Record<string, true> },
  remoteAllowed: new Set<string>(),
  remoteModels: null as string[] | null,
  placement: {} as Record<string, string>,
  created: {} as Record<string, import('../placement.js').CreatedSubscriptionProvider>,
  placementUnreadable: false,
  poolUnreadable: false,
  placementWriteFails: false,
  repaired: {} as Record<string, 'pending' | 'done'>,
  warn: vi.fn(),
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
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: (options: { label: string }) => options.label === 'subscription-upgrade-split-repairs'
    ? {
        invalidateIfChanged: () => {},
        isUnreadable: () => false,
        read: () => ({ repaired: h.repaired }),
        updateAtomic: async (edit: (input: { value: { repaired: typeof h.repaired } }) => { repaired?: typeof h.repaired }) => {
          const next = edit({ value: { repaired: h.repaired } });
          if (next.repaired) h.repaired = next.repaired;
        },
      }
    : options.label === 'subscription-account-placement'
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
}));
vi.mock('../../device-link/remoteModelAccess.js', () => ({
  remoteModelAccess: { allows: (_id: string, model: string) => !!model && (h.remoteModels === null || h.remoteModels.includes(model)) },
}));
vi.mock('../service.js', () => ({ executeSubscriptionAccountCommand: h.execute }));
vi.mock('../runtime.js', () => ({
  onSubscriptionAccountsChanged: vi.fn(),
  readSubscriptionPoolUsage: vi.fn(async () => undefined),
  readSubscriptionPoolModelAvailability: h.availability,
  readSubscriptionPoolScheduling: h.scheduling,
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
import { AccountServiceUnreachableError } from '../accountServiceError.js';
import { legacyCodexAccountCanRun, openAiRouteAllowsModel, setLegacyCodexAccountPaused } from '../legacyAccountAccess.js';
import {
  normalizePlacementFile,
  accountProviderId,
  createSubscriptionProvider,
  placeSubscriptionAccount,
  readMergedLegacyCodexAccountId,
  readOpenAiMergedLegacyAccountsIfReadable,
  restoreAutoMergedLegacyCodexAccounts,
} from '../placement.js';
import { findUpgradeSplitRepair, recordUpgradeSplitRepairStarted, settleUpgradeSplitRepairs, type UpgradeSplitRepairDeps } from '../upgradeSplitRepair.js';
registerSubscriptionAccountsIpc();
const invoke = (command: unknown) => h.handlers.get(SUBSCRIPTION_ACCOUNTS_CHANNEL)!({}, command);

// Unit: CLI-origin accounts were rejected by the actual placement writer. Moving out and back
// must persist like any account while the official CLI home and history remain unchanged.
it.each(['anthropic', 'openai'] as const)('persists CLI-origin %s placement without relocating its home', async kind => {
  const directory = accountDirectory(kind, 'default');
  const provider = await createSubscriptionProvider(kind, 'default', 'Account', () => '12345678');
  expect(accountProviderId(kind, 'default')).toBe(provider);
  expect(normalizePlacementFile({ accounts: h.placement, providers: h.created }).providers[provider].account).toBe('default');
  expect(accountDirectory(kind, 'default')).toBe(directory);
  await placeSubscriptionAccount(kind, 'default', kind);
  expect(accountProviderId(kind, 'default')).toBe(kind);
  expect(accountDirectory(kind, 'default')).toBe(directory);
});

// #10286 review: preserve the exact reset target through the real owner push
// adapter; ordinary pool/load events retain their original payload.
it('forwards scoped reset invalidation without marking ordinary pool changes', () => {
  const listener = vi.mocked(onSubscriptionAccountsChanged).mock.calls[0][0];
  listener('openai', 'second');
  expect(broadcast).toHaveBeenLastCalledWith('subscription-accounts:changed', { providerId: 'openai', resetAccountId: 'second' });
  listener('openai');
  expect(broadcast).toHaveBeenLastCalledWith('subscription-accounts:changed', { providerId: 'openai' });
  listener('openai', undefined, 'usage');
  expect(broadcast).toHaveBeenLastCalledWith('subscription-accounts:changed', { providerId: 'openai', change: 'usage' });
  listener('anthropic', undefined, 'load');
  expect(broadcast).toHaveBeenLastCalledWith('subscription-accounts:changed', { providerId: 'anthropic', change: 'load' });
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

// Unit, duplicate-account regression: one account can retain two native homes. The production
// placement entry must commit their move/take-out together; prior cases only moved one home.
it('moves and takes out all homes of an account atomically, including failed writes', async () => {
  const first = `cindy-${accountOwnerPrefix()}-11111111-1111-4111-8111-111111111111`;
  const second = `cindy-${accountOwnerPrefix()}-22222222-2222-4222-8222-222222222222`;
  h.placement = { [`openai:${first}`]: 'openai', [`openai:${second}`]: 'openai' };
  const before = structuredClone(h.placement);
  h.placementWriteFails = true;
  await expect(placeSubscriptionAccount('openai', [first, second], 'openai-target')).rejects.toThrow('placement write unavailable');
  expect(h.placement).toEqual(before);
  await expect(createSubscriptionProvider('openai', first, 'Account', () => '12345678', undefined, [second]))
    .rejects.toThrow('placement write unavailable');
  expect(h.placement).toEqual(before);
  expect(h.created).toEqual({});
  h.placementWriteFails = false;
  // One concurrent eligibility change while the automatic move waits for the placement lock.
  let eligible = true;
  h.beforeWrite = () => { eligible = false; };
  await expect(placeSubscriptionAccount('openai', [first, second], 'openai-target', () => {
    if (!eligible) throw new Error('Account is no longer eligible');
  })).rejects.toThrow('Account is no longer eligible');
  expect(h.placement).toEqual(before);
  let writes = 0;
  h.beforeWrite = () => { writes++; };
  await placeSubscriptionAccount('openai', [first, second], 'openai-target');
  expect(h.placement).toEqual({ [`openai:${first}`]: 'openai-target', [`openai:${second}`]: 'openai-target' });
  expect(writes).toBe(1);
  const target = await createSubscriptionProvider('openai', first, 'Account', () => '12345678', undefined, [second]);
  expect(h.placement).toEqual({ [`openai:${first}`]: target, [`openai:${second}`]: target });
  expect(h.created[target].account).toBe(first);
  expect(writes).toBe(2);
  await expect(placeSubscriptionAccount('openai', [first, '../escape'], 'openai')).rejects.toThrow('Account cannot be moved');
  expect(writes).toBe(2);
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
    h.remoteAllowed.add('openai');
    expect(openAiRouteAllowsModel('gpt-model', { remote: true, ownComputer: true })).toBe(true);
    expect(openAiRouteAllowsModel('gpt-model', { remote: true })).toBe(true);
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

  // 2026-11-18 user decision: 「允许被远程调用」 is the only switch; own computers and guests read the same one.
  it('admits imported accounts for own computers and guests by the same remote-use switch', () => {
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: true, ownComputer: true, newRoute: true })).toBe(false);
    h.remoteAllowed.add('openai-a');
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: true, ownComputer: true, newRoute: true })).toBe(true);
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: true, newRoute: true })).toBe(true);
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
    // CLI-origin profiles can move like every other account; malformed entries still fail closed.
    expect(normalizePlacementFile({ accounts: {
      'openai:default': 'openai-a', 'openai:../escape': 'openai-a', [`openai:${ids.a}`]: 'Not An Id',
      [`anthropic:${ids.a}`]: 'claude-work',
    } })).toEqual({ accounts: { 'openai:default': 'openai-a', [`anthropic:${ids.a}`]: 'claude-work' }, providers: {}, strategies: {} });
  });
});
describe('upgrade split repair', () => {
  const account = (id: string, paused = false) => ({ id, paused, limit: 4, weight: 1 });
  const pooledId = () => `cindy-${accountOwnerPrefix()}-12345678-1234-1234-1234-123456789abc`;
  // The id the 0.1.137–0.1.139 upgrade derived for an account (the removed placement.ts split).
  const splitId = (kind: 'openai' | 'anthropic', id: string) =>
    `${kind}-sub-${createHash('sha256').update(`${kind}:${id}:0`).digest('hex').slice(0, 8)}`;
  const deps = (patch: Partial<UpgradeSplitRepairDeps> = {}): UpgradeSplitRepairDeps => ({
    signInEvidence: () => 'signed-out', remoteInvocationAllowed: () => false, sharedProviderIds: () => new Set(),
    hasProviderGroup: () => false, renamed: () => false, disabled: () => false, ...patch,
  });
  // The field report's state after the upgrade: paused, signed-out default left in the built-in provider,
  // the only usable account in the provider the upgrade made for it.
  const split = (kind: 'openai' | 'anthropic') => {
    const id = pooledId();
    const providerId = splitId(kind, id);
    h.pools[kind] = { strategy: 'least', accounts: [account('default', true), account(id)] };
    h.placement[`${kind}:${id}`] = providerId;
    h.created[providerId] = { kind, name: 'Claude · someone', account: id };
    return { id, providerId };
  };
  beforeEach(() => {
    h.pools = {}; h.placement = {}; h.created = {}; h.repaired = {}; h.placementUnreadable = false; h.poolUnreadable = false;
  });

  // 2026-11-17 field report / 2026-11-18 user decision (subscription-account-pools.md 升级拆坏的自动并回), unit:
  // nothing put the account back, so groups and shares naming the built-in provider stayed broken.
  // Real placement/pool/repair-record stores; minimal input: one untouched split, built-in left unusable.
  // Review findings: a merged split stays as an alias, so a later take-out reuses its id and must not be
  // merged again; a started merge that did not go through must stay eligible.
  it.each(['anthropic', 'openai'] as const)('puts back an untouched %s split and never undoes a later take-out', async kind => {
    const owner = `${h.owner}:${h.generation}`;
    const { id, providerId } = split(kind);
    expect(findUpgradeSplitRepair(deps())).toEqual({ kind, providerId });
    // Signed out instead of paused qualifies the same way.
    h.pools[kind]!.accounts = [account('default'), account(id)];
    expect(findUpgradeSplitRepair(deps({ signInEvidence: (_k, accountId) => accountId === 'default' ? 'signed-out' : 'signed-in' })))
      .toEqual({ kind, providerId });
    await recordUpgradeSplitRepairStarted(providerId, owner);
    await settleUpgradeSplitRepairs(owner);
    expect(findUpgradeSplitRepair(deps())).toEqual({ kind, providerId });
    h.placement[`${kind}:${id}`] = kind; // what the merge command records
    await settleUpgradeSplitRepairs(owner);
    expect(h.repaired).toEqual({ [providerId]: 'done' });
    h.placement[`${kind}:${id}`] = providerId; // the user takes it out again
    expect(findUpgradeSplitRepair(deps())).toBeNull();
  });

  // Same rule for a split the user merged back by hand on this version; and a record is never written
  // into another owner's file (review finding: an owner switch mid-run).
  it('treats a split the user merged back as done and keeps records per owner', async () => {
    const owner = `${h.owner}:${h.generation}`;
    const { id, providerId } = split('anthropic');
    h.placement[`anthropic:${id}`] = 'anthropic';
    await settleUpgradeSplitRepairs(owner);
    h.placement[`anthropic:${id}`] = providerId;
    expect(findUpgradeSplitRepair(deps())).toBeNull();
    h.repaired = {};
    await expect(recordUpgradeSplitRepairStarted(providerId, 'previous-owner:1')).rejects.toThrow('owner changed');
    expect(h.repaired).toEqual({});
  });

  // Same decision: anything showing the user uses the split, or that the built-in provider still
  // serves or was turned off, leaves it alone. One guard per row on the otherwise qualifying input.
  it.each([
    ['the built-in default account is signed in', () => deps({ signInEvidence: (_k, accountId) => accountId === 'default' ? 'signed-in' : 'signed-out' }), 'unpause'],
    ['the built-in default account was not read yet', () => deps({ signInEvidence: () => 'unknown' }), 'unpause'],
    ['the built-in provider is disconnected', () => deps(), 'disconnect'],
    ['the built-in provider is switched off', () => deps({ disabled: providerId => providerId === 'anthropic' })],
    ['the provider was renamed', (id: string) => deps({ renamed: providerId => providerId === id })],
    ['the provider is switched off', (id: string) => deps({ disabled: providerId => providerId === id })],
    ['remote invocation was allowed', (id: string) => deps({ remoteInvocationAllowed: providerId => providerId === id })],
    ['the provider is shared', (id: string) => deps({ sharedProviderIds: () => new Set([id]) })],
    ['the share list is not known yet', () => deps({ sharedProviderIds: () => null })],
    ['a provider group was built on it', (id: string) => deps({ hasProviderGroup: providerId => providerId === id })],
    ['another account was added to it', () => deps(), 'add'],
    ['the user made it (random id)', () => deps(), 'rename-id'],
    ['the placement file is unreadable', () => deps(), 'unreadable'],
  ] as const)('leaves it when %s', (_name, make, change?: string) => {
    const kind = 'anthropic';
    const { id, providerId } = split(kind);
    if (change === 'unpause') h.pools[kind]!.accounts[0] = account('default');
    if (change === 'disconnect') h.pools[kind]!.disconnected = true;
    if (change === 'add') { const other = id.replace('123456789abc', '123456789abd'); h.pools[kind]!.accounts.push(account(other)); h.placement[`${kind}:${other}`] = providerId; }
    if (change === 'rename-id') { h.created = { 'anthropic-sub-0a1b2c3d': h.created[providerId]! }; h.placement[`${kind}:${id}`] = 'anthropic-sub-0a1b2c3d'; }
    if (change === 'unreadable') h.placementUnreadable = true;
    expect(findUpgradeSplitRepair(make(providerId))).toBeNull();
  });
});

describe('subscription management boundary', () => {
  // Unit: the optional query is additive and owner-only, including named pools;
  // old quota and availability replies were covered, anonymous scheduling was not.
  it('scopes anonymous scheduling to the owner and never accepts a path as a pool', async () => {
    const quota = h.handlers.get('maker:subscription-pool:quota')!;
    const summary = { version: 1, accounts: 2, running: 0, totalRunning: 4, full: false, urgency: null, fiveHourTight: false };
    h.scheduling.mockResolvedValue(summary);
    h.context = { controllerDeviceId: 'own-mac' };
    expect(await quota({}, 'openai-sub-pool', 'gpt-model', { scheduling: 1, ownComputer: false }))
      .toEqual({ providerId: 'openai-sub-pool', model: 'gpt-model', scheduling: summary });
    expect(h.scheduling).toHaveBeenLastCalledWith('openai-sub-pool', 'gpt-model', { remote: true, ownComputer: false });
    await quota({}, 'openai', 'gpt-model', { scheduling: 1, ownComputer: true });
    expect(h.scheduling).toHaveBeenLastCalledWith('openai', 'gpt-model', { remote: true, ownComputer: true });
    for (const provider of ['../openai', '/private/home', 'x'.repeat(41)])
      await expect(quota({}, provider, 'gpt-model', { scheduling: 1, ownComputer: true })).rejects.toThrow('INVALID_PARAMS');
    for (const model of ['', ' ', {}, 'x'.repeat(513)])
      await expect(quota({}, 'openai', model, { scheduling: 1, ownComputer: true })).rejects.toThrow('INVALID_PARAMS');
    h.context = { sharedTask: {} };
    await expect(quota({}, 'openai', 'gpt-model', { scheduling: 1, ownComputer: true })).rejects.toThrow('PERMISSION_DENIED');
    h.context = { controllerDeviceId: providerShareGuestPeer('share', 'member', 'device') };
    await expect(quota({}, 'openai', 'gpt-model', { scheduling: 1, ownComputer: true })).rejects.toThrow('PERMISSION_DENIED');
    expect(h.scheduling).toHaveBeenCalledTimes(2);
  });
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

  // A saved row can move or disappear between displaying it and clicking Sign in.
  it('reports a missing sign-in target separately from CLI or network errors', async () => {
    h.execute.mockRejectedValue(new Error('Account not found'));
    await expect(invoke({ action: 'login', providerId: 'openai', accountId: 'default', loginKey: 'stale' }))
      .rejects.toThrow('[NOT_FOUND]');
  });

  // 2026-11-18 user report, unit: an unreachable account service reached the renderer as the
  // generic "check the CLI login" error and left no cause in the log. Minimal input: the command
  // rejects with the classified network failure, or with an unknown error carrying file text.
  it('reports an unreachable account service as such and logs only a classified reason', async () => {
    h.execute.mockRejectedValue(new AccountServiceUnreachableError('Codex account request failed'));
    const error = await invoke({ action: 'login', providerId: 'openai', accountId: 'default', loginKey: 'offline' }).catch(error => error);
    expect(mapIpcErrorToI18nKey(error)).toBe('ipcError.SUBSCRIPTION_ACCOUNT_UNREACHABLE');
    expect(h.warn).toHaveBeenLastCalledWith('subscription account command failed',
      { action: 'login', providerId: 'openai', reason: 'account_service_unreachable' });
    h.execute.mockRejectedValue(new SyntaxError('Unexpected token in {"access_token":"fixture-secret"'));
    await expect(invoke({ action: 'login', providerId: 'openai', accountId: 'default', loginKey: 'parse' }))
      .rejects.toThrow('[SUBSCRIPTION_ACCOUNT_FAILED]');
    expect(h.warn).toHaveBeenLastCalledWith('subscription account command failed',
      { action: 'login', providerId: 'openai', reason: 'SyntaxError' });
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
