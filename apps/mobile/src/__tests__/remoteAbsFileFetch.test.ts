import { beforeAll, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  adaptTextFilePreviewResult,
  fetchRemoteAbsFileToUrl,
  fetchRemoteAbsFileOnce,
  readRemoteTextFilePreview,
  type RemoteAbsFileFetchDeps,
} from '@/session/remoteAbsFileFetch';
import type { RemoteTextFilePreviewResult } from '@/device-link/mobileMakerTransport';
import { clearPeerMedia, recordPeerMedia } from '@/device-link/peerFileRegistry';
const textIO = vi.hoisted(() => ({ size: 5, text: 'hello', read: vi.fn() }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({
  withDownloadedRemoteMediaFile: async (_url: string, _mime: string, _max: number, read: (file: unknown) => unknown) => {
    textIO.read();
    return read({ size: textIO.size, text: async () => textIO.text });
  },
}));

// Unit: exercise the actual RPC → file fallback, rather than only adapting the
// RPC shape. A legal large reply used to fail before reaching the text reader.
describe('large text preview', () => {
  const setup = () => {
    const { deps, fetchRemoteMedia, presignGet } = makeDeps();
    const readPreview = vi.fn<() => Promise<RemoteTextFilePreviewResult>>(async () => ({ success: true, transferRequired: true, size: 5 }));
    const deleteOssObject = vi.fn();
    textIO.size = 5; textIO.text = 'hello'; textIO.read.mockClear();
    fetchRemoteMedia.mockResolvedValue({ ossKey: 'oss/text', size: 5, mimeType: 'text/plain' });
    return { deps: { ...deps, readPreview, deleteOssObject, isCurrent: () => true }, fetchRemoteMedia, presignGet, readPreview, deleteOssObject };
  };
  it.each([false, true])('reads and cleans transferred text, legacy error=%s', async legacy => {
    const h = setup();
    if (legacy) h.readPreview.mockRejectedValue(Object.assign(new Error('too large'), { code: 'PAYLOAD_TOO_LARGE' }));
    expect(await readRemoteTextFilePreview(h.deps, '/tmp/text.txt')).toEqual({ success: true, data: 'hello', size: 5, limitMb: 10 });
    expect(h.fetchRemoteMedia.mock.calls[0][0]).toContain('maxBytes=10485760');
    expect(h.deleteOssObject).toHaveBeenCalledExactlyOnceWith('oss/text');
  });
  it.each(['forbidden', 'not_found', 'oversize'] as const)('does not transfer after host returns %s', async reason => {
    const h = setup();
    const result = { success: false, reason, size: 12 };
    h.readPreview.mockResolvedValue(result);
    expect(await readRemoteTextFilePreview(h.deps, '/tmp/text.txt')).toBe(result);
    expect(h.fetchRemoteMedia).not.toHaveBeenCalled();
  });
  it('keeps small text inline and does not retry connection failures as file reads', async () => {
    const h = setup();
    h.readPreview.mockResolvedValue({ success: true, data: '', size: 0 });
    expect(await readRemoteTextFilePreview(h.deps, '/tmp/text.txt')).toMatchObject({ data: '' });
    h.readPreview.mockRejectedValue(new Error('offline'));
    await expect(readRemoteTextFilePreview(h.deps, '/tmp/text.txt')).rejects.toThrow('offline');
    expect(h.fetchRemoteMedia).not.toHaveBeenCalled();
  });
  it('stops before transferring when cancelled during the RPC', async () => {
    const h = setup();
    const abort = new AbortController();
    h.readPreview.mockImplementation(async () => { abort.abort(); return { success: true, transferRequired: true, size: 5 }; });
    await expect(readRemoteTextFilePreview(h.deps, '/tmp/text.txt', abort.signal)).rejects.toThrow('PREVIEW_CANCELLED');
    expect(h.fetchRemoteMedia).not.toHaveBeenCalled();
  });
  it('cleans an uploaded object even when presigning fails', async () => {
    const h = setup();
    h.presignGet.mockRejectedValue(new Error('offline'));
    await expect(readRemoteTextFilePreview(h.deps, '/tmp/text.txt')).rejects.toThrow('offline');
    expect(h.deleteOssObject).toHaveBeenCalledExactlyOnceWith('oss/text');
  });
  it('rejects truncated data and releases the direct transfer staging file', async () => {
    const h = setup();
    const media = { ossKey: '', size: 6, mimeType: 'text/plain' };
    const dispose = vi.fn();
    recordPeerMedia(media, 'file:///text-staged', dispose);
    h.fetchRemoteMedia.mockResolvedValue(media);
    await expect(readRemoteTextFilePreview(h.deps, '/tmp/text.txt')).rejects.toThrow('PREVIEW_CHANGED');
    expect(dispose).toHaveBeenCalledOnce();
  });
});

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function makeDeps(overrides: Partial<{
  ossKey: string;
  getUrl: string;
  expiresAt: string;
}> = {}) {
  const fetchRemoteMedia = vi.fn<RemoteAbsFileFetchDeps['maker']['fetchRemoteMedia']>(async () => ({
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
  it.each([true, false])('reclaims the cloud object only after a local copy is available: %s', async (downloaded) => {
    const { deps } = makeDeps();
    const local = { ossKey: '', size: 3, mimeType: 'image/png' };
    const uri = 'file:///cached-absolute.png';
    const dispose = vi.fn();
    recordPeerMedia(local, uri, dispose);
    const deleteOssObject = vi.fn();
    const cacheDownload = vi.fn(async () => {
      expect(deleteOssObject).not.toHaveBeenCalled();
      return downloaded ? local : null;
    });
    deps.maker.fetchRemoteMedia = vi.fn(async () => ({
      ...local, ossKey: 'absolute/cloud-key', cacheDownload,
    }));
    try {
      const url = await fetchRemoteAbsFileToUrl({ ...deps, stream: false, deleteOssObject }, '/tmp/shot.png');
      expect(url).toBe(downloaded ? uri : 'https://oss.example/get/abc');
      expect(cacheDownload).toHaveBeenCalledWith('https://oss.example/get/abc');
      expect(deleteOssObject.mock.calls).toEqual(downloaded ? [['absolute/cloud-key']] : []);
      expect(dispose).not.toHaveBeenCalled();
    } finally { clearPeerMedia(); }
  });

  // Unit regression: cancelling HTML preparation while opening a link must not
  // enqueue the file read once that link eventually opens.
  it('does not start a preview file read after cancellation during link setup', async () => {
    const { deps, openLink, fetchRemoteMedia } = makeDeps();
    const controller = new AbortController();
    openLink.mockImplementation(async () => { controller.abort(); });
    await expect(fetchRemoteAbsFileOnce(deps, '/page.html', undefined, undefined, undefined, controller.signal))
      .rejects.toThrow('PREVIEW_CANCELLED');
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(openLink).toHaveBeenCalledOnce();
  });
  it('revalidates complete files while retaining streaming URLs', async () => {
    for (const first of [true, false]) {
      const { deps, fetchRemoteMedia } = makeDeps();
      await fetchRemoteAbsFileToUrl({ ...deps, stream: first }, '/media.mp4');
      await fetchRemoteAbsFileToUrl({ ...deps, stream: !first }, '/media.mp4');
      await fetchRemoteAbsFileToUrl({ ...deps, stream: first }, '/media.mp4');
      expect(fetchRemoteMedia).toHaveBeenCalledTimes(first ? 2 : 3);
      expect(fetchRemoteMedia.mock.calls.map((call) => ((call as unknown[])[1] as { stream?: boolean }).stream)).toEqual(
        first ? [undefined, false] : [false, undefined, false],
      );
    }
  });
  it('aborts an in-flight fetch once the caller cancels and does not retry', async () => {
    const { deps, fetchRemoteMedia, presignGet } = makeDeps();
    let cancelled = false;
    let seenSignal: AbortSignal | undefined;
    fetchRemoteMedia.mockImplementation(
      (...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          seenSignal = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
          seenSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = fetchRemoteAbsFileToUrl(
      { ...deps, stream: false, isCancelled: () => cancelled },
      '/tmp/big.zip',
    );
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    cancelled = true;
    await expect(pending).rejects.toThrow();
    expect(seenSignal?.aborted).toBe(true);
    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(presignGet).not.toHaveBeenCalled();
  });
  it('走 media:fetch 绝对路径通道并 presign 出下载地址', async () => {
    const { deps, fetchRemoteMedia, presignGet } = makeDeps();
    const url = await fetchRemoteAbsFileToUrl(deps, '/tmp/shot.png');
    expect(url).toBe('https://oss.example/get/abc');
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      `xdt-file://open?path=${encodeURIComponent('/tmp/shot.png')}`,
      expect.objectContaining({ beforeFetch: expect.any(Function) }),
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
      expect.objectContaining({ beforeFetch: expect.any(Function) }),
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
