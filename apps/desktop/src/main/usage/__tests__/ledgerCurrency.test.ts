import { describe, expect, it, beforeEach } from 'vitest';

import { DEFAULT_USAGE_CURRENCY } from '../../../shared/regionalMoney';
import {
  LEDGER_CURRENCY_FALLBACK,
  __resetActiveLedgerCurrencyForTesting,
  currentLedgerCurrency,
  hydrateLastKnownLedgerCurrency,
  isLedgerCurrencyKnown,
  resetLedgerCurrencyForAccountSwitch,
  setActiveLedgerCurrency,
} from '../ledgerCurrency';

describe('ledger currency fallback chain', () => {
  beforeEach(() => {
    __resetActiveLedgerCurrencyForTesting();
  });

  it('falls back to USD rather than the build region when nothing is known', () => {
    // 这是整组修复的核心不变量。此前兜底取构建区域币种(CN 构建 = CNY),而报价数值
    // 由服务端给定、恒为 USD 口径 —— 服务端某次漏发 currency 就会把 USD 数字盖上 CNY
    // 戳,既不换算也不拒收,产生 6.7 倍量级的错账。USD 是 SDK 自报费用与全部参考价表
    // 的原生口径,兜底成它最多是符号显示得保守,不会算错。
    expect(isLedgerCurrencyKnown()).toBe(false);
    expect(currentLedgerCurrency()).toBe('USD');
    expect(LEDGER_CURRENCY_FALLBACK).toBe('USD');
  });

  it('keeps the last known currency when a sync fails to confirm one', () => {
    // active 会因为完全正常的原因变成未知:目录同步在途、缓存 scope 失效、登出重登。
    // 若这些瞬时状态回落到兜底值,账本币种就会在两种币种之间来回翻,而下游账本按币种
    // 分行/取用,翻转会让展示值忽大忽小。
    setActiveLedgerCurrency('CNY');
    expect(currentLedgerCurrency()).toBe('CNY');

    setActiveLedgerCurrency(null);
    expect(currentLedgerCurrency()).toBe('CNY');
    expect(isLedgerCurrencyKnown()).toBe(true);
  });

  it('lets a newly confirmed currency win over the last known one', () => {
    setActiveLedgerCurrency('CNY');
    setActiveLedgerCurrency('USD');
    expect(currentLedgerCurrency()).toBe('USD');
  });

  it('hydrates a persisted currency only while nothing is known yet', () => {
    hydrateLastKnownLedgerCurrency('CNY');
    expect(currentLedgerCurrency()).toBe('CNY');

    // 磁盘快照可能比当前登录账号旧,绝不能覆盖本进程已经确认过的币种。
    setActiveLedgerCurrency('USD');
    hydrateLastKnownLedgerCurrency('CNY');
    setActiveLedgerCurrency(null);
    expect(currentLedgerCurrency()).toBe('USD');
  });

  it('ignores a null hydrate', () => {
    hydrateLastKnownLedgerCurrency(null);
    expect(isLedgerCurrencyKnown()).toBe(false);
    expect(currentLedgerCurrency()).toBe('USD');
  });

  it('drops the last known currency at an account boundary', () => {
    // lastKnown 的作用是熬过同一账号的瞬时未知。跨账号沿用就成了记错账:新账号的目录
    // 若恰好没声明币种,会静默继承上一个账号的结算币种。
    setActiveLedgerCurrency('CNY');
    resetLedgerCurrencyForAccountSwitch();
    expect(isLedgerCurrencyKnown()).toBe(false);
    expect(currentLedgerCurrency()).toBe('USD');
  });

  it('does not read the build region at all', () => {
    // 回归护栏:构建区域一旦重新参与回退,CN 构建就会再次把 USD 口径数值记成 CNY。
    // 这条断言在 global 构建上恒真,在 cn 构建上才有区分度 —— 后者正是出过事的组合。
    if (DEFAULT_USAGE_CURRENCY === 'CNY') {
      expect(currentLedgerCurrency()).not.toBe(DEFAULT_USAGE_CURRENCY);
    }
    expect(currentLedgerCurrency()).toBe('USD');
  });
});
