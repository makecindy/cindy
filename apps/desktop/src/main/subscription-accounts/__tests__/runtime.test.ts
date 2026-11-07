import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SubscriptionPoolConfig,
  SubscriptionProvider,
} from '../../../shared/subscriptionAccounts.js';
import {
  NATIVE_SUBSCRIPTION_ACCOUNT,
  type BaseAgent,
  type AgentSessionHandle,
  type StartSessionOptions,
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
  accountOwnerPrefix: () => h.owner,
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
  runSubscriptionAccountCommand,
} from '../runtime.js';
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
  h.legacyRead
    .mockReset()
    .mockResolvedValue({
      authenticated: true,
      identity: 'original@example.com',
      authSource: 'oauth',
    });
  h.legacyLogin.mockReset().mockResolvedValue(undefined);
});

describe('native account assignment on the executing computer', () => {
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
  it('reuses the default folder when the saved first account is no longer logged in', async () => {
    h.pools.anthropic!.accounts = [account('default')];
    h.read.mockResolvedValue({ authenticated: false });
    h.login.mockImplementation(async () => {
      h.read.mockResolvedValue({ authenticated: true });
    });
    await runSubscriptionAccountCommand({
      action: 'add',
      providerId: 'anthropic',
      loginKey: 'reconnect-first',
    });
    expect(h.login).toHaveBeenCalledWith('anthropic', 'anthropic/default', expect.any(AbortSignal));
    expect(h.pools.anthropic!.accounts.map((a) => a.id)).toEqual(['default']);
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
