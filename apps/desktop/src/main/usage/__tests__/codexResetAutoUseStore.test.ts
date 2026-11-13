import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', ownerScopedUserDataPath: () => '/unused' }));
vi.mock('../../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: { child: () => ({ info() {}, warn() {} }) } }));
import { CodexResetAutoUse } from '../codexResetAutoUse';
import { createCodexRateLimitResetService } from '../codexRateLimitReset';
import { UsageLimitAutoResume } from '../../maker-ipc/usageLimitAutoResume';
import { createCodexResetAutoUseStore, codexResetAccountKey } from '../codexResetAutoUseStore';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('reset preferences persistence', () => {
  it('runs persisted preferences through the reset service and resumes a waiting task exactly once', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-reset-integration-')); dirs.push(dir);
    const now = 1_800_000_000_000;
    const store = createCodexResetAutoUseStore(() => path.join(dir, 'settings.json'), () => 'owner');
    const account = codexResetAccountKey('test@example.com', 'workspace');
    await store.write('openai', account, { enabled: true });
    let redeemed = false;
    const consumeRpc = vi.fn(async () => { redeemed = true; return { outcome: 'reset' as const }; });
    const service = createCodexRateLimitResetService({
      now: () => now, createIdempotencyKey: () => '00000000-0000-4000-8000-000000000001',
      readAccountIdentity: async () => ({ email: 'test@example.com', accountId: 'workspace' }),
      readRateLimits: async () => ({
        rateLimits: { secondary: { usedPercent: redeemed ? 0 : 100, windowDurationMins: 10080, resetsAt: now / 1000 + 4 * 86400 } },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: { availableCount: redeemed ? 0 : 1, credits: redeemed ? [] : [{ id: 'one-credit', status: 'available', resetType: 'codexRateLimits', grantedAt: 1, expiresAt: now / 1000 + 86400, title: null, description: null }] },
      }),
      consumeResetCredit: consumeRpc, recordRateLimitSnapshot: async () => {},
    });
    const continueSession = vi.fn(async () => 'resumed' as const);
    let arm!: () => void;
    const armed = new Promise<void>(resolve => { arm = resolve; });
    const waiter = new UsageLimitAutoResume({
      now: () => now, random: () => 0, isEligible: async () => true, resolveResetAt: async () => now + 4 * 86_400_000,
      arm: () => true, isCurrent: () => true, cancel() {}, log() {}, continueSession,
      setTimer: () => { arm(); return 1; }, clearTimer() {},
    });
    waiter.onTurnError('waiting-task', { sdkError: 'rate_limit', message: 'usage limit reached' }, 1);
    await armed;
    const engine = new CodexResetAutoUse({
      now: () => now, scope: () => 'owner',
      read: async () => ({ ...await service.read(), autoUse: store.read('openai', account) }),
      authorized: () => store.read('openai', account).settings.enabled,
      consume: (_provider, key, authorized) => service.consume(key, authorized),
      record: (_provider, _snapshot, at) => store.record('openai', account, at),
      refreshWeb: async () => {},
      restored: async () => { await waiter.resumeRestored(async () => redeemed); }, warn: vi.fn(),
    });
    await Promise.all([engine.check('openai'), engine.check('openai')]);
    expect(consumeRpc).toHaveBeenCalledExactlyOnceWith({ creditId: 'one-credit', idempotencyKey: '00000000-0000-4000-8000-000000000001' });
    expect(continueSession).toHaveBeenCalledOnce();
    expect(store.read('openai', account).lastUsedAt).toBe(now);
    expect((await service.read()).rateLimitResetCredits?.availableCount).toBe(0);
    waiter.dispose();
  });

  it('reopens explicit overrides, binds them to one account and restores defaults', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-reset-settings-')); dirs.push(dir);
    const filename = path.join(dir, 'settings.json');
    const open = () => createCodexResetAutoUseStore(() => filename, () => 'owner');
    const key = codexResetAccountKey('example@example.com', 'workspace');
    const store = open();
    await store.write('openai', key, { enabled: true, minimumDays: 7 });
    expect(JSON.parse(readFileSync(filename, 'utf8')).openai.overrides).toEqual({ enabled: true, minimumDays: 7 });
    expect(open().read('openai', key).settings).toMatchObject({ enabled: true, minimumDays: 7 });
    expect(open().read('openai', codexResetAccountKey('other@example.com', 'other')).settings.enabled).toBe(false);
    await store.record('openai', key, 123);
    expect(open().read('openai', key).lastUsedAt).toBe(123);
    await store.write('openai', key, null);
    expect(open().read('openai', key)).toMatchObject({ customized: false, settings: { enabled: false, minimumDays: 3 } });
    expect(readFileSync(filename, 'utf8')).not.toContain('example@');
  });
  it('preserves sibling updates and rejects invalid settings instead of granting auto-use', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-reset-settings-')); dirs.push(dir);
    const store = createCodexResetAutoUseStore(() => path.join(dir, 'settings.json'), () => 'owner');
    const key = codexResetAccountKey('a@b.com', 'workspace');
    await Promise.all([store.write('openai', key, { enabled: true }), store.write('other', key, { minimumDays: 7 })]);
    expect(store.read('openai', key).settings.enabled).toBe(true);
    expect(store.read('other', key).settings.minimumDays).toBe(7);
    await expect(store.write('openai', key, { minimumDays: -1 })).rejects.toThrow();
    await expect(store.write('openai', key, { lowQuota: false, expiring: false })).rejects.toThrow();
    expect(store.read('openai', key).settings.lowQuota).toBe(true);
  });
});
