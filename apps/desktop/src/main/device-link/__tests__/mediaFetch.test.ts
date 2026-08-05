/**
 * mediaFetch.test.ts — 被控端入方向媒体取件:原始媒体 URL → 本地路径解析 → 上传 OSS。
 * mock cache-store resolver + mediaTransfer + fs,验 scheme 路由 / 路径解析 / 上传委托,
 * 以及图片上传去重缓存(命中复用 / skipCache / 源文件变化 / TTL / 非图片不缓存)。
 */
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const imageResolve = vi.hoisted(() => vi.fn());
const videoResolve = vi.hoisted(() => vi.fn());
vi.mock('../../imageCacheStore.js', () => ({ resolveSafe: imageResolve }));
vi.mock('../../videoCacheStore.js', () => ({ resolveSafe: videoResolve }));

const uploadLocalFile = vi.hoisted(() => vi.fn());
vi.mock('../mediaTransfer.js', () => ({ uploadLocalFile }));

const materializeSshRemoteMedia = vi.hoisted(() => vi.fn());
vi.mock('../../file-browser/ssh-media.js', () => ({ materializeSshRemoteMedia }));

const getSessionFsSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../../localDb/ipc/sessions.js', () => ({ getSessionFsSnapshot }));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const statMock = vi.hoisted(() => vi.fn());
const realpathMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ stat: statMock, realpath: realpathMock }));

import { fetchLocalMediaToOss, __testing } from '../mediaFetch.js';

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_THROW';
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  __testing.uploadCache.clear();
  statMock.mockResolvedValue({ size: 42, mtimeMs: 1000 });
  realpathMock.mockImplementation(async (p: string) => p);
  // 默认上传回显 contentType,便于断言 result.mimeType 来源
  uploadLocalFile.mockImplementation(async (_p: string, opts?: { contentType?: string }) => ({
    key: 'cindy/device-link/u/uuid.ext',
    size: 42,
    contentType: opts?.contentType ?? 'application/octet-stream',
  }));
  materializeSshRemoteMedia.mockResolvedValue({
    ok: true,
    cachePath: '/cache/ssh/plot.png',
    size: 42,
    mime: 'image/png',
    relPath: 'artifacts/plot.png',
  });
  getSessionFsSnapshot.mockResolvedValue({
    workingDir: '/home/u/proj',
    permissionMode: 'default',
    planModeEnabled: false,
    remoteHostId: 'host-1',
  });
});

afterEach(() => {
  __testing.setThumbnailRenderer(null);
  vi.useRealTimers();
});

describe('fetchLocalMediaToOss — scheme 路由', () => {
  it('xdt-image:// → imageCacheStore.resolveSafe,mime 透传给上传', async () => {
    imageResolve.mockReturnValue({ absPath: '/cache/a.png', mimeType: 'image/png' });
    const r = await fetchLocalMediaToOss({ url: 'xdt-image://sess/a.png' });
    expect(imageResolve).toHaveBeenCalledWith('xdt-image://sess/a.png');
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/a.png', { contentType: 'image/png' });
    expect(r).toEqual({ ossKey: 'cindy/device-link/u/uuid.ext', mimeType: 'image/png', size: 42 });
  });

  it('xdt-video:// → videoCacheStore.resolveSafe', async () => {
    videoResolve.mockReturnValue({ absPath: '/cache/v.mp4', mimeType: 'video/mp4' });
    const r = await fetchLocalMediaToOss({ url: 'xdt-video://sess/v.mp4' });
    expect(videoResolve).toHaveBeenCalledWith('xdt-video://sess/v.mp4');
    expect(r.mimeType).toBe('video/mp4');
  });

  it('xdt-file://local/?path= → 绝对路径,mime 由上传按 ext 推断(extHint 取请求扩展名)', async () => {
    const filePath = path.resolve('/tmp/x.pdf');
    await fetchLocalMediaToOss({ url: 'xdt-file://local/?path=%2Ftmp%2Fx.pdf' });
    expect(uploadLocalFile).toHaveBeenCalledWith(filePath, { extHint: '.pdf' });
    expect(imageResolve).not.toHaveBeenCalled();
    expect(videoResolve).not.toHaveBeenCalled();
  });

  it('xdt-audio://local/?path= → 同 file', async () => {
    const audioPath = path.resolve('/tmp/s.mp3');
    await fetchLocalMediaToOss({ url: 'xdt-audio://local/?path=%2Ftmp%2Fs.mp3' });
    expect(uploadLocalFile).toHaveBeenCalledWith(audioPath, { extHint: '.mp3' });
  });

  it('SSH xdt-file → 远程磁盘缓存→上传，不触发本机 realpath', async () => {
    const url = 'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fartifacts%2Fplot.png'
      + '&sessionId=session-ssh&remoteHostId=host-1&workdir=%2Fhome%2Fu%2Fproj&v=message-1';
    const result = await fetchLocalMediaToOss({ url });

    expect(getSessionFsSnapshot).toHaveBeenCalledWith('session-ssh');
    expect(materializeSshRemoteMedia).toHaveBeenCalledWith(
      { remoteHostId: 'host-1', workdir: '/home/u/proj' },
      url,
    );
    expect(realpathMock).not.toHaveBeenCalled();
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/ssh/plot.png', { contentType: 'image/png' });
    expect(result).toEqual({
      ossKey: 'cindy/device-link/u/uuid.ext',
      mimeType: 'image/png',
      size: 42,
    });
  });

  it('SSH 远程图片复用本地缓存文件生成 inline 缩略图', async () => {
    __testing.setThumbnailRenderer(async (p) => {
      expect(p).toBe('/cache/ssh/plot.png');
      return Buffer.from([7, 8]);
    });
    const url = 'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fartifacts%2Fplot.png'
      + '&sessionId=session-ssh&remoteHostId=host-1&workdir=%2Fhome%2Fu%2Fproj';
    const result = await fetchLocalMediaToOss({ url, thumbnail: true });

    expect(result.inlineBase64).toBe(Buffer.from([7, 8]).toString('base64'));
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });
});

describe('fetchLocalMediaToOss — 校验', () => {
  it('缺 url → 抛错', async () => {
    expect(await codeOf(() => fetchLocalMediaToOss({}))).toMatch(/缺少 url/);
    expect(await codeOf(() => fetchLocalMediaToOss(null))).toMatch(/缺少 url/);
  });
  it('不支持的 scheme → 抛错', async () => {
    expect(await codeOf(() => fetchLocalMediaToOss({ url: 'https://x/y.png' }))).toMatch(/不支持/);
    expect(await codeOf(() => fetchLocalMediaToOss({ url: 'xdt-model://s/m.glb' }))).toMatch(/不支持/);
  });
  it('file path 非绝对 → 抛错,不上传', async () => {
    expect(await codeOf(() => fetchLocalMediaToOss({ url: 'xdt-file://local/?path=rel.png' }))).toMatch(/绝对路径/);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });
  it('file 缺 path → 抛错', async () => {
    expect(await codeOf(() => fetchLocalMediaToOss({ url: 'xdt-file://local/' }))).toMatch(/缺少 path/);
  });
  it.each([
    'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fa.png&remoteHostId=host-1',
    'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fa.png&workdir=%2Fhome%2Fu%2Fproj',
    'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fa.png&sessionId=session-ssh&remoteHostId=&workdir=',
    'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fa.png&remoteHostId=host-1&workdir=%2Fhome%2Fu%2Fproj',
  ])('SSH 参数缺失或为空 → 拒绝且不回落本机路径（%s）', async (url) => {
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/SSH 媒体参数不完整/);
    expect(materializeSshRemoteMedia).not.toHaveBeenCalled();
    expect(realpathMock).not.toHaveBeenCalled();
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });
  it('SSH session 不存在 → 拒绝且不触碰远端文件服务', async () => {
    getSessionFsSnapshot.mockResolvedValueOnce(null);
    const url = 'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fa.png'
      + '&sessionId=missing&remoteHostId=host-1&workdir=%2Fhome%2Fu%2Fproj';
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/会话不存在/);
    expect(materializeSshRemoteMedia).not.toHaveBeenCalled();
  });
  it('本地 session 不能授权 SSH 媒体取件', async () => {
    getSessionFsSnapshot.mockResolvedValueOnce({
      workingDir: '/repo',
      permissionMode: 'default',
      planModeEnabled: false,
      remoteHostId: null,
    });
    const url = 'xdt-file://open?path=%2Frepo%2Fa.png'
      + '&sessionId=session-local&remoteHostId=host-1&workdir=%2Frepo';
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/不是有效的 SSH 会话/);
    expect(materializeSshRemoteMedia).not.toHaveBeenCalled();
  });
  it.each([
    ['other-host', '/home/u/proj'],
    ['host-1', '/'],
  ])('SSH URL host/workdir 与会话记录不一致 → 拒绝（%s, %s）', async (remoteHostId, workdir) => {
    const url = 'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fa.png'
      + `&sessionId=session-ssh&remoteHostId=${encodeURIComponent(remoteHostId)}`
      + `&workdir=${encodeURIComponent(workdir)}`;
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/上下文与会话记录不一致/);
    expect(materializeSshRemoteMedia).not.toHaveBeenCalled();
  });
  it('SSH materialize 拒绝 → 保留状态语义且不上传', async () => {
    materializeSshRemoteMedia.mockResolvedValueOnce({
      ok: false,
      status: 403,
      message: '媒体路径不在 SSH 会话工作目录内',
    });
    const url = 'xdt-file://open?path=%2Ftmp%2Fa.png'
      + '&sessionId=session-ssh&remoteHostId=host-1&workdir=%2Fhome%2Fu%2Fproj';
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/SSH 媒体取回失败（403）/);
    expect(realpathMock).not.toHaveBeenCalled();
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });
});

describe('fetchLocalMediaToOss — 敏感目录黑名单(与 xdt-file 协议同边界)', () => {
  const sshPng = path.join(os.homedir(), '.ssh', 'id_rsa.png');

  it('realpath 落在敏感目录 → 拒绝取件,不上传', async () => {
    const url = `xdt-file://local/?path=${encodeURIComponent(sshPng)}`;
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/敏感目录/);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('symlink 逃逸进敏感目录(realpath 后命中)→ 拒绝', async () => {
    realpathMock.mockResolvedValue(sshPng); // /tmp/innocent.png 实为 ~/.ssh 内文件的 symlink
    const url = 'xdt-file://local/?path=%2Ftmp%2Finnocent.png';
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/敏感目录/);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('字面路径命中敏感目录但 realpath 指向别处(后建 symlink 根)→ 仍拒绝', async () => {
    realpathMock.mockResolvedValue(path.resolve('/mnt/secrets/id_rsa.png'));
    const url = `xdt-file://local/?path=${encodeURIComponent(sshPng)}`;
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/敏感目录/);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('文件不存在(realpath ENOENT)→ 拒绝', async () => {
    realpathMock.mockRejectedValue(new Error('ENOENT'));
    const url = 'xdt-file://local/?path=%2Ftmp%2Fmissing.png';
    expect(await codeOf(() => fetchLocalMediaToOss({ url }))).toMatch(/不存在或不可读/);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('正常路径放行,上传使用 realpath 结果(关 TOCTOU 窗口),ext 取请求路径', async () => {
    const realTarget = path.resolve('/mnt/vol/real.pdf');
    realpathMock.mockResolvedValue(realTarget);
    await fetchLocalMediaToOss({ url: 'xdt-file://local/?path=%2Ftmp%2Fx.pdf' });
    // 字节读 realpath,但语义扩展名取请求路径(此处两者一致)
    expect(uploadLocalFile).toHaveBeenCalledWith(realTarget, { extHint: '.pdf' });
  });

  it('symlink 目标扩展名不同 → 上传按请求 URL 的扩展名(不因 realpath 目标退成 octet-stream)', async () => {
    // 请求 foo.mp3,realpath 落到无扩展名(或异扩展名)的真实目标
    realpathMock.mockResolvedValue(path.resolve('/mnt/blobstore/abc123'));
    await fetchLocalMediaToOss({ url: 'xdt-file://local/?path=%2Ftmp%2Ffoo.mp3' });
    expect(uploadLocalFile).toHaveBeenCalledWith(path.resolve('/mnt/blobstore/abc123'), {
      extHint: '.mp3',
    });
  });

  it('xdt-image://(app 缓存解析)不经黑名单 realpath 校验', async () => {
    imageResolve.mockReturnValue({ absPath: '/cache/a.png', mimeType: 'image/png' });
    await fetchLocalMediaToOss({ url: 'xdt-image://sess/a.png' });
    expect(realpathMock).not.toHaveBeenCalled();
  });
});

describe('fetchLocalMediaToOss — 图片上传去重', () => {
  const IMAGE_URL = 'xdt-image://sess/a.png';

  function nextUploadKey(key: string) {
    uploadLocalFile.mockImplementation(async (_p: string, opts?: { contentType?: string }) => ({
      key,
      size: 42,
      contentType: opts?.contentType ?? 'application/octet-stream',
    }));
  }

  beforeEach(() => {
    imageResolve.mockReturnValue({ absPath: '/cache/a.png', mimeType: 'image/png' });
  });

  it('mtime/size 未变、TTL 内 → 复用上次 ossKey,不重复上传', async () => {
    const first = await fetchLocalMediaToOss({ url: IMAGE_URL });
    nextUploadKey('key-2');
    const second = await fetchLocalMediaToOss({ url: IMAGE_URL });
    expect(second).toEqual({ ossKey: first.ossKey, mimeType: 'image/png', size: 42 });
    expect(uploadLocalFile).toHaveBeenCalledTimes(1);
  });

  it('skipCache → 强制重传并刷新缓存', async () => {
    await fetchLocalMediaToOss({ url: IMAGE_URL });
    nextUploadKey('key-2');
    const forced = await fetchLocalMediaToOss({ url: IMAGE_URL, skipCache: true });
    expect(forced.ossKey).toBe('key-2');
    expect(uploadLocalFile).toHaveBeenCalledTimes(2);
    // 重传后的新 key 进缓存,后续正常请求直接命中
    nextUploadKey('key-3');
    const after = await fetchLocalMediaToOss({ url: IMAGE_URL });
    expect(after.ossKey).toBe('key-2');
    expect(uploadLocalFile).toHaveBeenCalledTimes(2);
  });

  it('源文件 mtime 变化 → 缓存失效重传', async () => {
    await fetchLocalMediaToOss({ url: IMAGE_URL });
    statMock.mockResolvedValue({ size: 42, mtimeMs: 2000 });
    nextUploadKey('key-2');
    const changed = await fetchLocalMediaToOss({ url: IMAGE_URL });
    expect(changed.ossKey).toBe('key-2');
    expect(uploadLocalFile).toHaveBeenCalledTimes(2);
  });

  it('TTL 过期 → 重传', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await fetchLocalMediaToOss({ url: IMAGE_URL });
    vi.setSystemTime(__testing.UPLOAD_CACHE_TTL_MS + 1);
    nextUploadKey('key-2');
    const expired = await fetchLocalMediaToOss({ url: IMAGE_URL });
    expect(expired.ossKey).toBe('key-2');
    expect(uploadLocalFile).toHaveBeenCalledTimes(2);
  });

  it('非图片(xdt-video://)永不缓存', async () => {
    videoResolve.mockReturnValue({ absPath: '/cache/v.mp4', mimeType: 'video/mp4' });
    await fetchLocalMediaToOss({ url: 'xdt-video://sess/v.mp4' });
    await fetchLocalMediaToOss({ url: 'xdt-video://sess/v.mp4' });
    expect(uploadLocalFile).toHaveBeenCalledTimes(2);
    expect(__testing.uploadCache.size).toBe(0);
    expect(statMock).not.toHaveBeenCalled();
  });

  it('超出条目上限 FIFO 淘汰最旧', async () => {
    for (let i = 0; i < __testing.UPLOAD_CACHE_MAX + 1; i += 1) {
      imageResolve.mockReturnValue({ absPath: `/cache/${i}.png`, mimeType: 'image/png' });
      nextUploadKey(`key-${i}`);
      await fetchLocalMediaToOss({ url: `xdt-image://sess/${i}.png` });
    }
    expect(__testing.uploadCache.size).toBe(__testing.UPLOAD_CACHE_MAX);
    expect(__testing.uploadCache.has('xdt-image://sess/0.png')).toBe(false);
    expect(__testing.uploadCache.has(`xdt-image://sess/${__testing.UPLOAD_CACHE_MAX}.png`)).toBe(true);
  });
});

describe('__testing.parsePathQuery', () => {
  it('POSIX / Windows 绝对路径放行', () => {
    expect(__testing.parsePathQuery('xdt-file://local/?path=%2Fabs%2Fx.pdf')).toBe(path.resolve('/abs/x.pdf'));
    expect(__testing.parsePathQuery('xdt-file://local/?path=C%3A%5Cusers%5Cx.pdf')).toMatch(/x\.pdf$/);
  });
});

describe('thumbnail inline 回包', () => {
  afterEach(() => {
    __testing.setThumbnailRenderer(null);
  });

  it('图片 + thumbnail:true → 缩略图 inline base64 回包,不上传 OSS', async () => {
    imageResolve.mockReturnValue({ absPath: '/cache/a.png', mimeType: 'image/png' });
    __testing.setThumbnailRenderer(async () => Buffer.from([1, 2, 3]));
    const out = await fetchLocalMediaToOss({ url: 'xdt-image://sess/a.png', thumbnail: true });
    expect(out).toEqual({
      ossKey: '',
      mimeType: 'image/webp',
      size: 3,
      inlineBase64: Buffer.from([1, 2, 3]).toString('base64'),
    });
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('渲染失败 / 放弃(null)/ 产物超限 → 回落原图上传路径', async () => {
    imageResolve.mockReturnValue({ absPath: '/cache/a.png', mimeType: 'image/png' });

    __testing.setThumbnailRenderer(async () => { throw new Error('sharp boom'); });
    let out = await fetchLocalMediaToOss({ url: 'xdt-image://sess/a.png', thumbnail: true });
    expect(out.inlineBase64).toBeUndefined();
    expect(out.ossKey).not.toBe('');

    __testing.setThumbnailRenderer(async () => null);
    out = await fetchLocalMediaToOss({ url: 'xdt-image://sess/a.png', thumbnail: true, skipCache: true });
    expect(out.inlineBase64).toBeUndefined();

    __testing.setThumbnailRenderer(async () => Buffer.alloc(__testing.THUMB_INLINE_MAX_BYTES + 1));
    out = await fetchLocalMediaToOss({ url: 'xdt-image://sess/a.png', thumbnail: true, skipCache: true });
    expect(out.inlineBase64).toBeUndefined();
    expect(uploadLocalFile).toHaveBeenCalledTimes(3);
  });

  it('gif 动图不缩(静帧是语义损失),直接原图路径', async () => {
    imageResolve.mockReturnValue({ absPath: '/cache/anim.gif', mimeType: 'image/gif' });
    const renderer = vi.fn(async () => Buffer.from([1]));
    __testing.setThumbnailRenderer(renderer);
    const out = await fetchLocalMediaToOss({ url: 'xdt-image://sess/anim.gif', thumbnail: true });
    expect(renderer).not.toHaveBeenCalled();
    expect(out.inlineBase64).toBeUndefined();
  });

  it('xdt-file 无 mime 时按扩展名判定可缩', async () => {
    __testing.setThumbnailRenderer(async () => Buffer.from([9]));
    const out = await fetchLocalMediaToOss({
      url: 'xdt-file://local/?path=%2Fabs%2Fshot.PNG',
      thumbnail: true,
    });
    expect(out.inlineBase64).toBe(Buffer.from([9]).toString('base64'));
  });
});

describe('thumbnail 护栏(输入体量 + 渲染超时)', () => {
  afterEach(() => {
    __testing.setThumbnailRenderer(null);
    vi.useRealTimers();
  });

  it('输入超过 48MB 上限 → 不调渲染器,直接原图路径', async () => {
    imageResolve.mockReturnValue({ absPath: '/cache/huge.png', mimeType: 'image/png' });
    statMock.mockResolvedValue({ size: __testing.THUMB_INPUT_MAX_BYTES + 1, mtimeMs: 1 });
    const renderer = vi.fn(async () => Buffer.from([1]));
    __testing.setThumbnailRenderer(renderer);
    const out = await fetchLocalMediaToOss({ url: 'xdt-image://sess/huge.png', thumbnail: true });
    expect(renderer).not.toHaveBeenCalled();
    expect(out.inlineBase64).toBeUndefined();
    expect(uploadLocalFile).toHaveBeenCalledTimes(1);
  });

  it('渲染超时 → 回退原图路径,invoke 不被挂住', async () => {
    vi.useFakeTimers();
    imageResolve.mockReturnValue({ absPath: '/cache/slow.png', mimeType: 'image/png' });
    statMock.mockResolvedValue({ size: 1000, mtimeMs: 1 });
    __testing.setThumbnailRenderer(() => new Promise(() => { /* 永不 resolve,模拟 sharp 卡死 */ }));
    const pending = fetchLocalMediaToOss({ url: 'xdt-image://sess/slow.png', thumbnail: true, skipCache: true });
    await vi.advanceTimersByTimeAsync(__testing.THUMB_RENDER_TIMEOUT_MS + 1);
    const out = await pending;
    expect(out.inlineBase64).toBeUndefined();
    expect(out.ossKey).not.toBe('');
    expect(uploadLocalFile).toHaveBeenCalledTimes(1);
  });
});
