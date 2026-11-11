import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SubscriptionPoolConfig,
  SubscriptionProvider,
} from '../../../shared/subscriptionAccounts.js';
import {
  NATIVE_SUBSCRIPTION_ACCOUNT,
  AgentStartupStoppedError,
  AgentStartupCleanupPendingError,
  AgentNotAuthenticatedError,
  type BaseAgent,
  type AgentSessionHandle,
  type StartSessionOptions,
  type ForkSdkSessionOptions,
} from '@cindy/maker-core';
const h = vi.hoisted(() => ({
  owner: 'owner-a:1',
  pools: {} as Partial<Record<SubscriptionProvider, SubscriptionPoolConfig>>,
  bindings: new Map<string, { providerId: SubscriptionProvider; accountId: string }>(),
  read: vi.fn(),
  usage: vi.fn(),
  login: vi.fn(),
  bound: true,
  shared: true,
  legacyRead: vi.fn(),
  legacyLogin: vi.fn(),
  importedRead: vi.fn(),
  importedLogin: vi.fn(),
  accountAllowed: vi.fn(),
  setLegacyPaused: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/nativeProviderAuthBinding.js', () => ({
  bindNativeProviderAuth: vi.fn(),
  isNativeProviderAuthBound: () => h.bound,
  isNativeProviderAuthSharedSystemCredential: () => h.bound && h.shared,
}));
vi.mock('../nativeCli.js', () => ({
  readNativeAccount: h.read,
  readNativeAccountUsage: h.usage,
  loginNativeAccount: h.login,
  readLegacyCodexAccount: h.legacyRead,
  loginLegacyCodexAccount: h.legacyLogin,
  readLegacyCodexProviderAccount: h.importedRead,
  loginLegacyCodexProviderAccount: h.importedLogin,
}));
vi.mock('../../maker-host/codex-home-path.js', () => ({
  getCodexHome: () => '/existing-cindy/codex-home',
}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }));
vi.mock('../legacyAccountAccess.js', () => ({ legacyCodexAccountCanRun: h.accountAllowed, setLegacyCodexAccountPaused: h.setLegacyPaused }));
vi.mock('../store.js', () => ({
  readPool: (p: SubscriptionProvider) => h.pools[p] ?? null,
  readLegacyCodexAccountId: (id: string) => h.pools.openai?.legacyCodexAccounts?.[id],
  readLegacyCodexProviderId: (account: string) => Object.entries(h.pools.openai?.legacyCodexAccounts ?? {})
    .find(([, id]) => id === account)?.[0],
  defaultPool: () => ({
    strategy: 'least',
    accounts: [{ id: 'default', paused: false, limit: 4, weight: 1 }],
  }),
  accountDirectory: (p: string, id: string) => [p, id].join('/'),
  accountOwnerPrefix: () => h.owner.replaceAll(':', '-'),
  readAccountBinding: (key: string) => h.bindings.get(key),
  writeAccountBindings: async (
    keys: string[],
    providerId: SubscriptionProvider,
    accountId: string,
  ) => {
    for (const key of keys) h.bindings.set(key, { providerId, accountId });
  },
  updatePool: async (
    p: SubscriptionProvider,
    edit: (value: SubscriptionPoolConfig) => SubscriptionPoolConfig,
  ) => {
    h.pools[p] = edit(
      h.pools[p] ?? {
        strategy: 'least',
        accounts: [{ id: 'default', paused: false, limit: 4, weight: 1 }],
      },
    );
  },
}));
import {
  acquireSubscriptionAccount,
  readSubscriptionPool,
  disconnectSubscriptionPool,
  readSubscriptionPoolUsage,
  readSubscriptionPoolModelAvailability,
  readLegacySubscriptionPoolUsage,
  readSubscriptionSessionUsage,
  readSubscriptionSessionAccount,
  readSubscriptionPoolAccountUsages,
  runSubscriptionAccountCommand,
  observeSubscriptionAccountUsage,
} from '../runtime.js';
import { providerGroupMemberUsageState, providerGroupCodexUsageFromReads, providerGroupUsageSnapshot } from '../../provider-group/usage.js';
import { readLegacySubscriptionQuota } from '../legacyQuota.js';
import { withSubscriptionAccounts } from '../agent.js';
import { getSessionSubscriptionAccount } from '../session.js';
import { prepareSubscriptionAccountForSend } from '../prepareSend.js';
import type { SessionRowSnapshot } from '../../localDb/sessionDispatchSnapshot.js';
import { createProviderGroupDirectory } from '../../provider-group/directory.js';
import { createProviderGroupRouter, type ProviderGroupPersistedCooling } from '../../provider-group/router.js';
import { createProviderGroupService, type ProviderGroupSessionRow } from '../../provider-group/service.js';
import type { ProviderGroupBinding } from '../../provider-group/bindings.js';
import { normalizeProviderGroupConfig } from '../../../shared/providerGroup.js';
import type { ProviderView } from '@cindy/model-providers';
const account = (id: string) => ({ id, paused: false, limit: 1, weight: 1 });
let generation = 0;
beforeEach(() => {
  h.owner = 'owner-a:' + ++generation;
  h.bound = true;
  h.shared = true;
  h.pools = { anthropic: { strategy: 'least', accounts: [account('default'), account('second')] } };
  h.bindings.clear();
  h.read.mockReset().mockResolvedValue({ authenticated: true, identity: 'account' });
  h.usage.mockReset().mockResolvedValue({});
  h.login.mockReset().mockResolvedValue(undefined);
  h.legacyRead.mockReset().mockResolvedValue({
    authenticated: true,
    identity: 'original@example.com',
    authSource: 'oauth',
  });
  h.legacyLogin.mockReset().mockResolvedValue(undefined);
  h.importedRead.mockReset().mockResolvedValue({ authenticated: true, identity: 'imported@example.test' });
  h.importedLogin.mockReset().mockResolvedValue(undefined);
  h.accountAllowed.mockReset().mockReturnValue(true);
  h.setLegacyPaused.mockReset();
});

describe('tasks using imported Codex connections', () => {
  // User upgrade regression 2026-11-11, standard: old IDs must keep their account
  // for resume/fork in all OpenAI engines; prior coverage only tested the CLI default.
  it.each(['codex', 'claude-code', 'pi'] as const)('pins a saved %s connection to its imported account', async kind => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    const close = vi.fn(async () => {});
    const start = vi.fn<BaseAgent['startSession']>(async () => ({ id: 'native-old', close } as unknown as AgentSessionHandle));
    const agent = withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai-old', sessionId: 'old-task', resumeSessionId: 'native-old' } as StartSessionOptions);
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
    expect(h.bindings.get('task:old-task')?.accountId).toBe('imported');
    expect(h.importedRead).toHaveBeenCalledWith('openai-old', 'openai/imported');
    await handle.close();
    h.pools.openai.accounts = [account('default')];
    await expect(agent.startSession({ providerId: 'openai-old', sessionId: 'old-task' } as StartSessionOptions)).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
  });

  it('forks old history through the same imported account and reconnects through its old login', async () => {
    h.pools.openai = {
      strategy: 'round', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    const fork = vi.fn<(options: ForkSdkSessionOptions) => Promise<{ newSdkSessionId: string }>>(async () => ({ newSdkSessionId: 'forked' }));
    const agent = withSubscriptionAccounts({ kind: 'codex', forkSdkSession: fork } as unknown as BaseAgent);
    await agent.forkSdkSession({ providerId: 'openai-old', sourceSdkSessionId: 'old-native' } as ForkSdkSessionOptions);
    expect(fork.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
    expect(h.bindings.get('native:forked')?.accountId).toBe('imported');
    await runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'imported', loginKey: 'reconnect' });
    expect(h.importedLogin).toHaveBeenCalledWith('openai-old', expect.any(AbortSignal));
    expect(h.login).not.toHaveBeenCalled();
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'imported', paused: false });
    expect(h.setLegacyPaused).toHaveBeenCalledWith('openai-old', false);
  });

  it('does not lend an imported account whose old connection disallows remote use', async () => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    h.accountAllowed.mockImplementation((_provider, _model, options) => !options.remote);
    await expect(acquireSubscriptionAccount('openai', 'gpt-model', [], false, { remote: true })).rejects.toThrow('No subscription account');
    const local = await acquireSubscriptionAccount('openai', 'gpt-model', []);
    expect(local?.account.configDir).toBe('openai/imported');
    local?.release();
    h.accountAllowed.mockReturnValue(true);
    const remote = await acquireSubscriptionAccount('openai', 'gpt-model', [], false, { remote: true });
    h.accountAllowed.mockImplementation((_provider, _model, options) => !options.remote);
    await expect(remote!.account.readState()).rejects.toThrow('remote access was revoked');
    remote?.release();
  });

  // PR #9837 review / unit: a healthy imported account cannot clear a group's
  // cooldown for a new route its original grants deny. Prior tests only gated
  // allocation. Two accounts (exhausted default + healthy imported) reproduce it.
  it.each([false, true])('checks imported-account grants before recovering pool cooling (remote=%s)', async (remote) => {
    const model = 'chatgpt/gpt-6-astra';
    h.pools.openai = {
      strategy: 'order', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    let grant = 'all';
    h.accountAllowed.mockImplementation((_provider, target, options) =>
      !options.newRoute || (target === model && (grant === 'all' || (grant === 'local' && !options.remote))));
    h.usage.mockImplementation(async (_provider, dir) => {
      if (dir.endsWith('imported')) grant = 'denied'; // Revoked while the first quota read is in flight.
      return { codexUsage: {
        appServerBuckets: { codex: { limitId: 'codex', updatedAt: Date.now(),
          primary: { usedPercent: dir.endsWith('default') ? 100 : 10,
            resetsAt: Date.now() / 1000 + 3600, windowMinutes: 300 }, secondary: null } },
        webSnapshot: null, nativeAccountPool: true,
      } };
    });
    const options = { remote };
    expect(await readSubscriptionPoolModelAvailability('openai', model, options)).toBe(false);
    await expect(acquireSubscriptionAccount('openai', model, [], false, options)).rejects.toThrow('No subscription account');
    grant = 'local';
    expect(await readSubscriptionPoolModelAvailability('openai', model, options)).toBe(!remote);
    grant = 'all';
    expect(await readSubscriptionPoolModelAvailability('openai', model, options)).toBe(true);
    expect(h.bindings.size).toBe(0);
    const lease = await acquireSubscriptionAccount('openai', model, [], false, options);
    expect(lease?.account.configDir).toBe('openai/imported');
    lease?.release();
    grant = 'denied';
    expect(await readSubscriptionPoolModelAvailability('openai', model, options)).toBe(false);
  });

  it('pins an explicit old connection without task keys and does not persist a denied assignment', async () => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    const start = vi.fn<BaseAgent['startSession']>(async () => ({ id: 'native-keys', close: async () => {} } as unknown as AgentSessionHandle));
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai-old' } as StartSessionOptions);
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
    await handle.close();
    h.bindings.clear();
    h.accountAllowed.mockReturnValue(false);
    await expect(agent.startSession({ providerId: 'openai-old', sessionId: 'denied-new-task' } as StartSessionOptions)).rejects.toThrow();
    expect(h.bindings.size).toBe(0);
    expect(start).toHaveBeenCalledOnce();
  });

  // PR #9900 review, standard: an existing remote lease must track the actual
  // model after a hot switch. Earlier coverage only revoked the startup model.
  // PR #9837 merge regression: a completed switch followed by grant revocation
  // must also keep quota failures on the new model after access is restored.
  // Earlier tests checked permissions and quota tracking separately.
  it.each(['codex', 'claude-code', 'pi'] as const)('checks the current and target remote model for %s', async kind => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('imported'), { ...account('second'), paused: true }],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { codex: {
      limitId: 'codex', updatedAt: Date.now(),
      primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 },
      secondary: null,
    } }, webSnapshot: null } });
    const allowed = new Set(['model-a']);
    h.accountAllowed.mockImplementation((_provider, model, options) => !options.remote || allowed.has(model));
    const setModel = vi.fn<NonNullable<AgentSessionHandle['setModel']>>(async () => {});
    const send = vi.fn<AgentSessionHandle['send']>(async () => {});
    const start = vi.fn<BaseAgent['startSession']>(async () => ({
      id: 'switch-native', setModel, send, close: async () => {},
    } as unknown as AgentSessionHandle));
    const agent = withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({
      providerId: 'openai', model: 'model-a', workingDir: '.', sessionId: 'switch-task',
      deviceHosted: {
        workingDir: '.', extraDirs: [], writableDirs: [], platform: process.platform,
        shell: 'fixture', isGitRepo: false, tunnelUrl: 'http://127.0.0.1',
        tunnelToken: 'fixture-unused', mcpServers: [],
      },
    });
    await expect(handle.setModel!('model-b')).rejects.toThrow('remote access was revoked');
    expect(setModel).not.toHaveBeenCalled();
    allowed.add('model-b');
    setModel.mockRejectedValueOnce(new Error('switch failed'));
    await expect(handle.setModel!('model-b')).rejects.toThrow('switch failed');
    allowed.delete('model-b');
    await handle.send({ type: 'user', content: 'still model a' });
    allowed.add('model-b');
    await handle.setModel!('model-b');
    allowed.delete('model-a');
    await handle.send({ type: 'user', content: 'now model b' });
    expect(send).toHaveBeenCalledTimes(2);
    allowed.delete('model-b');
    await expect(handle.send({ type: 'user', content: 'revoked' })).rejects.toThrow('remote access was revoked');
    expect(send).toHaveBeenCalledTimes(2);
    expect(() => start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]!.assertCurrent())
      .toThrow('remote access was revoked');
    allowed.add('model-b');
    allowed.add('model-c');
    setModel.mockImplementationOnce(async () => { allowed.delete('model-c'); });
    await expect(handle.setModel!('model-c')).rejects.toThrow('remote access was revoked');
    await expect(handle.send({ type: 'user', content: 'revoked during switch' })).rejects.toThrow('remote access was revoked');
    expect(send).toHaveBeenCalledTimes(2);
    allowed.add('model-c');
    send.mockRejectedValueOnce(Object.assign(new Error('usage limit'), { codexErrorInfo: 'usageLimitExceeded' }));
    await expect(handle.send({ type: 'user', content: 'restored model c' })).rejects.toThrow('usage limit');
    expect(await readSubscriptionPoolModelAvailability('openai', 'model-c')).toBe(false);
    expect(await readSubscriptionPoolModelAvailability('openai', 'model-b')).toBe(true);
    await handle.close();
  });

  it('checks the imported connection model exclusion before a local switch', async () => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    h.accountAllowed.mockImplementation((_provider, model, options) => !options.modelSwitch || model !== 'model-b');
    const setModel = vi.fn<NonNullable<AgentSessionHandle['setModel']>>(async () => {});
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: async () => ({
      id: 'local-switch', setModel, close: async () => {},
    } as unknown as AgentSessionHandle) } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai', model: 'model-a', workingDir: '.' });
    await expect(handle.setModel!('model-b')).rejects.toThrow('does not allow this model');
    expect(setModel).not.toHaveBeenCalled();
    await handle.setModel!('model-a');
    expect(setModel).toHaveBeenCalledOnce();
    await handle.close();
  });
});

describe('native account assignment on the executing computer', () => {
  // Regression: a pinned exhausted account was reported as login-or-reset even
  // when another account was ready. Unit: exercise acquisition, not UI heuristics.
  it.each([null, 3600])('reports the bound account limit and only its trusted reset (%s)', async delay => {
    const now = Date.now();
    const resetAt = delay === null ? null : Math.floor(now / 1000) + delay;
    h.bindings.set('task:existing', { providerId: 'anthropic', accountId: 'second' });
    h.usage.mockImplementation(async (_provider, directory) => directory === 'anthropic/second'
      ? { claudeUsage: { updatedAt: now, fiveHour: { utilization: 100, resetsAt: resetAt }, sevenDay: null, scoped: [] } }
      : {});
    const error = await acquireSubscriptionAccount('anthropic', 'claude-sonnet-4-6', ['task:existing']).catch(e => e);
    expect(error.message).toContain('[SUBSCRIPTION_ACCOUNT_LIMITED]');
    if (resetAt) expect(error.message).toContain(`resetAtMs=${resetAt * 1000}`);
    else expect(error.message).not.toContain('resetAtMs=');
    expect(h.bindings.get('task:existing')?.accountId).toBe('second');
  });

  it.each(['signed-out', 'unavailable', 'removed'] as const)('distinguishes %s from exhaustion', async state => {
    h.bindings.set('task:existing', { providerId: 'anthropic', accountId: 'second' });
    if (state === 'removed') h.pools.anthropic!.accounts = [account('default')];
    else h.read.mockImplementation(async (_provider, directory) => {
      if (directory !== 'anthropic/second') return { authenticated: true };
      if (state === 'unavailable') throw new Error('temporary CLI failure');
      return { authenticated: false };
    });
    await expect(acquireSubscriptionAccount('anthropic', undefined, ['task:existing']))
      .rejects.toThrow(state === 'signed-out' ? '[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED]' : '[SUBSCRIPTION_ACCOUNT_UNAVAILABLE]');
  });

  it('projects the task binding without selecting, reserving or unpausing an account', async () => {
    h.pools.anthropic!.accounts[0].paused = true;
    h.bindings.set('task:existing', { providerId: 'anthropic', accountId: 'default' });
    const bound = await readSubscriptionPool('anthropic', false, 'existing');
    expect(bound.boundAccountId).toBe('default');
    expect(bound.accounts[0]).toMatchObject({ paused: true, running: 0 });
    expect((await readSubscriptionPool('anthropic', false, 'new-task')).boundAccountId).toBeNull();
    expect(await readSubscriptionPool('anthropic')).not.toHaveProperty('boundAccountId');
    h.pools.anthropic!.accounts = [account('second')];
    expect((await readSubscriptionPool('anthropic', false, 'existing')).boundAccountId).toBe('default');
    expect(h.bindings.size).toBe(1);
  });

  // #9517 review, unit: Add must recover both bound and unbound managed defaults.
  // A disconnected pool and a first Add bypassed the bound-default fallback.
  it.each([
    { bound: true, configured: true },
    { bound: false, configured: true },
    { bound: false, configured: false },
  ])('adds an isolated account for a managed default (bound=$bound, configured=$configured)', async ({ bound, configured }) => {
    h.bound = bound;
    if (configured) h.pools.openai = { strategy: 'least', accounts: [account('default')], disconnected: !bound };
    const signedIn = new Set<string>();
    h.read.mockImplementation(async (_provider, directory: string) =>
      directory === 'openai/default'
        ? { authenticated: false, errorReason: 'codex_provider_managed_auth' }
        : { authenticated: signedIn.has(directory), identity: 'new@example.test' },
    );
    h.login.mockImplementation(async (_provider, directory: string) => { signedIn.add(directory); });

    const result = await runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'recover' });

    expect(h.login).toHaveBeenCalledOnce();
    const newAccount = result.accounts.find((entry) => entry.id !== 'default');
    expect(newAccount).toMatchObject({ status: 'ready', identity: 'new@example.test' });
    expect(h.login).toHaveBeenCalledWith('openai', `openai/${newAccount!.id}`, expect.any(AbortSignal));
    expect(h.pools.openai!.accounts.map((entry) => entry.id)).toEqual(['default', newAccount!.id]);
    expect(result.accounts[0]).toMatchObject({ id: 'default', status: 'signed-out' });
    expect(result.accounts[0].authIssue).toBe(bound ? 'codex-provider-managed-auth' : undefined);
    expect(h.pools.openai!.disconnected).toBe(false);
    expect(h.legacyLogin).not.toHaveBeenCalled();
  });

  // Unit, #9517: redirecting an unbound default must preserve cancellation and
  // leave the disconnected pool unauthorized until an independent login succeeds.
  it('cancels isolated recovery without reconnecting the unbound default and can retry', async () => {
    h.bound = false;
    h.pools.openai = { strategy: 'least', accounts: [account('default')], disconnected: true };
    h.read.mockImplementation(async (_provider, directory: string) => directory === 'openai/default'
      ? { authenticated: false, errorReason: 'codex_provider_managed_auth' }
      : { authenticated: false });
    let started!: () => void;
    const loginStarted = new Promise<void>((resolve) => { started = resolve; });
    h.login.mockImplementationOnce((_provider, _directory, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('login_cancelled')), { once: true });
      started();
    }));
    const pending = runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'cancel-new' });
    const cancelled = expect(pending).rejects.toThrow('login_cancelled');
    await loginStarted;
    await runSubscriptionAccountCommand({ action: 'cancel', providerId: 'openai', loginKey: 'cancel-new' });
    await cancelled;
    expect(h.login.mock.calls[0][1]).not.toBe('openai/default');
    expect(h.pools.openai!.disconnected).toBe(true);
    await runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'retry-new' });
    expect(h.login).toHaveBeenCalledTimes(2);
    expect(h.login.mock.calls[1][1]).not.toBe('openai/default');
  });

  // #9517, unit: the real connection/reconnection entry must reject the CLI's
  // provider-managed auth state before login. Existing cases only cover signed-in/out.
  it.each([
    { action: 'connect', target: 'default', providerId: 'openai', loginKey: 'provider' },
    { action: 'add', providerId: 'openai', loginKey: 'provider' },
    { action: 'login', accountId: 'second', providerId: 'openai', loginKey: 'provider' },
  ] as const)('does not relaunch login for provider-managed authentication ($action)', async (command) => {
    h.bound = false;
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
    h.read.mockResolvedValue({ authenticated: false, errorReason: 'codex_provider_managed_auth' });
    if (command.action === 'connect') {
      const preview = await runSubscriptionAccountCommand({ action: 'preview', providerId: 'openai' });
      expect(preview.accounts[0]).toMatchObject({ status: 'signed-out', authIssue: 'codex-provider-managed-auth' });
      expect(h.usage).not.toHaveBeenCalled();
    }
    await expect(runSubscriptionAccountCommand(command)).rejects.toThrow('codex_provider_managed_auth');
    expect(h.login).not.toHaveBeenCalled();
    // The blocked attempt releases its login reservation, and "new" keeps using
    // its own directory instead of the incompatible default profile.
    h.read.mockImplementation(async (_provider, directory) => ({
      authenticated: !directory.endsWith('/default'),
      ...(directory.endsWith('/default') ? { errorReason: 'codex_provider_managed_auth' } : {}),
    }));
    const next = await runSubscriptionAccountCommand({ action: 'connect', target: 'new', providerId: 'openai', loginKey: 'next' });
    expect(h.login).toHaveBeenCalledOnce();
    expect(h.login.mock.calls[0][1]).not.toBe('openai/default');
    expect(next.accounts.at(-1)?.status).toBe('ready');
  });

  // 2026-11-11 user report (unit): the model list and composer usage showed the CLI default
  // account for a task pinned to another pool account. Display reads must resolve the same
  // bindings a resume does (task id first, then the native id a remote host knows), and never
  // substitute the default or the next pool pick. Minimal input: a task bound to `second`.
  it.each(['anthropic', 'openai'] as const)('names the account a %s task is pinned to', async (provider) => {
    h.pools[provider] = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.read.mockImplementation(async (_p: string, directory: string) => ({
      authenticated: true, identity: directory.endsWith('second') ? 'second@example.test' : 'first@example.test',
    }));
    const now = Date.now();
    h.usage.mockImplementation(async (_p: string, directory: string) => {
      const used = directory.endsWith('second') ? 30 : 90;
      const bucket = { limitId: 'codex', limitName: null, updatedAt: now,
        primary: { usedPercent: used, windowMinutes: 300, resetsAt: now / 1000 + 3600 }, secondary: null };
      return provider === 'anthropic'
        ? { claudeUsage: { updatedAt: now, fiveHour: { utilization: used, resetsAt: now / 1000 + 3600 }, sevenDay: null, scoped: [] } }
        : { codexUsage: { appServerBuckets: { codex: bucket }, webSnapshot: bucket } };
    });
    const read = (keys: { sessionId?: string; nativeSessionId?: string }) =>
      readSubscriptionSessionAccount(provider, keys);
    h.bindings.set('task:task-1', { providerId: provider, accountId: 'second' });
    const bound = await read({ sessionId: 'task-1', nativeSessionId: 'unbound-native' });
    expect(bound).toMatchObject({ state: 'bound', account: {
      isDefault: false, number: 2, identity: 'second@example.test', status: 'ready',
    } });
    expect(bound.state === 'bound' && (provider === 'anthropic'
      ? bound.account.usage?.claude?.fiveHour?.utilization
      : bound.account.usage?.codex?.buckets.codex.primary?.usedPercent)).toBe(30);
    // A remote executor only knows the native id.
    h.bindings.set('native:sdk-2', { providerId: provider, accountId: 'second' });
    expect(await read({ sessionId: 'controller-id', nativeSessionId: 'sdk-2' }))
      .toMatchObject({ state: 'bound', account: { number: 2 } });
    h.bindings.set('task:task-3', { providerId: provider, accountId: 'default' });
    expect(await read({ sessionId: 'task-3' }))
      .toMatchObject({ state: 'bound', account: { isDefault: true, identity: 'first@example.test' } });
    // Not yet run: the pool picks next turn. Pre-pool resume: the original default readers.
    expect(await read({ sessionId: 'new' })).toEqual({ providerId: provider, state: 'unassigned' });
    expect(await read({ sessionId: 'old', nativeSessionId: 'pre-pool' }))
      .toEqual({ providerId: provider, state: 'legacy' });
    // A removed account fails visibly instead of naming the remaining default.
    h.pools[provider]!.accounts = [account('default')];
    expect(await read({ sessionId: 'task-1' })).toEqual({ providerId: provider, state: 'unavailable' });
    expect(await read({ sessionId: 'task-3' })).toEqual({ providerId: provider, state: 'legacy' });
    h.pools = {};
    expect(await read({ sessionId: 'task-1' })).toEqual({ providerId: provider, state: 'legacy' });
  });

  // Unit, #9295 review: reset lookups refresh the pinned profile rather than
  // taking a different ready account; prior tests only covered pool availability.
  it.each([
    ['anthropic', 'default'], ['anthropic', 'second'], ['openai', 'default'], ['openai', 'second'],
  ] as const)('reads only the bound %s/%s quota for a native task', async (provider, accountId) => {
    h.pools[provider] = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.bindings.set('native:limited-task', { providerId: provider, accountId });
    const now = Date.now();
    const reset = now / 1000 + 3600;
    const bucket = { limitId: 'codex', limitName: null, updatedAt: now,
      primary: { usedPercent: 100, resetsAt: reset, windowMinutes: 300 }, secondary: null };
    h.usage.mockResolvedValue(provider === 'anthropic'
      ? { claudeUsage: { updatedAt: now, fiveHour: { utilization: 100, resetsAt: reset }, sevenDay: null, scoped: [] } }
      : { codexUsage: { appServerBuckets: { codex: bucket }, webSnapshot: bucket } });
    const scope = { subscriptionSessionId: 'limited-task' };
    const channel = provider === 'anthropic' ? 'maker:usage:claude-subscription' : 'maker:usage:account';
    const args = provider === 'anthropic' ? [provider, true, scope] : ['codex', provider, scope];
    const result = await readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, channel, args, readSubscriptionSessionUsage);
    if (accountId === 'default') {
      expect(result).toBeUndefined();
      expect(h.usage).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject(provider === 'anthropic' ? { fiveHour: { utilization: 100, resetsAt: reset } }
        : { primary: { usedPercent: 100, resetsAt: reset }, nativeAccountPool: true });
      expect(h.usage).toHaveBeenCalledExactlyOnceWith(provider, `${provider}/${accountId}`);
    }
    // A removed binding must not fall back to the still-available other profile.
    h.pools[provider]!.accounts = h.pools[provider]!.accounts.filter(a => a.id !== accountId);
    expect(await readSubscriptionSessionUsage(provider, 'limited-task')).toBeNull();
    expect(await readSubscriptionSessionUsage(provider, 'pre-pool-task')).toBeUndefined();
    expect(h.usage).toHaveBeenCalledTimes(accountId === 'default' ? 0 : 1);
  });

  // Unit: legacy wire reads must expose usable pool quota when the first account
  // is exhausted. Existing tests only exercise the new pool query, not old calls.
  it.each(['anthropic', 'openai'] as const)('keeps old %s quota readers usable without changing the default account card', async (provider) => {
    h.pools[provider] = { strategy: 'order', accounts: [account('default'), account('second')] };
    const now = Date.now();
    h.usage.mockImplementation(async (_provider: string, directory: string) => {
      const used = directory.endsWith('default') ? 100 : 12;
      const bucket = { limitId: 'codex', limitName: null, updatedAt: now,
        primary: { usedPercent: used, windowMinutes: 300, resetsAt: now / 1000 + 3600 }, secondary: null };
      return provider === 'anthropic'
        ? { claudeUsage: { updatedAt: now, fiveHour: { utilization: used, resetsAt: now / 1000 + 3600 }, sevenDay: null, scoped: [], accountFingerprint: 'private-identity' } }
        : { codexUsage: { appServerBuckets: { codex: bucket }, webSnapshot: bucket } };
    });
    const read = (channel: string, args: unknown[]) => readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, channel, args);
    if (provider === 'anthropic') {
      const usage = await read('maker:usage:claude-subscription', []);
      expect(usage).toMatchObject({ fiveHour: { utilization: 12 }, providerId: 'anthropic' });
      expect(providerGroupMemberUsageState({ claudeUsage: providerGroupUsageSnapshot(usage, now) }, undefined, now, 'claude-code').limited).toBe(false);
      expect(JSON.stringify(usage)).not.toContain('private-identity');
    } else {
      const usage = await read('maker:usage:account', ['codex']);
      const limits = await read('maker:usage:codex-rate-limits', []);
      const combined = providerGroupCodexUsageFromReads(usage, limits, now);
      for (const kind of ['codex', 'claude-code', 'pi'])
        expect(providerGroupMemberUsageState({ codexUsage: combined }, undefined, now, kind).limited).toBe(false);
      expect(limits).toMatchObject({ rateLimits: { primary: { usedPercent: 12 } }, resetOffer: null, rateLimitResetCredits: null });
    }
    const original = (await readSubscriptionPool(provider)).accounts[0];
    expect(provider === 'anthropic' ? original.usage?.claude?.fiveHour?.utilization
      : original.usage?.codex?.buckets.codex.primary?.usedPercent).toBe(100);
    const lease = await acquireSubscriptionAccount(provider, undefined, []);
    expect(lease).toMatchObject({ account: { configDir: `${provider}/second` } });
    lease?.release();
  });

  it('preserves legacy, named and explicit default-account reads, and never revives a disconnected pool', async () => {
    const read = vi.fn(readLegacySubscriptionPoolUsage);
    for (const [channel, args] of [
      ['maker:usage:claude-subscription', ['anthropic', false, 'default-subscription-account']],
      ['maker:usage:account', ['codex', 'openai', 'default-subscription-account']],
      ['maker:usage:codex-rate-limits', ['openai', 'default-subscription-account']],
      ['maker:usage:account', ['codex', 'openai-second']],
      ['maker:usage:claude-subscription', ['anthropic-second']],
      ['maker:usage:account', ['claude-code']],
    ] as Array<[string, unknown[]]>) expect(await readLegacySubscriptionQuota(read, channel, args)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    h.pools = {};
    expect(await readLegacySubscriptionQuota(read, 'maker:usage:account', ['codex'])).toBeUndefined();
    h.pools.openai = { strategy: 'order', accounts: [account('default')] };
    expect(await readLegacySubscriptionQuota(read, 'maker:usage:account', ['codex'])).toBeUndefined();
    h.pools.openai = { strategy: 'order', disconnected: true, accounts: [account('default')] };
    expect(await readLegacySubscriptionQuota(read, 'maker:usage:account', ['codex'])).toBeNull();
  });

  // Unit: legacy rate-limits readers timestamp a reply as fresh. A cached model
  // bucket must neither gain a new lifetime nor become the generic/WHAM quota.
  it.each([0, 11 * 60_000])('keeps model-only quota separate and rejects %i ms old native reads', async (age) => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    const now = Date.now();
    const bucket = { limitId: 'spark', limitName: 'Spark', updatedAt: now - age,
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: now / 1000 + 3600 }, secondary: null };
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { spark: bucket }, webSnapshot: null } });
    const usage = await readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, 'maker:usage:account', ['codex']);
    expect(usage).toMatchObject({ webSnapshot: null, appServerBuckets: { spark: { updatedAt: now - age } } });
    expect(usage).not.toHaveProperty('primary');
    const limits = await readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, 'maker:usage:codex-rate-limits', []);
    if (age) expect(limits).toBeNull();
    else expect(limits).toMatchObject({ rateLimits: { primary: null }, rateLimitsByLimitId: { spark: { primary: { usedPercent: 100 } } } });
  });
  // Regression: a signed-in CLI was silently reused by the wizard's "add account".
  // Unit tier: the real command entry must keep preview read-only and explicit
  // new-account intent isolated, including an unbound or expired first account.
  it.each(['anthropic', 'openai'] as const)(
    'previews an unbound %s login without authorizing it',
    async (providerId) => {
      h.bound = false;
      h.pools = {};
      const preview = await runSubscriptionAccountCommand({ action: 'preview', providerId });
      expect(preview.accounts[0]).toMatchObject({
        id: 'default',
        identity: 'account',
        status: 'ready',
      });
      expect(h.pools).toEqual({});
      expect(h.login).not.toHaveBeenCalled();
      expect((await readSubscriptionPool(providerId)).accounts[0].status).toBe('signed-out');
      expect(await acquireSubscriptionAccount(providerId, undefined, [])).toBeNull();
    },
  );
  it.each(
    ['anthropic', 'openai'].flatMap((providerId) =>
      [true, false].map((bound) => ({ providerId: providerId as SubscriptionProvider, bound })),
    ),
  )(
    'keeps explicit new $providerId login isolated with default binding=$bound',
    async ({ providerId, bound }) => {
      h.bound = bound;
      h.pools = {};
      h.read.mockImplementation(async (_provider, directory) => ({
        authenticated: !directory.endsWith('default') || !bound,
        identity: directory.endsWith('default') ? 'original@example.com' : 'new@example.com',
      }));
      await runSubscriptionAccountCommand({
        action: 'connect',
        target: 'new',
        providerId,
        loginKey: 'new',
      });
      const ids = h.pools[providerId]!.accounts.map((a) => a.id);
      expect(ids).toEqual(['default', expect.stringMatching(/^cindy-/)]);
      expect(h.login).toHaveBeenCalledExactlyOnceWith(
        providerId,
        `${providerId}/${ids[1]}`,
        expect.any(AbortSignal),
      );
    },
  );
  it.each(['anthropic', 'openai'].flatMap(providerId =>
    ['connect', 'add'].map(action => ({ providerId: providerId as SubscriptionProvider, action: action as 'connect' | 'add' }))))(
    'connects the detected $providerId default through $action without another browser login',
    async ({ providerId, action }) => {
      h.bound = false;
      h.pools = {};
      await runSubscriptionAccountCommand({
        action,
        target: 'default',
        providerId,
        loginKey: 'existing',
      });
      expect(h.pools[providerId]!.accounts.map((a) => a.id)).toEqual(['default']);
      expect(h.login).not.toHaveBeenCalled();
    },
  );
  it('keeps the private legacy Codex default when the wizard connects it', async () => {
    h.shared = false;
    h.pools = {};
    const preview = await runSubscriptionAccountCommand({
      action: 'preview',
      providerId: 'openai',
    });
    expect(preview.accounts[0]).toMatchObject({ identity: 'original@example.com', legacy: true });
    await runSubscriptionAccountCommand({
      action: 'connect',
      target: 'default',
      providerId: 'openai',
      loginKey: 'legacy',
    });
    expect(h.pools.openai!.legacyCodexDefault).toBe(true);
    expect(h.login).not.toHaveBeenCalled();
    expect(h.legacyLogin).not.toHaveBeenCalled();
    expect((await readSubscriptionPool('openai')).accounts[0].directory).toBe(
      '/existing-cindy/codex-home',
    );
  });
  // Shutdown may end the event queue before the underlying process confirms exit.
  it.each(['close', 'detach'] as const)(
    'keeps an account protected through %s failure and late terminal events until retry succeeds',
    async (method) => {
      h.pools.anthropic = { strategy: 'least', accounts: [account('second')] };
      let rejectClose!: (error: Error) => void;
      const teardown = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectClose = reject;
            }),
        )
        .mockResolvedValue(undefined);
      const nativeHandle = {
        id: 'closing-thread',
        send: vi.fn(async () => {}),
        close: teardown,
        detach: teardown,
        events: async function* () {
          yield { type: 'done', data: {} };
        },
      } as unknown as AgentSessionHandle;
      const agent = withSubscriptionAccounts({
        kind: 'claude-code',
        startSession: async () => nativeHandle,
      } as unknown as BaseAgent);
      const handle = await agent.startSession({
        providerId: 'anthropic',
        sessionId: 'closing-task',
      } as StartSessionOptions);
      await handle.send({ type: 'user', content: 'hello' });
      const closing = expect(handle[method]!()).rejects.toThrow('shutdown failed');
      for await (const event of handle.events()) expect(event.type).toBe('done');
      const login = {
        action: 'login' as const,
        providerId: 'anthropic' as const,
        accountId: 'second',
        loginKey: 'blocked',
      };
      await expect(runSubscriptionAccountCommand(login)).rejects.toThrow('in use');
      rejectClose(new Error('shutdown failed'));
      await closing;
      expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(1);
      expect(getSessionSubscriptionAccount('closing-task')).toBeDefined();
      await expect(
        runSubscriptionAccountCommand({
          action: 'remove',
          providerId: 'anthropic',
          accountId: 'second',
        }),
      ).rejects.toThrow('in use');
      await expect(handle.send({ type: 'user', content: 'late' })).rejects.toThrow('closing');
      await handle[method]!();
      expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(0);
      expect(getSessionSubscriptionAccount('closing-task')).toBeUndefined();
      await runSubscriptionAccountCommand(login);
      expect(h.login).toHaveBeenCalledOnce();
    },
  );
  it('does not interpret a consumer leaving the event iterator as runtime shutdown', async () => {
    const nativeHandle = {
      id: 'live-thread',
      send: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      events: async function* () {
        yield { type: 'text', data: { text: 'still working' } };
      },
    } as unknown as AgentSessionHandle;
    const agent = withSubscriptionAccounts({
      kind: 'claude-code',
      startSession: async () => nativeHandle,
    } as unknown as BaseAgent);
    const handle = await agent.startSession({
      providerId: 'anthropic',
      sessionId: 'live-task',
    } as StartSessionOptions);
    await handle.send({ type: 'user', content: 'hello' });
    for await (const event of handle.events()) {
      expect(event.type).toBe('text');
      break;
    }
    expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(1);
    expect(getSessionSubscriptionAccount('live-task')).toBeDefined();
    await handle.close();
    expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(0);
  });
  it.each(['stopped', 'unauthenticated', 'pending', 'opaque'] as const)(
    'only releases a %s startup reservation when its process is confirmed stopped',
    async (kind) => {
      let stopped!: () => void;
      const whenStopped = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      const error =
        kind === 'stopped'
          ? new AgentStartupStoppedError('failed')
          : kind === 'unauthenticated'
            ? new AgentNotAuthenticatedError('claude-code')
            : kind === 'pending'
              ? new AgentStartupCleanupPendingError('failed', { cause: 'failed', whenStopped })
              : new Error('opaque failure');
      const agent = withSubscriptionAccounts({
        kind: 'claude-code',
        startSession: async () => {
          throw error;
        },
      } as unknown as BaseAgent);
      await expect(
        agent.startSession({
          providerId: 'anthropic',
          sessionId: 'failed-task',
        } as StartSessionOptions),
      ).rejects.toBe(error);
      expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(
        kind === 'pending' || kind === 'opaque' ? 1 : 0,
      );
      if (kind === 'pending') {
        expect(getSessionSubscriptionAccount('failed-task')).toBeDefined();
        stopped();
        await whenStopped;
        expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(0);
        expect(getSessionSubscriptionAccount('failed-task')).toBeUndefined();
      }
    },
  );
  // PR review: selection happens before any process exists, so Maker must release startup resources.
  it('classifies an unavailable pool as a stopped startup without calling the native agent', async () => {
    h.pools.anthropic!.disconnected = true;
    const start = vi.fn();
    const agent = withSubscriptionAccounts({
      kind: 'claude-code',
      startSession: start,
    } as unknown as BaseAgent);
    await expect(
      agent.startSession({ providerId: 'anthropic' } as StartSessionOptions),
    ).rejects.toBeInstanceOf(AgentStartupStoppedError);
    expect(start).not.toHaveBeenCalled();
  });
  it('forks and binds a secondary Claude profile without moving to the default account', async () => {
    h.bindings.set('native:source-second', { providerId: 'anthropic', accountId: 'second' });
    const fork = vi.fn(async (options: ForkSdkSessionOptions) => {
      expect(options[NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/second');
      return { newSdkSessionId: 'fork-second', uuidMap: new Map() };
    });
    const agent = withSubscriptionAccounts({
      kind: 'claude-code',
      forkSdkSession: fork,
    } as unknown as BaseAgent);
    await agent.forkSdkSession({
      providerId: 'anthropic',
      sourceSdkSessionId: 'source-second',
      upToMessageId: 'message-second',
      workingDir: '/work',
    });
    expect(fork).toHaveBeenCalledOnce();
    expect(h.bindings.get('native:fork-second')?.accountId).toBe('second');
  });
  it('merges direct Codex quota events by bucket and keeps exhausted pools ineligible for every engine', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default')] };
    const window = (usedPercent: number) => ({
      usedPercent,
      windowMinutes: 300,
      resetsAt: Date.now() / 1000 + 7200,
    });
    h.usage.mockResolvedValue({
      codexUsage: {
        appServerBuckets: {
          codex: {
            limitId: 'codex',
            limitName: 'Codex',
            updatedAt: Date.now(),
            primary: window(10),
            secondary: null,
          },
          spark: {
            limitId: 'spark',
            limitName: 'special-model',
            updatedAt: Date.now(),
            primary: window(20),
            secondary: null,
          },
        },
        webSnapshot: null,
      },
    });
    const lease = await acquireSubscriptionAccount('openai', 'gpt-6', []);
    observeSubscriptionAccountUsage(lease!.account, { limitId: 'codex', primary: window(100) });
    const pooled = await readSubscriptionPoolUsage('openai');
    expect(pooled?.codexUsage?.appServerBuckets?.spark.primary?.usedPercent).toBe(20);
    expect(pooled?.codexUsage?.appServerBuckets?.codex.limitName).toBe('Codex');
    for (const kind of ['codex', 'pi', 'claude-code']) {
      expect(
        providerGroupMemberUsageState(pooled!, 'chatgpt/gpt-6', Date.now(), kind).limited,
      ).toBe(true);
      expect(
        providerGroupMemberUsageState(pooled!, 'chatgpt/special-model', Date.now(), kind).limited,
      ).toBe(false);
    }
    await expect(acquireSubscriptionAccount('openai', 'gpt-6', [])).rejects.toThrow(
      'No subscription account',
    );
    lease?.release();
  });
  // Upgrade regression: existing authorizations must not be rewritten by installing or opening the new UI.
  it('passes existing single-account sessions through unchanged until a pool is configured', async () => {
    h.pools = {};
    for (const [kind, providerId] of [
      ['claude-code', 'anthropic'],
      ['codex', 'openai'],
      ['claude-code', 'openai'],
      ['pi', 'openai'],
    ]) {
      const start = vi.fn(async () => ({ id: 'existing' }));
      const agent = withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent);
      const options = { providerId, sessionId: 'existing-task' } as StartSessionOptions;
      await agent.startSession(options);
      expect(start).toHaveBeenCalledExactlyOnceWith(options);
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(h.legacyRead).not.toHaveBeenCalled();
    expect(h.login).not.toHaveBeenCalled();
    expect(h.pools).toEqual({});
  });
  it('keeps the authorized private Codex account after adding a second account fails, and then balances both after success', async () => {
    h.pools = {};
    h.shared = false;
    h.read.mockResolvedValue({ authenticated: false });
    h.login.mockRejectedValueOnce(new Error('login_cancelled'));
    const before = await readSubscriptionPool('openai');
    expect(before.configured).toBe(false);
    expect(before.accounts[0]).toMatchObject({
      status: 'ready',
      identity: 'original@example.com',
      directory: '/existing-cindy/codex-home',
    });
    await expect(
      runSubscriptionAccountCommand({
        action: 'add',
        providerId: 'openai',
        loginKey: 'cancelled-second',
      }),
    ).rejects.toThrow('login_cancelled');
    expect(h.pools.openai?.legacyCodexDefault).toBe(true);
    const after = await readSubscriptionPool('openai');
    expect(after.accounts.map((a) => a.status)).toEqual(['ready', 'signed-out']);
    const original = await acquireSubscriptionAccount('openai', undefined, []);
    expect(original?.account.configDir).toBe('/existing-cindy/codex-home');
    original?.release();
    const addedId = h.pools.openai!.accounts[1].id;
    h.login.mockImplementation(async () => {
      h.read.mockResolvedValue({ authenticated: true, identity: 'second@example.com' });
    });
    await runSubscriptionAccountCommand({
      action: 'login',
      providerId: 'openai',
      accountId: addedId,
      loginKey: 'retry-second',
    });
    await runSubscriptionAccountCommand({
      action: 'configure',
      providerId: 'openai',
      strategy: 'round',
    });
    const next = await acquireSubscriptionAccount('openai', undefined, []);
    expect(next?.account.configDir).toBe('openai/' + addedId);
    next?.release();
    expect(h.legacyLogin).not.toHaveBeenCalled();
    expect(h.legacyRead).toHaveBeenCalled();
  });
  // Standard: real dispatch wrappers share scheduling across all OpenAI engines.
  it('shares OpenAI accounts across Codex, Claude Code and Pi, including secondary-only login', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    const selected: string[] = [];
    const handles: AgentSessionHandle[] = [];
    for (const kind of ['codex', 'claude-code', 'pi']) {
      const sessionId = 'pool-' + kind;
      const wrapped = withSubscriptionAccounts({
        kind,
        startSession: async (options: StartSessionOptions) => {
          expect(getSessionSubscriptionAccount(sessionId)).toBe(
            options[NATIVE_SUBSCRIPTION_ACCOUNT],
          );
          selected.push(options[NATIVE_SUBSCRIPTION_ACCOUNT]!.configDir);
          return {
            id: sessionId,
            close: async () => {},
            setModel: vi.fn(),
          } as unknown as AgentSessionHandle;
        },
      } as unknown as BaseAgent);
      handles.push(
        await wrapped.startSession({ providerId: 'openai', sessionId } as StartSessionOptions),
      );
    }
    expect(selected).toEqual(['openai/default', 'openai/second', 'openai/default']);
    expect(await handles[1].requiresModelSwitchRebuild?.('m', { providerId: 'xd' })).toBe(true);
    await Promise.all(handles.map((handle) => handle.close()));
    expect(getSessionSubscriptionAccount('pool-claude-code')).toBeUndefined();
    h.bound = false;
    h.owner = 'owner-a:' + ++generation;
    const secondary = await acquireSubscriptionAccount('openai', undefined, []);
    expect(secondary?.account.configDir).toBe('openai/second');
    secondary?.release();
  });
  it.each(['anthropic', 'openai'].flatMap(providerId =>
    [true, false].map(bound => ({ providerId: providerId as SubscriptionProvider, bound }))))('reuses the signed-out $providerId default folder with binding=$bound', async ({ providerId, bound }) => {
    h.bound = bound;
    h.pools[providerId] = { strategy: 'least', accounts: [account('default')] };
    h.read.mockResolvedValue({ authenticated: false });
    h.login.mockImplementation(async () => {
      h.read.mockResolvedValue({ authenticated: true });
    });
    await runSubscriptionAccountCommand({
      action: 'add',
      providerId,
      loginKey: 'reconnect-first',
    });
    expect(h.login).toHaveBeenCalledWith(providerId, `${providerId}/default`, expect.any(AbortSignal));
    expect(h.pools[providerId]!.accounts.map((a) => a.id)).toEqual(['default']);
  });
  it('only marks the selected account disconnected after a rejected bridge credential', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    const selected = await acquireSubscriptionAccount('openai', undefined, []);
    selected!.account.invalidateAuth!('token_revoked', 'fixture-token');
    expect((await readSubscriptionPool('openai')).accounts.map((a) => a.status)).toEqual([
      'signed-out',
      'ready',
    ]);
    const next = await acquireSubscriptionAccount('openai', undefined, []);
    expect(next?.account.configDir).toBe('openai/second');
    selected?.release();
    next?.release();
  });
  it('reserves concurrent starts before another picker can select, and counts running turns until release', async () => {
    const [first, second] = await Promise.all([
      acquireSubscriptionAccount('anthropic', 'claude-sonnet', ['task:a']),
      acquireSubscriptionAccount('anthropic', 'claude-sonnet', ['task:b']),
    ]);
    expect(first!.account.configDir).not.toBe(second!.account.configDir);
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      1, 1,
    ]);
    first!.running(false);
    const third = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', ['task:c']);
    expect(third!.account.id).toBe(first!.account.id);
    first!.release();
    second!.release();
    third!.release();
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      0, 0,
    ]);
  });
  it('uses the group round and order policies even when all limits are occupied', async () => {
    h.pools.anthropic!.strategy = 'round';
    const a = await acquireSubscriptionAccount('anthropic', undefined, []);
    const b = await acquireSubscriptionAccount('anthropic', undefined, []);
    const c = await acquireSubscriptionAccount('anthropic', undefined, []);
    expect([a!.account.configDir, b!.account.configDir, c!.account.configDir]).toEqual([
      'anthropic/default',
      'anthropic/second',
      'anthropic/default',
    ]);
    a!.release();
    b!.release();
    c!.release();
    h.pools.anthropic!.strategy = 'order';
    const ordered = await acquireSubscriptionAccount('anthropic', undefined, []);
    expect(ordered!.account.configDir).toBe('anthropic/default');
    ordered!.release();
  });
  it('refuses paused or removed native resumes instead of sending with disabled credentials', async () => {
    const original = await acquireSubscriptionAccount('anthropic', undefined, []);
    await original!.bind(['native:thread-a']);
    original!.release();
    h.pools.anthropic!.accounts[0].paused = true;
    await expect(acquireSubscriptionAccount('anthropic', undefined, ['native:thread-a'])).rejects.toThrow();
    // History inspection/fork control may still read the original home.
    const control = await acquireSubscriptionAccount('anthropic', undefined, ['native:thread-a'], true);
    expect(control!.account.id).toBe(original!.account.id);
    control!.release();
    h.pools.anthropic!.accounts.shift();
    await expect(
      acquireSubscriptionAccount('anthropic', undefined, ['native:thread-a']),
    ).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE]');
  });
  it('skips exhausted accounts with the same model-specific quota policy as provider groups', async () => {
    h.usage.mockImplementation(async (_provider: string, dir: string) =>
      dir.endsWith('default')
        ? {
            claudeUsage: {
              updatedAt: Date.now(),
              fiveHour: { utilization: 100, resetsAt: Date.now() / 1000 + 3600 },
              sevenDay: null,
              scoped: [],
            },
          }
        : {},
    );
    const selected = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', []);
    expect(selected!.account.configDir).toBe('anthropic/second');
    selected!.release();
  });
  it('does not silently fall back when the provider is disconnected', async () => {
    await disconnectSubscriptionPool('anthropic');
    await expect(acquireSubscriptionAccount('anthropic', undefined, [])).rejects.toThrow(
      'disconnected',
    );
  });
  it('fences late CLI results and leases at an owner boundary', async () => {
    let finish!: (value: unknown) => void;
    h.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.pools.anthropic!.accounts = [account('default')];
    const pending = acquireSubscriptionAccount('anthropic', undefined, []);
    h.owner = 'owner-b:1';
    finish({ authenticated: true });
    await expect(pending).rejects.toThrow('owner changed');
    expect(h.bindings.size).toBe(0);
  });
  it('reports usable pool quota to an outer group even when the default account is exhausted', async () => {
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({
      claudeUsage: {
        updatedAt: Date.now(),
        fiveHour: {
          utilization: dir.endsWith('default') ? 100 : 12,
          resetsAt: Date.now() / 1000 + 3600,
        },
        sevenDay: null,
        scoped: [],
      },
    }));
    expect((await readSubscriptionPoolUsage('anthropic'))?.claudeUsage?.fiveHour?.utilization).toBe(
      12,
    );
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      0, 0,
    ]);
  });
  // #9833, unit: the actual account pool and group router must agree after an
  // old task cools the member. Existing tests exercised these layers separately.
  it.each(['persisted', 'terminal', 'startup'] as const)('assigns a new same-model task to the healthy account after a %s cooldown', async (failure) => {
    const now = Date.now();
    const model = 'claude-sonnet-5-5';
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({ claudeUsage: {
      updatedAt: now,
      fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
      sevenDay: { utilization: dir.endsWith('default') ? 100 : 20, resetsAt: now / 1000 + 86400 },
      scoped: [],
    } }));
    h.bindings.set('native:old', { providerId: 'anthropic', accountId: 'default' });
    const config = normalizeProviderGroupConfig({ members: [{ kind: 'local' }] }, 'anthropic')!;
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [{ id: 'anthropic', name: 'Anthropic', connected: true,
        agents: ['claude-code'], auth: { method: 'oauth', native: 'claude' },
        models: { 'claude-code': [{ id: model, name: model, efforts: [], defaultEffort: null }] },
        routing: { 'claude-code': {} },
      } as unknown as ProviderView],
      localDeviceName: () => 'local', listDevices: async () => [], readDeviceProviders: async () => [],
      listReceivedShares: () => [], isMobilePlatform: () => false,
      readClaudeUsage: async () => (await readSubscriptionPoolUsage('anthropic'))?.claudeUsage ?? null,
      now: () => now,
    });
    const bindings = new Map<string, ProviderGroupBinding>();
    const router = createProviderGroupRouter({ directory, readGroup: () => config,
      listBindings: () => Object.fromEntries(bindings), isTurnRunning: () => false, now: () => now, random: () => 0,
      readPoolModelAvailability: async () => readSubscriptionPoolModelAvailability('anthropic', model),
      coolingStore: { read: (): ProviderGroupPersistedCooling => failure === 'persisted'
        ? { anthropic: { local: { 'claude:sonnet': now + 1_800_000 } } } : {}, write: vi.fn() },
    });
    const row: ProviderGroupSessionRow = { agentKind: 'claude-code', model, providerId: 'anthropic',
      agentDeviceId: null, remoteHostId: null, sdkSessionId: null };
    const switchAgentLocation = vi.fn();
    const service = createProviderGroupService({ router, directory, readGroup: () => config,
      readBinding: (id) => bindings.get(id) ?? null,
      writeBinding: async (id, binding) => {
        if (binding) bindings.set(id, { providerId: binding.providerId, memberKey: binding.memberKey, at: now });
        else bindings.delete(id);
      },
      isReleased: () => false, markReleased: vi.fn(), readSessionRow: async (id) => ({ ...row, sdkSessionId: id === 'old' ? 'native:old' : null }),
      resolveImplicitProvider: async () => 'anthropic', persistRoute: vi.fn(), hasAssistantHistory: async () => false,
      isFailoverEligible: async () => true, leaseRecovery: () => ({}), isLeaseCurrent: () => true,
      rearmContinue: () => 2, cancelContinue: vi.fn(), switchAgentLocation, isTurnRunning: () => false, hasLiveSession: () => false,
      continueSession: async () => 'resumed', fallback: vi.fn(), readResetAt: () => null,
      now: () => now, sleep: async () => {}, log: { info: vi.fn(), warn: vi.fn() },
    });
    if (failure !== 'persisted') {
      bindings.set('old', { providerId: 'anthropic', memberKey: 'local', at: now });
      if (failure === 'terminal') await service.onTurnError('old', { sdkError: 'rate_limit' }, 1);
      else {
        const context = await service.assignBeforeStart({ sessionId: 'old', agentKind: 'claude-code', model });
        expect(context).not.toBeNull();
        await service.nextAfterStartFailure(context!, new Error("You've hit your usage limit"));
      }
      expect(router.coolingUntil('anthropic', 'local', model)).toBe(now + 1_800_000);
    }
    expect(await service.assignBeforeStart({ sessionId: 'new', agentKind: 'claude-code', model }))
      .toMatchObject({ member: { key: 'local' } });
    const next = await acquireSubscriptionAccount('anthropic', model, ['task:new']);
    expect(next?.account.configDir).toBe('anthropic/second');
    next?.release();
    await expect(acquireSubscriptionAccount('anthropic', model, ['native:old'])).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_LIMITED]');
    expect(h.bindings.get('native:old')?.accountId).toBe('default');
    expect(switchAgentLocation).not.toHaveBeenCalled();
  });
  // PR #9837 / unit: an actual CLI failure without account_usage must outrank
  // optimistic cached quota. The previous group regression pre-exhausted it.
  it.each([
    ['startup', 'exhausted'], ['terminal', 'unknown'], ['send', 'healthy'],
  ] as const)('does not reuse the failed account after %s with a %s backup', async (failure, backup) => {
    const model = 'claude-sonnet-5-5';
    const now = Date.now();
    h.pools.anthropic!.strategy = 'order';
    h.usage.mockImplementation(async (_provider: string, dir: string) =>
      dir.endsWith('second') && backup === 'unknown' ? {} : { claudeUsage: {
        updatedAt: now, fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
        sevenDay: { utilization: dir.endsWith('second') ? backup === 'exhausted' ? 100 : 40 : 20,
          resetsAt: now / 1000 + 86400 },
      } });
    const error = new AgentStartupStoppedError(new Error("You've hit your usage limit"));
    const start = vi.fn(async () => {
      if (failure === 'startup') throw error;
      return { id: 'failed-native', close: async () => {},
        send: async () => { if (failure === 'send') throw error; },
        events: async function* () { yield { type: 'error', data: { sdkError: 'rate_limit' } }; },
      } as unknown as AgentSessionHandle;
    });
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: start } as unknown as BaseAgent);
    const options: StartSessionOptions = { providerId: 'anthropic', model, sessionId: 'failed-task', workingDir: '/work',
      ...(failure === 'terminal' ? { deviceHosted: { workingDir: '/controller/work', extraDirs: [], writableDirs: [],
        platform: 'win32' as const, shell: 'powershell', isGitRepo: false, tunnelUrl: 'http://127.0.0.1:1',
        tunnelToken: 'unused-test-token', mcpServers: [] } } : {}) };
    if (failure === 'startup') await expect(agent.startSession(options)).rejects.toThrow('usage limit');
    else {
      const handle = await agent.startSession(options);
      if (failure === 'send') await expect(handle.send({ type: 'user', content: 'hello' })).rejects.toThrow('usage limit');
      else for await (const _event of handle.events()) { /* Consume the actual wrapper. */ }
      await handle.close();
      expect(h.bindings.get('native:failed-native')?.accountId).toBe('default');
      const pinned = await acquireSubscriptionAccount('anthropic', model, ['native:failed-native']);
      expect(pinned?.account.configDir).toBe('anthropic/default'); // manual retry stays pinned
      pinned?.release();
    }
    expect(await readSubscriptionPoolModelAvailability('anthropic', model)).toBe(backup === 'healthy');
    if (backup === 'healthy') {
      const next = await acquireSubscriptionAccount('anthropic', model, ['task:new']);
      expect(next?.account.configDir).toBe('anthropic/second');
      next?.release();
    } else if (backup === 'exhausted') {
      await expect(acquireSubscriptionAccount('anthropic', model, ['task:new'])).rejects.toThrow('No subscription account');
    }
    expect(await readSubscriptionPoolModelAvailability('anthropic', 'claude-opus-5-5')).toBe(true);
  });

  // Unit: the account failure must follow model switches and expire at the real
  // reset (or the existing fallback), without treating retryable/overload as quota.
  it.each([60_000, null])('expires account failure evidence after %s ms and ignores stale-owner events', async (resetDelay) => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const sonnet = 'claude-sonnet-5-5';
      const opus = 'claude-opus-5-5';
      h.pools.anthropic!.accounts[1].paused = true;
      h.usage.mockImplementation(async () => ({ claudeUsage: { updatedAt: Date.now(),
        fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
        sevenDay: { utilization: 20, resetsAt: now / 1000 + 86400 },
      } }));
      let data: Record<string, unknown> = { sdkError: 'rate_limit', willRetry: true };
      const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async () => ({
        id: 'switching', close: async () => {}, setModel: async () => {},
        events: async function* () { yield { type: 'error', data }; },
      }) } as unknown as BaseAgent);
      const handle = await agent.startSession({ providerId: 'anthropic', model: sonnet } as StartSessionOptions);
      await handle.setModel!(opus);
      const consume = async () => { for await (const _event of handle.events()) { /* real dispatch */ } };
      await consume();
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(true);
      data = { sdkError: 'rate_limit', errorStatus: 529 };
      await consume();
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(true);
      data = { sdkError: 'rate_limit', ...(resetDelay === null ? {} : { usageResetAt: now + resetDelay }) };
      await consume();
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(false);
      expect(await readSubscriptionPoolModelAvailability('anthropic', sonnet)).toBe(true);
      const duration = resetDelay ?? 1_800_000;
      vi.setSystemTime(now + duration - 1);
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(false);
      vi.setSystemTime(now + duration);
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(true);
      h.owner += '-new';
      await consume(); // This old lease cannot poison the new owner's pool.
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(true);
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Unit: the same native OpenAI account serves Codex and ChatGPT bridge aliases;
  // an alias must not evade the failure recorded by the executing host.
  it('shares account failure evidence across native OpenAI model aliases', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { codex: {
      limitId: 'codex', updatedAt: Date.now(),
      primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 },
      secondary: null,
    } }, webSnapshot: null } });
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: async () => ({
      id: 'codex-failed', close: async () => {},
      events: async function* () { yield { type: 'error', data: { codexErrorInfo: 'usageLimitExceeded' } }; },
    }) } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai', model: 'gpt-6-astra' } as StartSessionOptions);
    for await (const _event of handle.events()) { /* actual host wrapper */ }
    await handle.close();
    const next = await acquireSubscriptionAccount('openai', 'chatgpt/gpt-6-astra', []);
    expect(next?.account.configDir).toBe('openai/second');
    next?.release();
    h.pools.openai!.accounts[1].paused = true;
    expect(await readSubscriptionPoolModelAvailability('openai', 'chatgpt/gpt-6-astra')).toBe(false);
    await runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'default', loginKey: 'reconnect' });
    expect(await readSubscriptionPoolModelAvailability('openai', 'chatgpt/gpt-6-astra')).toBe(true);
  });

  // #9833, unit: only an eligible account with known capacity may remove a
  // member cooldown. Pool aggregate tests did not cover this positive proof.
  it.each(['paused', 'removed', 'auth', 'unknown', 'exhausted', 'disconnected', 'single'] as const)(
    'does not recover a member when the alternate account is %s', async (reason) => {
      const now = Date.now();
      h.usage.mockImplementation(async (_provider: string, dir: string) => reason === 'unknown' && dir.endsWith('second') ? {} : ({ claudeUsage: {
        updatedAt: now, fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
        sevenDay: { utilization: dir.endsWith('default') || reason === 'exhausted' ? 100 : 20, resetsAt: now / 1000 + 86400 },
      } }));
      h.read.mockImplementation(async (_provider: string, dir: string) => {
        // Mutations happen while the CLI read is in flight, after the pool was captured.
        if (reason === 'paused') h.pools.anthropic!.accounts[1].paused = true;
        if (reason === 'removed') h.pools.anthropic!.accounts = h.pools.anthropic!.accounts.slice(0, 1);
        if (reason === 'disconnected') h.pools.anthropic!.disconnected = true;
        return { authenticated: !(reason === 'auth' && dir.endsWith('second')) };
      });
      if (reason === 'single') h.pools.anthropic!.accounts = [account('default')];
      expect(await readSubscriptionPoolModelAvailability('anthropic', 'claude-sonnet-5-5'))
        .toBe(reason === 'single' ? null : false);
    },
  );
  it('publishes usable model-specific Claude quota instead of the first account’s exhausted bucket', async () => {
    h.pools.anthropic!.strategy = 'order';
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({
      claudeUsage: {
        updatedAt: Date.now(),
        fiveHour: { utilization: 10, resetsAt: Date.now() / 1000 + 3600 },
        sevenDay: null,
        scoped: [
          {
            modelId: 'claude-sonnet',
            modelDisplayName: 'Sonnet',
            utilization: dir.endsWith('default') ? 100 : 20,
            resetsAt: Date.now() / 1000 + 3600,
          },
        ],
      },
    }));
    const quota = await readSubscriptionPoolUsage('anthropic');
    expect(quota?.claudeUsage?.scoped?.[0]?.utilization).toBe(20);
  });
  it('uses native Codex quota for ChatGPT bridge models and aggregates each model bucket separately', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.usage.mockImplementation(async (_provider: string, dir: string) => {
      const bucket = (limitId: string, usedPercent: number) => ({
        limitId,
        limitName: limitId,
        updatedAt: Date.now(),
        primary: { usedPercent, windowMinutes: 300, resetsAt: Date.now() / 1000 + 7200 },
        secondary: null,
      });
      return {
        codexUsage: {
          appServerBuckets: {
            codex: bucket('codex', dir.endsWith('default') ? 100 : 15),
            special: bucket('special', dir.endsWith('default') ? 5 : 100),
          },
          webSnapshot: null,
        },
      };
    });
    const chosen = await acquireSubscriptionAccount('openai', 'chatgpt/gpt-6-astra', []);
    expect(chosen?.account.configDir).toBe('openai/second');
    chosen?.release();
    const quota = (await readSubscriptionPoolUsage('openai'))?.codexUsage?.appServerBuckets;
    expect(quota?.codex.primary?.usedPercent).toBe(15);
    expect(quota?.special.primary?.usedPercent).toBe(5);
  });
  // Regression: settings showed one weekly bar per account. Each account must carry every
  // window of its own snapshot, and sharing must list only accounts that can serve tasks.
  it('reports every usage window per account and lists only assignable accounts for sharing', async () => {
    h.pools.anthropic!.accounts.push({ ...account('paused'), paused: true }, account('signed-out'));
    h.read.mockImplementation(async (_provider: string, dir: string) => ({
      authenticated: !dir.endsWith('signed-out'),
      identity: dir,
    }));
    const window = (utilization: number) => ({ utilization, resetsAt: Date.now() / 1000 + 3600 });
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({
      claudeUsage: {
        updatedAt: Date.now(),
        fiveHour: window(dir.endsWith('default') ? 2 : 30),
        sevenDay: window(dir.endsWith('default') ? 86 : 40),
        scoped: [{ modelId: 'claude-fable', modelDisplayName: 'Fable', ...window(16) }],
      },
    }));
    const view = await readSubscriptionPool('anthropic');
    expect(view.accounts.map((a) => a.usage?.claude?.sevenDay?.utilization)).toEqual([
      86,
      40,
      40,
      undefined,
    ]);
    expect(view.accounts[1].usage?.claude).toMatchObject({
      fiveHour: { utilization: 30 },
      scoped: [{ modelDisplayName: 'Fable', utilization: 16 }],
    });
    const shared = await readSubscriptionPoolAccountUsages('anthropic');
    expect(shared?.map((a) => [a.isDefault, a.usage?.claudeUsage?.sevenDay?.utilization])).toEqual([
      [true, 86],
      [false, 40],
    ]);
    expect(JSON.stringify(shared)).not.toContain('anthropic/');
    h.pools.anthropic!.disconnected = true;
    expect(await readSubscriptionPoolAccountUsages('anthropic')).toBeUndefined();
    expect((await readSubscriptionPool('anthropic')).accounts.every((a) => !a.usage)).toBe(true);
  });
  // User-reported quota oscillation / unit: frequent SDK events used to renew
  // the cache clock forever. Existing tests never cross endpoint TTL with events.
  it('refreshes authoritative Claude percentages despite continuous SDK events', async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      h.pools.anthropic = { strategy: 'order', accounts: [account('default')] };
      const reset = now / 1000 + 604800;
      h.usage.mockResolvedValue({ claudeUsage: {
        source: 'oauth-endpoint', updatedAt: now, sevenDay: { utilization: 22, resetsAt: reset },
      } });
      const lease = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', []);
      for (let i = 0; i < 5; i++) {
        now += 31_000;
        observeSubscriptionAccountUsage(lease!.account, {
          rateLimitType: 'seven_day', utilization: 0.2, resetsAt: reset, status: 'allowed',
        });
        expect((await readSubscriptionPool('anthropic')).accounts[0].usage?.claude?.sevenDay?.utilization).toBe(22);
      }
      expect(h.usage).toHaveBeenCalledTimes(1);
      now += 31_000;
      h.usage.mockResolvedValue({ claudeUsage: {
        source: 'oauth-endpoint', updatedAt: now, sevenDay: { utilization: 24, resetsAt: reset },
      } });
      observeSubscriptionAccountUsage(lease!.account, {
        rateLimitType: 'seven_day', utilization: 0.2, resetsAt: reset, status: 'allowed',
      });
      expect((await readSubscriptionPool('anthropic')).accounts[0].usage?.claude?.sevenDay?.utilization).toBe(24);
      expect(h.usage).toHaveBeenCalledTimes(2);
      lease!.release();
    } finally { clock.mockRestore(); }
  });

  // #9951 P1 / unit: list reads yield to auth and quota I/O. Existing TTL tests
  // complete I/O immediately and cannot detect a rejected event being overwritten.
  it.each(['anthropic', 'openai'] as const)('retains %s quota events during auth, endpoint and failed endpoint reads', async (provider) => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let releaseRead: (() => void) | undefined;
    try {
      h.pools[provider] = { strategy: 'order', accounts: [account('default')] };
      const reset = now / 1000 + 86400;
      const initial = provider === 'anthropic'
        ? { claudeUsage: { source: 'oauth-endpoint', updatedAt: now, fiveHour: { utilization: 20, resetsAt: reset } } }
        : { codexUsage: { appServerBuckets: {
            codex: { limitId: 'codex', updatedAt: now,
              primary: { usedPercent: 20, windowMinutes: 300, resetsAt: reset },
              secondary: { usedPercent: 25, windowMinutes: 10080, resetsAt: reset } },
            spark: { limitId: 'spark', updatedAt: now,
              primary: { usedPercent: 15, windowMinutes: 300, resetsAt: reset }, secondary: null },
          }, webSnapshot: null } };
      h.usage.mockResolvedValue(initial);
      const lease = await acquireSubscriptionAccount(provider, provider === 'anthropic' ? 'claude-sonnet' : 'gpt-6', []);
      for (const phase of ['auth', 'endpoint', 'failed-endpoint', 'new-window']) {
        now += phase === 'auth' ? 31_000 : 181_000;
        let started!: () => void;
        const reading = new Promise<void>(resolve => { started = resolve; });
        const paused = new Promise<void>(resolve => { releaseRead = resolve; });
        if (phase === 'auth') h.read.mockImplementationOnce(async () => {
          started(); await paused; return { authenticated: true, identity: 'account' };
        });
        else h.usage.mockImplementationOnce(async () => {
          started(); await paused;
          if (phase === 'failed-endpoint') throw new Error('endpoint unavailable');
          return provider === 'anthropic' ? { claudeUsage: {
            source: 'oauth-endpoint', updatedAt: now + 1,
            fiveHour: { utilization: 30, resetsAt: phase === 'new-window' ? reset + 18000 : reset },
            sevenDay: { utilization: 45, resetsAt: reset },
            scoped: [{ modelDisplayName: 'Opus', utilization: 60, resetsAt: reset }],
          } } : { codexUsage: { appServerBuckets: {
            codex: { limitId: 'codex', updatedAt: now + 1,
              primary: { usedPercent: 30, windowMinutes: 300, resetsAt: phase === 'new-window' ? reset + 18000 : reset },
              secondary: { usedPercent: 45, windowMinutes: 10080, resetsAt: reset } },
            spark: { limitId: 'spark', updatedAt: now + 1,
              primary: { usedPercent: 60, windowMinutes: 300, resetsAt: reset }, secondary: null },
          }, webSnapshot: null }, codexCredits: { hasCredits: true, unlimited: false, balance: '8.50' } };
        });
        const view = readSubscriptionPool(provider);
        await reading;
        observeSubscriptionAccountUsage(lease!.account, provider === 'anthropic'
          ? { rateLimitType: 'five_hour', utilization: 1, resetsAt: reset, status: 'rejected' }
          : { limitId: 'codex', primary: { usedPercent: 100, windowMinutes: 300, resetsAt: reset } });
        releaseRead!();
        const usage = (await view).accounts[0].usage;
        if (phase === 'new-window') {
          if (provider === 'anthropic') {
            expect(usage?.claude?.fiveHour?.resetsAt).toBe(reset + 18000);
            expect(usage?.claude?.rateLimitStatus).toBeUndefined();
          } else expect(usage?.codex?.buckets.codex.primary).toMatchObject({ usedPercent: 30, resetsAt: reset + 18000 });
          const nextLease = await acquireSubscriptionAccount(provider, provider === 'anthropic' ? 'claude-sonnet' : 'gpt-6', []);
          expect(nextLease).toBeTruthy();
          nextLease!.release();
          continue;
        }
        if (provider === 'anthropic') expect(usage?.claude?.rateLimitStatus).toBe('rejected');
        else expect(usage?.codex?.buckets.codex.primary?.usedPercent).toBe(100);
        if (phase === 'endpoint') {
          // #9951 P2: a concurrent event must not discard successful read fields
          // or keep the endpoint TTL expired. Prior tests only checked rejection.
          if (provider === 'anthropic') expect(usage?.claude).toMatchObject({
            fiveHour: { utilization: 30 }, sevenDay: { utilization: 45 },
            scoped: [{ modelDisplayName: 'Opus', utilization: 60 }],
          });
          else expect(usage?.codex).toMatchObject({
            buckets: { codex: { secondary: { usedPercent: 45 } }, spark: { primary: { usedPercent: 60 } } },
            credits: { balance: '8.50' },
          });
          const readCount = h.usage.mock.calls.length;
          now += 31_000;
          await readSubscriptionPool(provider);
          expect(h.usage).toHaveBeenCalledTimes(readCount);
        }
        await expect(acquireSubscriptionAccount(provider, provider === 'anthropic' ? 'claude-sonnet' : 'gpt-6', []))
          .rejects.toThrow('No subscription account is available');
      }
      lease!.release();
    } finally { releaseRead?.(); clock.mockRestore(); }
  });

  it('keeps Codex credits for the account card when quota events update its buckets', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default')] };
    h.usage.mockResolvedValue({
      codexUsage: {
        appServerBuckets: {
          codex: {
            limitId: 'codex',
            limitName: null,
            updatedAt: Date.now(),
            primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Date.now() / 1000 + 600 },
            secondary: null,
          },
        },
        webSnapshot: null,
      },
      codexCredits: { hasCredits: true, unlimited: false, balance: '12.50' },
    });
    const lease = await acquireSubscriptionAccount('openai', 'gpt-6', []);
    observeSubscriptionAccountUsage(lease!.account, {
      limitId: 'codex',
      primary: { usedPercent: 55, windowMinutes: 300, resetsAt: Date.now() / 1000 + 600 },
    });
    lease!.release();
    expect((await readSubscriptionPool('openai')).accounts[0].usage?.codex).toMatchObject({
      buckets: { codex: { primary: { usedPercent: 55 } } },
      credits: { balance: '12.50' },
    });
  });
  it('reserves login before asynchronous writes, and an early cancellation never launches the CLI', async () => {
    const pending = runSubscriptionAccountCommand({
      action: 'login',
      providerId: 'anthropic',
      accountId: 'default',
      loginKey: 'first',
    });
    const rejected = expect(
      runSubscriptionAccountCommand({
        action: 'login',
        providerId: 'anthropic',
        accountId: 'second',
        loginKey: 'second',
      }),
    ).rejects.toThrow('login_in_progress');
    const cancelled = expect(pending).rejects.toThrow('login_cancelled');
    await runSubscriptionAccountCommand({
      action: 'cancel',
      providerId: 'anthropic',
      loginKey: 'first',
    });
    await rejected;
    await cancelled;
    expect(h.login).not.toHaveBeenCalled();
  });
  it('does not replace credentials while an account is running a turn', async () => {
    const active = await acquireSubscriptionAccount('anthropic', undefined, []);
    await expect(
      runSubscriptionAccountCommand({
        action: 'login',
        providerId: 'anthropic',
        accountId: 'default',
        loginKey: 'busy',
      }),
    ).rejects.toThrow('in use');
    expect(h.login).not.toHaveBeenCalled();
    active!.release();
  });
  // Standard tier: exercise the real dispatch wrapper, not a second copy of its routing logic.
  it('keeps direct and device-hosted starts in the same pool and releases turn counts after terminal events', async () => {
    const routes: StartSessionOptions[] = [];
    const native = {
      kind: 'claude-code',
      startSession: async (options: StartSessionOptions) => {
        routes.push(options);
        return {
          id: `thread-${routes.length}`,
          send: async () => {},
          close: async () => {},
          events: async function* () {
            yield { type: 'done', data: {} };
          },
        } as unknown as AgentSessionHandle;
      },
    } as unknown as BaseAgent;
    const agent = withSubscriptionAccounts(native);
    const first = await agent.startSession({
      providerId: 'anthropic',
      sessionId: 'first',
      workingDir: '/work',
    } as StartSessionOptions);
    await first.send({ type: 'user', content: 'hello' });
    const second = await agent.startSession({
      providerId: 'anthropic',
      sessionId: 'hosted',
      workingDir: '/work',
      deviceHosted: true,
    } as unknown as StartSessionOptions);
    expect(routes[0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).not.toBe(
      routes[1][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir,
    );
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      1, 0,
    ]);
    for await (const event of first.events()) {
      expect(event.type).toBe('done');
    }
    await second.close();
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      0, 0,
    ]);
  });
  it('preserves a pre-pool Codex resume on its legacy home instead of silently selecting ~/.codex', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    const start = vi.fn(async () => ({ id: 'legacy' }));
    const agent = withSubscriptionAccounts({
      kind: 'codex',
      startSession: start,
    } as unknown as BaseAgent);
    const options = {
      providerId: 'openai',
      resumeSessionId: 'legacy',
      sessionId: 'old-task',
    } as StartSessionOptions;
    await agent.startSession(options);
    expect(start).toHaveBeenCalledExactlyOnceWith(options);
    expect(h.read).not.toHaveBeenCalled();
  });
});

// Unit regression (2026-11-11): retry reused a disabled account despite another account
// having quota. Existing lease tests did not exercise pre-send context transfer.
// The production entry must change only task ownership after durable history recovery.
describe('disabled task account recovery before send', () => {
  async function fixture() {
    const original = await acquireSubscriptionAccount('anthropic', 'claude-model', []);
    await original!.bind(['task:task-a', 'native:native-a']);
    original!.release();
    h.pools.anthropic!.accounts[0].paused = true;
    const row = { status: 'active', providerId: 'anthropic', agentKind: 'cc',
      model: 'claude-model', sdkSessionId: 'native-a' } as SessionRowSnapshot;
    const deps = {
      readSession: vi.fn(async () => row),
      isRunning: vi.fn(() => false),
      rebuild: vi.fn(async (_id: string, assertCurrent: () => void) => {
        assertCurrent();
        row.sdkSessionId = null;
      }),
    };
    return { row, deps, original: original! };
  }
  it.each(['paused', 'removed'] as const)('moves a %s task to a usable account while retaining original native history ownership', async cause => {
    const { row, deps } = await fixture();
    if (cause === 'removed') h.pools.anthropic!.accounts.shift();
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(true);
    expect(row.sdkSessionId).toBeNull();
    expect(h.bindings.get('task:task-a')?.accountId).toBe('second');
    expect(h.bindings.get('native:native-a')?.accountId).toBe('default');
    const resumed = await acquireSubscriptionAccount('anthropic', row.model!, ['task:task-a']);
    expect(resumed?.account.configDir).toBe('anthropic/second');
    resumed?.release();
    await expect(acquireSubscriptionAccount('anthropic', row.model!, ['task:task-a', 'native:native-a']))
      .rejects.toThrow('account changed');
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(false);
    expect(deps.rebuild).toHaveBeenCalledOnce();
  });
  it('recovers an older Claude task whose original default home has no persisted binding', async () => {
    const { deps } = await fixture();
    h.bindings.clear();
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(true);
    expect(h.bindings.get('task:task-a')?.accountId).toBe('second');
    expect(h.bindings.has('native:native-a')).toBe(false);
  });
  it.each(['codex', 'cc', 'pi'])('uses the same account transfer for OpenAI %s tasks', async agentKind => {
    const { row, deps } = await fixture();
    row.providerId = 'openai';
    row.agentKind = agentKind;
    h.pools.openai = h.pools.anthropic;
    h.bindings.set('task:task-a', { providerId: 'openai', accountId: 'default' });
    h.bindings.set('native:native-a', { providerId: 'openai', accountId: 'default' });
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(true);
    expect(h.bindings.get('task:task-a')).toEqual({ providerId: 'openai', accountId: 'second' });
    expect(h.bindings.get('native:native-a')?.accountId).toBe('default');
  });
  it.each(['no-replacement', 'busy', 'rebuild-failed', 'owner-changed', 'target-disabled'] as const)('preserves the original binding on %s', async failure => {
    const { row, deps } = await fixture();
    if (failure === 'no-replacement') h.pools.anthropic!.accounts[1].paused = true;
    if (failure === 'busy') deps.isRunning.mockReturnValue(true);
    if (failure === 'rebuild-failed') deps.rebuild.mockRejectedValueOnce(new Error('disk full'));
    if (failure === 'owner-changed') deps.readSession.mockImplementationOnce(async () => { h.owner = 'other-owner'; return row; });
    if (failure === 'target-disabled') deps.rebuild.mockImplementationOnce(async (_id, assertCurrent) => {
      h.pools.anthropic!.accounts[1].paused = true;
      assertCurrent();
    });
    await expect(prepareSubscriptionAccountForSend('task-a', deps)).rejects.toThrow();
    expect(row.sdkSessionId).toBe('native-a');
    expect(h.bindings.get('task:task-a')?.accountId).toBe('default');
    expect(h.bindings.get('native:native-a')?.accountId).toBe('default');
    if (failure !== 'owner-changed')
      expect((await readSubscriptionPool('anthropic')).accounts.every(a => a.running === 0)).toBe(true);
  });
  it.each(['enabled', 'ssh', 'remote-agent', 'different-provider'] as const)('does not transfer a task when %s', async kind => {
    const { row, deps } = await fixture();
    if (kind === 'enabled') h.pools.anthropic!.accounts[0].paused = false;
    if (kind === 'ssh') row.remoteHostId = 'remote-host';
    if (kind === 'remote-agent') row.agentDeviceId = 'other-computer';
    if (kind === 'different-provider') row.providerId = 'custom';
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(false);
    expect(deps.rebuild).not.toHaveBeenCalled();
    expect(h.bindings.get('task:task-a')?.accountId).toBe('default');
  });
  it('blocks the next send on an already-live handle after its account is disabled', async () => {
    const send = vi.fn(async () => {});
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async () => ({
      id: 'native-a', send, close: async () => {},
    }) } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'anthropic', sessionId: 'task-a' } as StartSessionOptions);
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'anthropic', accountId: 'default', paused: true });
    await expect(handle.send({ type: 'user', content: 'continue' })).rejects.toThrow('disabled');
    expect(send).not.toHaveBeenCalled();
    await handle.close();
  });
});
