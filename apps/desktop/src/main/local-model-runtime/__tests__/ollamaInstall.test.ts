import { readdir, rm, access } from 'node:fs/promises';
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
import { findOllamaBinary } from '../ollamaSidecar.js';

describe('installOfficialSidecar', () => {
  // Integration: a failed repair of the current version must retain both the
  // previous manifest and its runnable binary; extraction uses a new directory.
  it('preserves the running installation when a same-version repair fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ollama-repair-'));
    try {
      const root = path.join(dir, 'ollama-runtime');
      const old = path.join(root, 'v0.32.14', 'ollama');
      await mkdir(path.dirname(old), {recursive: true}); await writeFile(old, 'original');
      const manifest = {version: '0.32.14', binary: old, sha256: 'ab'.repeat(32)};
      await writeFile(path.join(root, 'current.json'), JSON.stringify(manifest));
      await expect(installOfficialSidecar(dir, {platform: 'darwin',
        resolve: async () => ({...manifest, url: 'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz', assetName: 'ollama-darwin.tgz', sizeBytes: 12}),
        download: async () => {}, extract: async (_file, destination) => {
          await mkdir(destination, {recursive: true}); await writeFile(path.join(destination, 'partial'), 'unfinished');
          throw new Error('SYNTHETIC_EXTRACT_FAILURE');
        },
      })).rejects.toThrow('SYNTHETIC_EXTRACT_FAILURE');
      expect(await readSidecarManifest(dir)).toEqual(manifest);
      expect(await readFile(old, 'utf8')).toBe('original');
      expect((await readdir(root)).filter(name => name.startsWith('v0.32.14'))).toEqual(['v0.32.14']);
    } finally { await rm(dir, {recursive: true, force: true}); }
  });

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
    expect((await readdir(path.join(dir, 'ollama-runtime'))).filter(name => name.startsWith('v0.32.14'))).toEqual([]);
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
