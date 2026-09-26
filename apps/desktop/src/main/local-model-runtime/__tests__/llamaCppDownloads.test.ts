import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

afterEach(() => vi.unstubAllGlobals());
describe('managed llama.cpp downloads', () => {
  it.each([true, false])(
    'resumes and verifies a saved prefix (server honors Range: %s)',
    async (honorsRange) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-llamacpp-resume-test-'));
      const bytes = Buffer.from('GGUF resumed download');
      const asset = {
        url: 'https://huggingface.co/owner/repo/resolve/main/model.gguf',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const dest = path.join(dir, 'model.gguf');
      try {
        await writeFile(`${dest}.partial`, bytes.subarray(0, 5));
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
          () => {},
          true,
        );
        expect(await readFile(dest)).toEqual(bytes);
        expect(await readdir(dir)).toEqual(['model.gguf']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('preserves paused bytes, rejects mismatched ranges, and removes corrupt prefixes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-llamacpp-pause-test-'));
    const bytes = Buffer.from('GGUF resumed download');
    const dest = path.join(dir, 'model.gguf');
    const asset = {
      url: 'https://huggingface.co/owner/repo/resolve/main/model.gguf',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    try {
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(bytes.subarray(0, 5));
                },
              }),
            ),
        ),
      );
      const running = downloadLlamaCppAsset(asset, dest, 'hf', controller.signal, () => {}, true);
      const paused = expect(running).rejects.toThrow();
      try {
        // Pause after the prefix reaches disk, not on the transform's earlier progress event.
        await vi.waitFor(async () => {
          expect(await readFile(`${dest}.partial`)).toEqual(bytes.subarray(0, 5));
        });
      } finally {
        controller.abort('DOWNLOAD_PAUSED');
        await paused;
      }
      expect(await readFile(`${dest}.partial`)).toEqual(bytes.subarray(0, 5));
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
        downloadLlamaCppAsset(asset, dest, 'hf', new AbortController().signal, () => {}, true),
      ).rejects.toThrow('DOWNLOAD_FAILED');
      expect(await readdir(dir)).toEqual([]);
      await writeFile(`${dest}.partial`, Buffer.alloc(bytes.length, 0));
      await expect(
        downloadLlamaCppAsset(asset, dest, 'hf', new AbortController().signal, () => {}, true),
      ).rejects.toThrow('DOWNLOAD_CHECKSUM');
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
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
  it('only promotes verified bytes and removes partial files on checksum failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-llamacpp-download-test-'));
    const bytes = Buffer.from('GGUF test');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fetchMock = vi.fn().mockImplementation(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const dest = path.join(dir, 'model.gguf');
      const asset = {
        url: 'https://huggingface.co/owner/repo/resolve/main/model.gguf',
        size: bytes.length,
        sha256,
      };
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
      expect(await readdir(dir)).toEqual(['model.gguf']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
