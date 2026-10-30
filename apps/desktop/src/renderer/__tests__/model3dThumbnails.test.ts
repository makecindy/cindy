// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const render = vi.fn();
const dispose = vi.fn();
const createThumbnailRenderer = vi.fn(() => ({ render, dispose }));

vi.mock('@/lib/model3d/modelViewerSdk', () => ({
  loadModelViewerSdk: vi.fn(async () => ({ createThumbnailRenderer })),
}));

const readModelFileBytes = vi.fn();
const statPath = vi.fn();

const { getModel3DThumbnail, resetModel3DThumbnails } = await import('@/lib/model3d/thumbnails');
const { MODEL3D_THUMBNAIL_MAX_BYTES } = await import('@/lib/model3d/readModel3DBlob');

const blobSource = (n = 0) => ({ kind: 'blob' as const, url: `cindy-media://blobs/${n.toString(16).padStart(64, '0')}.glb` });
const PNG = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

beforeEach(async () => {
  resetModel3DThumbnails();
  // reset() disposes the previous renderer asynchronously; let it settle before clearing the spies
  await Promise.resolve();
  await Promise.resolve();
  render.mockReset().mockImplementation(async () => ({ blob: PNG() }));
  dispose.mockReset();
  createThumbnailRenderer.mockClear();
  readModelFileBytes.mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), size: 3 });
  statPath.mockReset().mockResolvedValue({ kind: 'file', mtimeMs: 1000, sizeBytes: 3 });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    readModelFileBytes,
    fsBrowse: { statPath },
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('getModel3DThumbnail', () => {
  it('renders a PNG data URL, sharing one renderer, and passes the model name so the SDK can pick the loader', async () => {
    const src = await getModel3DThumbnail(blobSource(1));
    expect(src.startsWith('data:image/png')).toBe(true);
    expect(createThumbnailRenderer).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: expect.stringMatching(/\.glb$/), format: 'png' }),
    );
    await getModel3DThumbnail(blobSource(2));
    expect(createThumbnailRenderer).toHaveBeenCalledTimes(1); // still the same renderer / GL context
  });

  it('renders square thumbnails with framing padding and leaves the view to the SDK default (angled)', async () => {
    await getModel3DThumbnail(blobSource(1));
    const options = render.mock.calls[0][0];
    expect(options.width).toBe(options.height);
    expect(options.padding).toBe(1.25);
    // 不指定 presetView:缩略图默认的 3/4 斜视角由 SDK 提供,别在这里写死回 front
    expect(options).not.toHaveProperty('presetView');
  });

  it('dedupes concurrent requests for the same source', async () => {
    const [a, b, c] = await Promise.all([
      getModel3DThumbnail(blobSource(1)),
      getModel3DThumbnail(blobSource(1)),
      getModel3DThumbnail(blobSource(1)),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('queues model reads behind the active thumbnail generation', async () => {
    let releaseFirstRender!: () => void;
    const firstRenderFinished = new Promise<void>((resolve) => {
      releaseFirstRender = resolve;
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/1.glb')) {
        return Promise.resolve(new Response(new Uint8Array([1]), { status: 200 }));
      }
      return firstRenderFinished.then(() => new Response(new Uint8Array([2]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render.mockImplementation(async ({ model }: { model: Blob }) => {
      if (model.size === 1) {
        await firstRenderFinished;
      }
      return { blob: PNG() };
    });

    const first = getModel3DThumbnail(blobSource(1));
    await Promise.resolve();
    const second = getModel3DThumbnail(blobSource(2));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirstRender();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels queued generations on reset before their model bytes are read', async () => {
    let releaseFirstRender!: () => void;
    const firstRenderFinished = new Promise<void>((resolve) => {
      releaseFirstRender = resolve;
    });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render.mockImplementation(async () => {
      await firstRenderFinished;
      return { blob: PNG() };
    });

    const first = getModel3DThumbnail(blobSource(1));
    await Promise.resolve();
    const second = getModel3DThumbnail(blobSource(2));
    await Promise.resolve();
    resetModel3DThumbnails();
    releaseFirstRender();

    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves repeat requests from the cache', async () => {
    await getModel3DThumbnail(blobSource(1));
    await getModel3DThumbnail(blobSource(1));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used entries beyond the cache limit', async () => {
    for (let i = 0; i < 50; i++) await getModel3DThumbnail(blobSource(i));
    expect(render).toHaveBeenCalledTimes(50);
    await getModel3DThumbnail(blobSource(49)); // newest: still cached
    expect(render).toHaveBeenCalledTimes(50);
    await getModel3DThumbnail(blobSource(0)); // oldest: evicted → regenerated
    expect(render).toHaveBeenCalledTimes(51);
  });

  it('caches a failure briefly, then retries after the TTL', async () => {
    // Only Date is faked: jsdom's FileReader (data URL encoding) relies on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    render.mockRejectedValueOnce(new Error('webgl lost'));
    await expect(getModel3DThumbnail(blobSource(1))).rejects.toThrow('webgl lost');
    await expect(getModel3DThumbnail(blobSource(1))).rejects.toThrow('webgl lost');
    expect(render).toHaveBeenCalledTimes(1); // second call reused the cached failure
    vi.setSystemTime(Date.now() + 31_000);
    await expect(getModel3DThumbnail(blobSource(1))).resolves.toMatch(/^data:image\/png/);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('reads local models through the IPC, never fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await getModel3DThumbnail({ kind: 'local', absPath: '/work/ship.fbx' });
    expect(readModelFileBytes).toHaveBeenCalledWith({ filePath: '/work/ship.fbx' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'ship.fbx' }));
  });

  it('regenerates a local thumbnail when the file changes (mtime / size in the key)', async () => {
    const source = { kind: 'local' as const, absPath: '/work/ship.fbx' };
    await getModel3DThumbnail(source);
    await getModel3DThumbnail(source);
    expect(render).toHaveBeenCalledTimes(1);
    statPath.mockResolvedValue({ kind: 'file', mtimeMs: 2000, sizeBytes: 3 });
    await getModel3DThumbnail(source);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('refuses oversized local files before reading them into memory', async () => {
    statPath.mockResolvedValue({ kind: 'file', mtimeMs: 1, sizeBytes: MODEL3D_THUMBNAIL_MAX_BYTES + 1 });
    await expect(getModel3DThumbnail({ kind: 'local', absPath: '/work/huge.fbx' })).rejects.toThrow(/too large/i);
    expect(readModelFileBytes).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('still works when stat fails (falls back to a path-only key)', async () => {
    statPath.mockRejectedValue(new Error('IPC down'));
    await expect(getModel3DThumbnail({ kind: 'local', absPath: '/work/a.glb' })).resolves.toMatch(/^data:/);
  });

  it('reset disposes the renderer and clears the cache', async () => {
    await getModel3DThumbnail(blobSource(1));
    resetModel3DThumbnails();
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
    await getModel3DThumbnail(blobSource(1));
    expect(render).toHaveBeenCalledTimes(2);
    expect(createThumbnailRenderer).toHaveBeenCalledTimes(2);
  });
});

