// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCaptureColor } from '../normalizeCaptureColor';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('capture palette serialization', () => {
  it('serializes sampled sRGB including alpha and removes its temporary DOM node', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    const context = { fillStyle: '', fillRect: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([12, 34, 56, 128]) }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const before = document.documentElement.childElementCount;
    expect(normalizeCaptureColor('red', '#123456')).toBe(`rgba(12, 34, 56, ${128 / 255})`);
    expect(context.fillStyle).toBe('rgb(255, 0, 0)');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(document.documentElement.childElementCount).toBe(before);
  });

  it('falls back on invalid CSS without allocating a canvas', () => {
    vi.stubGlobal('CSS', { supports: () => false });
    const create = vi.spyOn(document, 'createElement');
    expect(normalizeCaptureColor('red; background:url(x)', '#123456')).toBe('#123456');
    expect(create).not.toHaveBeenCalled();
  });

  it('removes its probe and falls back if pixel sampling is unavailable', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => { throw new Error('unavailable'); });
    const before = document.documentElement.childElementCount;
    expect(normalizeCaptureColor('red', '#123456')).toBe('#123456');
    expect(document.documentElement.childElementCount).toBe(before);
  });
});
