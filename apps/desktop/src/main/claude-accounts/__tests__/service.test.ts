/**
 * Claude accounts service: add (log in once), switch, remove, health, active env.
 *
 * Real registry store and real profile linker in a temp dir; only the CLI is faked.
 *
 * 测试价值
 * - 生产入口与可观察结果：createClaudeAccountsService 的公开方法；持久化的账号列表、活动账号、
 *   传给 CLI 的 CLAUDE_CONFIG_DIR、磁盘上的 profile 链接与主账号数据。
 * - 规则依据：docs/dev-rules/claude-multi-account.md §4.1、§4.4、§4.5。
 * - 现有覆盖缺口：registry / linker / env 的单元测试不覆盖登录回滚与切换副作用。
 * - 最小失败输入：登录取消后 profile 残留；切到未登录账号；重复 email；删除活动账号。
 * - tier：unit（临时目录真实文件系统，假 CLI，无网络）。
 */
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClaudeAccountsService, type ClaudeAccountsCli } from '../service.js';
import { MASTER_ACCOUNT_ID } from '../types.js';

type Status = Awaited<ReturnType<ClaudeAccountsCli['probe']>>;

let root: string;
let masterDir: string;
let accountsRoot: string;
let seq: number;
/** Login state per CLAUDE_CONFIG_DIR ('' = master). */
let logins: Map<string, Status>;
let nextLoginEmail: string | null;
let loginOutcome: 'ok' | 'cancelled';

const cli: ClaudeAccountsCli = {
  probe: vi.fn(async (env: Record<string, string>) => logins.get(env.CLAUDE_CONFIG_DIR ?? '') ?? { loggedIn: false }),
  login: vi.fn(async (env: Record<string, string>) => {
    if (loginOutcome === 'cancelled') return { ok: false as const, reason: 'login_cancelled' as const };
    const status: Status = { loggedIn: true, email: nextLoginEmail ?? 'x@example.com', subscriptionType: 'pro' };
    logins.set(env.CLAUDE_CONFIG_DIR ?? '', status);
    return { ok: true as const, status };
  }),
};

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function makeService(onActiveAccountChanged = vi.fn()) {
  const service = createClaudeAccountsService({
    accountsRoot,
    masterDir,
    registryFile: path.join(accountsRoot, 'registry.json'),
    cli,
    onActiveAccountChanged,
    now: () => 1_000,
    newId: () => `acct_svc${String(++seq).padStart(5, '0')}`,
  });
  return { service, onActiveAccountChanged };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-acct-service-'));
  masterDir = path.join(root, 'home', '.claude');
  accountsRoot = path.join(root, 'userData', 'claude-accounts');
  await mkdir(path.join(masterDir, 'projects', 'p'), { recursive: true });
  await writeFile(path.join(masterDir, 'projects', 'p', 's.jsonl'), 'history');
  await writeFile(path.join(masterDir, 'CLAUDE.md'), '# memory');
  seq = 0;
  logins = new Map([['', { loggedIn: true, email: 'me@example.com', subscriptionType: 'pro' }]]);
  nextLoginEmail = 'friend.of.mine@example.com';
  loginOutcome = 'ok';
  vi.mocked(cli.probe).mockClear();
  vi.mocked(cli.login).mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createClaudeAccountsService', () => {
  it('starts with only the master, whose env is the CLI default', async () => {
    const { service } = makeService();
    expect(await service.listAccounts()).toMatchObject({
      activeAccountId: MASTER_ACCOUNT_ID,
      accounts: [{ id: MASTER_ACCOUNT_ID, kind: 'master' }],
    });
    expect(await service.activeAccountEnv()).toEqual({});
  });

  it('adds an account by logging in once inside its own linked profile', async () => {
    const { service, onActiveAccountChanged } = makeService();
    const result = await service.addAccount({ label: 'Second' }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, account: { id: 'acct_svc00001', label: 'Second' } });
    const profileDir = path.join(accountsRoot, 'acct_svc00001');
    expect(cli.login).toHaveBeenCalledWith({ CLAUDE_CONFIG_DIR: profileDir }, expect.any(AbortSignal));
    // The profile already sees the master's history before the first session.
    expect(await readFile(path.join(profileDir, 'projects', 'p', 's.jsonl'), 'utf8')).toBe('history');
    const listed = await makeService().service.listAccounts();
    expect(listed.activeAccountId).toBe(MASTER_ACCOUNT_ID);
    expect(listed.accounts[1]).toMatchObject({
      id: 'acct_svc00001',
      identity: { email: 'friend.of.mine@example.com', subscriptionType: 'pro' },
    });
    expect(onActiveAccountChanged).not.toHaveBeenCalled();
  });

  it('rolls back the profile when login does not finish', async () => {
    loginOutcome = 'cancelled';
    const { service } = makeService();
    expect(await service.addAccount({ label: 'Nope' }, new AbortController().signal)).toEqual({
      ok: false,
      reason: 'login_cancelled',
    });
    expect(await exists(path.join(accountsRoot, 'acct_svc00001'))).toBe(false);
    expect((await service.listAccounts()).accounts).toHaveLength(1);
    expect(await readFile(path.join(masterDir, 'CLAUDE.md'), 'utf8')).toBe('# memory');
  });

  it('rejects logging in with an account that is already added (including the master)', async () => {
    nextLoginEmail = 'ME@example.com';
    const { service } = makeService();
    expect(await service.addAccount({ label: 'Dup' }, new AbortController().signal)).toEqual({
      ok: false,
      reason: 'duplicate_identity',
    });
    expect(await exists(path.join(accountsRoot, 'acct_svc00001'))).toBe(false);
  });

  it('rejects an invalid label before starting any login', async () => {
    const { service } = makeService();
    expect(await service.addAccount({ label: '   ' }, new AbortController().signal)).toEqual({
      ok: false,
      reason: 'invalid_label',
    });
    expect(cli.login).not.toHaveBeenCalled();
  });

  it('switches without logging in again and reports the change once', async () => {
    const { service, onActiveAccountChanged } = makeService();
    await service.addAccount({ label: 'Second' }, new AbortController().signal);
    vi.mocked(cli.login).mockClear();
    expect(await service.switchAccount('acct_svc00001')).toEqual({ ok: true });
    expect(cli.login).not.toHaveBeenCalled();
    expect(onActiveAccountChanged).toHaveBeenCalledOnce();
    expect(onActiveAccountChanged).toHaveBeenCalledWith({ previousId: MASTER_ACCOUNT_ID, nextId: 'acct_svc00001' });
    expect(await service.activeAccountEnv()).toEqual({ CLAUDE_CONFIG_DIR: path.join(accountsRoot, 'acct_svc00001') });
    // Persisted: a fresh service (app restart) keeps the choice.
    expect((await makeService().service.listAccounts()).activeAccountId).toBe('acct_svc00001');
    // Switching to the account that is already active is a no-op.
    expect(await service.switchAccount('acct_svc00001')).toEqual({ ok: true });
    expect(onActiveAccountChanged).toHaveBeenCalledOnce();
  });

  it('refuses to switch to an account that is logged out or unknown', async () => {
    const { service, onActiveAccountChanged } = makeService();
    await service.addAccount({ label: 'Second' }, new AbortController().signal);
    logins.delete(path.join(accountsRoot, 'acct_svc00001'));
    expect(await service.switchAccount('acct_svc00001')).toEqual({ ok: false, reason: 'not_logged_in' });
    expect(await service.switchAccount('acct_nothere1')).toEqual({ ok: false, reason: 'unknown_account' });
    expect((await service.listAccounts()).activeAccountId).toBe(MASTER_ACCOUNT_ID);
    expect(onActiveAccountChanged).not.toHaveBeenCalled();
  });

  it('removing the active account falls back to master and keeps master data', async () => {
    const { service, onActiveAccountChanged } = makeService();
    await service.addAccount({ label: 'Second' }, new AbortController().signal);
    await service.switchAccount('acct_svc00001');
    onActiveAccountChanged.mockClear();
    await service.removeAccount('acct_svc00001');
    expect(onActiveAccountChanged).toHaveBeenCalledWith({ previousId: 'acct_svc00001', nextId: MASTER_ACCOUNT_ID });
    expect(await exists(path.join(accountsRoot, 'acct_svc00001'))).toBe(false);
    expect(await readFile(path.join(masterDir, 'projects', 'p', 's.jsonl'), 'utf8')).toBe('history');
    expect(await service.activeAccountEnv()).toEqual({});
    await expect(service.removeAccount(MASTER_ACCOUNT_ID)).rejects.toMatchObject({ code: 'master_immutable' });
  });

  it('blocks the active env when the profile cannot be prepared', async () => {
    const { service } = makeService();
    await service.addAccount({ label: 'Second' }, new AbortController().signal);
    await service.switchAccount('acct_svc00001');
    const profileDir = path.join(accountsRoot, 'acct_svc00001');
    await rm(profileDir, { recursive: true, force: true });
    await writeFile(profileDir, 'a file where the profile dir should be');
    await expect(service.activeAccountEnv()).rejects.toMatchObject({
      name: 'ClaudeAccountEnvError',
      code: 'profile_unavailable',
    });
  });

  it('serialises concurrent adds so neither is lost', async () => {
    const { service } = makeService();
    nextLoginEmail = null;
    let n = 0;
    vi.mocked(cli.login).mockImplementation(async (env) => {
      const status = { loggedIn: true, email: `user${++n}@example.com` };
      logins.set(env.CLAUDE_CONFIG_DIR ?? '', status);
      return { ok: true as const, status };
    });
    await Promise.all([
      service.addAccount({ label: 'A' }, new AbortController().signal),
      service.addAccount({ label: 'B' }, new AbortController().signal),
    ]);
    expect((await makeService().service.listAccounts()).accounts.map((a) => a.label)).toEqual(['Master', 'A', 'B']);
  });

  it('reports health for every account without repairing anything', async () => {
    const { service } = makeService();
    await service.addAccount({ label: 'Second' }, new AbortController().signal);
    await rm(path.join(accountsRoot, 'acct_svc00001', 'skills'));
    const health = await service.checkHealth();
    expect(health.map((h) => [h.accountId, h.login.loggedIn])).toEqual([
      [MASTER_ACCOUNT_ID, true],
      ['acct_svc00001', true],
    ]);
    expect(health[0]!.profile).toBeUndefined();
    expect(health[1]!.profile?.healthy).toBe(false);
    expect(await exists(path.join(accountsRoot, 'acct_svc00001', 'skills'))).toBe(false);
  });
});
