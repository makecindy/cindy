/**
 * accountCurrencyStore — 账号结算币种的独立持久化。
 *
 * ## 为什么不跟着报价缓存走
 *
 * 结算币种和价格表的稳定性差了一个数量级：价格表随时可能改、随时可能拉不到，
 * 而一个账号的结算币种基本不变。可它此前被塞在 model-pricing.json 的同一份快照里，
 * 于是共享了那份快照的全部失效条件 —— 报价缓存的 scope 含 endpoint 与凭证文件的
 * inode/mtime，凭证轮换、端点切换、冷启动期 userId 尚未就绪都会让整份快照作废，
 * 币种跟着一起变成未知，账本随即回落兜底值。实测这会让同一账号的账本币种一天内
 * 翻转多次。
 *
 * 所以这里单独存一份，scope 只认 userId：凭证轮换与端点变化都不影响它。
 *
 * 按 userId 分桶而不是只存一个值，是因为切号后必须立刻停止沿用上一个账号的币种；
 * userId 未知（冷启动尚未接管、未登录）时既不读也不写 —— 宁可让 ledgerCurrency 走
 * 兜底，也不能把 A 账号的币种记到 B 账号头上。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import type { MoneyCurrency } from '../../shared/regionalMoney.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import {
  hydrateLastKnownLedgerCurrency,
  resetLedgerCurrencyForAccountSwitch,
} from './ledgerCurrency.js';

const log = createLogger('accountCurrencyStore');

const STORE_VERSION = 1;
const STORE_FILE = 'ledger-currency.json';

interface StorePayload {
  version: number;
  entries: Record<string, MoneyCurrency>;
}

let memo: Record<string, MoneyCurrency> | null = null;
let writeChain: Promise<void> = Promise.resolve();
let hydratedUserId: string | null = null;
/**
 * 账号代际。每次活跃账号真正发生变化时 +1，唯一写入者是 noteActiveAccount。
 *
 * 存在的理由是 A→B→A：跨 await 的写入只比较「当前 userId 是否还等于发起时的 userId」
 * 不足以判定期间没换过人 —— 切走又切回会让这个比较重新相等，于是一份在 B 期间就已
 * 过期的读取结果被当成有效值提交。代际号单调递增，切回来也不会复用旧值。
 */
let accountGeneration = 0;

function storePath(): string {
  return path.join(app.getPath('userData'), 'cache', STORE_FILE);
}

function isCurrency(value: unknown): value is MoneyCurrency {
  return value === 'CNY' || value === 'USD';
}

function parseEntries(raw: unknown): Record<string, MoneyCurrency> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const payload = raw as Partial<StorePayload>;
  if (payload.version !== STORE_VERSION) return {};
  if (!payload.entries || typeof payload.entries !== 'object' || Array.isArray(payload.entries)) {
    return {};
  }
  const out: Record<string, MoneyCurrency> = {};
  for (const [userId, currency] of Object.entries(payload.entries)) {
    if (userId && isCurrency(currency)) out[userId] = currency;
  }
  return out;
}

async function readEntries(): Promise<Record<string, MoneyCurrency>> {
  if (memo) return memo;
  try {
    memo = parseEntries(JSON.parse(await fs.readFile(storePath(), 'utf8')));
  } catch (err) {
    const code =
      typeof err === 'object' && err && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code !== 'ENOENT') {
      log.debug('read ledger currency store failed:', err instanceof Error ? err.message : String(err));
    }
    memo = {};
  }
  return memo;
}

/**
 * 记住某账号的结算币种。同值重复写会被跳过，避免每次目录同步都碰盘。
 *
 * 写入串行化：目录同步与登录接管可能几乎同时触发，并发 readEntries + writeFile 会让
 * 后写的整份覆盖先写的，丢掉另一个账号的条目。
 */
export function rememberAccountCurrency(
  userId: string | null | undefined,
  currency: MoneyCurrency | null,
): void {
  if (!userId || !currency) return;
  writeChain = writeChain.then(async () => {
    const entries = await readEntries();
    if (entries[userId] === currency) return;
    const next = { ...entries, [userId]: currency };
    const file = storePath();
    // 写临时文件 + rename 原子落位（同 learn-host/runStore）。直接覆盖写会在崩溃或断电时
    // 留下截断的 JSON，readEntries 解析失败后把 entries 当空 —— 整份币种快照丢失，冷启动
    // 回退链退到 USD 兜底，对 CNY 结算账号就是本 PR 要修的那个错账。
    // tmp 名带 pid + 随机串，避免多进程残留碰撞。
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const payload: StorePayload = { version: STORE_VERSION, entries: next };
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, file);
      // memo 表示「磁盘上是什么」，只在落位成功后才提交。抢先更新会让上面第 96 行的
      // 同值短路把后续同步一并跳过 —— 一次瞬时写失败就变成本进程再也不重试，重启后
      // 报价缓存又恰好失效时，CNY 账号会丢掉这份独立快照并回落 USD。
      memo = next;
      log.info(`ledger currency remembered: user=${userId} currency=${currency}`);
    } catch (err) {
      log.warn(
        'persist ledger currency failed:',
        err instanceof Error ? err.message : String(err),
      );
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  });
}

/**
 * 记录「当前是哪个账号在记账」，账号变了就丢掉内存里的「上次已知」币种。
 *
 * 同步实现，因为目录同步(replaceGatewayModelPricing)是同步路径，必须在它写入
 * setActiveLedgerCurrency 之前就完成账号边界判定 —— 否则新账号目录没声明币种的那一轮
 * 会先按上一个账号的口径记完账。
 */
export function noteActiveAccount(userId: string | null | undefined): void {
  if (!userId) return;
  if (hydratedUserId === userId) return;
  if (hydratedUserId) {
    resetLedgerCurrencyForAccountSwitch();
    log.info(`ledger currency reset for account switch: ${hydratedUserId} -> ${userId}`);
  }
  hydratedUserId = userId;
  accountGeneration += 1;
}

/**
 * 启动时把当前账号上次已知的结算币种恢复给 ledgerCurrency。
 *
 * 必须在任何记账路径之前跑（prewarm 阶段）：否则 /models 回来之前的那几轮会按兜底
 * 币种入账，而那正是币种翻转的主要来源之一。
 *
 * ## 不变量
 *
 * 跨越 await 的账号相关写入，只有在这段 await 期间**账号身份一次都没变过**时才允许
 * 提交。判据是账号代际号，不是 userId 相等 —— 后者挡得住 A→B，挡不住 A→B→A：切回来
 * 之后 userId 重新相等，一份在 B 期间就已过期的读取结果会被当成有效值写进 lastKnown。
 */
export async function hydrateAccountCurrency(userId?: string): Promise<MoneyCurrency | null> {
  const resolved = userId ?? getCurrentDbClientUserId();
  if (!resolved) return null;
  noteActiveAccount(resolved);
  const generation = accountGeneration;
  const entries = await readEntries();
  if (accountGeneration !== generation) {
    log.info(
      `ledger currency hydrate discarded: account changed during read (user=${resolved}, ` +
        `generation ${generation} -> ${accountGeneration})`,
    );
    return null;
  }
  const currency = entries[resolved] ?? null;
  if (currency) {
    hydrateLastKnownLedgerCurrency(currency);
    log.info(`ledger currency hydrated: user=${resolved} currency=${currency}`);
  }
  return currency;
}

/** 仅测试：丢掉内存快照，强制下次重读磁盘。 */
export function __resetAccountCurrencyStoreForTesting(): void {
  accountGeneration = 0;
  memo = null;
  writeChain = Promise.resolve();
  hydratedUserId = null;
}
