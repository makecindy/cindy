import { describe, expect, it, vi } from 'vitest';

const nativeRun = vi.fn();

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({
    loadModels: vi.fn(),
    unloadModels: vi.fn(),
    sha256File: vi.fn(),
    run: nativeRun,
  }),
}));

const { base64ToFloat32, nativeSpeakerOnnxRunner, packFloat32 } = await import(
  '../../modules/cindy-speaker-onnx/src'
);

function float32ToBase64(values: number[]): string {
  const bytes = new Uint8Array(Float32Array.from(values).buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('cindy-speaker-onnx bridge', () => {
  it('packs inputs back to back, respecting subarray offsets', () => {
    const backing = Float32Array.of(9, 1, 2, 9);
    const packed = packFloat32([backing.subarray(1, 3), Float32Array.of(3)]);
    expect(Array.from(new Float32Array(packed.buffer))).toEqual([1, 2, 3]);
  });

  it('decodes base64 float32 output', () => {
    expect(Array.from(base64ToFloat32(float32ToBase64([0.5, -2, 1e-3])))).toEqual([
      0.5,
      -2,
      Math.fround(1e-3),
    ]);
  });

  it('sends names, dims and packed data in a stable order and decodes every output', async () => {
    nativeRun.mockResolvedValueOnce({
      prob: { dims: [1, 1], base64: float32ToBase64([0.75]) },
      new_h: { dims: [2], base64: float32ToBase64([1, 2]) },
    });
    const out = await nativeSpeakerOnnxRunner.run('vad', {
      x: { data: Float32Array.of(1, 2), dims: [1, 2] },
      h: { data: Float32Array.of(3), dims: [1] },
    });
    const [model, names, dims, packed] = nativeRun.mock.calls[0];
    expect(model).toBe('vad');
    expect(names).toEqual(['x', 'h']);
    expect(dims).toEqual([[1, 2], [1]]);
    expect(Array.from(new Float32Array((packed as Uint8Array).buffer))).toEqual([1, 2, 3]);
    expect(out.prob).toEqual({ dims: [1, 1], data: Float32Array.of(0.75) });
    expect(Array.from(out.new_h.data)).toEqual([1, 2]);
  });
});
