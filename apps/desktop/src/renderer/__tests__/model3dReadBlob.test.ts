// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MODEL3D_THUMBNAIL_MAX_BYTES,
  MODEL3D_VIEW_MAX_BYTES,
  Model3DTooLargeError,
  model3DFileName,
  model3DSourceFormat,
  readModel3DBlob,
} from '@/lib/model3d/readModel3DBlob';

const HASH = 'a'.repeat(64);
const readModelFileBytes = vi.fn();

beforeEach(() => {
  readModelFileBytes.mockReset();
  vi.stubGlobal('electronAPI', { readModelFileBytes });
  (window as unknown as { electronAPI: unknown }).electronAPI = { readModelFileBytes };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model3DFileName / model3DSourceFormat', () => {
  it('derives the file name (with extension) from either source kind', () => {
    expect(model3DFileName({ kind: 'blob', url: `cindy-media://blobs/${HASH}.glb` })).toBe(`${HASH}.glb`);
    expect(model3DFileName({ kind: 'local', absPath: '/work/Chair.FBX' })).toBe('Chair.FBX');
    expect(model3DFileName({ kind: 'local', absPath: 'C:\\work\\chair.obj' })).toBe('chair.obj');
  });

  it('reports the recognised format, and null for non-models', () => {
    expect(model3DSourceFormat({ kind: 'local', absPath: '/a/b.STL' })).toBe('stl');
    expect(model3DSourceFormat({ kind: 'local', absPath: '/a/b.zip' })).toBeNull();
  });
});

describe('readModel3DBlob — managed (cindy-media) source', () => {
  const source = { kind: 'blob' as const, url: `cindy-media://blobs/${HASH}.glb` };

  it('fetches the bytes and returns a blob with the file name', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { blob, fileName } = await readModel3DBlob(source);
    expect(fileName).toBe(`${HASH}.glb`);
    expect(blob.size).toBe(4);
    expect(fetchMock).toHaveBeenCalledWith(source.url, expect.objectContaining({}));
  });

  it('rejects on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(readModel3DBlob(source)).rejects.toThrow(/404/);
  });

  it('rejects before reading the body when Content-Length is over the limit', async () => {
    const body = vi.fn(async () => new Blob([]));
    const res = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(MODEL3D_THUMBNAIL_MAX_BYTES + 1) }),
      blob: body,
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => res));
    await expect(readModel3DBlob(source, { maxBytes: MODEL3D_THUMBNAIL_MAX_BYTES })).rejects.toBeInstanceOf(
      Model3DTooLargeError,
    );
    expect(body).not.toHaveBeenCalled();
  });

  it('honours an aborted signal without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(readModel3DBlob(source, { signal: controller.signal })).rejects.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('readModel3DBlob — local source', () => {
  const source = { kind: 'local' as const, absPath: '/work/ship.fbx' };

  it('reads through the main-process IPC, never via fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    readModelFileBytes.mockResolvedValue({ bytes: new Uint8Array([9, 8, 7]), size: 3 });
    const { blob, fileName } = await readModel3DBlob(source);
    expect(readModelFileBytes).toHaveBeenCalledWith({ filePath: '/work/ship.fbx' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fileName).toBe('ship.fbx');
    expect(blob.size).toBe(3);
  });

  it('rejects results above the requested limit', async () => {
    readModelFileBytes.mockResolvedValue({ bytes: new Uint8Array(1), size: MODEL3D_THUMBNAIL_MAX_BYTES + 1 });
    await expect(readModel3DBlob(source, { maxBytes: MODEL3D_THUMBNAIL_MAX_BYTES })).rejects.toBeInstanceOf(
      Model3DTooLargeError,
    );
  });

  it('keeps the viewer limit aligned with the main-process 128MB cap', () => {
    expect(MODEL3D_VIEW_MAX_BYTES).toBe(128 * 1024 * 1024);
  });

  it('propagates IPC failures', async () => {
    readModelFileBytes.mockRejectedValue(new Error('PERMISSION_DENIED'));
    await expect(readModel3DBlob(source)).rejects.toThrow('PERMISSION_DENIED');
  });
});
