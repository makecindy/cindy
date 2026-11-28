/**
 * useDeviceApiKeyStatus 生命周期单测:挂载拉取 / 缓存命中 / 离线驱逐后清展示并重拉 /
 * 晚到旧响应被代次守卫拒绝 / 重连(connectionEpoch)重跑 effect。对应 #5450 §11.3,
 * 接线对齐 useDeviceModelPricing(缓存核心走真实实现)。
 */
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllDeviceModelMeta,
  evictDeviceModelMeta,
  fetchDeviceApiKeyStatus,
} from '@/device-link/deviceModelMetaCache';
import { useDeviceApiKeyStatus } from '@/device-link/useDeviceModelMeta';

const linkState = { connectionEpoch: 0 };
const getApiKeyPresent = vi.fn<() => Promise<{ present: boolean }>>();

vi.mock('@/device-link/useMobileMakerTransport', () => ({
  useMobileMakerTransport: () => ({
    getModelPricing: () => Promise.resolve(null),
    getApiKeyPresent: () => getApiKeyPresent(),
  }),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ connectionEpoch: linkState.connectionEpoch }),
}));

describe('useDeviceApiKeyStatus 生命周期刷新', () => {
  beforeEach(() => {
    clearAllDeviceModelMeta();
    linkState.connectionEpoch = 0;
    getApiKeyPresent.mockReset();
  });
  afterEach(() => cleanup());

  it('挂载 cache-miss 拉取成功 → 展示 presence', async () => {
    getApiKeyPresent.mockResolvedValue({ present: true });
    const { result } = renderHook(() => useDeviceApiKeyStatus('devA'));
    expect(result.current).toBe('unknown');
    await waitFor(() => expect(result.current).toBe('present'));
    expect(getApiKeyPresent).toHaveBeenCalledTimes(1);
  });

  it('缓存命中不拉取;离线驱逐后回 unknown 并自动重拉新值', async () => {
    await fetchDeviceApiKeyStatus('devA', vi.fn().mockResolvedValue({ present: true }));
    getApiKeyPresent.mockResolvedValue({ present: false });
    const { result } = renderHook(() => useDeviceApiKeyStatus('devA'));
    expect(result.current).toBe('present');
    expect(getApiKeyPresent).not.toHaveBeenCalled();

    act(() => {
      evictDeviceModelMeta('devA'); // 设备离线驱逐,页面仍挂载
    });
    expect(result.current).toBe('unknown'); // 先回降级值
    await waitFor(() => expect(result.current).toBe('absent'));
    expect(getApiKeyPresent).toHaveBeenCalledTimes(1);
  });

  it('驱逐后在途旧响应晚到,被代次守卫拒绝,不覆盖新拉取', async () => {
    let releaseFirst: (v: { present: boolean }) => void = () => undefined;
    let releaseSecond: (v: { present: boolean }) => void = () => undefined;
    getApiKeyPresent.mockImplementationOnce(
      () => new Promise<{ present: boolean }>((resolve) => { releaseFirst = resolve; }),
    );
    getApiKeyPresent.mockImplementationOnce(
      () => new Promise<{ present: boolean }>((resolve) => { releaseSecond = resolve; }),
    );
    const { result } = renderHook(() => useDeviceApiKeyStatus('devA'));
    await waitFor(() => expect(getApiKeyPresent).toHaveBeenCalledTimes(1));

    act(() => {
      evictDeviceModelMeta('devA'); // 触发失效订阅 → 第二次拉取
    });
    await waitFor(() => expect(getApiKeyPresent).toHaveBeenCalledTimes(2));

    act(() => {
      releaseFirst({ present: true }); // 旧响应(驱逐前发起)晚到
    });
    // 先冲刷微任务,让代次守卫的 .then 回调执行完再断言;否则守卫失效时旧值
    // 会稍后才写入,断言提前通过造成漏报。
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toBe('unknown'); // 旧值不得覆盖

    act(() => {
      releaseSecond({ present: false }); // 新响应到达
    });
    await waitFor(() => expect(result.current).toBe('absent'));
  });

  it('宽限期内重连(驱逐被取消):缓存命中也强制刷新新值', async () => {
    // 首次成功拉取并记录缓存所属连接代次。
    getApiKeyPresent.mockResolvedValueOnce({ present: true });
    const { result, rerender } = renderHook(() => useDeviceApiKeyStatus('devA'));
    await waitFor(() => expect(result.current).toBe('present'));
    expect(getApiKeyPresent).toHaveBeenCalledTimes(1);

    // 同设备重连(离线宽限期内恢复,驱逐被取消,缓存未清):effect 重跑命中缓存,
    // 但缓存属旧连接代次,须强制刷新拿被控端当前 presence。
    getApiKeyPresent.mockResolvedValueOnce({ present: false });
    act(() => {
      linkState.connectionEpoch = 1;
    });
    rerender();
    await waitFor(() => expect(result.current).toBe('absent'));
    expect(getApiKeyPresent).toHaveBeenCalledTimes(2);
  });

  it('离线驱逐重拉失败维持 unknown;重连后重拉拿到新值', async () => {
    getApiKeyPresent
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ present: true });
    const { result, rerender } = renderHook(() => useDeviceApiKeyStatus('devA'));
    await waitFor(() => expect(getApiKeyPresent).toHaveBeenCalledTimes(1));
    expect(result.current).toBe('unknown'); // 首拉失败:降级且不缓存

    act(() => {
      evictDeviceModelMeta('devA'); // 失效订阅触发重拉(仍离线)
    });
    await waitFor(() => expect(getApiKeyPresent).toHaveBeenCalledTimes(2));
    expect(result.current).toBe('unknown');

    act(() => {
      linkState.connectionEpoch = 1; // 重连
    });
    rerender();
    await waitFor(() => expect(getApiKeyPresent).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current).toBe('present'));
  });
});
