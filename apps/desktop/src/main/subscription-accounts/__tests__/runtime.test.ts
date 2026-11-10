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
}));
vi.mock('../../maker-host/codex-home-path.js', () => ({
  getCodexHome: () => '/existing-cindy/codex-home',
}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }));
vi.mock('../store.js', () => ({
  readPool: (p: SubscriptionProvider) => h.pools[p] ?? null,
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
  readLegacySubscriptionPoolUsage,
  readSubscriptionSessionUsage,
  readSubscriptionPoolAccountUsages,
  runSubscriptionAccountCommand,
  observeSubscriptionAccountUsage,
} from '../runtime.js';
import { providerGroupMemberUsageState, providerGroupCodexUsageFromReads, providerGroupUsageSnapshot } from '../../provider-group/usage.js';
import { readLegacySubscriptionQuota } from '../legacyQuota.js';
import { withSubscriptionAccounts } from '../agent.js';
import { getSessionSubscriptionAccount } from '../session.js';
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
});

describe('native account assignment on the executing computer', () => {
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
  it('keeps a resumed task on its original account, including a paused account, and refuses removed accounts', async () => {
    const original = await acquireSubscriptionAccount('anthropic', undefined, []);
    await original!.bind(['native:thread-a']);
    original!.release();
    h.pools.anthropic!.accounts[0].paused = true;
    const resumed = await acquireSubscriptionAccount('anthropic', undefined, ['native:thread-a']);
    expect(resumed!.account.id).toBe(original!.account.id);
    resumed!.release();
    h.pools.anthropic!.accounts.shift();
    await expect(
      acquireSubscriptionAccount('anthropic', undefined, ['native:thread-a']),
    ).rejects.toThrow('requires login');
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
