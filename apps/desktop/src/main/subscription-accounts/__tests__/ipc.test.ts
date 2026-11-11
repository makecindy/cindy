/** Standard tier: owner-only account management, wire validation and path confinement.
 * Native process calls and metadata persistence are replaced; the production parser/path builder run unchanged.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionPoolConfig } from '../../../shared/subscriptionAccounts.js';
const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg: unknown) => Promise<unknown>>(),
  context: null as null | { sharedTask?: object },
  trusted: true,
  execute: vi.fn(),
  owner: 'owner-a',
  generation: 1,
  bindings: {} as Record<string, { providerId: 'anthropic' | 'openai'; accountId: string }>,
  pools: {} as Partial<Record<'anthropic' | 'openai', SubscriptionPoolConfig>>,
  beforeWrite: undefined as (() => void) | undefined,
  access: { disabledModels: {}, disabledProviders: {} } as { disabledModels: Record<string, true>; disabledProviders: Record<string, true> },
  remoteAllowed: new Set<string>(),
  remoteModels: null as string[] | null,
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
  createOverrideSettingsFile: () => ({
    invalidateIfChanged: () => {},
    read: () => ({ bindings: h.bindings, pools: h.pools }),
    updateAtomic: async (edit: (input: { value: { pools: typeof h.pools; bindings: typeof h.bindings } }) => { pools: typeof h.pools }) => {
      h.beforeWrite?.();
      const next = edit({ value: { pools: h.pools, bindings: h.bindings } });
      h.pools = next.pools;
    },
  }),
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
  readLegacySubscriptionPoolUsage: vi.fn(async () => undefined),
  readSubscriptionSessionUsage: vi.fn(async () => undefined),
}));
import { registerSubscriptionAccountsIpc } from '../ipc.js';
import { accountDirectory, accountOwnerPrefix, migrateLegacyCodexAccounts, readBoundClaudeConfigDir, readLegacyCodexAccountId } from '../store.js';
import { SUBSCRIPTION_ACCOUNTS_CHANNEL } from '../../../shared/subscriptionAccounts.js';
import { mapIpcErrorToI18nKey } from '../../../shared/ipcError.js';
import { legacyCodexAccountCanRun, setLegacyCodexAccountPaused } from '../legacyAccountAccess.js';
registerSubscriptionAccountsIpc();
const invoke = (command: unknown) => h.handlers.get(SUBSCRIPTION_ACCOUNTS_CHANNEL)!({}, command);
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
  h.execute.mockReset().mockResolvedValue({ accounts: [] });
});

describe('legacy Codex account upgrade', () => {
  it('keeps original model exclusions and remote permission after folding a connection', () => {
    h.access.disabledModels['openai-a:chatgpt/gpt-model'] = true;
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: false, newRoute: true })).toBe(false);
    expect(legacyCodexAccountCanRun('openai-a', 'gpt-model', { remote: false, newRoute: false })).toBe(true);
    expect(legacyCodexAccountCanRun('openai-a', undefined, { remote: true, newRoute: false })).toBe(false);
    h.remoteAllowed.add('openai-a');
    expect(legacyCodexAccountCanRun('openai-a', 'other-model', { remote: true, newRoute: true })).toBe(true);
    h.access.disabledProviders['openai-a'] = true;
    expect(legacyCodexAccountCanRun('openai-a', undefined, { remote: false, newRoute: true })).toBe(false);
    setLegacyCodexAccountPaused('openai-a', false);
    expect(legacyCodexAccountCanRun('openai-a', undefined, { remote: false, newRoute: true })).toBe(true);
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
});
describe('subscription management boundary', () => {
  // #9517, unit: CLI provider-managed auth must survive the real handler and
  // renderer decoder as actionable copy, not the generic CLI/network failure.
  it('reports provider-managed authentication through the owner IPC error protocol', async () => {
    h.execute.mockRejectedValue(new Error('codex_provider_managed_auth'));
    const error = await invoke({ action: 'connect', target: 'default', providerId: 'openai', loginKey: 'login' }).catch(error => error);
    expect(mapIpcErrorToI18nKey(error)).toBe('ipcError.SUBSCRIPTION_CODEX_PROVIDER_AUTH');
  });
  it('admits the trusted owner and paired owner remote context, never an untrusted frame or shared-task guest', async () => {
    const command = { action: 'read', providerId: 'anthropic' };
    await invoke(command);
    h.trusted = false;
    await expect(invoke(command)).rejects.toThrow('untrusted');
    h.context = {};
    await invoke(command);
    h.context = { sharedTask: {} };
    await expect(invoke(command)).rejects.toThrow('PERMISSION_DENIED');
    expect(h.execute).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid account paths, settings and login keys before any native operation', async () => {
    for (const command of [
      { action: 'login', accountId: '../credentials', loginKey: 'login' },
      { action: 'add', loginKey: '../callback' },
      { action: 'connect', target: '../credentials', loginKey: 'login' },
      { action: 'connect', target: 'new', loginKey: '../callback' },
      { action: 'connect', loginKey: 'login' },
      { action: 'configure', accountId: 'default', limit: 0 },
      { action: 'configure', paused: false },
      { action: 'configure', strategy: 'unknown' },
    ])
      await expect(invoke({ providerId: 'anthropic', ...command })).rejects.toThrow(
        'INVALID_PARAMS',
      );
    expect(h.execute).not.toHaveBeenCalled();
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
