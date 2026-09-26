import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
const mocks = vi.hoisted(() => ({ download: vi.fn(), cleanup: vi.fn() }));
vi.mock('../../downloader/index.js', () => mocks);
import { downloadOfficialAsset } from '../ollamaInstall';
import { isAllowedOllamaDownloadUrl } from '../ollamaRelease';

describe('Ollama shared download adapter', () => {
  it('delegates official URL policy, byte limits, cancellation and progress', async () => {
    const asset = {
      version: '0.32.14',
      url: 'https://github.com/ollama/ollama/releases/download/v0.32.14/ollama-darwin.tgz',
      sha256: 'a'.repeat(64),
      sizeBytes: 100,
      assetName: 'ollama-darwin.tgz',
    };
    const signal = new AbortController().signal;
    const progress = vi.fn();
    const target = path.join(os.tmpdir(), 'no-actual-download');
    mocks.download.mockImplementation(async (opts) => {
      opts.onProgress({ loaded: 50, total: 100, speedBps: 10 });
    });
    await downloadOfficialAsset(asset, target, { signal, onProgress: progress });
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: asset.url,
        targetPath: target,
        expectedSize: 100,
        maxBytes: 100,
        sha256: asset.sha256,
        isUrlAllowed: isAllowedOllamaDownloadUrl,
        signal,
      }),
    );
    expect(progress).toHaveBeenCalledWith(50, 100, 10);
  });
});
