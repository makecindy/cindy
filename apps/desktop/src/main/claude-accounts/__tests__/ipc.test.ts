/**
 * Claude accounts IPC handlers: the authorization boundary between renderer and main.
 *
 * 测试价值
 * - 生产入口与可观察结果：createClaudeAccountsIpcHandlers 的各 handler；返回给 renderer 的结构
 *   （不含任何路径）、错误码、对 service 的调用与登录取消。
 * - 规则依据：docs/dev-rules/electron-security-and-process-boundaries.md §5（校验 sender 与
 *   payload、错误不带内部路径）；claude-multi-account.md §4。
 * - 现有覆盖缺口：service 测试不经过 IPC 边界。
 * - 最小失败输入：不可信 sender；`../x` 账号 id；超长 label；无数据 owner；删除主账号。
 * - tier：unit（假 service、假 sender 校验）。
 */
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeAccountsIpcHandlers, type ClaudeAccountsIpcDeps } from '../ipc.js';
import { ClaudeAccountRegistryError } from '../registry.js';
import type { ClaudeAccountsService } from '../service.js';
import type { MissionSnapshot } from '../handoff.js';

const event = {} as IpcMainInvokeEvent;
const PROFILE = 'C:\\Users\\me\\AppData\\Roaming\\Cindy\\owners\\abc\\claude-accounts\\acct_work0001';

function fakeService(): ClaudeAccountsService {
  return {
    listAccounts: vi.fn(async () => ({
      version: 1 as const,
      activeAccountId: 'acct_work0001',
      accounts: [
        { id: 'master', kind: 'master' as const, label: 'Master', createdAt: 1, identity: { email: 'me@example.com' } },
        { id: 'acct_work0001', kind: 'extra' as const, label: 'Work', createdAt: 2, lastUsedAt: 5, identity: { email: 'w@example.com', subscriptionType: 'pro' } },
      ],
    })),
    activeAccountEnv: vi.fn(async () => ({})),
    addAccount: vi.fn(async () => ({
      ok: true as const,
      account: { id: 'acct_new00001', kind: 'extra' as const, label: 'New', createdAt: 3, identity: { email: 'n@example.com' } },
    })),
    switchAccount: vi.fn(async () => ({ ok: true as const })),
    removeAccount: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => [
      { accountId: 'master', label: 'Master', login: { loggedIn: true, email: 'me@example.com' } },
      {
        accountId: 'acct_work0001',
        label: 'Work',
        login: { loggedIn: false, error: `spawn failed at ${PROFILE}` },
        profile: {
          profileDir: PROFILE,
          exists: true,
          healthy: false,
          mode: 'linked' as const,
          entries: [
            { name: 'projects', kind: 'dir' as const, state: 'linked' as const },
            { name: 'skills', kind: 'dir' as const, state: 'missing' as const },
            { name: 'CLAUDE.md', kind: 'file' as const, state: 'diverged' as const },
          ],
        },
      },
    ]),
  };
}

function setup(overrides: Partial<ClaudeAccountsIpcDeps> = {}) {
  const service = fakeService();
  const deps: ClaudeAccountsIpcDeps = {
    service: () => service,
    assertTrusted: vi.fn(),
    ownerReady: () => true,
    findTranscript: vi.fn(async () => 'C:\\Users\\me\\.claude\\projects\\p\\sess.jsonl'),
    readSnapshot: vi.fn(async (): Promise<MissionSnapshot> => ({
      goal: 'Ship the login page',
      recentInstructions: [],
      todos: [{ content: 'Write tests', status: 'pending' }],
      filesTouched: ['C:\\proj\\a.ts', 'C:\\proj\\b.ts'],
      recentErrors: [],
      interrupted: { tool: 'Bash', detail: 'pnpm test' },
      contextTokens: 90_000,
      userTurns: 4,
      cwd: 'C:\\proj',
    })),
    ...overrides,
  };
  return { service, deps, handlers: createClaudeAccountsIpcHandlers(deps) };
}

describe('sender and payload validation', () => {
  it('checks the sender before every handler does anything', async () => {
    const { service, deps, handlers } = setup({
      assertTrusted: vi.fn(() => {
        throw new Error('untrusted sender');
      }),
    });
    const calls: Array<() => Promise<unknown>> = [
      () => handlers.list(event),
      () => handlers.add(event, { label: 'X', loginKey: 'k1' }),
      () => handlers.cancelAdd(event, 'k1'),
      () => handlers.switchAccount(event, 'master'),
      () => handlers.remove(event, 'acct_work0001'),
      () => handlers.health(event),
      () => handlers.handoffPreview(event, 'session-1'),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow('untrusted sender');
    expect(service.listAccounts).not.toHaveBeenCalled();
    expect(service.addAccount).not.toHaveBeenCalled();
    expect(service.removeAccount).not.toHaveBeenCalled();
    expect(deps.findTranscript).not.toHaveBeenCalled();
  });

  it.each([
    ['switch', (h: ReturnType<typeof setup>['handlers']) => h.switchAccount(event, '../../etc')],
    ['remove', (h: ReturnType<typeof setup>['handlers']) => h.remove(event, 'acct_UPPER')],
    ['add label', (h: ReturnType<typeof setup>['handlers']) => h.add(event, { label: 'x'.repeat(200), loginKey: 'k' })],
    ['add key', (h: ReturnType<typeof setup>['handlers']) => h.add(event, { label: 'ok', loginKey: 'has space' })],
    ['add shape', (h: ReturnType<typeof setup>['handlers']) => h.add(event, 'not an object')],
    ['session', (h: ReturnType<typeof setup>['handlers']) => h.handoffPreview(event, '')],
  ])('rejects invalid %s payloads with INVALID_PARAMS', async (_name, call) => {
    const { service, handlers } = setup();
    await expect(call(handlers)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(service.switchAccount).not.toHaveBeenCalled();
    expect(service.removeAccount).not.toHaveBeenCalled();
    expect(service.addAccount).not.toHaveBeenCalled();
  });
});

describe('handlers', () => {
  it('lists accounts without any paths, marking the active one', async () => {
    const { handlers } = setup();
    const view = await handlers.list(event);
    expect(view).toEqual({
      activeAccountId: 'acct_work0001',
      accounts: [
        { id: 'master', kind: 'master', label: 'Master', email: 'me@example.com', active: false },
        { id: 'acct_work0001', kind: 'extra', label: 'Work', email: 'w@example.com', subscriptionType: 'pro', lastUsedAt: 5, active: true },
      ],
    });
  });

  it('refuses to add or switch while no data owner is active', async () => {
    const { service, handlers } = setup({ ownerReady: () => false });
    expect(await handlers.add(event, { label: 'X', loginKey: 'k1' })).toEqual({ ok: false, reason: 'no_owner' });
    expect(await handlers.switchAccount(event, 'master')).toEqual({ ok: false, reason: 'no_owner' });
    expect(service.addAccount).not.toHaveBeenCalled();
    expect(service.switchAccount).not.toHaveBeenCalled();
  });

  it('adds an account and lets the same login key cancel it', async () => {
    const { service, handlers } = setup();
    let seen: AbortSignal | undefined;
    vi.mocked(service.addAccount).mockImplementationOnce(async (_input, signal) => {
      seen = signal;
      await handlers.cancelAdd(event, 'other-key');
      expect(signal.aborted).toBe(false);
      await handlers.cancelAdd(event, 'key-1');
      return { ok: false, reason: signal.aborted ? 'login_cancelled' : 'login_failed' };
    });
    expect(await handlers.add(event, { label: '  Work  ', loginKey: 'key-1' })).toEqual({ ok: false, reason: 'login_cancelled' });
    expect(seen?.aborted).toBe(true);
    expect(service.addAccount).toHaveBeenCalledWith({ label: '  Work  ' }, expect.any(AbortSignal));
    expect(await handlers.add(event, { label: 'New', loginKey: 'key-2' })).toEqual({
      ok: true,
      account: { id: 'acct_new00001', kind: 'extra', label: 'New', email: 'n@example.com', active: false },
    });
  });

  it('maps "remove the master" to INVALID_PARAMS and passes other removals through', async () => {
    const { service, handlers } = setup();
    vi.mocked(service.removeAccount).mockRejectedValueOnce(
      new ClaudeAccountRegistryError('master_immutable', 'the master account cannot be removed'),
    );
    await expect(handlers.remove(event, 'master')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(handlers.remove(event, 'acct_work0001')).resolves.toEqual({ ok: true });
    expect(service.removeAccount).toHaveBeenLastCalledWith('acct_work0001');
  });

  it('reports health with entry names and states only — never paths or raw errors', async () => {
    const { handlers } = setup();
    const health = await handlers.health(event);
    expect(health).toEqual([
      { accountId: 'master', label: 'Master', loggedIn: true, email: 'me@example.com' },
      {
        accountId: 'acct_work0001',
        label: 'Work',
        loggedIn: false,
        checkFailed: true,
        profile: {
          healthy: false,
          mode: 'linked',
          problems: [
            { name: 'skills', state: 'missing' },
            { name: 'CLAUDE.md', state: 'diverged' },
          ],
        },
      },
    ]);
    expect(JSON.stringify(health)).not.toMatch(/AppData|Users|claude-accounts/);
  });

  it('previews a handoff from the local transcript, with no paths in the result', async () => {
    const { deps, handlers } = setup();
    const preview = await handlers.handoffPreview(event, 'session-1');
    expect(deps.findTranscript).toHaveBeenCalledWith('session-1');
    expect(preview).toMatchObject({
      available: true,
      recommended: 'brief',
      resumeTokens: 90_000,
      goal: 'Ship the login page',
      userTurns: 4,
      filesTouched: 2,
      interruptedTool: 'Bash',
    });
    if (!preview.available) throw new Error('expected a preview');
    expect(preview.brief).toContain('Ship the login page');
    expect(preview.briefTokens).toBeGreaterThan(0);
  });

  it.each([
    ['not_found', { findTranscript: async () => null }],
    ['not_claude', { findTranscript: async () => 'not_claude' as const }],
    ['unreadable', { readSnapshot: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }],
  ])('reports %s when a preview is not possible', async (reason, overrides) => {
    const { handlers } = setup(overrides as Partial<ClaudeAccountsIpcDeps>);
    expect(await handlers.handoffPreview(event, 'session-1')).toEqual({ available: false, reason });
  });
});
