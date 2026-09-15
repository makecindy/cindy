/**
 * 端到端 RPC 测试:server(runFileService)与 client(FileServiceClient)
 * 经内存 PassThrough 管道直连,fs 操作落在 mkdtemp fixture 上——不 spawn
 * 进程、不走 SSH,但除传输外整条链路(codec / 分发 / scanner 安全层 /
 * 错误映射)与生产完全一致。
 */

import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rename, rm, writeFile as fsWriteFile, readFile as fsReadFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runFileService } from '../server.js';
import { FileServiceClient, type FileServiceStream } from '../client.js';
import { FILE_SERVICE_SCHEMA_VERSION } from '../protocol.js';

/** 把两条 PassThrough 包装成 client 侧的 FileServiceStream。 */
function memoryStream(toServer: PassThrough, fromServer: PassThrough): FileServiceStream {
  return {
    write: (data) => void toServer.write(data),
    onStdout: (cb) => {
      const handler = (chunk: Buffer | string): void =>
        cb(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      fromServer.on('data', handler);
      return () => fromServer.off('data', handler);
    },
    onStderr: () => () => {},
    onClose: (cb) => {
      const handler = (): void => cb({ code: 0, signal: null });
      fromServer.on('end', handler);
      return () => fromServer.off('end', handler);
    },
    onError: () => () => {},
    kill: () => {
      toServer.end();
    },
  };
}

describe('remote-file-service RPC end-to-end', () => {
  let workdir: string;
  let toServer: PassThrough;
  let fromServer: PassThrough;
  let serverDone: Promise<void>;
  let client: FileServiceClient;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'rfs-test-'));
    await fsWriteFile(path.join(workdir, '.gitignore'), 'ignored-dir/\n', 'utf8');
    await mkdir(path.join(workdir, 'src'));
    await mkdir(path.join(workdir, 'ignored-dir'));
    await mkdir(path.join(workdir, 'node_modules'));
    await fsWriteFile(path.join(workdir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await fsWriteFile(path.join(workdir, 'README.md'), '# hi\n', 'utf8');
    await fsWriteFile(path.join(workdir, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0a]));

    toServer = new PassThrough();
    fromServer = new PassThrough();
    const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    serverDone = runFileService(toServer, fromServer, { logger: silent });
    client = new FileServiceClient({ stream: memoryStream(toServer, fromServer), requestTimeoutMs: 2000 });
  });

  afterEach(async () => {
    client.dispose();
    await serverDone;
    await rm(workdir, { recursive: true, force: true });
  });

  it('handshake reports matching schema version', async () => {
    const info = await client.connect();
    expect(info.schemaVersion).toBe(FILE_SERVICE_SCHEMA_VERSION);
    expect(info.pid).toBeGreaterThan(0);
  });

  it('listDir shows vcs-ignored entries, hides builtin dirs, sorts dirs before files', async () => {
    await client.connect();
    const { entries } = await client.request('listDir', { workdir });
    const names = entries.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    // 文件树不吃 VCS ignore(honorVcsIgnore: false):真实存在的目录要可见。
    expect(names).toContain('ignored-dir');
    // 内置大目录屏蔽不受开关影响。
    expect(names).not.toContain('node_modules');
    expect(entries[0]?.type).toBe('directory');
  });

  it('readFile returns content and BINARY_FILE for binaries', async () => {
    await client.connect();
    const file = await client.request('readFile', { workdir, relPath: 'src/a.ts' });
    expect(file.content).toBe('export const a = 1;\n');
    expect(file.truncated).toBe(false);

    await expect(client.request('readFile', { workdir, relPath: 'blob.bin' })).rejects.toMatchObject({
      code: 'BINARY_FILE',
    });
  });

  it('rejects path traversal via OPERATION_FAILED', async () => {
    await client.connect();
    await expect(
      client.request('readFile', { workdir, relPath: '../outside.txt' }),
    ).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
  });

  it('write path: writeFile / createFile / createFolder / renameEntry / deleteEntry', async () => {
    await client.connect();

    await client.request('writeFile', { workdir, relPath: 'README.md', content: '# changed\n' });
    expect(await fsReadFile(path.join(workdir, 'README.md'), 'utf8')).toBe('# changed\n');

    const created = await client.request('createFile', { workdir, relPath: 'src/new.ts' });
    expect(created.type).toBe('file');

    const folder = await client.request('createFolder', { workdir, relPath: 'docs' });
    expect(folder.type).toBe('directory');

    const renamed = await client.request('renameEntry', {
      workdir,
      fromRel: 'src/new.ts',
      toRel: 'src/renamed.ts',
    });
    expect(renamed.relPath).toBe('src/renamed.ts');

    await client.request('deleteEntry', { workdir, relPath: 'src/renamed.ts' });
    const { entries } = await client.request('listDir', { workdir, relPath: 'src' });
    expect(entries.map((e) => e.name)).not.toContain('renamed.ts');
  });

  it('writeNewFile creates exclusively and refuses an existing target', async () => {
    await mkdir(path.join(workdir, 'tool-results'));
    const r = await client.request('writeNewFile', { workdir, relPath: 'tool-results/x.json', content: '{"a":1}' });
    expect(r.size).toBe(7);
    expect(await fsReadFile(path.join(workdir, 'tool-results/x.json'), 'utf8')).toBe('{"a":1}');
    await expect(
      client.request('writeNewFile', { workdir, relPath: 'tool-results/x.json', content: 'again' }),
    ).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    await expect(
      client.request('writeNewFile', { workdir, relPath: 'tool-results/y.json', content: 42 as unknown as string }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(typeof r.dev).toBe('string');
    expect(typeof r.ino).toBe('string');
    expect(r.ino).toMatch(/^\d+$/);
  });

  it('verifyNewFile proves content identity and eraseIfSame zeroes only that inode', async () => {
    await mkdir(path.join(workdir, 'tool-results'));
    const written = await client.request('writeNewFile', { workdir, relPath: 'tool-results/v.json', content: '{"v":1}' });
    const sha256 = createHash('sha256').update('{"v":1}').digest('hex');
    const verified = await client.request('verifyNewFile', { workdir, relPath: 'tool-results/v.json', sha256, size: 7 });
    expect(verified).toMatchObject({ dev: written.dev, ino: written.ino, size: 7 });
    await expect(
      client.request('verifyNewFile', { workdir, relPath: 'tool-results/v.json', sha256: 'f'.repeat(64), size: 7 }),
    ).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    await expect(
      client.request('verifyNewFile', { workdir, relPath: 'tool-results/v.json', sha256, size: -1 as number }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await client.request('eraseIfSame', { workdir, relPath: 'tool-results/v.json', dev: written.dev, ino: `${written.ino}0` })).toEqual({ erased: false });
    expect(await client.request('eraseIfSame', { workdir, relPath: 'tool-results/v.json', dev: written.dev, ino: written.ino })).toEqual({ erased: true });
  });

  // Codex P1 (round 29/30): the daemon keeps the writer's descriptor as the caller's inode
  // capability — erase through it needs no pathname; release closes it; params validated.
  it('writeNewFile returns a hold that eraseIfSame can use and releaseNewFile closes', async () => {
    await mkdir(path.join(workdir, 'tool-results'));
    const written = await client.request('writeNewFile', { workdir, relPath: 'tool-results/p.json', content: '{"p":1}' });
    expect(written.holdId).toMatch(/^[0-9a-f-]{36}$/);
    expect(written.durable).toBe(true);
    const sha256 = createHash('sha256').update('{"p":1}').digest('hex');
    const verified = await client.request('verifyNewFile', { workdir, relPath: 'tool-results/p.json', sha256, size: 7 });
    expect(verified).toMatchObject({ ino: written.ino, holdId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await expect(client.request('releaseNewFile', {} as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await client.request('releaseNewFile', { holdId: written.holdId })).toEqual({ released: true });
    expect(await client.request('releaseNewFile', { holdId: written.holdId })).toEqual({ released: false });
    expect(await client.request('releaseNewFile', { holdId: verified.holdId })).toEqual({ released: true });

    const second = await client.request('writeNewFile', { workdir, relPath: 'tool-results/q.json', content: '{"q":1}' });
    await expect(
      client.request('eraseIfSame', { workdir, relPath: 'tool-results/q.json', dev: second.dev, ino: second.ino, holdId: 5 as unknown as string }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // The directory leaves the workdir: the pathname no longer reaches the inode, the hold does.
    await rename(path.join(workdir, 'tool-results'), path.join(workdir, '..', path.basename(workdir) + '-moved'));
    try {
      expect(await client.request('eraseIfSame', { workdir, relPath: 'tool-results/q.json', dev: second.dev, ino: second.ino })).toEqual({ erased: false });
      expect(await client.request('eraseIfSame', { workdir, relPath: 'tool-results/q.json', dev: second.dev, ino: second.ino, holdId: second.holdId })).toEqual({ erased: true });
      expect(await fsReadFile(path.join(workdir, '..', path.basename(workdir) + '-moved', 'q.json'), 'utf8')).toBe('');
    } finally {
      await rm(path.join(workdir, '..', path.basename(workdir) + '-moved'), { recursive: true, force: true });
    }
  });

  it('unknown method → UNKNOWN_METHOD; bad params → BAD_REQUEST', async () => {
    await client.connect();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.request('nonsense' as any, {}),
    ).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.request('readFile', { workdir } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('no rgPath: listAllFiles falls back to JS walk; search fails with RG_UNAVAILABLE', async () => {
    await client.connect();
    // 文件名清单不依赖 rg:纯 JS 遍历 fallback,与文件树同一套 ignore 过滤。
    await fsWriteFile(path.join(workdir, 'ignored-dir', 'hidden.txt'), 'x\n', 'utf8');
    const listed = await client.request('listAllFiles', { workdir });
    expect(listed.truncated).toBe(false);
    expect(listed.files).toContain('README.md');
    expect(listed.files).toContain('src/a.ts');
    expect(listed.files.some((f) => f.startsWith('ignored-dir/'))).toBe(false);
    // 内容搜索仍 rg-only:专属码(不与 BAD_REQUEST 混桶),renderer 映射友好文案。
    await expect(
      client.request('searchStart', { workdir, query: 'x', caseSensitive: false, maxMatches: 10 }),
    ).rejects.toMatchObject({ code: 'RG_UNAVAILABLE' });
  });

  it('readFileChunk round-trips arbitrary (binary) files byte-exactly', async () => {
    await client.connect();
    // 3MB 含 NUL 的模式数据:分片读不做二进制拦截、不做 2MiB 截断。
    const big = Buffer.alloc(3_000_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await fsWriteFile(path.join(workdir, 'big.bin'), big);
    const parts: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const c = await client.request('readFileChunk', {
        workdir,
        relPath: 'big.bin',
        offset,
        length: 1024 * 1024,
      });
      expect(c.size).toBe(3_000_000);
      const buf = Buffer.from(c.dataBase64, 'base64');
      parts.push(buf);
      offset += buf.length;
      if (c.eof) break;
    }
    expect(Buffer.concat(parts).equals(big)).toBe(true);
  });

  it('watchStart streams fileTree events for real fs changes', async () => {
    await client.connect();
    const events: Array<{ workdir: string; type: string; relPath: string }> = [];
    client.onEvent((evt) => {
      if (evt.event === 'fileTree') {
        events.push(evt.data as { workdir: string; type: string; relPath: string });
      }
    });
    await client.request('watchStart', { workdir });
    // fs.watch 就绪与事件推送都是异步的;写文件后轮询等 coalesce 窗口飞完。
    await new Promise((r) => setTimeout(r, 100));
    await fsWriteFile(path.join(workdir, 'src', 'watched.ts'), 'x\n', 'utf8');
    await vi.waitFor(
      () => {
        if (!events.some((e) => e.relPath === 'src/watched.ts')) throw new Error('no event yet');
      },
      { timeout: 3000, interval: 50 },
    );
    const evt = events.find((e) => e.relPath === 'src/watched.ts');
    expect(evt?.workdir).toBe(workdir);
    expect(['add', 'change']).toContain(evt?.type);
    // 文件树不吃 VCS ignore:往 ignored-dir 写要有事件(目录可见,变化要能刷新)。
    events.length = 0;
    await fsWriteFile(path.join(workdir, 'ignored-dir', 'x.txt'), 'y\n', 'utf8');
    await vi.waitFor(
      () => {
        if (!events.some((e) => e.relPath === 'ignored-dir/x.txt')) throw new Error('no event yet');
      },
      { timeout: 3000, interval: 50 },
    );
    // 内置大目录屏蔽不受开关影响:往 node_modules 写不该有事件。
    events.length = 0;
    await fsWriteFile(path.join(workdir, 'node_modules', 'x.txt'), 'y\n', 'utf8');
    await new Promise((r) => setTimeout(r, 250));
    expect(events.filter((e) => e.relPath.startsWith('node_modules/'))).toEqual([]);
    await client.request('watchStop', { workdir });
  });

  it('channel close rejects pending requests and marks client dead', async () => {
    await client.connect();
    toServer.end();
    fromServer.end();
    await serverDone;
    await new Promise((r) => setTimeout(r, 10));
    expect(client.isDead).toBe(true);
    await expect(client.request('stat', { workdir, relPath: 'README.md' })).rejects.toMatchObject({
      code: 'CHANNEL_CLOSED',
    });
  });
});
