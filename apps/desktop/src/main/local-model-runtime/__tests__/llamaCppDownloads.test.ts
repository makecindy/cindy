/**
 * 测试价值（下载部分，2026-11-17 改走共享下载器后重写）
 * - 生产入口与可观察结果：downloadLlamaCppAsset —— 只有校验通过的字节落到目标文件；暂停保留
 *   续传数据、继续后从断点接着下；取消与失败清掉部分文件；坏前缀等待用户显式继续而不被删除。
 * - Bug／规则依据：verified-downloads.md（统一走 main/downloader，摘要必填，来源白名单逐跳检查）；
 *   原自写实现的暂停／继续、坏前缀保留语义不得退化。
 * - 现有覆盖缺口：共享下载器自身的测试不覆盖 llama.cpp 的暂停原因、取消清理和错误名映射。
 * - 最小失败输入：暂停在 5 字节后再继续；暂停后服务器回错 Content-Range；前缀不可读后继续。
 * - tier：unit，临时目录真实文件，stub 全局 fetch（outboundFetch 直连路径）。
 * 连接期计时不覆盖本地前缀哈希由 downloader/__tests__/download.test.ts 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  allowedDownloadUrl,
  downloadLlamaCppAsset,
  pickLlamaCppRelease,
  selectGgufShards,
  resolveHfRepository,
} from '../llamaCppDownloads.js';
import { validLlamaCppFile, validLlamaCppRepo } from '../../../shared/llamaCpp.js';

const fsMocks = vi.hoisted(() => ({ stat: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  stat: fsMocks.stat,
}));
beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsMocks.stat.mockImplementation(fs.stat);
});
afterEach(() => vi.unstubAllGlobals());

const bytes = Buffer.from('GGUF resumed download');
const asset = {
  url: 'https://huggingface.co/owner/repo/resolve/main/model.gguf',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const noRetry = { retry: { maxAttempts: 1 } };
async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'cindy-llamacpp-download-'));
}
/** Sends the first five bytes, then holds the connection open until the request aborts. */
function stallingAfterPrefix(signal: AbortSignal) {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(bytes.subarray(0, 5)));
        signal.addEventListener('abort', () => c.error(signal.reason), { once: true });
      },
    }),
    { headers: { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' } },
  );
}
/** Real pause through the public entry: five bytes on disk, then `DOWNLOAD_PAUSED`. */
async function pausedAfterPrefix(dest: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => stallingAfterPrefix(init.signal!)),
  );
  const controller = new AbortController();
  const running = downloadLlamaCppAsset(asset, dest, 'hf', controller.signal, () => {}, true);
  const settled = running.catch((error) => error);
  // Pause after the prefix reaches disk, not on an earlier progress event.
  await vi.waitFor(async () =>
    expect(await readFile(`${dest}.part`)).toEqual(bytes.subarray(0, 5)),
  );
  controller.abort('DOWNLOAD_PAUSED');
  expect((await settled).name).toBe('AbortError');
}

describe('managed llama.cpp downloads', () => {
  it.each([true, false])(
    'pauses, keeps the prefix and continues from it (server honors Range: %s)',
    async (honorsRange) => {
      const dir = await tempDir();
      const dest = path.join(dir, 'model.gguf');
      try {
        await pausedAfterPrefix(dest);
        expect((await readdir(dir)).sort()).toEqual(['model.gguf.meta.json', 'model.gguf.part']);
        const seen: number[] = [];
        const fetchMock = vi.fn(async (_url, init) => {
          expect(init.headers.Range).toBe('bytes=5-');
          return honorsRange
            ? new Response(bytes.subarray(5), {
                status: 206,
                headers: { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` },
              })
            : new Response(bytes);
        });
        vi.stubGlobal('fetch', fetchMock);
        await downloadLlamaCppAsset(
          asset,
          dest,
          'hf',
          new AbortController().signal,
          (n) => seen.push(n),
          true,
        );
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(seen[0]).toBe(honorsRange ? 5 : 0);
        expect(await readFile(dest)).toEqual(bytes);
        expect(await readdir(dir)).toEqual(['model.gguf']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('removes partial bytes on cancel and when the server returns the wrong range', async () => {
    const dir = await tempDir();
    const dest = path.join(dir, 'model.gguf');
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => stallingAfterPrefix(init.signal!)),
      );
      const controller = new AbortController();
      const running = downloadLlamaCppAsset(asset, dest, 'hf', controller.signal, () => {}, true);
      const settled = running.catch((error) => error);
      await vi.waitFor(async () => expect(await readFile(`${dest}.part`)).toHaveLength(5));
      controller.abort();
      expect((await settled).name).toBe('AbortError');
      expect(await readdir(dir)).toEqual([]);

      await pausedAfterPrefix(dest);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(bytes.subarray(5), {
              status: 206,
              headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
            }),
        ),
      );
      await expect(
        downloadLlamaCppAsset(
          asset,
          dest,
          'hf',
          new AbortController().signal,
          () => {},
          true,
          noRetry,
        ),
      ).rejects.toThrow('DOWNLOAD_FAILED');
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each(['EACCES', 'EPERM', 'EIO'])(
    'retains a paused prefix when stat fails with %s',
    async (code) => {
      const dir = await tempDir();
      const dest = path.join(dir, 'model.gguf');
      try {
        await writeFile(`${dest}.part`, bytes.subarray(0, 5));
        fsMocks.stat.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(
          downloadLlamaCppAsset(asset, dest, 'hf', new AbortController().signal, () => {}, true),
        ).rejects.toThrow('DOWNLOAD_RESUME_READ_FAILED');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await readFile(`${dest}.part`)).toEqual(bytes.subarray(0, 5));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  // Review finding: a full disk while resuming silently paused instead of failing and freeing
  // the partial file as the pre-shared-downloader code did.
  it('fails and frees the partial file when the disk fills up while resuming', async () => {
    const dir = await tempDir();
    const dest = path.join(dir, 'model.gguf');
    try {
      await pausedAfterPrefix(dest);
      const nodeFs = await import('node:fs');
      const open = nodeFs.default.promises.open;
      const diskFull = Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      vi.spyOn(nodeFs.default.promises, 'open').mockImplementation(async (...args) => {
        const handle = await open(...(args as Parameters<typeof open>));
        handle.writeFile = vi.fn(async () => Promise.reject(diskFull)) as never;
        return handle;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(bytes.subarray(5), {
              status: 206,
              headers: { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` },
            }),
        ),
      );
      await expect(
        downloadLlamaCppAsset(
          asset,
          dest,
          'hf',
          new AbortController().signal,
          () => {},
          true,
          noRetry,
        ),
      ).rejects.toThrow('DOWNLOAD_FAILED');
      expect(await readdir(dir)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'retains a paused prefix that cannot be read back for verification',
    async () => {
      const dir = await tempDir();
      const dest = path.join(dir, 'model.gguf');
      try {
        await pausedAfterPrefix(dest);
        await chmod(`${dest}.part`, 0o200);
        vi.stubGlobal(
          'fetch',
          vi.fn(
            async () =>
              new Response(bytes.subarray(5), {
                status: 206,
                headers: { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` },
              }),
          ),
        );
        await expect(
          downloadLlamaCppAsset(
            asset,
            dest,
            'hf',
            new AbortController().signal,
            () => {},
            true,
            noRetry,
          ),
        ).rejects.toThrow('DOWNLOAD_RESUME_READ_FAILED');
        await chmod(`${dest}.part`, 0o600);
        expect(await readFile(`${dest}.part`)).toEqual(bytes.subarray(0, 5));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('rejects paths, shell arguments, untrusted hosts and credential-bearing URLs', () => {
    for (const file of [
      'MMPROJ-F16.gguf',
      'sub/mtp-model.gguf',
      'DFlash_model.gguf',
      'mmproj.gguf',
    ])
      expect(validLlamaCppFile(file)).toBe(false);
    for (const repo of ['../model', 'owner/../../foo', 'https://huggingface.co/a/b', '-hf a/b'])
      expect(validLlamaCppRepo(repo)).toBe(false);
    for (const file of ['../model.gguf', '/tmp/a.gguf', 'x\\a.gguf', 'a\n.gguf', 'mmproj-F16.gguf'])
      expect(validLlamaCppFile(file)).toBe(false);
    expect(validLlamaCppRepo('Qwen/Qwen3-GGUF')).toBe(true);
    expect(validLlamaCppFile('Q4/model-00001-of-00002.gguf')).toBe(true);
    for (const url of [
      'http://huggingface.co/a',
      'https://huggingface.co.evil.test/a',
      'https://user:pass@huggingface.co/a',
      'https://127.0.0.1/a',
    ])
      expect(allowedDownloadUrl(url, 'hf')).toBe(false);
    expect(
      allowedDownloadUrl(
        'https://github.com/evil/llama.cpp/releases/download/b1/llama-bin.zip',
        'github',
      ),
    ).toBe(false);
  });
  it('selects a platform build with a published checksum, skipping metadata-only releases', () => {
    const releases = [
      { tag_name: 'v0.5.0', assets: [] },
      {
        tag_name: 'b11177',
        assets: ['macos-arm64.tar.gz', 'win-cpu-x64.zip'].map((suffix) => ({
          name: `llama-b11177-bin-${suffix}`,
          browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/b11177/llama-b11177-bin-${suffix}`,
          digest: `sha256:${'a'.repeat(64)}`,
          size: 10,
        })),
      },
    ];
    expect(pickLlamaCppRelease(releases, 'darwin', 'arm64').version).toBe('b11177');
    expect(pickLlamaCppRelease(releases, 'win32', 'x64').name).toContain('win-cpu');
    expect(() => pickLlamaCppRelease(releases, 'linux', 's390x')).toThrow('UNSUPPORTED');
    releases[1]!.assets[0]!.digest = '';
    expect(() => pickLlamaCppRelease(releases, 'darwin', 'arm64')).toThrow('RELEASE_UNAVAILABLE');
  });
  it('downloads every shard and rejects an incomplete set before downloading anything', () => {
    const files = [1, 2].map((n) => ({
      name: `Q4/model-0000${n}-of-00002.gguf`,
      size: 10,
      sha256: 'a'.repeat(64),
    }));
    expect(selectGgufShards(files, files[1]!.name)).toEqual(files);
    expect(() => selectGgufShards(files.slice(0, 1), files[0]!.name)).toThrow('MODEL_INCOMPLETE');
  });
  it('pins downloads to the repository revision and only exposes hashed GGUF weights', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          sha: 'b'.repeat(40),
          siblings: [
            { rfilename: 'a.gguf', lfs: { size: 4, sha256: 'a'.repeat(64) } },
            { rfilename: 'unsafe.gguf' },
            { rfilename: '../bad.gguf', lfs: { size: 4, sha256: 'a'.repeat(64) } },
          ],
        }),
      ),
    );
    const result = await resolveHfRepository('owner/repo', new AbortController().signal);
    expect(result.revision).toBe('b'.repeat(40));
    expect(result.files.map((f) => f.name)).toEqual(['a.gguf']);
  });
  it('only promotes verified bytes and keeps redirects on the allowed hosts', async () => {
    const dir = await tempDir();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const dest = path.join(dir, 'model.gguf');
      await downloadLlamaCppAsset(asset, dest, 'hf', new AbortController().signal, () => {});
      expect(await readFile(dest)).toEqual(bytes);
      await expect(
        downloadLlamaCppAsset(
          { ...asset, sha256: 'a'.repeat(64) },
          path.join(dir, 'bad.gguf'),
          'hf',
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow('DOWNLOAD_CHECKSUM');
      expect(await readdir(dir)).toEqual(['model.gguf']);
      fetchMock.mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
      );
      await expect(
        downloadLlamaCppAsset(
          asset,
          path.join(dir, 'redirect.gguf'),
          'hf',
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow('DOWNLOAD_BLOCKED');
      expect(fetchMock).toHaveBeenLastCalledWith(asset.url, expect.anything());
      expect(await readdir(dir)).toEqual(['model.gguf']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
