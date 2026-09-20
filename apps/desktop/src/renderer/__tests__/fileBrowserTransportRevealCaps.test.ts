/**
 * fileBrowserTransport —— 「显示被忽略的目录」能力探测的三态语义。
 *
 * 这条链路的错误分类直接决定用户看到什么：
 *   - 确定性不支持（老被控端没有 remote-op channel）→ false → 标题行开关按
 *     不可用呈现并说明原因；
 *   - 瞬态失败（隧道不可达 / 重连中）→ **null**，不能落定成 false —— 否则一次
 *     网络抖动就被显示成「对方版本过旧」，连接恢复后也不会自愈。
 *
 * 缓存语义同时被锁住：只缓存肯定结论 true；「不支持」不留在缓存里（被控端可能在
 * 一次掉线期间升级），瞬态更不缓存。
 *
 * window.electronAPI 用 vi.stubGlobal 注入（node 环境，无 jsdom）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InvokeMock = ReturnType<typeof vi.fn>;

let invokeMock: InvokeMock;
let transport: typeof import('../lib/fileBrowserTransport');
/** 模块级 reconnect 订阅注册进来的回调:测试用它们模拟「没有任何 hook 观察」期间的重连。 */
let presenceCallbacks: Array<(snapshot: { deviceId: string; online: boolean }) => void>;
let statusCallbacks: Array<(payload: { status: string }) => void>;

beforeEach(async () => {
  // 模块级重连代次与订阅标志要按测试隔离(否则第一个测试的订阅会跨用例残留)。
  vi.resetModules();
  invokeMock = vi.fn();
  presenceCallbacks = [];
  statusCallbacks = [];
  vi.stubGlobal('window', {
    electronAPI: {
      deviceLink: {
        invoke: invokeMock,
        onPresenceChanged: (cb: (snapshot: { deviceId: string; online: boolean }) => void) => {
          presenceCallbacks.push(cb);
          return () => {
            const index = presenceCallbacks.indexOf(cb);
            if (index >= 0) presenceCallbacks.splice(index, 1);
          };
        },
        onStatusChanged: (cb: (payload: { status: string }) => void) => {
          statusCallbacks.push(cb);
          return () => {
            const index = statusCallbacks.indexOf(cb);
            if (index >= 0) statusCallbacks.splice(index, 1);
          };
        },
      },
    },
  });
  transport = await import('../lib/fileBrowserTransport');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 探测缓存是模块级 per-deviceId，单测用唯一 deviceId 隔离。
let seq = 0;
const freshDevice = () => `reveal-${Date.now().toString(36)}-${seq++}`;

describe('deviceSupportsRevealIgnoredDirs', () => {
  it('新被控端:true,并缓存(不重复探测)', async () => {
    const deviceId = freshDevice();
    invokeMock.mockResolvedValue({ ok: true, gzip: true, showIgnoredDirs: true });

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(true);
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // 探测走 caps op,与 workdir 无关。
    expect(invokeMock.mock.calls[0][2][0]).toMatchObject({ op: 'caps' });
  });

  it('老被控端(caps 返回 unknown op):false,且不缓存(升级后重连能自愈)', async () => {
    const deviceId = freshDevice();
    invokeMock.mockResolvedValue({ ok: false, message: 'unknown op: caps' });

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(false);
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // 被控端升级后重连:同一 deviceId 重探必须拿到新结论。
    invokeMock.mockResolvedValue({ ok: true, showIgnoredDirs: true });
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it('caps 有响应但没带能力位(中间版本):false', async () => {
    const deviceId = freshDevice();
    invokeMock.mockResolvedValue({ ok: true, gzip: true });

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(false);
  });

  it('老端无 remote-op channel(CHANNEL_NOT_ALLOWED):确定性 false', async () => {
    const deviceId = freshDevice();
    invokeMock.mockRejectedValue(new Error('DEVICE_LINK_CHANNEL_NOT_ALLOWED'));

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(false);
  });

  it('瞬态失败:返回 null(不是 false),不缓存,恢复后重探拿到真结论', async () => {
    const deviceId = freshDevice();
    invokeMock.mockRejectedValueOnce(new Error('device link tunnel is not connected'));

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(null);

    invokeMock.mockResolvedValue({ ok: true, showIgnoredDirs: true });
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  /**
   * 重连代次必须是**进程级**的:面板卸载 →(没有任何 hook 观察)→ 重挂载时
   * hook 局计数器又从 0 开始。拿 hook 局代次当缓存 key 的话,下面这步缓存里的
   * 旧肯定结论会被误用 —— 开关对着已回滚的老端一直可按。所以缓存自己订阅全局
   * reconnect 流拿代次。
   */
  it('重连(即使没有任何 hook 观察)作废肯定结论缓存', async () => {
    const deviceId = freshDevice();
    invokeMock.mockResolvedValue({ ok: true, showIgnoredDirs: true });

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(true);
    // 同代次命中缓存,不重复探测。
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // 模块级订阅已惰性建立。
    expect(presenceCallbacks.length).toBe(1);

    // 设备被回滚成中间版本 + 重连:订阅侧只看到一次 online 事件(非 hook 驱动)。
    invokeMock.mockResolvedValue({ ok: true, gzip: true });
    presenceCallbacks[0]({ deviceId, online: true });

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // 已落定的否定结论本就不缓存 —— 下一次仍然重新问。
    invokeMock.mockResolvedValue({ ok: true, showIgnoredDirs: true });
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it('relay 恢复 online 同样作废缓存', async () => {
    const deviceId = freshDevice();
    invokeMock.mockResolvedValue({ ok: true, showIgnoredDirs: true });
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(statusCallbacks.length).toBe(1);

    invokeMock.mockResolvedValue({ ok: true, gzip: true });
    statusCallbacks[0]({ status: 'online' });

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo')).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
