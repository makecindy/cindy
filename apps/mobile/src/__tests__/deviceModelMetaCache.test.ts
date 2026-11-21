/**
 * deviceModelMetaCache 单测:命中 / inflight 去重 / 失败降级(不缓存、不抛)/ 空表收敛 null /
 * evict 代际作废 / clearAll。纯逻辑,node env。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllDeviceModelMeta,
  evictDeviceModelMeta,
  fetchDeviceApiKeyStatus,
  fetchDeviceModelPricing,
  getCachedDeviceApiKeyStatus,
  getCachedDeviceModelPricing,
  getDeviceModelPricingGen,
  refreshDeviceModelPricing,
  subscribeDeviceModelPricingGen,
} from '@/device-link/deviceModelMetaCache';

const PRICING = { 'gpt-5.5': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 } };

describe('deviceModelMetaCache', () => {
  beforeEach(() => {
    clearAllDeviceModelMeta();
  });

  it('单价表:命中缓存不再 fetch;空表 / 非法形状收敛为 null', async () => {
    const fetcher = vi.fn().mockResolvedValue(PRICING);
    await expect(fetchDeviceModelPricing('devA', fetcher)).resolves.toEqual(PRICING);
    await expect(fetchDeviceModelPricing('devA', fetcher)).resolves.toEqual(PRICING);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getCachedDeviceModelPricing('devA')).toEqual(PRICING);

    await expect(fetchDeviceModelPricing('devB', vi.fn().mockResolvedValue({}))).resolves.toBeNull();
    expect(getCachedDeviceModelPricing('devB')).toBeNull(); // 空表也缓存(合法结果,无价可示)
  });

  it('key presence:present/absent 映射;失败 → undefined 且不缓存(下次重试)', async () => {
    await expect(
      fetchDeviceApiKeyStatus('devA', vi.fn().mockResolvedValue({ present: true })),
    ).resolves.toBe('present');
    expect(getCachedDeviceApiKeyStatus('devA')).toBe('present');

    const failing = vi.fn().mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
    await expect(fetchDeviceApiKeyStatus('devB', failing)).resolves.toBeUndefined();
    expect(getCachedDeviceApiKeyStatus('devB')).toBeUndefined();
    // 失败未缓存 → 再次调用会重试。
    await expect(
      fetchDeviceApiKeyStatus('devB', vi.fn().mockResolvedValue({ present: false })),
    ).resolves.toBe('absent');
  });

  it('inflight 去重:并发两次只 fetch 一次', async () => {
    let release: (v: { present: boolean }) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<{ present: boolean }>((r) => { release = r; }));
    const p1 = fetchDeviceApiKeyStatus('devA', fetcher);
    const p2 = fetchDeviceApiKeyStatus('devA', fetcher);
    release({ present: true });
    await expect(p1).resolves.toBe('present');
    await expect(p2).resolves.toBe('present');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('evict:代际作废在途 fetch 的回写(旧数据不落缓存)', async () => {
    let release: (v: typeof PRICING) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<typeof PRICING>((r) => { release = r; }));
    const p = fetchDeviceModelPricing('devA', fetcher);
    evictDeviceModelMeta('devA');
    release(PRICING);
    await p;
    expect(getCachedDeviceModelPricing('devA')).toBeUndefined();
  });

  it('clearAll:清空全部设备并作废在途', async () => {
    await fetchDeviceApiKeyStatus('devA', vi.fn().mockResolvedValue({ present: true }));
    await fetchDeviceModelPricing('devB', vi.fn().mockResolvedValue(PRICING));
    clearAllDeviceModelMeta();
    expect(getCachedDeviceApiKeyStatus('devA')).toBeUndefined();
    expect(getCachedDeviceModelPricing('devB')).toBeUndefined();
  });

  it('refresh:忽略缓存命中强制拉取,与在途去重', async () => {
    await fetchDeviceModelPricing('devA', vi.fn().mockResolvedValue(PRICING));
    expect(getCachedDeviceModelPricing('devA')).toEqual(PRICING);

    const PRICING_V2 = { 'gpt-5.5': { inputUsdPerMtok: 4, outputUsdPerMtok: 20 } };
    let release: (v: typeof PRICING_V2) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<typeof PRICING_V2>((r) => { release = r; }));
    const pending = refreshDeviceModelPricing('devA', fetcher);
    // 缓存命中不短路:refresh 必须真正发起拉取。
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 与在途去重。
    void refreshDeviceModelPricing('devA', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    release(PRICING_V2);
    await expect(pending).resolves.toEqual(PRICING_V2);
    expect(getCachedDeviceModelPricing('devA')).toEqual(PRICING_V2);
  });

  it('代际:evict/clearAll 自增并通知订阅者,退订后不再通知', () => {
    // 代际是模块级累计的(前面用例已驱动过 devA),只断言相对增量。
    const base = getDeviceModelPricingGen('devA');
    const seen: number[] = [];
    const unsubscribe = subscribeDeviceModelPricingGen('devA', () => {
      seen.push(getDeviceModelPricingGen('devA'));
    });
    evictDeviceModelMeta('devA');
    evictDeviceModelMeta('devA');
    clearAllDeviceModelMeta();
    expect(getDeviceModelPricingGen('devA')).toBe(base + 3);
    unsubscribe();
    evictDeviceModelMeta('devA');
    expect(seen).toEqual([base + 1, base + 2, base + 3]);
  });

  it('代际订阅只收本设备的通知', () => {
    const seen: string[] = [];
    subscribeDeviceModelPricingGen('devA', () => seen.push('devA'));
    evictDeviceModelMeta('devB');
    expect(seen).toEqual([]);
  });
});
