import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  getCurrentDbClientUserId: vi.fn(() => 'user-a' as string | null),
  electronAppGetPath: vi.fn(() => ''),
}));

vi.mock('electron', () => ({
  app: { getPath: mocks.electronAppGetPath },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientUserId: mocks.getCurrentDbClientUserId,
}));

import {
  __resetAccountCurrencyStoreForTesting,
  hydrateAccountCurrency,
  noteActiveAccount,
  rememberAccountCurrency,
} from '../accountCurrencyStore';
import {
  __resetActiveLedgerCurrencyForTesting,
  currentLedgerCurrency,
  isLedgerCurrencyKnown,
} from '../ledgerCurrency';

let tempUserDataDir: string | null = null;

function storeFile(): string {
  if (!tempUserDataDir) throw new Error('temp userData is not initialized');
  return path.join(tempUserDataDir, 'cache', 'ledger-currency.json');
}

async function writeStore(entries: Record<string, string>): Promise<void> {
  const file = storeFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, entries }), 'utf8');
}

/** 等 rememberAccountCurrency 的串行写链跑完（它是 fire-and-forget）。 */
async function flushWrites(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(async () => {
  tempUserDataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-ledger-currency-'));
  mocks.electronAppGetPath.mockReturnValue(tempUserDataDir);
  mocks.getCurrentDbClientUserId.mockReturnValue('user-a');
  __resetAccountCurrencyStoreForTesting();
  __resetActiveLedgerCurrencyForTesting();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempUserDataDir) {
    await rm(tempUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempUserDataDir = null;
  }
});

describe('hydrate across an account switch', () => {
  // 不变量：跨越 await 的账号相关写入，只有在这段 await 期间**账号身份一次都没变过**
  // 时才允许提交。
  //
  // 判据必须是账号代际号而不是「当前 userId 是否还等于发起时的 userId」——后者挡得住
  // A→B，挡不住 A→B→A：切回来之后 userId 重新相等，一份在 B 期间就已过期的读取结果
  // 会被当成有效值写进 lastKnown。
  //
  // 表驱动交错序列而不是逐条孤立用例：ABA 与 ABCA 两行对「只比 userId」的实现必然
  // 失败，「期间重复 note 同一账号」一行则对「每次 note 都递增代际」的实现失败 ——
  // 两个方向都能把错误修法区分出来。
  const interleavings: Array<{ name: string; during: string[]; committed: boolean }> = [
    { name: '期间无任何账号事件', during: [], committed: true },
    { name: '期间重复 note 同一账号', during: ['user-a', 'user-a'], committed: true },
    { name: '切走未回 (A→B)', during: ['user-b'], committed: false },
    { name: '切走又切回 (A→B→A)', during: ['user-b', 'user-a'], committed: false },
    { name: '绕一圈再回 (A→B→C→A)', during: ['user-b', 'user-c', 'user-a'], committed: false },
  ];

  for (const { name, during, committed } of interleavings) {
    it(`${committed ? 'commits' : 'discards'} the hydrate — ${name}`, async () => {
      await writeStore({ 'user-a': 'CNY', 'user-b': 'USD', 'user-c': 'USD' });

      const pending = hydrateAccountCurrency('user-a');
      // await 期间的账号事件（真实链路里是 replaceGatewayModelPricing 的同步 noteActiveAccount）。
      for (const userId of during) noteActiveAccount(userId);

      await expect(pending).resolves.toBe(committed ? 'CNY' : null);
      if (committed) {
        expect(currentLedgerCurrency()).toBe('CNY');
      } else {
        // 丢弃时绝不能把 A 的币种留在账本上，回退链要回到「上次已知 → USD」。
        expect(isLedgerCurrencyKnown()).toBe(false);
        expect(currentLedgerCurrency()).toBe('USD');
      }
    });
  }

  it('hydrates normally when the account stays put', async () => {
    await writeStore({ 'user-a': 'CNY' });
    await expect(hydrateAccountCurrency('user-a')).resolves.toBe('CNY');
    expect(currentLedgerCurrency()).toBe('CNY');
  });

  it('drops the previous account currency on switch', async () => {
    await writeStore({ 'user-a': 'CNY' });
    await hydrateAccountCurrency('user-a');
    expect(currentLedgerCurrency()).toBe('CNY');

    noteActiveAccount('user-b');
    expect(isLedgerCurrencyKnown()).toBe(false);
    expect(currentLedgerCurrency()).toBe('USD');
  });

  it('returns null without touching the ledger when no user is known', async () => {
    mocks.getCurrentDbClientUserId.mockReturnValue(null);
    await expect(hydrateAccountCurrency()).resolves.toBeNull();
    expect(isLedgerCurrencyKnown()).toBe(false);
  });
});

describe('persistence durability', () => {
  it('writes atomically and leaves no temp file behind', async () => {
    // 直接覆盖写会在崩溃 / 断电时留下截断 JSON，readEntries 解析失败后把 entries 当空，
    // 整份币种快照丢失 —— 冷启动退回兜底币种，正是本 PR 要修的那类错账。
    rememberAccountCurrency('user-a', 'CNY');
    await flushWrites();

    const raw = await readFile(storeFile(), 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 1, entries: { 'user-a': 'CNY' } });

    const leftovers = (await readdir(path.dirname(storeFile()))).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('retries after a transient write failure instead of giving up for the process', async () => {
    // memo 表示「磁盘上是什么」。抢在落位前更新它，会让同值短路把后续同步一并跳过 ——
    // 一次瞬时写失败就变成本进程再也不重试，重启后报价缓存又恰好失效时，CNY 账号会
    // 丢掉这份独立快照并回落 USD。
    const fsp = await import('node:fs/promises');
    const renameSpy = vi
      .spyOn(fsp.default, 'rename')
      .mockRejectedValueOnce(new Error('EBUSY: transient'));

    rememberAccountCurrency('user-a', 'CNY');
    await flushWrites();
    expect(renameSpy).toHaveBeenCalledTimes(1);
    await expect(readFile(storeFile(), 'utf8').catch(() => null)).resolves.toBeNull();

    // 同一账号同一币种再来一次：不能被同值短路吃掉。
    renameSpy.mockRestore();
    rememberAccountCurrency('user-a', 'CNY');
    await flushWrites();
    expect(JSON.parse(await readFile(storeFile(), 'utf8')).entries).toEqual({
      'user-a': 'CNY',
    });
  });

  it('keeps other accounts when appending a new one', async () => {
    await writeStore({ 'user-b': 'USD' });
    rememberAccountCurrency('user-a', 'CNY');
    await flushWrites();

    expect(JSON.parse(await readFile(storeFile(), 'utf8')).entries).toEqual({
      'user-b': 'USD',
      'user-a': 'CNY',
    });
  });

  it('treats a truncated store as empty instead of throwing', async () => {
    const file = storeFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"version":1,"entr', 'utf8');

    await expect(hydrateAccountCurrency('user-a')).resolves.toBeNull();
    expect(isLedgerCurrencyKnown()).toBe(false);
  });

  it('ignores a store written by a future version', async () => {
    await mkdir(path.dirname(storeFile()), { recursive: true });
    await writeFile(
      storeFile(),
      JSON.stringify({ version: 99, entries: { 'user-a': 'CNY' } }),
      'utf8',
    );
    await expect(hydrateAccountCurrency('user-a')).resolves.toBeNull();
  });
});
