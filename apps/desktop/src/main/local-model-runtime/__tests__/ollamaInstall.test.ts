import { access } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  installOfficialSidecar,
  readSidecarManifest,
  resolveOfficialSidecarAsset,
} from '../ollamaInstall.js';
import { OLLAMA_GITHUB_API_LATEST } from '../ollamaRelease.js';
import { DownloadError } from '../../downloader/index.js';
import { findOllamaBinary } from '../ollamaSidecar.js';

describe('installOfficialSidecar', () => {
  it('writes a sidecar manifest after extract', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ollama-install-'));
    const binary = path.join(dir, 'ollama');
    await writeFile(binary, '#!/bin/sh\n');
    const result = await installOfficialSidecar(dir, {
      platform: 'darwin',
      resolve: async () => ({
        version: '0.32.14',
        url: 'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz',
        sha256: 'ab'.repeat(32),
        sizeBytes: 12,
        assetName: 'ollama-darwin.tgz',
      }),
      download: async () => undefined,
      extract: async () => binary,
    });
    expect(result).toEqual({ version: '0.32.14', binary });
    await expect(readSidecarManifest(dir)).resolves.toMatchObject({
      version: '0.32.14',
      binary,
    });
    expect(JSON.parse(await readFile(path.join(dir, 'ollama-runtime', 'current.json'), 'utf8')).binary).toBe(
      binary,
    );
    await expect(
      access(path.join(dir, 'ollama-runtime', 'downloads', 'ollama-darwin.tgz')),
    ).rejects.toThrow();
  });

  // 测试价值
  // - 生产入口与可观察结果：installOfficialSidecar 推给 maker:local-model:install-progress 的
  //   进度；设置页 Ollama 安装进度条据此显示重试原因、校验与安装阶段。
  // - Bug／规则依据：verified-downloads.md「下载进度与界面」——重试与校验不能看起来像卡住。
  // - 现有覆盖缺口：此前没有任何用例断言安装进度；旧实现丢弃了重试与校验回调。
  // - 最小失败输入：下载中途一次龟速重试，随后完成。
  // - tier：unit（注入下载与解压，临时目录）。
  it('reports retries, verifying and unpacking in the standard download progress', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ollama-install-'));
    const seen: Array<{ phase: string; download?: { phase: string; retryReason?: string } }> = [];
    await installOfficialSidecar(dir, {
      platform: 'darwin',
      resolve: async () => ({
        version: '0.32.14',
        url: 'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz',
        sha256: 'ab'.repeat(32),
        sizeBytes: 100,
        assetName: 'ollama-darwin.tgz',
      }),
      download: async (_asset, _target, opts) => {
        opts?.onProgress?.(40, 100, 10);
        opts?.onRetry?.({
          attempt: 2,
          delayMs: 1,
          cause: new DownloadError('TIMEOUT', 'slow', undefined, undefined, 'slow'),
        });
        opts?.onProgress?.(100, 100, 10);
        opts?.onVerifying?.();
      },
      extract: async () => path.join(dir, 'ollama'),
      onProgress: (progress) => seen.push(progress),
    });
    expect(seen.map((p) => [p.phase, p.download?.phase])).toEqual([
      ['resolving', 'preparing'],
      ['downloading', 'downloading'], // 40% falls inside the throttle window after the reset
      ['downloading', 'retrying'],
      ['downloading', 'downloading'],
      ['verifying', 'verifying'],
      ['extracting', 'installing'],
    ]);
    expect(seen[2]!.download?.retryReason).toBe('slow');
  });

  it('removes a leftover archive after a failed extract', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ollama-install-fail-'));
    await expect(
      installOfficialSidecar(dir, {
        platform: 'darwin',
        resolve: async () => ({
          version: '0.32.14',
          url: 'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz',
          sha256: 'ab'.repeat(32),
          sizeBytes: 12,
          assetName: 'ollama-darwin.tgz',
        }),
        download: async (_asset, destPath) => {
          await mkdir(path.dirname(destPath), { recursive: true });
          await writeFile(destPath, 'archive');
        },
        extract: async () => {
          throw new Error('extract failed');
        },
      }),
    ).rejects.toThrow('extract failed');
    await expect(
      access(path.join(dir, 'ollama-runtime', 'downloads', 'ollama-darwin.tgz')),
    ).rejects.toThrow();
  });

  it('accepts a windows zip asset name', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ollama-install-win-'));
    const binary = path.join(dir, 'ollama.exe');
    await writeFile(binary, 'MZ');
    const result = await installOfficialSidecar(dir, {
      platform: 'win32',
      arch: 'x64',
      resolve: async () => ({
        version: '0.32.14',
        url: 'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-windows-amd64.zip',
        sha256: 'ab'.repeat(32),
        sizeBytes: 12,
        assetName: 'ollama-windows-amd64.zip',
      }),
      download: async () => undefined,
      extract: async () => binary,
    });
    expect(result).toEqual({ version: '0.32.14', binary });
  });

  it('finds ollama.exe in an extracted windows tree', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ollama-find-'));
    const nested = path.join(dir, 'bin');
    await mkdir(nested);
    const binary = path.join(nested, 'ollama.exe');
    await writeFile(binary, 'MZ');
    expect(findOllamaBinary(dir)).toBe(binary);
  });

  it('aborts extraction and does not write the sidecar manifest', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ollama-install-abort-'));
    const abort = new AbortController();
    const pending = installOfficialSidecar(dir, {
      platform: 'darwin',
      signal: abort.signal,
      resolve: async () => ({
        version: '0.32.14',
        url: 'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz',
        sha256: 'ab'.repeat(32),
        sizeBytes: 12,
        assetName: 'ollama-darwin.tgz',
      }),
      download: async (_asset, destPath) => {
        await mkdir(path.dirname(destPath), { recursive: true });
        await writeFile(destPath, 'archive');
      },
      extract: async (_archive, destDir, _platform, signal) => {
        await mkdir(destDir, { recursive: true });
        await writeFile(path.join(destDir, 'partial'), 'partial');
        abort.abort();
        if (signal?.aborted) throw new Error('aborted');
        throw new Error('expected abort');
      },
    });
    await expect(pending).rejects.toThrow('aborted');
    await expect(readSidecarManifest(dir)).resolves.toBeNull();
    await expect(access(path.join(dir, 'ollama-runtime', 'v0.32.14'))).rejects.toThrow();
  });

  it('aborts a hanging GitHub release lookup when cancelled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ollama-install-resolve-abort-'));
    const abort = new AbortController();
    const pending = installOfficialSidecar(dir, {
      platform: 'darwin',
      signal: abort.signal,
      resolve: (_fetch, _platform, _arch, signal) =>
        new Promise((_, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      download: async () => {
        throw new Error('should not download');
      },
      extract: async () => {
        throw new Error('should not extract');
      },
    });
    abort.abort();
    await expect(pending).rejects.toThrow('aborted');
    await expect(readSidecarManifest(dir)).resolves.toBeNull();
  });

  it('passes the abort signal into the GitHub latest lookup', async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(_url).toBe(OLLAMA_GITHUB_API_LATEST);
      expect(init?.signal).toBe(abort.signal);
      abort.abort();
      throw new Error('aborted');
    });
    await expect(
      resolveOfficialSidecarAsset(fetchImpl as typeof fetch, 'darwin', 'arm64', abort.signal),
    ).rejects.toThrow('aborted');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
