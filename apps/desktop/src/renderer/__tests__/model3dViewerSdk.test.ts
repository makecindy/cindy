// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = {
  setEnabledFormats: vi.fn(),
  setDracoDecoderFiles: vi.fn(),
};
const createDracoDecoderFiles = vi.fn();
const order: string[] = [];

async function load() {
  vi.resetModules();
  vi.doMock('mivo-model-viewer', () => sdk);
  vi.doMock('@/lib/model3d/dracoDecoder', () => ({ createDracoDecoderFiles }));
  return import('@/lib/model3d/modelViewerSdk');
}

beforeEach(() => {
  order.length = 0;
  sdk.setEnabledFormats.mockReset().mockImplementation(() => { order.push('formats'); });
  sdk.setDracoDecoderFiles.mockReset().mockImplementation(() => { order.push('draco'); });
  createDracoDecoderFiles.mockReset().mockResolvedValue({
    'draco_wasm_wrapper.js': 'blob:wrapper',
    'draco_decoder.wasm': 'blob:wasm',
  });
});

afterEach(() => {
  vi.doUnmock('mivo-model-viewer');
  vi.doUnmock('@/lib/model3d/dracoDecoder');
});

describe('loadModelViewerSdk', () => {
  it('limits the formats to the recognised 3D set (no zip / vrml / step) and self-hosts Draco', async () => {
    const { loadModelViewerSdk } = await load();
    await loadModelViewerSdk();
    const formats = sdk.setEnabledFormats.mock.calls[0][0] as string[];
    expect(formats).toEqual(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', '3mf', '3ds']);
    expect(formats).not.toContain('zip');
    expect(sdk.setDracoDecoderFiles).toHaveBeenCalledWith({
      'draco_wasm_wrapper.js': 'blob:wrapper',
      'draco_decoder.wasm': 'blob:wasm',
    });
  });

  it('configures once and returns the same SDK to every caller', async () => {
    const { loadModelViewerSdk } = await load();
    const [a, b] = await Promise.all([loadModelViewerSdk(), loadModelViewerSdk()]);
    expect(a === b).toBe(true);
    await loadModelViewerSdk();
    expect(sdk.setEnabledFormats).toHaveBeenCalledTimes(1);
    expect(sdk.setDracoDecoderFiles).toHaveBeenCalledTimes(1);
  });

  it('never hands the SDK out unconfigured: a Draco setup failure rejects, then a retry succeeds', async () => {
    createDracoDecoderFiles.mockRejectedValueOnce(new Error('decoder unavailable'));
    const { loadModelViewerSdk } = await load();
    await expect(loadModelViewerSdk()).rejects.toThrow('decoder unavailable');
    const loaded = await loadModelViewerSdk();
    expect(loaded.setEnabledFormats).toBe(sdk.setEnabledFormats);
    expect(sdk.setDracoDecoderFiles).toHaveBeenCalledTimes(1);
  });
});
