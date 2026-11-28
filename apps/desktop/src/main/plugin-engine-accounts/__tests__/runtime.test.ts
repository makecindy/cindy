import { hostSessionIdFor } from '../../remote-agent/host/sessionIdentity.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcpAccountError,
  AgentStartupStoppedError,
  NATIVE_SUBSCRIPTION_ACCOUNT,
  type AgentSessionHandle,
  type BaseAgent,
  type StartSessionOptions,
} from '@cindy/maker-core';

/*
 * 测试价值
 * - 生产入口与可观察结果：插件引擎账号池的公开入口——acquirePluginEngineAccount(新任务选哪个账号、
 *   绑定任务留在原账号、满载报错)、withPluginEngineAccounts(启动失败换下一个账号、把账号目录交给引擎)、
 *   preparePluginEngineAccountForSend / canSwitchPluginEngineTaskAccount / readPluginEngineSessionAccount
 *   (本机与同账号远程 Agent 发送前换号及撞额度立即换号)、runPluginEngineAccountCommand(添加账号与失败回滚)。
 * - Bug／规则依据：docs/product-rules/subscription-account-pools.md「插件引擎的账号」(与内置账号池同一套分配、
 *   并发上限、暂停、任务固定账号、启动失败、发送前换号及同账号远程 Agent 换号)；plugin-harnesses.md「引擎账号」。
 * - 现有覆盖缺口：新模块；内置账号池的测试只覆盖 Claude / Codex，原测试未覆盖仅有 native 绑定／旧默认登录时的
 *   canSwitchPluginEngineTaskAccount 以及同账号远程 Agent 的换号探测与边界拒绝。
 * - 最小失败输入：两个已登录账号的引擎连开两个任务；第一个账号启动时报额度用完；绑定账号额度用完后再发送；
 *   仅绑定 native 会话或旧默认登录的冷却账号查 canSwitchPluginEngineTaskAccount；控制端无本地池时远程 Agent 任务
 *   撞额度／暂停／移出／关闭远程调用／分享访客／旧端拒绝；
 *   空闲一分钟后绑定账号已退出登录再发送；重新登录只回「已登录」不回身份；插件登录失败的添加；
 *   各账号只列出自己的真实模型时用引擎默认模型（`default`）开任务；还没保存过账号设置时重启后重新登录原有登录；
 *   同一登录加了两次并暂停其中排前的那个。
 * - tier：unit(内存设置文件、内存冷却、假的插件 worker；只有账号目录在 mkdtemp 临时目录里创建)。
 *   实测耗时：< 2s。
 */
const h = vi.hoisted(() => ({
  root: '',
  files: new Map<string, unknown>(),
  cooling: {} as Record<string, Record<string, unknown>>,
  status: new Map<string, { state: 'signed-in' | 'signed-out'; identity?: { email?: string }; fingerprint?: string; models?: string[] }>(),
  usage: new Map<string, { updatedAt: number; windows?: Array<{ label: string; remainingPercent: number; resetsAt?: number; windowMinutes?: number }> } | null>(),
  login: vi.fn(),
  harnesses: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner-a:1',
  isAppSessionBoundaryPending: () => false,
  getActiveAppSession: () => ({ dataOwnerId: 'owner-a' }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(h.root, ...parts),
}));
vi.mock('../../maker-host/logger-adapter.js', () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger };
  return { desktopMakerLogger: logger };
});
vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: <T,>(options: { filePath: () => string; defaults: T; normalize: (raw: unknown) => T }) => {
    const read = (): T => options.normalize(h.files.get(options.filePath()) ?? structuredClone(options.defaults));
    return {
      read,
      invalidateIfChanged() {},
      async updateAtomic(updater: (state: { value: T }) => Partial<T> | null) {
        const value = read();
        const patch = updater({ value });
        if (patch) h.files.set(options.filePath(), options.normalize({ ...value, ...patch }));
        return read();
      },
    };
  },
}));
vi.mock('../../provider-group/coolingStore.js', () => ({
  readPluginEngineAccountCooling: () => h.cooling,
  writePluginEngineAccountCooling: async (next: Record<string, Record<string, unknown>>) => {
    for (const [engine, members] of Object.entries(next)) h.cooling[engine] = { ...h.cooling[engine], ...members };
  },
  clearPluginEngineAccountCooling: async () => undefined,
}));
vi.mock('../../cindy-brain/pluginHarnesses.js', () => ({
  getPluginHarnessRegistry: () => ({ list: () => h.harnesses }),
  readPluginHarnessAccountStatus: async (_key: string, dir?: string) => h.status.get(dir ? path.basename(dir) : 'default') ?? null,
  readPluginHarnessUsage: async (_key: string, dir?: string) => h.usage.get(dir ? path.basename(dir) : 'default') ?? null,
  loginPluginHarnessAccount: h.login,
  cancelPluginHarnessAccountLogin: async () => undefined,
}));

const {
  acquirePluginEngineAccount,
  readPluginEnginePoolAccountUsages,
  readPluginEngineTaskUsage,
  readPluginEngineSessionAccount,
  runPluginEngineAccountCommand,
  resetPluginEngineAccountsRuntimeForTests,
} = await import('../runtime.js');
const { withPluginEngineAccounts } = await import('../agent.js');
const { canSwitchPluginEngineTaskAccount, preparePluginEngineAccountForSend } = await import('../failover.js');
const { updatePluginEnginePool, readPluginEngineBinding, readPluginEnginePool, writePluginEngineBindings } = await import('../store.js');

const ENGINE = 'dsh-plugin:dsh';
const PROVIDER = `acp-plugin:${ENGINE}`;
// Account ids carry the Cindy account's prefix, as newly added ones do.
const OWNER_PREFIX = createHash('sha256').update('owner-a').digest('hex').slice(0, 12);
const A = `cindy-${OWNER_PREFIX}-00000000-0000-4000-8000-00000000000a`;
const B = `cindy-${OWNER_PREFIX}-00000000-0000-4000-8000-00000000000b`;

afterAll(() => {
  if (h.root) rmSync(h.root, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!h.root) h.root = mkdtempSync(path.join(tmpdir(), 'plugin-engine-accounts-'));
  h.files.clear();
  h.cooling = {};
  h.status.clear();
  h.login.mockReset();
  h.harnesses = [{ key: ENGINE, ghostId: 'dsh-plugin', harnessId: 'dsh', name: 'DSH', protocol: 'acp',
    availability: { state: 'available' }, accounts: { methods: [{ id: 'api-key', label: 'API Key', kind: 'secret' }] } }];
  resetPluginEngineAccountsRuntimeForTests();
  h.status.set('default', { state: 'signed-out' });
  h.status.set(A, { state: 'signed-in', identity: { email: 'a@example.com' } });
  h.status.set(B, { state: 'signed-in', identity: { email: 'b@example.com' } });
  await updatePluginEnginePool(ENGINE, pool => ({
    ...pool,
    accounts: [...pool.accounts, { id: A, paused: false, limit: 4, weight: 1 }, { id: B, paused: false, limit: 4, weight: 1 }],
  }));
});

describe('plugin engine account pool', () => {
  // Unit #13748: the same original id can name a host task and a borrowed-engine task.
  // The paused original login, both bindings and the unassigned fallback have observable quotas.
  it('reads the bound plugin account quota for host and borrowed tasks', async () => {
    h.harnesses[0]!.reportsUsage = true;
    const hosted = hostSessionIdFor('desk', 'same-id');
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool, accounts: pool.accounts.map(account => account.id === 'default' ? { ...account, paused: true } : account),
    }));
    for (const [id, remainingPercent] of [['default', 66], [A, 73], [B, 98]] as const) {
      h.usage.set(id, { updatedAt: 1234, windows: [{ label: 'Quota', remainingPercent }] });
    }
    await writePluginEngineBindings(ENGINE, ['task:same-id'], A, PROVIDER);
    await writePluginEngineBindings(ENGINE, [`task:${hosted}`], B, PROVIDER);
    const read = (id: string) => readPluginEngineTaskUsage(ENGINE, id, { fallbackToOriginal: true });
    expect(await read('same-id')).toEqual(h.usage.get(A));
    expect(await read(hosted)).toEqual(h.usage.get(B));
    expect(await read(hostSessionIdFor('other', 'same-id'))).toEqual(h.usage.get('default'));
    expect(await readPluginEngineTaskUsage(ENGINE, 'unassigned')).toBeNull();
  });

  it('spreads new tasks over signed-in accounts, keeps a bound task on its account and stops at the limit', async () => {
    const first = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t1']);
    const second = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t2']);
    expect(new Set([first!.accountId, second!.accountId])).toEqual(new Set([A, B]));
    expect(first!.accountDir).toBe(path.join(h.root, 'plugin-engine-accounts', 'dsh-plugin', 'dsh', first!.accountId));
    await first!.bind(['task:t1']);
    const again = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t1'], { resuming: true });
    expect(again).toMatchObject({ accountId: first!.accountId, pinned: true });
    again!.release();

    // Both accounts at a limit of one: a new task is refused instead of overloading one of them.
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool, accounts: pool.accounts.map(account => ({ ...account, limit: 1, limitSet: true as const })),
    }));
    await expect(acquirePluginEngineAccount(PROVIDER, undefined, ['task:t3'])).rejects.toThrow('SUBSCRIPTION_ACCOUNTS_FULL');
    second!.release();
    const third = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t3']);
    expect(third!.accountId).toBe(second!.accountId);
  });

  it('moves a new task to the next account when its account refuses to start, and cools that account', async () => {
    await updatePluginEnginePool(ENGINE, pool => ({ ...pool, strategy: 'order' }));
    const starts: Array<string | undefined> = [];
    const agent = {
      kind: 'acp',
      async startSession(options: StartSessionOptions): Promise<AgentSessionHandle> {
        const account = options[NATIVE_SUBSCRIPTION_ACCOUNT];
        starts.push(account?.configDir);
        if (account?.configDir.endsWith(A)) {
          throw new AgentStartupStoppedError(new AcpAccountError({ kind: 'usage-limit', resetsAt: Date.now() + 3_600_000 }));
        }
        return { id: 'native-1', events: async function* () {}, close: async () => {} } as unknown as AgentSessionHandle;
      },
    } as unknown as BaseAgent;
    const handle = await withPluginEngineAccounts(agent).startSession({ providerId: PROVIDER, sessionId: 't1', workingDir: '/w' } as StartSessionOptions);
    expect(handle.id).toBe('native-1');
    expect(starts.map(dir => dir && path.basename(dir))).toEqual([A, B]);
    expect(readPluginEngineBinding(ENGINE, 'task:t1')?.accountId).toBe(B);
    expect(Object.keys(h.cooling[ENGINE] ?? {})).toEqual([A]);
    // The cooled account is skipped for the next new task while another account can take it.
    const next = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t2']);
    expect(next!.accountId).toBe(B);
  });

  it('hands a task off before sending when its account is used up or paused, and fails when no account is left', async () => {
    const rebuild = vi.fn(async (_id: string, assertCurrent: () => void) => { assertCurrent(); });
    const deps = {
      readSession: async () => ({ status: 'active', providerId: PROVIDER, agentKind: 'acp', model: null, sdkSessionId: 'native-1' }),
      isRunning: () => false,
      rebuild,
    };
    const lease = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t1']);
    await lease!.bind(['task:t1', 'native:native-1']);
    const from = lease!.accountId;
    lease!.observeFailure({ message: 'used up', usageLimit: true, usageResetAt: Date.now() + 3_600_000 }, undefined, 'run');
    lease!.release();
    expect(await preparePluginEngineAccountForSend('t1', deps)).toBe(true);
    const moved = readPluginEngineBinding(ENGINE, 'task:t1')!.accountId;
    expect(moved).not.toBe(from);
    // The old conversation keeps its own account; only the task moved.
    expect(readPluginEngineBinding(ENGINE, 'native:native-1')?.accountId).toBe(from);
    expect(rebuild).toHaveBeenCalledOnce();

    // Pausing the new account with the other one still cooling: nothing can take the task.
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool, accounts: pool.accounts.map(account => account.id === moved ? { ...account, paused: true } : account),
    }));
    await expect(preparePluginEngineAccountForSend('t1', deps)).rejects.toThrow('No subscription account is available');
  });

  // An idle task's sign-in can lapse after its account was last read (review of #12242). Minimal
  // input: a task bound to a signed-in account that the plugin reports signed out a minute later.
  it('re-reads an idle task account before sending once its last answer is old, and moves the task when it signed out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const deps = {
        readSession: async () => ({ status: 'active', providerId: PROVIDER, agentKind: 'acp', model: null, sdkSessionId: 'native-1' }),
        isRunning: () => false,
        rebuild: async (_id: string, assertCurrent: () => void) => { assertCurrent(); },
      };
      const lease = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t1']);
      await lease!.bind(['task:t1', 'native:native-1']);
      lease!.release();
      const from = lease!.accountId;
      h.status.set(from, { state: 'signed-out' });
      // Within the cache period the plugin is not asked again: the task stays.
      expect(await preparePluginEngineAccountForSend('t1', deps)).toBe(false);
      expect(readPluginEngineBinding(ENGINE, 'task:t1')?.accountId).toBe(from);
      vi.setSystemTime(Date.now() + 61_000);
      expect(await preparePluginEngineAccountForSend('t1', deps)).toBe(true);
      expect(readPluginEngineBinding(ENGINE, 'task:t1')?.accountId).not.toBe(from);
    } finally {
      vi.useRealTimers();
    }
  });

  // A re-login must come back as the same account (review of #12242). Minimal input: the plugin
  // answers a re-login of a@example.com with "signed in" and no identity.
  it('keeps a re-signed-in account out of new tasks until the plugin shows the same identity', async () => {
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool,
      strategy: 'order',
      accounts: pool.accounts.map(account => account.id === A ? { ...account, lastConfirmedIdentity: 'a@example.com' } : account),
    }));
    h.login.mockImplementationOnce(async (_key: string, dir: string) => {
      h.status.set(path.basename(dir), { state: 'signed-in' });
      return { ok: true };
    });
    await expect(runPluginEngineAccountCommand({ action: 'login', providerId: PROVIDER, accountId: A, loginKey: 'k1', methodId: 'api-key', secret: 'sk-a' }))
      .rejects.toThrow('account_mismatch');
    const elsewhere = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t1']);
    expect(elsewhere!.accountId).toBe(B);
    elsewhere!.release();

    h.login.mockImplementationOnce(async (_key: string, dir: string) => {
      h.status.set(path.basename(dir), { state: 'signed-in', identity: { email: 'A@example.com' } });
      return { ok: true };
    });
    await runPluginEngineAccountCommand({ action: 'login', providerId: PROVIDER, accountId: A, loginKey: 'k2', methodId: 'api-key', secret: 'sk-a' });
    expect((await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t2']))!.accountId).toBe(A);
  });

  it('adds an account only after the plugin signs it in, and leaves nothing behind when the sign-in fails', async () => {
    h.login.mockImplementationOnce(async (_key: string, dir: string, methodId: string, secret?: string) => {
      expect([methodId, secret]).toEqual(['api-key', 'sk-test']);
      h.status.set(path.basename(dir), { state: 'signed-in', identity: { email: 'c@example.com' } });
      return { ok: true };
    });
    const added = await runPluginEngineAccountCommand({ action: 'add', providerId: PROVIDER, loginKey: 'k1', methodId: 'api-key', secret: 'sk-test' });
    expect(added.accounts.map(account => account.identity)).toEqual([undefined, 'a@example.com', 'b@example.com', 'c@example.com']);
    expect(added.pluginEngine?.methods.map(method => method.id)).toEqual(['api-key']);

    h.login.mockResolvedValueOnce({ ok: false, error: 'invalid-secret' });
    await expect(runPluginEngineAccountCommand({ action: 'add', providerId: PROVIDER, loginKey: 'k2', methodId: 'api-key', secret: 'bad' }))
      .rejects.toThrow('login_failed');
    const after = await runPluginEngineAccountCommand({ action: 'read', providerId: PROVIDER });
    expect(after.accounts).toHaveLength(4);
  });

  // Review of #12242: before any account setting is saved, the original login's identity was not
  // kept, so after a restart its re-login accepted anyone. Minimal input: no saved pool, the original
  // login read once as me@example.com, Cindy restarted, then re-signed in as other@example.com.
  it('keeps the original login identity before any account setting is saved, and checks its re-login against it', async () => {
    h.files.clear();
    h.status.set('default', { state: 'signed-in', identity: { email: 'me@example.com' } });
    await runPluginEngineAccountCommand({ action: 'read', providerId: PROVIDER });
    await vi.waitFor(() => expect(readPluginEnginePool(ENGINE)?.accounts.find(account => account.id === 'default')?.lastConfirmedIdentity)
      .toBe('me@example.com'));
    resetPluginEngineAccountsRuntimeForTests();
    h.login.mockImplementationOnce(async (_key: string, dir: string | undefined) => {
      h.status.set(dir ? path.basename(dir) : 'default', { state: 'signed-in', identity: { email: 'other@example.com' } });
      return { ok: true };
    });
    await expect(runPluginEngineAccountCommand({ action: 'login', providerId: PROVIDER, accountId: 'default', loginKey: 'k1', methodId: 'api-key', secret: 'sk' }))
      .rejects.toThrow('account_mismatch');
  });

  // Review of #12242: a task of a taken-out provider merged back keeps that provider as its route, so
  // the handoff must bind through it. Minimal input: task on S bound to A, S merged back, A paused.
  it('keeps a handed-off task on its new account when its taken-out provider was merged back', async () => {
    const S = `${PROVIDER}~ab12cd34`;
    await updatePluginEnginePool(ENGINE, pool => ({ ...pool, providers: { ab12cd34: { strategy: 'expiring' } }, placement: { [A]: 'ab12cd34' } }));
    const lease = await acquirePluginEngineAccount(S, undefined, ['task:t1']);
    expect(lease!.accountId).toBe(A);
    await lease!.bind(['task:t1', 'native:native-1']);
    lease!.release();
    await updatePluginEnginePool(ENGINE, pool => ({
      strategy: pool.strategy,
      accounts: pool.accounts.map(account => account.id === A ? { ...account, paused: true } : account),
    }));
    const deps = {
      readSession: async () => ({ status: 'active', providerId: S, agentKind: 'acp', model: null, sdkSessionId: 'native-1' }),
      isRunning: () => false,
      rebuild: async (_id: string, assertCurrent: () => void) => { assertCurrent(); },
    };
    expect(await preparePluginEngineAccountForSend('t1', deps)).toBe(true);
    const next = await acquirePluginEngineAccount(S, undefined, ['task:t1'], { resuming: false });
    expect(next).toMatchObject({ accountId: B, pinned: true });
  });

  // Review of #12242: the same login added twice counts once, and pausing the first of its directories
  // left none to take tasks. Minimal input: A and B report one fingerprint, A paused; then both on.
  it('lets the other directory of a login added twice take tasks when one is paused, and counts their load once', async () => {
    h.status.set(A, { state: 'signed-in', identity: { email: 'a@example.com' }, fingerprint: 'same-login' });
    h.status.set(B, { state: 'signed-in', identity: { email: 'a@example.com' }, fingerprint: 'same-login' });
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool, accounts: pool.accounts.map(account => account.id === A ? { ...account, paused: true } : account),
    }));
    const lease = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t1']);
    expect(lease!.accountId).toBe(B);
    // Both on, each limited to one task: the login runs one task, whichever directory took it.
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool, accounts: pool.accounts.map(account => ({ ...account, paused: false, limit: 1, limitSet: true as const })),
    }));
    await expect(acquirePluginEngineAccount(PROVIDER, undefined, ['task:t2'])).rejects.toThrow('SUBSCRIPTION_ACCOUNTS_FULL');
  });

  // Review of #12242: `default` asks for the engine's own starting model, so accounts that list their
  // real models must still take it. Minimal input: each account lists one model, none named `default`.
  it('starts the engine default model on accounts that list their own models, and matches named models', async () => {
    h.status.set(A, { state: 'signed-in', identity: { email: 'a@example.com' }, models: ['deepseek-chat'] });
    h.status.set(B, { state: 'signed-in', identity: { email: 'b@example.com' }, models: ['deepseek-reasoner'] });
    const lease = await acquirePluginEngineAccount(PROVIDER, 'default', ['task:t1']);
    expect([A, B]).toContain(lease!.accountId);
    lease!.release();
    expect((await acquirePluginEngineAccount(PROVIDER, 'deepseek-reasoner', ['task:t2']))!.accountId).toBe(B);
  });

  // ZCode reports nothing for an original login that runs on other providers: it kept starting tasks
  // before the plugin had accounts and must keep doing so. Minimal input: only the original login,
  // with no status from the plugin.
  it('keeps the original login taking tasks when the plugin cannot report it', async () => {
    await updatePluginEnginePool(ENGINE, pool => ({ ...pool, accounts: pool.accounts.filter(account => account.id === 'default') }));
    h.status.delete('default');
    const lease = await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t1']);
    expect(lease).toMatchObject({ accountId: 'default', accountDir: undefined });
  });

  it('leaves engines whose plugin does not keep accounts apart to start as before', async () => {
    h.harnesses = [{ ...h.harnesses[0], accounts: { methods: [] } }];
    expect(await acquirePluginEngineAccount(PROVIDER, undefined, ['task:t1'])).toBeNull();
  });

  // Unit regression (provider-sharing.md): shared plugin engines (e.g. Antigravity) read only
  // assignable signed-in accounts' usage without exposing account identities or directories,
  // and distinguish non-reporting engines (`unsupported`) from unavailable ones (`[]`).
  it('reads assignable signed-in account usages for shared plugin engines without leaking identity', async () => {
    const now = Date.now();
    h.usage.clear();
    h.harnesses = [{ ...h.harnesses[0], reportsUsage: true }];
    h.status.set('default', { state: 'signed-in', identity: { email: 'default@example.com' } });
    h.status.set(A, { state: 'signed-in', identity: { email: 'a@example.com' } });
    h.status.set(B, { state: 'signed-out', identity: { email: 'b@example.com' } });
    h.usage.set('default', { updatedAt: now, windows: [{ label: 'Gemini Models · weekly', remainingPercent: 80, windowMinutes: 10_080 }] });
    h.usage.set(A, { updatedAt: now, windows: [{ label: 'Gemini Models · weekly', remainingPercent: 50, windowMinutes: 10_080 }] });
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool,
      accounts: pool.accounts.map(account => account.id === 'default' ? { ...account, paused: true } : account),
    }));

    const pooled = await readPluginEnginePoolAccountUsages(PROVIDER);
    expect(pooled).toEqual([{ usage: h.usage.get(A) }]);
    expect(JSON.stringify(pooled)).not.toContain('example.com');

    // Non-pooled (single-account) plugin engine with reportsUsage reads the base engine usage.
    h.harnesses = [{ ...h.harnesses[0], reportsUsage: true, accounts: undefined }];
    expect(await readPluginEnginePoolAccountUsages(PROVIDER)).toEqual([{ usage: h.usage.get('default') }]);

    // Engine without reportsUsage is explicitly unsupported; unavailable engine returns empty.
    h.harnesses = [{ ...h.harnesses[0], reportsUsage: undefined }];
    expect(await readPluginEnginePoolAccountUsages(PROVIDER)).toBe('unsupported');
    h.harnesses = [{ ...h.harnesses[0], reportsUsage: true, availability: { state: 'unavailable' } }];
    expect(await readPluginEnginePoolAccountUsages(PROVIDER)).toEqual([]);
  });

  // 2026-11-28 regression: canSwitchPluginEngineTaskAccount previously only read `task:${id}` inside
  // canSwitchPluginEngineAccount, missing native-only bindings and pre-pool default tasks.
  it('detects immediate switch eligibility for native-only and pre-pool default plugin engine tasks', async () => {
    await writePluginEngineBindings(ENGINE, ['native:native-only'], A, PROVIDER);
    const leaseA = await acquirePluginEngineAccount(PROVIDER, 'gemini-4-neon', ['native:native-only'], { resuming: true });
    leaseA!.observeFailure({ message: 'Individual quota reached', usageLimit: true, usageResetAt: Date.now() + 3_600_000 }, 'gemini-4-neon', 'run');
    leaseA!.release();

    const nativeOnlyRow = { status: 'active', providerId: PROVIDER, agentKind: 'acp', model: 'gemini-4-neon', sdkSessionId: 'native-only' };
    expect(await canSwitchPluginEngineTaskAccount('task-without-task-key', async () => nativeOnlyRow)).toBe(true);

    // Pre-pool task with no stored binding falls back to the engine's original login ('default').
    resetPluginEngineAccountsRuntimeForTests();
    h.status.set('default', { state: 'signed-in', identity: { email: 'orig@example.com' } });
    await writePluginEngineBindings(ENGINE, ['native:pre-pool-temp'], 'default', PROVIDER);
    const pinnedDefault = await acquirePluginEngineAccount(PROVIDER, 'gemini-4-neon', ['native:pre-pool-temp'], { resuming: true });
    pinnedDefault!.observeFailure({ message: 'Individual quota reached', usageLimit: true, usageResetAt: Date.now() + 3_600_000 }, 'gemini-4-neon', 'run');
    pinnedDefault!.release();
    const prePoolRow = { status: 'active', providerId: PROVIDER, agentKind: 'acp', model: 'gemini-4-neon', sdkSessionId: 'unbound-pre-pool' };
    expect(await canSwitchPluginEngineTaskAccount('pre-pool-task', async () => prePoolRow)).toBe(true);
  });

  // 2026-11-28 (subscription-account-pools.md): same-account remote Agent plugin engine tasks fail
  // over via the executing computer's session-account probe, even when the controller has no local pool.
  it('hands off same-account remote Agent plugin engine tasks when blocked, paused, or removed, and degrades safely', async () => {
    await writePluginEngineBindings(ENGINE, ['native:remote-native-1'], A, PROVIDER);
    const leaseA = await acquirePluginEngineAccount(PROVIDER, 'gemini-4-neon', ['native:remote-native-1'], { resuming: true });
    leaseA!.observeFailure({ message: 'Individual quota reached', usageLimit: true, usageResetAt: Date.now() + 3_600_000 }, 'gemini-4-neon', 'run');
    leaseA!.release();

    let remoteOffered = true;
    const executorHarnesses = [...h.harnesses];
    const invokeRemote = vi.fn(async (_deviceId: string, _channel: string, args: unknown[]) => {
      const query = args[0] as { providerId: string; nativeSessionId?: string; model?: string };
      // Simulate the executing computer having the plugin pool while the controller does not.
      const prev = h.harnesses;
      h.harnesses = executorHarnesses;
      try {
        const result = await readPluginEngineSessionAccount(query.providerId, query, {
          remote: true,
          ownComputer: true,
          isRemoteOffered: () => remoteOffered,
        });
        return { ok: true, result };
      } finally {
        h.harnesses = prev;
      }
    });

    // Controller computer has NO local plugin engine installed.
    h.harnesses = [];
    const remoteRow = {
      status: 'active',
      providerId: PROVIDER,
      agentKind: 'acp',
      model: 'gemini-4-neon',
      sdkSessionId: 'remote-native-1',
      agentDeviceId: 'own-mac-mini',
    };
    const rebuild = vi.fn(async (_id: string, assertCurrent: () => void) => { assertCurrent(); });
    const deps = { readSession: async () => remoteRow, isRunning: () => false, rebuild, invokeRemote };

    // 1. Blocked on executor with B healthy -> immediate switch & pre-send rebuild; no identity leaked.
    expect(await canSwitchPluginEngineTaskAccount('remote-t1', deps.readSession, invokeRemote)).toBe(true);
    const firstReply = await invokeRemote.mock.results[0].value;
    expect(JSON.stringify(firstReply.result)).not.toContain('example.com');
    expect(await preparePluginEngineAccountForSend('remote-t1', deps)).toBe(true);
    expect(rebuild).toHaveBeenCalledOnce();

    // 2. Remote offering turned off on executor -> fails closed, does not touch context.
    remoteOffered = false;
    expect(await canSwitchPluginEngineTaskAccount('remote-t1', deps.readSession, invokeRemote)).toBe(false);
    expect(await preparePluginEngineAccountForSend('remote-t1', deps)).toBe(false);
    expect(rebuild).toHaveBeenCalledOnce();
    remoteOffered = true;

    // 3. Account A removed on executor with B paused -> no replacement, explicit failure without rebuild.
    h.harnesses = executorHarnesses;
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool,
      accounts: pool.accounts
        .filter(account => account.id !== A)
        .map(account => account.id === B ? { ...account, paused: true } : account),
    }));
    h.harnesses = [];
    expect(await canSwitchPluginEngineTaskAccount('remote-t1', deps.readSession, invokeRemote)).toBe(false);
    await expect(preparePluginEngineAccountForSend('remote-t1', deps)).rejects.toThrow('No subscription account is available');
    expect(rebuild).toHaveBeenCalledOnce();

    // 4. Unpause B -> removed A hands off cleanly to B.
    h.harnesses = executorHarnesses;
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool,
      accounts: pool.accounts.map(account => account.id === B ? { ...account, paused: false } : account),
    }));
    h.harnesses = [];
    expect(await preparePluginEngineAccountForSend('remote-t1', deps)).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(2);

    // 5. Provider-share guest, SSH remote host, and older executor (ok: false) never trigger handoff.
    const guestRow = { ...remoteRow, agentDeviceId: 'share:share-1' };
    const sshRow = { ...remoteRow, agentDeviceId: null, remoteHostId: 'ssh-host' };
    expect(await preparePluginEngineAccountForSend('guest-t', { ...deps, readSession: async () => guestRow })).toBe(false);
    expect(await preparePluginEngineAccountForSend('ssh-t', { ...deps, readSession: async () => sshRow })).toBe(false);
    const oldHostInvoke = vi.fn(async () => ({ ok: false }));
    expect(await canSwitchPluginEngineTaskAccount('remote-t1', deps.readSession, oldHostInvoke)).toBe(false);
    expect(await preparePluginEngineAccountForSend('remote-t1', { ...deps, invokeRemote: oldHostInvoke })).toBe(false);
  });

  // The remote probe and fresh start must choose from the same provider as the bound account.
  // Moving A out while leaving B on the original route is the smallest false-positive case.
  it('probes the bound account provider before a remote handoff', async () => {
    await writePluginEngineBindings(ENGINE, ['task:remote-t1'], A, PROVIDER);
    await updatePluginEnginePool(ENGINE, pool => ({
      ...pool,
      providers: { ab12cd34: { strategy: 'order' } },
      placement: { [A]: 'ab12cd34' },
      accounts: pool.accounts.map(account => account.id === A ? { ...account, paused: true } : account),
    }));
    const keys = { sessionId: 'remote-t1', model: 'gemini-4-neon' };
    const options = { remote: true, ownComputer: true, isRemoteOffered: () => true };
    const isolated = await readPluginEngineSessionAccount(PROVIDER, keys, options);
    expect(isolated).toMatchObject({ state: 'bound', account: { paused: true, switchAvailable: false } });
    await expect(acquirePluginEngineAccount(PROVIDER, keys.model, ['task:remote-t1'], { resuming: false }))
      .rejects.toThrow('No subscription account is available');

    // A sibling in the taken-out provider does not make that provider remotely offered.
    await updatePluginEnginePool(ENGINE, pool => ({ ...pool, placement: { [A]: 'ab12cd34', [B]: 'ab12cd34' } }));
    expect(await readPluginEngineSessionAccount(PROVIDER, keys, options))
      .toMatchObject({ state: 'bound', account: { paused: true, switchAvailable: false } });

    // Moving A back to the remotely offered provider makes B selectable on both paths.
    await updatePluginEnginePool(ENGINE, pool => ({ ...pool, placement: {} }));
    const available = await readPluginEngineSessionAccount(PROVIDER, keys, options);
    expect(available).toMatchObject({ state: 'bound', account: { paused: true, switchAvailable: true } });
    const lease = await acquirePluginEngineAccount(PROVIDER, keys.model, ['task:remote-t1'], { resuming: false });
    expect(lease?.accountId).toBe(B);
    lease?.release();
  });
});

// plugin-security-and-authoring.md §5（存量升级无感）＋ provider-groups.md「选择方式」：旧版本存下的选法名字
// (轮询 round、权重 weight、最少占用 least)读进来换成统一后的选法，账号与权重原样保留，用户什么都不用做。
it('reads strategies an older version stored for a plugin engine pool under the unified names', async () => {
  const { normalizePluginEngineAccountsFile } = await import('../store');
  const file = normalizePluginEngineAccountsFile({
    engines: {
      'sample:engine': {
        strategy: 'round',
        accounts: [{ id: 'default', paused: false, limit: 4, weight: 3 }],
        providers: { ab12cd34: { strategy: 'weight' } },
      },
      'other:engine': { strategy: 'least', accounts: [{ id: 'default' }] },
    },
    bindings: {},
  });
  expect(file.engines['sample:engine']).toMatchObject({
    strategy: 'rotate', accounts: [{ id: 'default', weight: 3 }], providers: { ab12cd34: { strategy: 'weighted' } },
  });
  expect(file.engines['other:engine']?.strategy).toBe('expiring');
});
