/**
 * dirExport.test.ts — 被控端文件夹导出任务(打包 → 分段推送 → 终态)。
 * 锁:超过分段上限时按段推送、进度单调、终态带回分段引用;失败时清掉已传的 OSS
 * 对象;临时目录在任何终态都被删除。
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../device-link/index.js', () => ({ remoteInvoke: vi.fn() }));
vi.mock('../../device-link/filePeer.js', () => ({ tryUploadPeerAttachment: vi.fn() }));
vi.mock('../../device-link/mediaTransfer.js', () => ({
  MAX_MEDIA_BYTES: 2 ** 31,
  removeRemote: vi.fn(),
  uploadLocalFile: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getDirExportStatus, startDirExport, type DirExportDeps } from '../dir-export';

let tmp: string;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dir-export-test-'));
});
afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function waitTerminal(id: string) {
  for (let i = 0; i < 200; i++) {
    const status = getDirExportStatus(id);
    if (status?.state === 'done' || status?.state === 'error') return status;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
}

function makeDeps(overrides: Partial<DirExportDeps> = {}): DirExportDeps & { temps: string } {
  const temps = path.join(tmp, 'temp');
  return {
    temps,
    tempRoot: () => temps,
    maxPartBytes: 4096,
    removeRemote: vi.fn(),
    sendPart: vi.fn(async (_controller, file: string, onProgress) => {
      const size = (await fsp.stat(file)).size;
      onProgress(size);
      return { ref: `ref-${size}`, size, sha256: 'a'.repeat(64), ossKey: `key-${size}` };
    }),
    ...overrides,
  };
}

describe('startDirExport', () => {
  it('打包后按分段推送给控制端,终态带回分段引用并清掉临时目录', async () => {
    const dir = path.join(tmp, 'src');
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'big.bin'), Buffer.alloc(10_000, 7));
    const deps = makeDeps();
    await fsp.mkdir(deps.temps);

    const status = await waitTerminal(startDirExport(dir, 'ctrl-1', deps));

    expect(status.state).toBe('done');
    expect(status.total).toBeGreaterThan(10_000);
    expect(status.sent).toBe(status.total);
    expect(status.file).toMatchObject({ size: status.total });
    expect((status.file as { parts: unknown[] }).parts.length).toBeGreaterThan(1);
    expect(status.parts).toEqual((status.file as { parts: unknown[] }).parts);
    expect(deps.sendPart).toHaveBeenCalledWith(
      'ctrl-1',
      expect.any(String),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    // 成功时 OSS 对象留给控制端取件后删除。
    expect(deps.removeRemote).not.toHaveBeenCalled();
    expect(await fsp.readdir(deps.temps)).toEqual([]);
  });

  it('推送失败:终态 error,已传的 OSS 对象被清理,临时目录被删', async () => {
    const dir = path.join(tmp, 'src');
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'big.bin'), Buffer.alloc(10_000, 7));
    let calls = 0;
    const deps = makeDeps({
      sendPart: vi.fn(async (_c, file: string) => {
        if (++calls === 2) throw new Error('relay down');
        const size = (await fsp.stat(file)).size;
        return { ref: 'r', size, sha256: 'a'.repeat(64), ossKey: 'first-key' };
      }),
    });
    await fsp.mkdir(deps.temps);

    const status = await waitTerminal(startDirExport(dir, 'ctrl-1', deps));

    expect(status).toMatchObject({ state: 'error', message: 'relay down' });
    // 已推出的分段随失败终态告诉控制端,由它清理收件箱。
    expect(status.parts).toHaveLength(1);
    expect(deps.removeRemote).toHaveBeenCalledWith('first-key');
    expect(await fsp.readdir(deps.temps)).toEqual([]);
  });

  it('未知 transfer 返回 null', () => {
    expect(getDirExportStatus('dir_missing')).toBeNull();
  });
});
