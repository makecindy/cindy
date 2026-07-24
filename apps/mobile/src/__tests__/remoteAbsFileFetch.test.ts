import { beforeAll, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  adaptTextFilePreviewResult,
  fetchRemoteAbsFileToUrl,
  type RemoteAbsFileFetchDeps,
} from '@/session/remoteAbsFileFetch';
import type { RemoteTextFilePreviewResult } from '@/device-link/mobileMakerTransport';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function makeDeps(overrides: Partial<{
  ossKey: string;
  getUrl: string;
  expiresAt: string;
}> = {}) {
  const fetchRemoteMedia = vi.fn(async () => ({
    ossKey: overrides.ossKey ?? 'oss/abc',
    mimeType: 'image/png',
    size: 1234,
  }));
  const presignGet = vi.fn(async () => ({
    getUrl: overrides.getUrl ?? 'https://oss.example/get/abc',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }));
  const openLink = vi.fn(async () => undefined);
  const deps: RemoteAbsFileFetchDeps = {
    maker: { fetchRemoteMedia },
    deviceId: `dev-${Math.random().toString(36).slice(2)}`,
    openLink,
    presignGet,
  };
  return { deps, fetchRemoteMedia, presignGet, openLink };
}

describe('fetchRemoteAbsFileToUrl', () => {
  it('走 media:fetch 绝对路径通道并 presign 出下载地址', async () => {
    const { deps, fetchRemoteMedia, presignGet } = makeDeps();
    const url = await fetchRemoteAbsFileToUrl(deps, '/tmp/shot.png');
    expect(url).toBe('https://oss.example/get/abc');
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      `xdt-file://open?path=${encodeURIComponent('/tmp/shot.png')}`,
      undefined,
    );
    expect(presignGet).toHaveBeenCalledWith('oss/abc');
  });

  it('短 TTL 内同 deviceId+absPath 命中缓存,不重复取件', async () => {
    const { deps, fetchRemoteMedia } = makeDeps();
    await fetchRemoteAbsFileToUrl(deps, '/tmp/shot.png');
    await fetchRemoteAbsFileToUrl(deps, '/tmp/shot.png');
    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
  });

  it('超过短 TTL 后重新取件(同路径覆写不吃旧字节的保障)', async () => {
    vi.useFakeTimers({ now: Date.now() });
    try {
      const { deps, fetchRemoteMedia } = makeDeps({
        // presign 给足 2 小时,确保重取是 TTL 驱动而不是 presign 过期驱动。
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      });
      await fetchRemoteAbsFileToUrl(deps, '/tmp/shot.png');
      vi.advanceTimersByTime(61 * 1000);
      await fetchRemoteAbsFileToUrl(deps, '/tmp/shot.png');
      expect(fetchRemoteMedia).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('缓存条目数超上限时按插入序淘汰最旧', async () => {
    const { deps, fetchRemoteMedia } = makeDeps();
    for (let i = 0; i < 65; i += 1) {
      await fetchRemoteAbsFileToUrl(deps, `/tmp/file-${i}.png`);
    }
    expect(fetchRemoteMedia).toHaveBeenCalledTimes(65);
    // 第 0 个已被逐出 → 再次请求触发重新取件;第 64 个仍在缓存。
    await fetchRemoteAbsFileToUrl(deps, '/tmp/file-0.png');
    expect(fetchRemoteMedia).toHaveBeenCalledTimes(66);
    await fetchRemoteAbsFileToUrl(deps, '/tmp/file-64.png');
    expect(fetchRemoteMedia).toHaveBeenCalledTimes(66);
  });

  it('presign 已临期(安全窗内)时重新取件', async () => {
    const { deps, fetchRemoteMedia } = makeDeps({
      // 30s 后过期,落在 isResolvedRemoteMediaFresh 的 60s 安全窗内 → 视为不新鲜。
      expiresAt: new Date(Date.now() + 30 * 1000).toISOString(),
    });
    await fetchRemoteAbsFileToUrl(deps, '/tmp/shot.png');
    await fetchRemoteAbsFileToUrl(deps, '/tmp/shot.png');
    expect(fetchRemoteMedia).toHaveBeenCalledTimes(2);
  });

  it('Windows 被控端绝对路径同样按 path 参数编码', async () => {
    const { deps, fetchRemoteMedia } = makeDeps();
    await fetchRemoteAbsFileToUrl(deps, 'C:\\tmp\\shot.png');
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      `xdt-file://open?path=${encodeURIComponent('C:\\tmp\\shot.png')}`,
      undefined,
    );
  });
});

describe('adaptTextFilePreviewResult', () => {
  it('成功回包映射 readFile 同构 ok 结果(纯文本,无 gzip)', () => {
    const res: RemoteTextFilePreviewResult = { success: true, data: 'hello\nworld', size: 11 };
    expect(adaptTextFilePreviewResult('/tmp/a.txt', res)).toEqual({
      ok: true,
      data: { relPath: '/tmp/a.txt', content: 'hello\nworld', size: 11, mtimeMs: 0 },
    });
  });

  it('oversize 映射 OVERSIZE + stat(供「超上限,可下载」占位显示 size)', () => {
    const res: RemoteTextFilePreviewResult = { success: false, reason: 'oversize', size: 99_999_999 };
    expect(adaptTextFilePreviewResult('/tmp/big.log', res)).toEqual({
      ok: false,
      code: 'OVERSIZE',
      stat: { relPath: '/tmp/big.log', type: 'file', size: 99_999_999, mtimeMs: 0 },
    });
  });

  it.each([
    ['not_found', '文件不存在'],
    ['forbidden', '该路径不允许读取'],
  ] as const)('%s 映射 READ_FAILED 与对应文案', (reason, message) => {
    const res: RemoteTextFilePreviewResult = { success: false, reason, size: 0 };
    expect(adaptTextFilePreviewResult('/tmp/a.txt', res)).toEqual({
      ok: false,
      code: 'READ_FAILED',
      message,
    });
  });

  it('read_failed 优先透出被控端 error 文本', () => {
    const res: RemoteTextFilePreviewResult = {
      success: false,
      reason: 'read_failed',
      error: 'EACCES: permission denied',
      size: 0,
    };
    expect(adaptTextFilePreviewResult('/tmp/a.txt', res)).toEqual({
      ok: false,
      code: 'READ_FAILED',
      message: 'EACCES: permission denied',
    });
  });
});
