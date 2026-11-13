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
  bindings: {} as Record<string, { providerId: 'anthropic' | 'openai'; accountId: string }>,
  pools: {} as Partial<Record<'anthropic' | 'openai', SubscriptionPoolConfig>>,
  beforeWrite: undefined as (() => void) | undefined,
  access: { disabledModels: {}, disabledProviders: {} } as { disabledModels: Record<string, true>; disabledProviders: Record<string, true> },
  remoteAllowed: new Set<string>(),
  ownComputers: false,
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
import { accountDirectory, accountOwnerPrefix, migrateLegacyCodexAccounts, readBoundClaudeConfigDir, readLegacyCodexAccountId, normalizePoolFile } from '../store.js';
import { SUBSCRIPTION_ACCOUNTS_CHANNEL } from '../../../shared/subscriptionAccounts.js';
import { mapIpcErrorToI18nKey } from '../../../shared/ipcError.js';
import { legacyCodexAccountCanRun, openAiRouteAllowsModel, setLegacyCodexAccountPaused } from '../legacyAccountAccess.js';
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
  h.execute.mockReset().mockResolvedValue({ accounts: [] });
  h.availability.mockReset().mockResolvedValue(true);
  h.sessionRead.mockReset().mockResolvedValue({ providerId: 'anthropic', state: 'legacy' });
});

describe('legacy Codex account upgrade', () => {
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
    h.context = { sharedTask: {} };
    await expect(invoke(query)).rejects.toThrow('PERMISSION_DENIED');
    h.context = null;
    for (const bad of [
      { action: 'session', providerId: 'anthropic' },
      { action: 'session', providerId: 'anthropic', sessionId: '' },
      { action: 'session', providerId: 'anthropic', sessionId: 'x'.repeat(257) },
      { action: 'session', providerId: 'anthropic-second', sessionId: 'task-1' },
      ...['', ' ', 1, {}, 'x'.repeat(513)].map(model => ({ ...query, model })),
      ...['', ' ', 1, {}, 'x'.repeat(257)].map(legacyProviderId => ({ ...query, legacyProviderId })),
      { ...remoteQuery, legacyProviderId: 'old-codex' },
    ])
      await expect(invoke(bad)).rejects.toThrow('INVALID_PARAMS');
    h.sessionRead.mockRejectedValue(new Error('fixture-private-path'));
    await expect(invoke(query)).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_FAILED]');
    expect(h.sessionRead).toHaveBeenCalledTimes(5);
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
