// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDracoDecoderFilesLoader } from '@/lib/model3d/dracoDecoder';

const WRAPPER = 'wrapper-source-text';
// "\0asm" + version 1 — the 8-byte WebAssembly header
const WASM_B64 = 'AGFzbQEAAAA=';
const WASM_BYTES = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

const blobs = new Map<string, Blob>();
let counter = 0;

function load(wasmUrl: string) {
  return createDracoDecoderFilesLoader({ wrapperSource: WRAPPER, wasmUrl });
}

const bytesOf = async (blob: Blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));

beforeEach(() => {
  blobs.clear();
  counter = 0;
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:test/${counter++}`;
      blobs.set(url, blob);
      return url;
    }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDracoDecoderFiles', () => {
  it('turns the bundled wrapper and the inlined wasm (data URL) into blob URLs without any fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const createDracoDecoderFiles = load(`data:application/wasm;base64,${WASM_B64}`);
    const files = await createDracoDecoderFiles();

    expect(Object.keys(files).sort()).toEqual(['draco_decoder.wasm', 'draco_wasm_wrapper.js']);
    const wrapper = blobs.get(files['draco_wasm_wrapper.js'])!;
    const wasm = blobs.get(files['draco_decoder.wasm'])!;
    expect(wrapper.type).toBe('text/javascript');
    expect(await wrapper.text()).toBe(WRAPPER);
    expect(wasm.type).toBe('application/wasm');
    expect(await bytesOf(wasm)).toEqual(WASM_BYTES);
    // CSP connect-src does not allow data:, so a data URL must never be fetched
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches the wasm from the dev server when it is not inlined (dev mode)', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(WASM_BYTES), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const createDracoDecoderFiles = load('/@fs/three/draco_decoder.wasm');
    const files = await createDracoDecoderFiles();
    expect(fetchMock).toHaveBeenCalledWith('/@fs/three/draco_decoder.wasm');
    expect(await bytesOf(blobs.get(files['draco_decoder.wasm'])!)).toEqual(WASM_BYTES);
  });

  it('creates the blob URLs only once, even for concurrent callers', async () => {
    const createDracoDecoderFiles = load(`data:application/wasm;base64,${WASM_B64}`);
    const [a, b] = await Promise.all([createDracoDecoderFiles(), createDracoDecoderFiles()]);
    expect(a).toBe(b);
    expect(await createDracoDecoderFiles()).toBe(a);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('can be retried after a failure instead of caching the rejection', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(new Uint8Array(WASM_BYTES), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const createDracoDecoderFiles = load('/@fs/three/draco_decoder.wasm');
    await expect(createDracoDecoderFiles()).rejects.toThrow('network down');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await expect(createDracoDecoderFiles()).resolves.toHaveProperty('draco_decoder.wasm');
  });

  it('rejects a non-ok dev-server response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const createDracoDecoderFiles = load('/@fs/three/draco_decoder.wasm');
    await expect(createDracoDecoderFiles()).rejects.toThrow(/404/);
  });
});
