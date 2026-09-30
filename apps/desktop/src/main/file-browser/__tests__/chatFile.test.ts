/**
 * chatFile.test.ts — 聊天文件远程取回编排(chat-file.ts)契约。
 * ---------------------------------------------------------------------------
 * 锁四件事:
 *  1. toWorkdirRel 的 POSIX / Windows 两风格换算与 `..` 逃逸拒绝;
 *  2. ssh:workdir 内走 stat + fetchBigFile,workdir 外 OUTSIDE_WORKDIR;
 *  3. device:workdir 内走 deviceStat + fetchBigFile,workdir 外走 media:fetch
 *     任意绝对路径通道落缓存;
 *  4. 失败语义:stat 失败 → NOT_FOUND;取回失败 → stale 兜底命中回历史副本
 *     (stale:true),miss 回 FETCH_FAILED。
 */
import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

// chat-file 经 ssh-media 传递依赖 electron / SSH pool 的模块链,单测全走注入,
// 这里把生产默认依赖链切断(同 sshMedia.test.ts)。
vi.mock('electron', () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  app: { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() },
}));
vi.mock('../remote-deps.js', () => ({ getRemoteFileBrowser: vi.fn() }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  buildDevicePathUrl,
  fetchChatFile,
  statChatFile,
  toWorkdirRel,
  type ChatFileDeps,
} from '../chat-file';

function makeDeps(overrides: Partial<ChatFileDeps> = {}): ChatFileDeps {
  return {
    sshStat: vi.fn().mockResolvedValue({ type: 'file', size: 10, mtimeMs: 1000 }),
    deviceStat: vi.fn().mockResolvedValue({ type: 'file', size: 10, mtimeMs: 1000 }),
    fetchBigFile: vi.fn().mockResolvedValue('/cache/copy.bin'),
    deviceMediaFetch: vi.fn().mockResolvedValue({ ossKey: 'k1', size: 20 }),
    downloadToFile: vi.fn().mockResolvedValue(undefined),
    removeRemote: vi.fn(),
    fetchToCache: vi.fn(async (_id, executor) => {
      await executor('/cache/tmp.part', () => undefined);
      return '/cache/out.bin';
    }) as unknown as ChatFileDeps['fetchToCache'],
    findStale: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const noop = () => undefined;

describe('toWorkdirRel', () => {
  it('POSIX:workdir 内出相对路径,外/逃逸/自身 → null', () => {
    expect(toWorkdirRel('/w/proj', '/w/proj/a/b.txt')).toBe('a/b.txt');
    expect(toWorkdirRel('/w/proj/', '/w/proj/a.txt')).toBe('a.txt');
    expect(toWorkdirRel('/w/proj', '/w/other/a.txt')).toBeNull();
    expect(toWorkdirRel('/w/proj', '/w/proj/../up.txt')).toBeNull();
    expect(toWorkdirRel('/w/proj', '/w/proj')).toBeNull();
    // 前缀相似但不同目录不误判
    expect(toWorkdirRel('/w/proj', '/w/proj2/a.txt')).toBeNull();
  });

  it('`.` 段归一:`/w/./a` 与 `/w/a` 同形(chip join 会保留 ./ 前缀)', () => {
    expect(toWorkdirRel('/w/proj', '/w/proj/./Skills/a.md')).toBe('Skills/a.md');
    expect(toWorkdirRel('C:\\w', 'C:\\w\\.\\a.txt')).toBe('a.txt');
  });

  it('Windows:大小写不敏感前缀 + 反斜杠归一,输出 POSIX 相对路径', () => {
    expect(toWorkdirRel('C:\\Users\\me\\proj', 'C:\\Users\\me\\proj\\out\\a.png')).toBe('out/a.png');
    expect(toWorkdirRel('c:/users/me/proj', 'C:\\USERS\\ME\\PROJ\\a.txt')).toBe('a.txt');
    expect(toWorkdirRel('C:\\w', 'D:\\w\\a.txt')).toBeNull();
    expect(toWorkdirRel('C:\\w', 'C:\\w\\..\\a.txt')).toBeNull();
    // 风格不匹配(POSIX workdir + Windows 路径)→ null
    expect(toWorkdirRel('/w', 'C:\\w\\a.txt')).toBeNull();
  });
});

describe('fetchChatFile — ssh 来源', () => {
  const origin = { kind: 'ssh', remoteHostId: 'h1' } as const;

  it('workdir 内:stat + fetchBigFile(remoteHostId 分支)', async () => {
    const deps = makeDeps();
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/a.txt' }, noop, deps);
    expect(res).toEqual({ ok: true, cachePath: '/cache/copy.bin', stale: false, size: 10 });
    expect(deps.sshStat).toHaveBeenCalledWith('h1', '/w', 'a.txt');
    expect(deps.fetchBigFile).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: 'a.txt', remoteHostId: 'h1' }),
      noop,
    );
  });

  it('workdir 外 → OUTSIDE_WORKDIR,不发任何远端请求', async () => {
    const deps = makeDeps();
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/etc/hosts' }, noop, deps);
    expect(res).toEqual({ ok: false, code: 'OUTSIDE_WORKDIR' });
    expect(deps.sshStat).not.toHaveBeenCalled();
    expect(deps.fetchBigFile).not.toHaveBeenCalled();
  });

  it('stat 真 ENOENT / 目录 → NOT_FOUND(不走 stale)', async () => {
    const deps = makeDeps({
      sshStat: vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory')),
      findStale: vi.fn().mockResolvedValue('/cache/old.bin'),
    });
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/a.txt' }, noop, deps);
    expect(res).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    const dirDeps = makeDeps({
      sshStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 0 }),
    });
    const res2 = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/dir' }, noop, dirDeps);
    expect(res2).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('stat 传输类失败(非 ENOENT):stale 命中回历史副本,miss 回 FETCH_FAILED', async () => {
    const linkDown = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('channel closed'), { code: 'CHANNEL_CLOSED' }));
    const hit = makeDeps({ sshStat: linkDown, findStale: vi.fn().mockResolvedValue('/cache/old.bin') });
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/a.txt' }, noop, hit);
    expect(res).toEqual({ ok: true, cachePath: '/cache/old.bin', stale: true, size: -1 });

    const miss = makeDeps({ sshStat: linkDown });
    const res2 = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/a.txt' }, noop, miss);
    expect(res2).toMatchObject({ ok: false, code: 'FETCH_FAILED' });
  });

  it('取回失败:stale 命中回历史副本,miss 回 FETCH_FAILED', async () => {
    const failFetch = vi.fn().mockRejectedValue(new Error('link down'));
    const hit = makeDeps({
      fetchBigFile: failFetch,
      findStale: vi.fn().mockResolvedValue('/cache/old.bin'),
    });
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/a.txt' }, noop, hit);
    expect(res).toEqual({ ok: true, cachePath: '/cache/old.bin', stale: true, size: -1 });

    const miss = makeDeps({ fetchBigFile: failFetch });
    const res2 = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/a.txt' }, noop, miss);
    expect(res2).toMatchObject({ ok: false, code: 'FETCH_FAILED' });
  });
});

describe('fetchChatFile — device 来源', () => {
  const origin = { kind: 'device', deviceId: 'd1' } as const;

  it('workdir 内:deviceStat + fetchBigFile(deviceId 分支)', async () => {
    const deps = makeDeps();
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/x/b.png' }, noop, deps);
    expect(res).toEqual({ ok: true, cachePath: '/cache/copy.bin', stale: false, size: 10 });
    expect(deps.deviceStat).toHaveBeenCalledWith('d1', '/w', 'x/b.png');
    expect(deps.fetchBigFile).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: 'x/b.png', deviceId: 'd1' }),
      noop,
    );
    expect(deps.deviceMediaFetch).not.toHaveBeenCalled();
  });

  it('Windows 被控端 workdir 内路径正确换算', async () => {
    const deps = makeDeps();
    await fetchChatFile(
      { origin, workdir: 'C:\\Users\\me\\proj', absPath: 'C:\\Users\\me\\proj\\out\\a.png' },
      noop,
      deps,
    );
    expect(deps.deviceStat).toHaveBeenCalledWith('d1', 'C:\\Users\\me\\proj', 'out/a.png');
  });

  it('workdir 外:media:fetch 任意绝对路径通道 → OSS 直下落缓存', async () => {
    const deps = makeDeps();
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/other/c.pdf' }, noop, deps);
    expect(res).toEqual({ ok: true, cachePath: '/cache/out.bin', stale: false, size: 20 });
    expect(deps.deviceMediaFetch).toHaveBeenCalledWith('d1', buildDevicePathUrl('/other/c.pdf'));
    expect(deps.downloadToFile).toHaveBeenCalledWith(
      'k1',
      '/cache/tmp.part',
      undefined,
      expect.any(Function),
    );
    // 用后删 OSS 对象
    expect(deps.removeRemote).toHaveBeenCalledWith('k1');
    expect(deps.deviceStat).not.toHaveBeenCalled();
  });

  it('workdir 内 stat 传输类失败:走 stale 兜底(deviceStat 同 ssh 语义)', async () => {
    const linkDown = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('device offline'), { code: 'DEVICE_OFFLINE' }));
    const hit = makeDeps({ deviceStat: linkDown, findStale: vi.fn().mockResolvedValue('/cache/old.png') });
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/x/b.png' }, noop, hit);
    expect(res).toEqual({ ok: true, cachePath: '/cache/old.png', stale: true, size: -1 });
    // 真 ENOENT 仍是 NOT_FOUND,不走 stale
    const enoent = makeDeps({
      deviceStat: vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory')),
      findStale: vi.fn().mockResolvedValue('/cache/old.png'),
    });
    const res2 = await fetchChatFile({ origin, workdir: '/w', absPath: '/w/x/b.png' }, noop, enoent);
    expect(res2).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('workdir 外缓存命中(executor 被跳过):仍必须删掉本次上传的 OSS 对象', async () => {
    // fetchToCache 模拟命中:不调 executor 直接回缓存路径。
    const deps = makeDeps({
      fetchToCache: vi.fn(async () => '/cache/hit.pdf') as unknown as ChatFileDeps['fetchToCache'],
    });
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/other/c.pdf' }, noop, deps);
    expect(res).toEqual({ ok: true, cachePath: '/cache/hit.pdf', stale: false, size: 20 });
    expect(deps.downloadToFile).not.toHaveBeenCalled();
    // 命中路径没有消费 ossKey,必须补删,否则每次命中泄漏一个对象。
    expect(deps.removeRemote).toHaveBeenCalledWith('k1');
  });

  it('workdir 外:fetchToCache 在 executor 执行前抛错 → 补删已上传的 OSS 对象(泄漏回归)', async () => {
    const deps = makeDeps({
      // executor 从未被调用就拒绝(缓存目录准备失败 / 并发去重 promise 被拒等)
      fetchToCache: vi.fn().mockRejectedValue(new Error('disk full')) as unknown as ChatFileDeps['fetchToCache'],
    });
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/other/c.pdf' }, noop, deps);
    expect(res).toMatchObject({ ok: false, code: 'FETCH_FAILED' });
    // media:fetch 已让被控端上传 k1,catch 路径必须 best-effort 补删
    expect(deps.removeRemote).toHaveBeenCalledWith('k1');
  });

  it('workdir 外 media:fetch 失败:stale 兜底 / FETCH_FAILED', async () => {
    const fail = vi.fn().mockRejectedValue(new Error('offline'));
    const hit = makeDeps({
      deviceMediaFetch: fail,
      findStale: vi.fn().mockResolvedValue('/cache/old.pdf'),
    });
    const res = await fetchChatFile({ origin, workdir: '/w', absPath: '/other/c.pdf' }, noop, hit);
    expect(res).toEqual({ ok: true, cachePath: '/cache/old.pdf', stale: true, size: -1 });

    const miss = makeDeps({ deviceMediaFetch: fail });
    const res2 = await fetchChatFile({ origin, workdir: '/w', absPath: '/other/c.pdf' }, noop, miss);
    expect(res2).toMatchObject({ ok: false, code: 'FETCH_FAILED' });
  });
});

describe('statChatFile — chip 点亮预检', () => {
  const ssh = { kind: 'ssh', remoteHostId: 'h1' } as const;
  const dev = { kind: 'device', deviceId: 'd1' } as const;

  it.each([ssh, dev])('checks command outputs against timestamps from the file-owning host (%j)', async (origin) => {
    const deps = makeDeps();
    const args = { origin, workdir: '/w', absPath: '/w/report.pdf' };
    expect(await statChatFile({ ...args, modifiedWindow: { startMs: 900, endMs: 1100 } }, deps)).toBe('file');
    expect(await statChatFile({ ...args, modifiedWindow: { startMs: 1001, endMs: null } }, deps)).toBe('nonfile');
    expect(await statChatFile({ ...args, modifiedWindow: { startMs: 900, endMs: 1000 } }, deps)).toBe('nonfile');
    const noTimestamp = makeDeps({
      deviceStat: vi.fn().mockResolvedValue({ type: 'file', size: 10 }),
      sshStat: vi.fn().mockResolvedValue({ type: 'file', size: 10 }),
    });
    expect(await statChatFile({ ...args, modifiedWindow: { startMs: 900, endMs: null } }, noTimestamp)).toBe('nonfile');
  });

  it('文件 → file;目录 → directory(chip 点亮,点击定位侧边栏文件浏览器)', async () => {
    const deps = makeDeps();
    expect(await statChatFile({ origin: ssh, workdir: '/w', absPath: '/w/a.txt' }, deps)).toBe('file');
    const dirDeps = makeDeps({
      sshStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 0 }),
      deviceStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 0 }),
    });
    expect(await statChatFile({ origin: ssh, workdir: '/w', absPath: '/w/Skills' }, dirDeps)).toBe('directory');
    expect(await statChatFile({ origin: dev, workdir: '/w', absPath: '/w/Skills' }, dirDeps)).toBe('directory');
  });

  it('`./目录` 形态(截图案例):join 后带 . 段归一,判 directory', async () => {
    const dirDeps = makeDeps({
      deviceStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 0 }),
    });
    const verdict = await statChatFile({ origin: dev, workdir: '/w', absPath: '/w/./Skills' }, dirDeps);
    expect(verdict).toBe('directory');
    expect(dirDeps.deviceStat).toHaveBeenCalledWith('d1', '/w', 'Skills');
  });

  it('不存在(ENOENT/NOT_FOUND)→ nonfile;传输类错误 → unknown(乐观点亮)', async () => {
    const enoent = makeDeps({
      sshStat: vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory')),
    });
    expect(await statChatFile({ origin: ssh, workdir: '/w', absPath: '/w/x.txt' }, enoent)).toBe('nonfile');

    const linkDown = makeDeps({
      sshStat: vi.fn().mockRejectedValue(Object.assign(new Error('channel closed'), { code: 'CHANNEL_CLOSED' })),
    });
    expect(await statChatFile({ origin: ssh, workdir: '/w', absPath: '/w/x.txt' }, linkDown)).toBe('unknown');
  });

  it('ssh workdir 外 → nonfile(点了也是 OUTSIDE_WORKDIR);device workdir 外 → unknown(无 stat 通道)', async () => {
    const deps = makeDeps();
    expect(await statChatFile({ origin: ssh, workdir: '/w', absPath: '/etc/hosts' }, deps)).toBe('nonfile');
    expect(await statChatFile({ origin: dev, workdir: '/w', absPath: '/etc/hosts' }, deps)).toBe('unknown');
    expect(deps.sshStat).not.toHaveBeenCalled();
    expect(deps.deviceStat).not.toHaveBeenCalled();
  });
});

describe('fetchChatFile — 参数校验', () => {
  it('缺 workdir / absPath / origin 形态非法 → BAD_ARGS', async () => {
    const deps = makeDeps();
    const ssh = { kind: 'ssh', remoteHostId: 'h1' } as const;
    expect(await fetchChatFile({ origin: ssh, workdir: '', absPath: '/a' }, noop, deps)).toEqual({
      ok: false,
      code: 'BAD_ARGS',
    });
    expect(await fetchChatFile({ origin: ssh, workdir: '/w', absPath: '' }, noop, deps)).toEqual({
      ok: false,
      code: 'BAD_ARGS',
    });
    expect(
      await fetchChatFile(
        { origin: { kind: 'ssh', remoteHostId: '' }, workdir: '/w', absPath: '/a' },
        noop,
        deps,
      ),
    ).toEqual({ ok: false, code: 'BAD_ARGS' });
    expect(
      await fetchChatFile(
        // @ts-expect-error 非法 origin 形态(线上来自 renderer,防御校验)
        { origin: { kind: 'local' }, workdir: '/w', absPath: '/a' },
        noop,
        deps,
      ),
    ).toEqual({ ok: false, code: 'BAD_ARGS' });
  });
});
