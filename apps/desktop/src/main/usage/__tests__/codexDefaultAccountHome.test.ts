/**
 * 测试价值
 * - 生产入口与可观察结果：`maker:usage:codex-rate-limits` 的 `openai` 目标由
 *   `createCodexRateLimitResetService(withDetachedDefaultCodexHome(内置目标))` 组成（maker-ipc/usage.ts），
 *   这里用同样的组合读取额度并兑换重置次数，断言返回的额度与兑换落在哪个账号目录。
 * - Bug 依据：2026-11-13 Windows 无建链接权限，Cindy 的 codex-home 没有 auth.json，账号池默认账号在
 *   `~/.codex` 正常运行任务，设置页却一直「ChatGPT 配额更新失败」（`codex not authenticated: no_oauth`）。
 * - 现有覆盖缺口：codexRateLimitReset.test.ts 只用假依赖测重置控制面，没有覆盖内置目标与默认账号目录的选择。
 * - 最小失败输入：账号池含非旧版默认账号；codex-home 无 auth.json；默认账号目录有 auth.json。
 * - tier：unit（真实临时目录 + 进程内假 CLI，不启动 Codex）。
 * - 实测耗时：见交付说明。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  nativeHome: '',
  defaultHome: '',
  pool: null as null | { disconnected?: boolean; legacyCodexDefault?: boolean; accounts: Array<{ id: string; paused: boolean }> },
  rpc: vi.fn(),
  readNativeAccount: vi.fn(),
  readNativeCodexTokens: vi.fn(),
  readPool: vi.fn(),
  credentialCurrent: true,
}));

vi.mock('../../maker-host/codex-home-path.js', () => ({ getCodexHome: () => h.nativeHome }));
vi.mock('../../subscription-accounts/store.js', () => ({
  readPool: h.readPool,
  accountDirectory: () => h.defaultHome,
}));
vi.mock('../../subscription-accounts/nativeCli.js', () => ({
  codexAccountRpc: h.rpc,
  readNativeAccount: h.readNativeAccount,
  // The real token reader parses auth.json; the fake only proves the guard is consulted.
  readNativeCodexTokens: h.readNativeCodexTokens,
}));

import { createCodexRateLimitResetService } from '../codexRateLimitReset.js';
import { detachedDefaultCodexHome, withDetachedDefaultCodexHome } from '../codexDefaultAccountHome.js';

const DEFAULT_LIMITS = {
  rateLimits: { planType: 'pro', primary: { usedPercent: 42, windowDurationMins: 10_080 } },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: { availableCount: 1, credits: null },
};

let root = '';
function native() {
  return {
    readRateLimits: vi.fn(async () => {
      throw new Error('codex not authenticated: no_oauth');
    }),
    consumeResetCredit: vi.fn(async () => ({ outcome: 'reset' as const })),
    readAccountIdentity: vi.fn(async () => ({ email: null, accountId: null })),
    recordRateLimitSnapshot: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cindy-codex-default-home-'));
  h.nativeHome = path.join(root, 'codex-home');
  h.defaultHome = path.join(root, '.codex');
  mkdirSync(h.nativeHome);
  mkdirSync(h.defaultHome);
  writeFileSync(path.join(h.defaultHome, 'auth.json'), '{"tokens":"fake"}');
  h.pool = { accounts: [{ id: 'default', paused: false }, { id: 'cindy-abc-1', paused: false }] };
  h.readPool.mockReset().mockImplementation(() => h.pool);
  h.credentialCurrent = true;
  h.readNativeCodexTokens.mockReset().mockImplementation(async () => ({
    accessToken: 'fake-token', chatgptAccountId: 'workspace-default', canDispatch: () => h.credentialCurrent,
  }));
  h.rpc.mockReset().mockImplementation(async (_home: string, method: string) =>
    method === 'account/rateLimits/read' ? DEFAULT_LIMITS : { outcome: 'reset' });
  h.readNativeAccount.mockReset().mockResolvedValue({ authenticated: true, identity: 'default@example.com' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('built-in Codex quota target of the account pool default account', () => {
  it('reads and redeems on the default account home when the built-in connection has no login', async () => {
    const builtIn = native();
    const service = createCodexRateLimitResetService(withDetachedDefaultCodexHome(builtIn, () => {}));

    const snapshot = await service.read();
    expect(snapshot.rateLimits?.primary?.usedPercent).toBe(42);
    expect(snapshot.account?.email).toBe('de***@example.com');
    expect(builtIn.readRateLimits).not.toHaveBeenCalled();
    // The built-in usage cache is not overwritten by another home's read.
    expect(builtIn.recordRateLimitSnapshot).not.toHaveBeenCalled();

    const result = await service.consume(snapshot.resetOffer!.idempotencyKey);
    expect(result.outcome).toBe('reset');
    expect(h.rpc).toHaveBeenCalledWith(
      h.defaultHome, 'account/rateLimitResetCredit/consume', expect.anything(), expect.any(Function));
    expect(builtIn.consumeResetCredit).not.toHaveBeenCalled();
  });

  it.each([
    ['the built-in connection has its own login', () => writeFileSync(path.join(h.nativeHome, 'auth.json'), '{}')],
    ['the default account is the legacy private home', () => { h.pool = { ...h.pool!, legacyCodexDefault: true }; }],
    ['there is no account pool', () => { h.pool = null; }],
    ['the default account has no login file', () => rmSync(path.join(h.defaultHome, 'auth.json'))],
  ])('keeps the built-in reader when %s', async (_case, arrange) => {
    arrange();
    const builtIn = native();
    const service = createCodexRateLimitResetService(withDetachedDefaultCodexHome(builtIn, () => {}));

    await expect(service.read()).rejects.toThrow('no_oauth');
    expect(builtIn.readRateLimits).toHaveBeenCalledOnce();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('rejects an in-flight read when the built-in connection gets its own login', async () => {
    const builtIn = native();
    const service = createCodexRateLimitResetService(withDetachedDefaultCodexHome(builtIn, () => {}));
    h.rpc.mockImplementationOnce(async () => {
      writeFileSync(path.join(h.nativeHome, 'auth.json'), '{}');
      return DEFAULT_LIMITS;
    });

    await expect(service.read()).rejects.toThrow('ChatGPT account changed');
    expect(builtIn.recordRateLimitSnapshot).not.toHaveBeenCalled();
  });

  it.each(['credential', 'owner', 'pool disconnect', 'default removal', 'built-in login'])
    ('rejects redemption when the %s changes during CLI startup', async (changed) => {
    let ownerCurrent = true;
    const builtIn = native();
    const service = createCodexRateLimitResetService(withDetachedDefaultCodexHome(builtIn, () => {
      if (!ownerCurrent) throw new Error('Account scope changed');
    }));
    const snapshot = await service.read();
    const dispatch = vi.fn();
    h.rpc.mockImplementationOnce(async (_home, _method, _params, canDispatch: () => Promise<boolean>) => {
      if (changed === 'credential') h.credentialCurrent = false;
      else if (changed === 'owner') ownerCurrent = false;
      else if (changed === 'pool disconnect') h.pool = { ...h.pool!, disconnected: true };
      else if (changed === 'default removal') h.pool = { ...h.pool!, accounts: [] };
      else writeFileSync(path.join(h.nativeHome, 'auth.json'), '{}');
      if (!await canDispatch()) throw new Error('Codex account changed before dispatch');
      dispatch();
      return { outcome: 'reset' };
    });

    await expect(service.consume(snapshot.resetOffer!.idempotencyKey)).rejects.toThrow('changed before dispatch');
    expect(dispatch).not.toHaveBeenCalled();
    expect(builtIn.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('rejects a pool revocation that happens while filesystem checks are pending', async () => {
    h.readPool.mockImplementationOnce(() => {
      const pool = h.pool;
      queueMicrotask(() => { h.pool = { ...h.pool!, disconnected: true }; });
      return pool;
    });
    await expect(detachedDefaultCodexHome()).resolves.toBeNull();
  });

  it.each([true, false])('rejects redemption after its verified source changes (default home: %s)', async (defaultHome) => {
    const builtIn = native();
    let selectedHome: string | null = defaultHome ? h.defaultHome : null;
    const target = withDetachedDefaultCodexHome(builtIn, () => {}, async () => selectedHome);
    const identity = await target.readAccountIdentity();
    selectedHome = defaultHome ? null : h.defaultHome;

    await expect(target.consumeResetCredit({ idempotencyKey: 'source-switch' }, identity))
      .rejects.toThrow('ChatGPT account changed');
    expect(h.rpc).not.toHaveBeenCalled();
    expect(builtIn.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('keeps the verified credential proof when a concurrent identity read completes', async () => {
    const builtIn = native();
    const target = withDetachedDefaultCodexHome(builtIn, () => {});
    const verified = await target.readAccountIdentity();
    h.readNativeCodexTokens.mockResolvedValueOnce({
      accessToken: 'another-fake-token', chatgptAccountId: 'workspace-default', canDispatch: () => true,
    });
    await target.readAccountIdentity();
    h.credentialCurrent = false;

    await expect(target.consumeResetCredit({ idempotencyKey: 'concurrent-read' }, verified))
      .rejects.toThrow('ChatGPT account changed');
    expect(h.rpc).not.toHaveBeenCalled();
    expect(builtIn.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('does not cache a default-home snapshot after the built-in connection gets its own login', async () => {
    const builtIn = native();
    const target = withDetachedDefaultCodexHome(builtIn, () => {});
    const identity = await target.readAccountIdentity();
    writeFileSync(path.join(h.nativeHome, 'auth.json'), '{}');

    await target.recordRateLimitSnapshot({ accountId: identity.accountId }, identity);
    expect(builtIn.recordRateLimitSnapshot).not.toHaveBeenCalled();
  });
});
