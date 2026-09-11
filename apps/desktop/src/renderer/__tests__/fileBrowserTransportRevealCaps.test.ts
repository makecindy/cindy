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

beforeEach(async () => {
  invokeMock = vi.fn();
  vi.stubGlobal('window', {
    electronAPI: { deviceLink: { invoke: invokeMock } },
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

  it('肯定结论按连接代次失效:重连后重探(被控端被回滚到老端也能纠正)', async () => {
    const deviceId = freshDevice();
    invokeMock.mockResolvedValue({ ok: true, showIgnoredDirs: true });

    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo', 0)).resolves.toBe(
      true,
    );
    // 同代次命中缓存,不重复探测。
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo', 0)).resolves.toBe(
      true,
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // 重连(代次 +1):旧结论作废,重新问 —— 设备此时已被回滚成中间版本。
    invokeMock.mockResolvedValue({ ok: true, gzip: true });
    await expect(transport.deviceSupportsRevealIgnoredDirs(deviceId, '/repo', 1)).resolves.toBe(
      false,
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
