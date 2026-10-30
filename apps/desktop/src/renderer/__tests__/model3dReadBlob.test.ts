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
const readModelFileResourceBytes = vi.fn();
const statPath = vi.fn();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  readModelFileBytes.mockReset();
  readModelFileResourceBytes.mockReset();
  statPath.mockReset().mockResolvedValue({ kind: 'file', sizeBytes: 3 });
  const api = { readModelFileBytes, readModelFileResourceBytes, fsBrowse: { statPath } };
  vi.stubGlobal('electronAPI', api);
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => `blob:model-resource-${blob.size}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectURL,
    });
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL');
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: originalRevokeObjectURL,
    });
  } else {
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  }
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

  it('inlines external glTF buffers and textures through the confined resource IPC', async () => {
    const gltf = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        buffers: [{ uri: 'meshes/ship.bin', byteLength: 3 }],
        images: [{ uri: 'textures/albedo.png' }],
      }),
    );
    readModelFileBytes.mockResolvedValue({ bytes: gltf, size: gltf.byteLength });
    readModelFileResourceBytes
      .mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3]), size: 3 })
      .mockResolvedValueOnce({ bytes: new Uint8Array([4, 5]), size: 2 });

    const model = await readModel3DBlob({ kind: 'local', absPath: '/work/ship.gltf' });
    const { blob, fileName } = model;
    const inlined = JSON.parse(await blob.text()) as {
      buffers: Array<{ uri: string }>;
      images: Array<{ uri: string }>;
    };
    expect(fileName).toBe('ship.gltf');
    expect(inlined.buffers[0].uri).toBe('blob:model-resource-3');
    expect(inlined.images[0].uri).toBe('blob:model-resource-2');
    expect(readModelFileResourceBytes).toHaveBeenNthCalledWith(1, {
      modelPath: '/work/ship.gltf',
      relativePath: 'meshes/ship.bin',
    });
    expect(readModelFileResourceBytes).toHaveBeenNthCalledWith(2, {
      modelPath: '/work/ship.gltf',
      relativePath: 'textures/albedo.png',
    });
    model.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('stops reading companion resources when the load is aborted', async () => {
    const gltf = new TextEncoder().encode(
      JSON.stringify({
        asset: { version: '2.0' },
        buffers: [{ uri: 'meshes/ship.bin', byteLength: 3 }],
        images: [{ uri: 'textures/albedo.png' }],
      }),
    );
    readModelFileBytes.mockResolvedValue({ bytes: gltf, size: gltf.byteLength });
    let resolveResource!: (result: { bytes: Uint8Array; size: number }) => void;
    readModelFileResourceBytes.mockReturnValue(
      new Promise((resolve) => {
        resolveResource = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = readModel3DBlob({ kind: 'local', absPath: '/work/ship.gltf' }, { signal: controller.signal });
    await vi.waitFor(() => expect(readModelFileResourceBytes).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveResource({ bytes: new Uint8Array([1, 2, 3]), size: 3 });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(readModelFileResourceBytes).toHaveBeenCalledTimes(1);
  });

  it('rejects results above the requested limit', async () => {
    readModelFileBytes.mockResolvedValue({ bytes: new Uint8Array(1), size: MODEL3D_THUMBNAIL_MAX_BYTES + 1 });
    await expect(readModel3DBlob(source, { maxBytes: MODEL3D_THUMBNAIL_MAX_BYTES })).rejects.toBeInstanceOf(
      Model3DTooLargeError,
    );
  });

  it('reports a local file over the limit as too large before reading it (not a generic failure)', async () => {
    statPath.mockResolvedValue({ kind: 'file', sizeBytes: MODEL3D_VIEW_MAX_BYTES + 1 });
    const error = await readModel3DBlob(source).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Model3DTooLargeError);
    expect((error as Model3DTooLargeError).size).toBe(MODEL3D_VIEW_MAX_BYTES + 1);
    expect(readModelFileBytes).not.toHaveBeenCalled();
  });

  it('still converts the main-process size rejection when stat is unavailable or stale', async () => {
    statPath.mockRejectedValue(new Error('stat failed'));
    readModelFileBytes.mockRejectedValue(
      new Error("Error invoking remote method 'read-model-file-bytes': Error: [PRECONDITION_FAILED] file exceeds the preview size limit"),
    );
    await expect(readModel3DBlob(source)).rejects.toBeInstanceOf(Model3DTooLargeError);
  });

  it('keeps other PRECONDITION_FAILED rejections as ordinary errors', async () => {
    readModelFileBytes.mockRejectedValue(new Error('[PRECONDITION_FAILED] file changed during read'));
    await expect(readModel3DBlob(source)).rejects.not.toBeInstanceOf(Model3DTooLargeError);
  });

  it('keeps the viewer limit aligned with the main-process 128MB cap', () => {
    expect(MODEL3D_VIEW_MAX_BYTES).toBe(128 * 1024 * 1024);
  });

  it('propagates IPC failures', async () => {
    readModelFileBytes.mockRejectedValue(new Error('PERMISSION_DENIED'));
    await expect(readModel3DBlob(source)).rejects.toThrow('PERMISSION_DENIED');
  });
});
