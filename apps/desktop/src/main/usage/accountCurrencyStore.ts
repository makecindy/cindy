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
import {createAccountCurrencyStore} from "@cindy/app-runtime/accountCurrencyStore";


export const {rememberAccountCurrency,noteActiveAccount,hydrateAccountCurrency,__resetAccountCurrencyStoreForTesting,__flushAccountCurrencyStoreForTesting}=createAccountCurrencyStore({
userDataDirectory:()=>app.getPath("userData"),
getCurrentDbClientUserId:()=>getCurrentDbClientUserId(),
createLogger,
hydrateLastKnownLedgerCurrency:(...args)=>hydrateLastKnownLedgerCurrency(...args),
resetLedgerCurrencyForAccountSwitch:()=>resetLedgerCurrencyForAccountSwitch()
});
