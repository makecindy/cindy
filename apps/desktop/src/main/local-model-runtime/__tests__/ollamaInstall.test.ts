import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { installOfficialSidecar, readSidecarManifest } from '../ollamaInstall.js';
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
});
