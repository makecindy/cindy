/**
 * useDeviceModelPricing 生命周期单测:挂载拉取 / 缓存命中 / 离线驱逐后清展示并重拉 /
 * 晚到旧响应被代次守卫拒绝 / 重连(connectionEpoch)重跑 effect。对应 #5450 §11.3。
 *
 * 只 mock transport 与 DeviceLinkContext 两个边界;缓存核心(deviceModelMetaCache)走
 * 真实实现,node 语义与生产一致。
 */
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllDeviceModelMeta,
  evictDeviceModelMeta,
  fetchDeviceModelPricing,
  refreshDeviceModelPricing,
} from '@/device-link/deviceModelMetaCache';
import { useDeviceModelPricing } from '@/device-link/useDeviceModelMeta';

type Pricing = { [model: string]: { inputUsdPerMtok: number; outputUsdPerMtok: number } };
const PRICING: Pricing = { 'gpt-5.5': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 } };
const PRICING_V2: Pricing = { 'gpt-5.5': { inputUsdPerMtok: 4, outputUsdPerMtok: 20 } };

const linkState = { connectionEpoch: 0 };
const getModelPricing = vi.fn<() => Promise<Pricing>>();

vi.mock('@/device-link/useMobileMakerTransport', () => ({
  useMobileMakerTransport: () => ({
    getModelPricing: () => getModelPricing(),
    getApiKeyPresent: () => Promise.resolve({ present: false }),
  }),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ connectionEpoch: linkState.connectionEpoch }),
}));

describe('useDeviceModelPricing 生命周期刷新', () => {
  beforeEach(() => {
    clearAllDeviceModelMeta();
    linkState.connectionEpoch = 0;
    getModelPricing.mockReset();
  });
  afterEach(() => cleanup());

  it('挂载 cache-miss 拉取成功 → 展示价格', async () => {
    getModelPricing.mockResolvedValue(PRICING);
    const { result } = renderHook(() => useDeviceModelPricing('devA'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual(PRICING));
    expect(getModelPricing).toHaveBeenCalledTimes(1);
  });

  it('缓存命中不拉取;离线驱逐后清展示并自动重拉新值', async () => {
    await fetchDeviceModelPricing('devA', vi.fn().mockResolvedValue(PRICING));
    getModelPricing.mockResolvedValue(PRICING_V2);
    const { result } = renderHook(() => useDeviceModelPricing('devA'));
    expect(result.current).toEqual(PRICING);
    expect(getModelPricing).not.toHaveBeenCalled();

    act(() => {
      evictDeviceModelMeta('devA'); // 设备离线驱逐,页面仍挂载
    });
    expect(result.current).toBeNull(); // 先清展示(降级),不带旧值重拉窗口
    await waitFor(() => expect(result.current).toEqual(PRICING_V2));
    expect(getModelPricing).toHaveBeenCalledTimes(1);
  });

  it('驱逐后在途旧响应晚到,被代次守卫拒绝,不覆盖新拉取', async () => {
    let releaseFirst: (v: Pricing) => void = () => undefined;
    let releaseSecond: (v: Pricing) => void = () => undefined;
    getModelPricing.mockImplementationOnce(
      () => new Promise<Pricing>((resolve) => { releaseFirst = resolve; }),
    );
    getModelPricing.mockImplementationOnce(
      () => new Promise<Pricing>((resolve) => { releaseSecond = resolve; }),
    );
    const { result } = renderHook(() => useDeviceModelPricing('devA'));
    await waitFor(() => expect(getModelPricing).toHaveBeenCalledTimes(1));

    act(() => {
      evictDeviceModelMeta('devA'); // 触发失效订阅 → 第二次拉取
    });
    await waitFor(() => expect(getModelPricing).toHaveBeenCalledTimes(2));

    act(() => {
      releaseFirst(PRICING); // 旧响应(驱逐前发起)晚到
    });
    // 先冲刷微任务,让代次守卫的 .then 回调执行完再断言;否则守卫失效时旧值
    // 会稍后才写入,断言提前通过造成漏报(greptile P2)。
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toBeNull(); // 旧值不得覆盖

    act(() => {
      releaseSecond(PRICING_V2); // 新响应到达
    });
    await waitFor(() => expect(result.current).toEqual(PRICING_V2));
  });

  it('同设备重连(connectionEpoch 变化)重跑 effect;在途拉取经去重共享', async () => {
    let release: (v: Pricing) => void = () => undefined;
    getModelPricing.mockImplementation(
      () => new Promise<Pricing>((resolve) => { release = resolve; }),
    );
    const { result, rerender } = renderHook(() => useDeviceModelPricing('devA'));
    expect(getModelPricing).toHaveBeenCalledTimes(1);

    act(() => {
      evictDeviceModelMeta('devA'); // 离线驱逐 → 订阅触发重拉
    });
    expect(getModelPricing).toHaveBeenCalledTimes(2);

    act(() => {
      linkState.connectionEpoch = 1; // 重连:effect 重跑,与在途拉取 inflight 去重
    });
    rerender();
    expect(getModelPricing).toHaveBeenCalledTimes(2);

    act(() => {
      release(PRICING);
    });
    await waitFor(() => expect(result.current).toEqual(PRICING));
  });

  it('宽限期内重连(驱逐被取消):缓存命中也强制刷新新值', async () => {
    // 首次成功拉取并记录缓存所属连接代次。
    getModelPricing.mockResolvedValueOnce(PRICING);
    const { result, rerender } = renderHook(() => useDeviceModelPricing('devA'));
    await waitFor(() => expect(result.current).toEqual(PRICING));
    expect(getModelPricing).toHaveBeenCalledTimes(1);

    // 同设备重连(离线宽限期内恢复,驱逐被取消,缓存未清):effect 重跑命中缓存,
    // 但缓存属旧连接代次,须强制刷新拿被控端当前价(greptile P1)。
    getModelPricing.mockResolvedValueOnce(PRICING_V2);
    act(() => {
      linkState.connectionEpoch = 1;
    });
    rerender();
    await waitFor(() => expect(result.current).toEqual(PRICING_V2));
    expect(getModelPricing).toHaveBeenCalledTimes(2);
  });

  it('离线驱逐重拉失败维持降级;重连后重拉拿到新值', async () => {
    getModelPricing
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(PRICING_V2);
    const { result, rerender } = renderHook(() => useDeviceModelPricing('devA'));
    await waitFor(() => expect(getModelPricing).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull(); // 首拉失败:降级且不缓存

    act(() => {
      evictDeviceModelMeta('devA'); // 失效订阅触发重拉(仍离线)
    });
    await waitFor(() => expect(getModelPricing).toHaveBeenCalledTimes(2));
    expect(result.current).toBeNull();

    act(() => {
      linkState.connectionEpoch = 1; // 重连
    });
    rerender();
    await waitFor(() => expect(getModelPricing).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current).toEqual(PRICING_V2));
  });
});
