import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Tiny models with real content hashes exercise the same cache validation as production.
vi.mock('@cindy/voice-input-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/voice-input-core')>();
  const assets = [
    { role: 'vad', fileName: 'vad.onnx', sha256: createHash('sha256').update(Buffer.alloc(8)).digest('hex'), bytes: 8 },
    { role: 'embedding', fileName: 'embed.onnx', sha256: createHash('sha256').update(Buffer.alloc(16)).digest('hex'), bytes: 16 },
  ] as const;
  return {
    ...actual,
    SPEAKER_MODEL_ASSETS: assets,
    SPEAKER_MODEL_TOTAL_BYTES: 24,
    speakerModelAsset: (role: string) => assets.find((asset) => asset.role === role),
  };
});

const { SpeakerModelStore } = await import('../speakerModelStore');
const { DownloadError, createDownloader } = await import('../../../downloader');
const { SPEAKER_MODEL_ASSETS, speakerModelLocalName, speakerModelCdnPath } = await import('@cindy/voice-input-core');

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-speaker-models-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

type DownloadCall = { url: string; targetPath: string; expectedSize?: number; sha256?: string };

function fakeDownload(calls: DownloadCall[], fail?: (call: DownloadCall) => Error | undefined) {
  return vi.fn(async (options: DownloadCall & { onProgress?: (event: { loaded: number }) => void }) => {
    calls.push(options);
    const error = fail?.(options);
    if (error) throw error;
    options.onProgress?.({ loaded: options.expectedSize ?? 0 });
    fs.writeFileSync(options.targetPath, Buffer.alloc(options.expectedSize ?? 0));
    return { path: options.targetPath, size: options.expectedSize ?? 0, sha256: options.sha256 ?? '', fromCache: false };
  });
}

function createStore(download: ReturnType<typeof fakeDownload>, cdn = 'https://cdn.example.com/') {
  return new SpeakerModelStore({
    dir: () => dir,
    cdnBaseUrl: () => cdn,
    download: download as never,
  });
}

describe('SpeakerModelStore', () => {
  it('reports missing until every model is on disk, then ready', async () => {
    const calls: DownloadCall[] = [];
    const store = createStore(fakeDownload(calls));
    expect(store.getModelPaths()).toBeNull();
    expect(store.getState().modelState).toBe('missing');

    await store.ensureDownloaded();

    expect(calls.map((call) => call.url)).toEqual(
      SPEAKER_MODEL_ASSETS.map((asset) => `https://cdn.example.com/${speakerModelCdnPath(asset)}`),
    );
    expect(calls.every((call) => call.sha256 && call.expectedSize)).toBe(true);
    expect(store.getState()).toMatchObject({ modelState: 'ready', downloadedBytes: 24, totalBytes: 24 });
    expect(store.getModelPaths()).toEqual({
      vadModel: path.join(dir, speakerModelLocalName(SPEAKER_MODEL_ASSETS[0])),
      embeddingModel: path.join(dir, speakerModelLocalName(SPEAKER_MODEL_ASSETS[1])),
    });
  });

  it('joins a running download instead of starting another', async () => {
    const calls: DownloadCall[] = [];
    const store = createStore(fakeDownload(calls));
    await Promise.all([store.ensureDownloaded(), store.ensureDownloaded()]);
    expect(calls).toHaveLength(2);
  });

  it('skips models already present and removes files of older versions', async () => {
    fs.writeFileSync(path.join(dir, speakerModelLocalName(SPEAKER_MODEL_ASSETS[0])), Buffer.alloc(8));
    fs.writeFileSync(path.join(dir, 'old-model.onnx'), 'stale');
    const calls: DownloadCall[] = [];
    await createStore(fakeDownload(calls)).ensureDownloaded();
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'old-model.onnx'))).toBe(false);
  });

  it('rejects same-size corrupt cached models and replaces them through the real downloader', async () => {
    for (const asset of SPEAKER_MODEL_ASSETS) {
      fs.writeFileSync(path.join(dir, speakerModelLocalName(asset)), Buffer.alloc(asset.bytes, 1));
    }
    const request = vi.fn(async (url: string) => {
      const asset = SPEAKER_MODEL_ASSETS.find((entry) => url.endsWith(speakerModelCdnPath(entry)))!;
      return { response: new Response(new Uint8Array(asset.bytes), {
        headers: { 'content-length': String(asset.bytes) },
      }) };
    });
    const download = createDownloader();
    const store = new SpeakerModelStore({
      dir: () => dir,
      cdnBaseUrl: () => 'https://cdn.example.com',
      download: (options) => download({ ...options, request }),
    });

    expect(store.getState().modelState).toBe('missing');
    expect(store.getModelPaths()).toBeNull();
    await store.ensureDownloaded();
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.getState().modelState).toBe('ready');
    for (const asset of SPEAKER_MODEL_ASSETS) {
      expect(createHash('sha256').update(fs.readFileSync(path.join(dir, speakerModelLocalName(asset)))).digest('hex'))
        .toBe(asset.sha256);
    }
  });

  it('reuses hash checks until a cached file changes, then downloads only that model', async () => {
    const calls: DownloadCall[] = [];
    const store = createStore(fakeDownload(calls));
    await store.ensureDownloaded();
    expect(store.getState().modelState).toBe('ready');
    const read = vi.spyOn(fs, 'readFileSync');
    store.getState();
    store.getModelPaths();
    await store.ensureDownloaded();
    expect(read).not.toHaveBeenCalled();

    const asset = SPEAKER_MODEL_ASSETS[0];
    const file = path.join(dir, speakerModelLocalName(asset));
    fs.writeFileSync(file, Buffer.alloc(asset.bytes, 1));
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(store.getState().modelState).toBe('missing');
    expect(store.getModelPaths()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);

    await store.ensureDownloaded();
    expect(calls).toHaveLength(3);
    expect(calls[2].targetPath).toBe(file);
    expect(store.getState().modelState).toBe('ready');
  });

  it('invalidates a replaced file even when its size and modification time are preserved', async () => {
    const store = createStore(fakeDownload([]));
    await store.ensureDownloaded();
    const asset = SPEAKER_MODEL_ASSETS[0];
    const file = path.join(dir, speakerModelLocalName(asset));
    const modified = new Date(1_000);
    fs.utimesSync(file, modified, modified);
    expect(store.getState().modelState).toBe('ready');

    const replacement = path.join(dir, 'replacement');
    fs.writeFileSync(replacement, Buffer.alloc(asset.bytes, 1));
    fs.utimesSync(replacement, modified, modified);
    fs.renameSync(replacement, file);
    expect(store.getState().modelState).toBe('missing');
    expect(store.getModelPaths()).toBeNull();
  });

  it('rejects a file changed during verification instead of caching the earlier bytes', async () => {
    const store = createStore(fakeDownload([]));
    await store.ensureDownloaded();
    const asset = SPEAKER_MODEL_ASSETS[0];
    const file = path.join(dir, speakerModelLocalName(asset));
    const readFile = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce((...args) => {
      const data = readFile(...args);
      fs.writeFileSync(file, Buffer.alloc(asset.bytes, 1));
      fs.utimesSync(file, new Date(0), new Date(0));
      return data;
    });
    // A fresh store has no cached result and must validate the files on disk.
    const reopened = createStore(fakeDownload([]));
    expect(reopened.getState().modelState).toBe('missing');
    expect(reopened.getModelPaths()).toBeNull();
  });

  it('does not retain verification after a cached file disappears', async () => {
    const store = createStore(fakeDownload([]));
    await store.ensureDownloaded();
    expect(store.getState().modelState).toBe('ready');
    const asset = SPEAKER_MODEL_ASSETS[0];
    const file = path.join(dir, speakerModelLocalName(asset));
    fs.unlinkSync(file);
    expect(store.getState().modelState).toBe('missing');
    fs.writeFileSync(file, Buffer.alloc(asset.bytes, 1));
    expect(store.getModelPaths()).toBeNull();
  });

  it('classifies a checksum failure and allows a retry', async () => {
    const calls: DownloadCall[] = [];
    let failOnce = true;
    const store = createStore(
      fakeDownload(calls, () => {
        if (!failOnce) return undefined;
        failOnce = false;
        return new DownloadError('CHECKSUM', 'mismatch');
      }),
    );
    await expect(store.ensureDownloaded()).rejects.toThrow('mismatch');
    expect(store.getState()).toMatchObject({ modelState: 'failed', downloadError: 'checksum' });

    await store.ensureDownloaded();
    expect(store.getState().modelState).toBe('ready');
  });

  it('treats a user cancel as missing, not failed', async () => {
    const store = createStore(fakeDownload([], () => new DownloadError('ABORTED', 'aborted')));
    await expect(store.ensureDownloaded()).rejects.toThrow();
    expect(store.getState()).toMatchObject({ modelState: 'missing' });
    expect(store.getState().downloadError).toBeUndefined();
  });

  it('refuses a CDN base that is not https', async () => {
    const calls: DownloadCall[] = [];
    const store = createStore(fakeDownload(calls), '');
    await expect(store.ensureDownloaded()).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(store.getState()).toMatchObject({ modelState: 'failed', downloadError: 'unavailable' });
  });
});
