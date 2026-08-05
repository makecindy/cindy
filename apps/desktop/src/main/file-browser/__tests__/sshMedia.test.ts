/**
 * sshMedia.test.ts — SSH 聊天媒体管线单测(依赖全注入,不触 SSH / electron)。
 *   - toWorkdirRelPosix:内 / 外 / `..` 逃逸 / workdir 自身 / 尾斜杠
 *   - makeSshChunkExecutor:分片循环写盘、空片防死循环
 *   - serveSshRemoteMedia:400(无路径语义)/ 403(workdir 外)/ 415(非媒体扩展名)
 *     / 404(目录)/ 200 全量 / 206 range / 416 / 502(上游失败)
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  app: { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() },
}));
// 切断 remote-deps 的 SSH pool / 安装器依赖链(生产默认依赖;本测试全部走注入)。
vi.mock('../remote-deps.js', () => ({ getRemoteFileBrowser: vi.fn() }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  makeSshChunkExecutor,
  materializeSshRemoteMedia,
  serveSshRemoteMedia,
  toWorkdirRelPosix,
  type SshMediaDeps,
} from '../ssh-media';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ssh-media-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('toWorkdirRelPosix', () => {
  const wd = '/home/u/proj';
  it('workdir 内 → 相对路径', () => {
    expect(toWorkdirRelPosix(wd, '/home/u/proj/out/a.png')).toBe('out/a.png');
    expect(toWorkdirRelPosix(`${wd}/`, '/home/u/proj/a.png')).toBe('a.png');
  });
  it('workdir 外 / 前缀相似 / 自身 / `..` / 非绝对 → null', () => {
    expect(toWorkdirRelPosix(wd, '/tmp/a.png')).toBeNull();
    expect(toWorkdirRelPosix(wd, '/home/u/proj2/a.png')).toBeNull();
    expect(toWorkdirRelPosix(wd, '/home/u/proj')).toBeNull();
    expect(toWorkdirRelPosix(wd, '/home/u/proj/../secret')).toBeNull();
    expect(toWorkdirRelPosix(wd, 'rel/a.png')).toBeNull();
    expect(toWorkdirRelPosix('rel-wd', '/home/u/proj/a.png')).toBeNull();
  });
});

describe('makeSshChunkExecutor', () => {
  it('分片循环写盘(2 片 + eof),进度按累计字节回报', async () => {
    const chunks = [
      { dataBase64: Buffer.from('hello ').toString('base64'), eof: false, size: 11, mtimeMs: 1 },
      { dataBase64: Buffer.from('world').toString('base64'), eof: true, size: 11, mtimeMs: 1 },
    ];
    let call = 0;
    const request = vi.fn(async () => chunks[call++]) as unknown as SshMediaDeps['request'];
    const dest = path.join(tmpDir, 'out.bin');
    const progress = vi.fn();
    await makeSshChunkExecutor(request, 'h1', '/wd', 'out.bin')(dest, progress);
    expect(await readFile(dest, 'utf8')).toBe('hello world');
    expect(progress).toHaveBeenLastCalledWith(11, 11, 'download');
    expect(request).toHaveBeenCalledWith('h1', 'readFileChunk', {
      workdir: '/wd',
      relPath: 'out.bin',
      offset: 0,
      length: 1024 * 1024,
    });
  });

  it('eof 前的空片 → 抛错(防上游异常导致死循环)', async () => {
    const request = vi.fn(async () => ({ dataBase64: '', eof: false, size: 10, mtimeMs: 1 }));
    const dest = path.join(tmpDir, 'bad.bin');
    await expect(
      makeSshChunkExecutor(request as unknown as SshMediaDeps['request'], 'h1', '/wd', 'x')(dest, vi.fn()),
    ).rejects.toThrow('empty chunk before eof');
  });
});

describe('serveSshRemoteMedia', () => {
  const origin = { remoteHostId: 'host-1', workdir: '/home/u/proj' };

  function makeDeps(overrides?: Partial<SshMediaDeps>): SshMediaDeps {
    return {
      request: vi.fn(async () => ({ type: 'file', size: 4, mtimeMs: 1 })) as unknown as SshMediaDeps['request'],
      fetchToCache: vi.fn(async () => {
        const p = path.join(tmpDir, 'cached.png');
        await writeFile(p, Buffer.from([1, 2, 3, 4]));
        return p;
      }),
      ...overrides,
    };
  }

  it('无路径语义(cache-id / 非 path scheme)→ 400,不触上游', async () => {
    const deps = makeDeps();
    const r = await serveSshRemoteMedia(origin, 'xdt-image://sess/a.png', null, deps);
    expect(r.status).toBe(400);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('workdir 外 → 403', async () => {
    const r = await serveSshRemoteMedia(origin, 'xdt-file://local/?path=%2Ftmp%2Fa.png', null, makeDeps());
    expect(r.status).toBe(403);
  });

  it('非媒体扩展名 → 415(不做任意二进制下载通道)', async () => {
    const r = await serveSshRemoteMedia(
      origin,
      'xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2Fa.exe',
      null,
      makeDeps(),
    );
    expect(r.status).toBe(415);
  });

  it('stat 到目录 → 404', async () => {
    const deps = makeDeps({
      request: vi.fn(async () => ({ type: 'directory', size: 0, mtimeMs: 1 })) as unknown as SshMediaDeps['request'],
    });
    const r = await serveSshRemoteMedia(
      origin,
      'xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2Fdir.png',
      null,
      deps,
    );
    expect(r.status).toBe(404);
  });

  it('happy path:stat → fetchToCache(identity 正确)→ 200 全量', async () => {
    const deps = makeDeps();
    const r = await serveSshRemoteMedia(
      origin,
      'xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2Fout%2Fa.png',
      null,
      deps,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(deps.fetchToCache).toHaveBeenCalledWith(
      {
        transport: 'ssh',
        endpointId: 'host-1',
        workdir: '/home/u/proj',
        relPath: 'out/a.png',
        size: 4,
        mtimeMs: 1,
      },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('materialize 直接返回 device-link 可上传的缓存文件契约', async () => {
    const deps = makeDeps();
    const result = await materializeSshRemoteMedia(
      origin,
      'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fout%2Fa.png&v=message-1',
      deps,
    );
    expect(result).toEqual({
      ok: true,
      cachePath: path.join(tmpDir, 'cached.png'),
      size: 4,
      mime: 'image/png',
      relPath: 'out/a.png',
    });
  });

  it('range → 206 切片;越界 → 416', async () => {
    const url = 'xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2Fa.png';
    const r206 = await serveSshRemoteMedia(origin, url, 'bytes=1-2', makeDeps());
    expect(r206.status).toBe(206);
    expect(r206.headers.get('content-range')).toBe('bytes 1-2/4');
    expect([...new Uint8Array(await r206.arrayBuffer())]).toEqual([2, 3]);

    const r416 = await serveSshRemoteMedia(origin, url, 'bytes=9-', makeDeps());
    expect(r416.status).toBe(416);
    expect(r416.headers.get('content-range')).toBe('bytes */4');
  });

  it('上游失败(stat / 取回抛错)→ 502', async () => {
    const deps = makeDeps({
      request: vi.fn(async () => {
        throw new Error('ssh channel lost');
      }) as unknown as SshMediaDeps['request'],
    });
    const r = await serveSshRemoteMedia(
      origin,
      'xdt-file://local/?path=%2Fhome%2Fu%2Fproj%2Fa.png',
      null,
      deps,
    );
    expect(r.status).toBe(502);
  });
});
