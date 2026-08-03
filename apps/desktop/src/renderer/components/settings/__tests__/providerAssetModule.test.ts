import { describe, expect, it } from 'vitest';

import { resolveXdAssetModuleState } from '../providerAssetModule';

const OK = {
  billingAccessible: true,
  syncState: 'ok' as const,
  available: '18.42',
};

describe('resolveXdAssetModuleState', () => {
  it('个人云账号 + 拿到余额 → 渲染余额块', () => {
    expect(resolveXdAssetModuleState(OK)).toEqual({ kind: 'balance', available: '18.42' });
  });

  it('企业账号 → 整个资产模块不渲染(不是灰置、不给占位、也不给重试)', () => {
    expect(resolveXdAssetModuleState({ ...OK, billingAccessible: false })).toEqual({
      kind: 'hidden',
    });
    // 关键:企业账号即使凭据同步失败也不该看到「重试余额」——那笔钱不属于这个账号。
    expect(
      resolveXdAssetModuleState({ ...OK, billingAccessible: false, syncState: 'failed' }),
    ).toEqual({ kind: 'hidden' });
  });

  it('凭据同步失败 → 故障态(本该有、这次拿不到,所以给重试)', () => {
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'failed' })).toEqual({ kind: 'fault' });
    // 故障态优先于「余额还没回来」:两者同时成立时用户需要的是恢复入口。
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'failed', available: null })).toEqual({
      kind: 'fault',
    });
  });

  it('企业未开通 / 服务未启用 → 不渲染(没有可恢复的东西,给重试是假承诺)', () => {
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'unsupported' })).toEqual({
      kind: 'hidden',
    });
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'disabled' })).toEqual({ kind: 'hidden' });
  });

  it('余额查询不支持 / 尚未返回 → 不渲染,不显示「—」占位', () => {
    expect(resolveXdAssetModuleState({ ...OK, available: null })).toEqual({ kind: 'hidden' });
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'syncing', available: null })).toEqual({
      kind: 'hidden',
    });
  });

  it('同步中但余额已有缓存 → 照常显示(不为了一次刷新把数字抽走)', () => {
    expect(resolveXdAssetModuleState({ ...OK, syncState: 'syncing' })).toEqual({
      kind: 'balance',
      available: '18.42',
    });
  });
});
