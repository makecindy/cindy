/**
 * chatDownload.test.ts — 远程「下载到本地」编排(chat-download.ts)。
 * 锁:
 *  1. 文件复用取回链路后落到下载文件夹,重名加编号,不覆盖已有文件;
 *  2. 文件夹(device):旧被控端不声明 dirExport → REMOTE_UNSUPPORTED;新被控端轮询到
 *     done 后取回分段、解包,最终改名进下载文件夹,暂存目录不残留;
 *  3. 文件夹(ssh):远端 tar 流直接解包;tar 非零退出且一个字节都没收到 → 失败;
 *  4. 取回链路的失败 code 原样透传。
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../remote-deps.js', () => ({ getRemoteFileBrowser: vi.fn() }));

import { downloadChatEntry, type ChatDownloadDeps } from '../chat-download';
import { packDirectory } from '../dir-archive';
import { isWorkdirRoot } from '../../../shared/workdirPath';

let tmp: string;
let downloads: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'chat-download-test-'));
  downloads = path.join(tmp, 'Downloads');
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function buildTar(): Promise<Buffer> {
  const src = path.join(tmp, 'fixture');
  await fsp.mkdir(path.join(src, 'Contents'), { recursive: true });
  await fsp.writeFile(path.join(src, 'Contents', 'a.txt'), 'hello');
  const chunks: Buffer[] = [];
  for await (const c of packDirectory(src, () => undefined)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function makeDeps(overrides: Partial<ChatDownloadDeps> = {}): ChatDownloadDeps {
  return {
    downloadsDir: () => downloads,
    sshStat: vi.fn().mockResolvedValue({ type: 'file', size: 5, mtimeMs: 1 }),
    deviceStat: vi.fn().mockResolvedValue({ type: 'file', size: 5, mtimeMs: 1 }),
    fetchFile: vi.fn(),
    deviceOp: vi.fn(),
    receivePart: vi.fn(),
    discardPart: vi.fn().mockResolvedValue(undefined),
    sshTar: vi.fn(),
    pollMs: 1,
    ...overrides,
  };
}

const device = { kind: 'device', deviceId: 'dev-1' } as const;
const ssh = { kind: 'ssh', remoteHostId: 'host-1' } as const;

describe('downloadChatEntry', () => {
  it('文件:取回后复制进下载文件夹,重名加编号', async () => {
    const cache = path.join(tmp, 'cache.bin');
    await fsp.writeFile(cache, 'data');
    const deps = makeDeps({
      fetchFile: vi.fn().mockResolvedValue({ ok: true, cachePath: cache, stale: true, size: 4 }),
    });
    const args = { origin: device, workdir: '/w', absPath: '/w/out/report.txt' };

    const first = await downloadChatEntry(args, () => undefined, deps);
    const second = await downloadChatEntry(args, () => undefined, deps);

    expect(first).toEqual({
      ok: true,
      path: path.join(downloads, 'report.txt'),
      stale: true,
      skipped: 0,
    });
    expect(second).toMatchObject({ ok: true, path: path.join(downloads, 'report (1).txt') });
    expect(await fsp.readFile(path.join(downloads, 'report (1).txt'), 'utf8')).toBe('data');
  });

  it('文件:取回链路的失败 code 原样返回', async () => {
    const deps = makeDeps({
      deviceStat: vi.fn().mockRejectedValue(new Error('ENOENT')),
      fetchFile: vi.fn().mockResolvedValue({ ok: false, code: 'NOT_FOUND' }),
    });
    expect(
      await downloadChatEntry(
        { origin: device, workdir: '/w', absPath: '/w/missing.txt' },
        () => undefined,
        deps,
      ),
    ).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('文件夹(device):旧被控端没有 dirExport 能力 → REMOTE_UNSUPPORTED', async () => {
    const deps = makeDeps({
      deviceStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 1 }),
      deviceOp: vi.fn().mockRejectedValue(new Error('unknown op: caps')),
    });
    const res = await downloadChatEntry(
      { origin: device, workdir: '/w', absPath: '/w/Game.app' },
      () => undefined,
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: 'REMOTE_UNSUPPORTED' });
    expect(await fsp.readdir(downloads)).toEqual([]);
  });

  it('文件夹(device):轮询到 done 后取回、解包、改名进下载文件夹', async () => {
    const archive = await buildTar();
    const statuses = [
      { ok: true, state: 'packing', packed: 100, sent: 0, total: 0, skipped: 0 },
      { ok: true, state: 'sending', packed: 0, sent: 10, total: archive.length, skipped: 0 },
      {
        ok: true,
        state: 'done',
        packed: 0,
        sent: archive.length,
        total: archive.length,
        skipped: 1,
        file: { ref: 'peer-ref', size: archive.length, sha256: 'b'.repeat(64) },
      },
    ];
    const deviceOp = vi.fn(async (_id: string, args: Record<string, unknown>) => {
      if (args.op === 'caps') return { ok: true, dirExport: true };
      if (args.op === 'exportDirStart') return { ok: true, transferId: 't1' };
      return statuses.shift();
    });
    const receivePart = vi.fn(async (_id: string, _part: unknown, dest: string) => {
      await fsp.writeFile(dest, archive);
    });
    const phases: string[] = [];
    const deps = makeDeps({
      deviceStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 1 }),
      deviceOp: deviceOp as ChatDownloadDeps['deviceOp'],
      receivePart,
    });
    // 已有同名文件夹 → 编号避让。
    await fsp.mkdir(path.join(downloads, 'Game.app'), { recursive: true });

    const res = await downloadChatEntry(
      { origin: device, workdir: '/w', absPath: '/w/build/Game.app' },
      (_r, _t, phase) => phases.push(phase),
      deps,
    );

    const target = path.join(downloads, 'Game (1).app');
    expect(res).toEqual({ ok: true, path: target, stale: false, skipped: 1 });
    expect(await fsp.readFile(path.join(target, 'Contents', 'a.txt'), 'utf8')).toBe('hello');
    expect(deviceOp).toHaveBeenCalledWith('dev-1', {
      op: 'exportDirStart',
      workdir: '/w',
      relPath: 'build/Game.app',
    });
    expect(receivePart.mock.calls[0][0]).toBe('dev-1');
    expect(phases).toEqual(expect.arrayContaining(['pack', 'upload', 'extract']));
    expect((await fsp.readdir(downloads)).sort()).toEqual(['Game (1).app', 'Game.app']);
  });

  it('文件:复制进下载文件夹失败时不留半截文件', async () => {
    const deps = makeDeps({
      fetchFile: vi.fn().mockResolvedValue({
        ok: true,
        cachePath: path.join(tmp, 'gone.bin'),
        stale: false,
        size: 4,
      }),
    });
    const res = await downloadChatEntry(
      { origin: device, workdir: '/w', absPath: '/w/report.txt' },
      () => undefined,
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: 'FETCH_FAILED' });
    expect(await fsp.readdir(downloads)).toEqual([]);
  });

  it('工作目录本身按文件夹下载(relPath 为空,不走单文件取回)', async () => {
    const archive = await buildTar();
    const sshTar = vi.fn(async () => {
      const stream = new PassThrough();
      stream.end(archive);
      return { stream, done: Promise.resolve(0), stderr: () => '', kill: vi.fn() };
    });
    const deps = makeDeps({ sshTar });
    const res = await downloadChatEntry(
      { origin: ssh, workdir: '/home/u/proj', absPath: '/home/u/proj/' },
      () => undefined,
      deps,
    );
    expect(res).toMatchObject({ ok: true, path: path.join(downloads, 'proj') });
    expect(sshTar).toHaveBeenCalledWith('host-1', '/home/u/proj');
    expect(deps.sshStat).not.toHaveBeenCalled();
    expect(deps.fetchFile).not.toHaveBeenCalled();
  });

  it('Windows 被控端:写法不同的工作目录本身也按目录下载', async () => {
    const deviceOp = vi.fn(async (_id: string, args: Record<string, unknown>) => {
      if (args.op === 'caps') return { ok: true, dirExport: true };
      return { ok: false, message: 'stop here' };
    });
    const deps = makeDeps({ deviceOp: deviceOp as ChatDownloadDeps['deviceOp'] });
    await downloadChatEntry(
      { origin: device, workdir: 'C:/Repo', absPath: 'c:\\repo\\' },
      () => undefined,
      deps,
    );
    expect(deviceOp).toHaveBeenCalledWith('dev-1', {
      op: 'exportDirStart',
      workdir: 'C:/Repo',
      relPath: '',
    });
    expect(deps.fetchFile).not.toHaveBeenCalled();
  });

  it('文件夹(device):中途失败时放弃已推来但没取走的分段', async () => {
    const part = (n: number) => ({ ref: `peer-${n}`, size: 10, sha256: String(n).repeat(64) });
    const deviceOp = vi.fn(async (_id: string, args: Record<string, unknown>) => {
      if (args.op === 'caps') return { ok: true, dirExport: true };
      if (args.op === 'exportDirStart') return { ok: true, transferId: 't1' };
      return {
        ok: true,
        state: 'done',
        packed: 0,
        sent: 20,
        total: 20,
        skipped: 0,
        parts: [part(1), part(2)],
        file: { size: 20, parts: [part(1), part(2)] },
      };
    });
    let calls = 0;
    const receivePart = vi.fn(async (_id: string, _part: unknown, dest: string) => {
      if (++calls === 2) throw new Error('FILE_PEER_INTEGRITY');
      await fsp.writeFile(dest, Buffer.alloc(10));
    });
    const deps = makeDeps({
      deviceStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 1 }),
      deviceOp: deviceOp as ChatDownloadDeps['deviceOp'],
      receivePart,
    });
    const res = await downloadChatEntry(
      { origin: device, workdir: '/w', absPath: '/w/Game.app' },
      () => undefined,
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: 'FETCH_FAILED' });
    expect(deps.discardPart).toHaveBeenCalledTimes(1);
    expect(deps.discardPart).toHaveBeenCalledWith('dev-1', part(2));
    expect(await fsp.readdir(downloads)).toEqual([]);
  });

  it('文件夹(device):远端导出失败 → FETCH_FAILED,不留暂存目录', async () => {
    const deps = makeDeps({
      deviceStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 1 }),
      deviceOp: vi.fn(async (_id: string, args: Record<string, unknown>) => {
        if (args.op === 'caps') return { ok: true, dirExport: true };
        if (args.op === 'exportDirStart') return { ok: true, transferId: 't1' };
        return {
          ok: true,
          state: 'error',
          message: 'ENOSPC: no space left',
          parts: [{ ref: 'peer-a', size: 5, sha256: 'c'.repeat(64) }],
        };
      }) as ChatDownloadDeps['deviceOp'],
    });
    const res = await downloadChatEntry(
      { origin: device, workdir: '/w', absPath: '/w/Game.app' },
      () => undefined,
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: 'NO_SPACE' });
    expect(deps.discardPart).toHaveBeenCalledWith('dev-1', {
      ref: 'peer-a',
      size: 5,
      sha256: 'c'.repeat(64),
    });
    expect(await fsp.readdir(downloads)).toEqual([]);
  });

  it('文件夹(ssh):远端 tar 流直接解包', async () => {
    const archive = await buildTar();
    const sshTar = vi.fn(async () => {
      const stream = new PassThrough();
      stream.end(archive);
      return { stream, done: Promise.resolve(0), stderr: () => '', kill: vi.fn() };
    });
    const deps = makeDeps({
      sshStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 1 }),
      sshTar,
    });
    const res = await downloadChatEntry(
      { origin: ssh, workdir: '/home/u/proj', absPath: '/home/u/proj/dist' },
      () => undefined,
      deps,
    );
    expect(res).toEqual({ ok: true, path: path.join(downloads, 'dist'), stale: false, skipped: 0 });
    expect(sshTar).toHaveBeenCalledWith('host-1', '/home/u/proj/dist');
    expect(await fsp.readFile(path.join(downloads, 'dist', 'Contents', 'a.txt'), 'utf8')).toBe(
      'hello',
    );
  });

  it('文件夹(ssh):通道异常关闭(无退出码)即使收到过内容也判失败', async () => {
    const archive = await buildTar();
    const deps = makeDeps({
      sshStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 1 }),
      sshTar: vi.fn(async () => {
        const stream = new PassThrough();
        stream.end(archive);
        return { stream, done: Promise.resolve(null), stderr: () => '', kill: vi.fn() };
      }),
    });
    const res = await downloadChatEntry(
      { origin: ssh, workdir: '/home/u/proj', absPath: '/home/u/proj/dist' },
      () => undefined,
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: 'FETCH_FAILED' });
    expect(await fsp.readdir(downloads)).toEqual([]);
  });

  it('文件:中止信号传入取回链路,取回期间中止则不落盘', async () => {
    const cache = path.join(tmp, 'cache.bin');
    await fsp.writeFile(cache, 'data');
    const abort = new AbortController();
    const fetchFile = vi.fn(async (_a: unknown, _p: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
      return { ok: true as const, cachePath: cache, stale: false, size: 4 };
    });
    const deps = makeDeps({ fetchFile: fetchFile as ChatDownloadDeps['fetchFile'] });
    const res = await downloadChatEntry(
      { origin: device, workdir: '/w', absPath: '/w/report.txt' },
      () => undefined,
      deps,
      abort.signal,
    );
    expect(res).toMatchObject({ ok: false });
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(await fsp.readdir(downloads).catch(() => [])).toEqual([]);
  });

  it('发起方消失(abort)后停止轮询,不落盘', async () => {
    const abort = new AbortController();
    let polls = 0;
    const deps = makeDeps({
      deviceStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 1 }),
      deviceOp: vi.fn(async (_id: string, args: Record<string, unknown>) => {
        if (args.op === 'caps') return { ok: true, dirExport: true };
        if (args.op === 'exportDirStart') return { ok: true, transferId: 't1' };
        if (++polls === 2) abort.abort();
        return { ok: true, state: 'packing', packed: 1, sent: 0, total: 0, skipped: 0, parts: [] };
      }) as ChatDownloadDeps['deviceOp'],
    });
    const res = await downloadChatEntry(
      { origin: device, workdir: '/w', absPath: '/w/Game.app' },
      () => undefined,
      deps,
      abort.signal,
    );
    expect(res).toMatchObject({ ok: false });
    expect(polls).toBe(2);
    expect(await fsp.readdir(downloads)).toEqual([]);
  });

  it('文件夹(ssh):tar 失败且没有任何输出 → FETCH_FAILED', async () => {
    const deps = makeDeps({
      sshStat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtimeMs: 1 }),
      sshTar: vi.fn(async () => {
        const stream = new PassThrough();
        stream.end();
        return {
          stream,
          done: Promise.resolve(127),
          stderr: () => 'tar: not found',
          kill: vi.fn(),
        };
      }),
    });
    const res = await downloadChatEntry(
      { origin: ssh, workdir: '/home/u/proj', absPath: '/home/u/proj/dist' },
      () => undefined,
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: 'FETCH_FAILED' });
    expect(await fsp.readdir(downloads)).toEqual([]);
  });
});

describe('isWorkdirRoot', () => {
  it('按 toWorkdirRel 同一套归一判断是否为工作目录本身', () => {
    expect(isWorkdirRoot('/w/proj', '/w/proj/')).toBe(true);
    expect(isWorkdirRoot('/w/proj/', '/w/./proj')).toBe(true);
    expect(isWorkdirRoot('/w/proj', '/w/proj/a')).toBe(false);
    expect(isWorkdirRoot('C:/Repo', 'c:\\repo\\')).toBe(true);
    expect(isWorkdirRoot('C:\\Repo', 'C:/Repo/sub')).toBe(false);
    expect(isWorkdirRoot('/w/proj', 'C:/w/proj')).toBe(false);
  });
});
