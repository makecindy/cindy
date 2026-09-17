import { describe, expect, it, vi } from 'vitest';
import { decodeWindowsCursorFrame } from '../windowsCursorFrame';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const cursor = {
  visible: true,
  x: 0.25,
  y: 0.75,
  width: 4,
  height: 6,
  hotX: 2,
  hotY: 4,
  bgra: Buffer.alloc(4 * 6 * 4).toString('base64'),
};
const frame = (value: unknown = cursor) => JSON.stringify({ jpeg: 'anBlZw==', cursor: value });

describe('Windows local cursor frames', () => {
  it.each([1, 1.25, 1.5, 2])(
    'preserves raster and position while converting %s DPI geometry to points',
    (scale) => {
      const encode = vi.fn(() => png);
      expect(decodeWindowsCursorFrame(frame(), scale, encode)).toEqual({
        jpeg: 'anBlZw==',
        cursor: {
          visible: true,
          x: 0.25,
          y: 0.75,
          width: 4 / scale,
          height: 6 / scale,
          hotX: 2 / scale,
          hotY: 4 / scale,
          png: png.toString('base64'),
        },
      });
      expect(encode).toHaveBeenCalledWith(Buffer.alloc(96), { width: 4, height: 6 });
    },
  );
  it('keeps the old helper JPEG path and hidden cursor state', () => {
    expect(decodeWindowsCursorFrame('anBlZw==', 1, () => png)).toBe('anBlZw==');
    expect(
      decodeWindowsCursorFrame(frame({ ...cursor, visible: false }), 1, () => png),
    ).toMatchObject({ cursor: { visible: false } });
  });
  it.each([
    null,
    {},
    { ...cursor, width: 257 },
    { ...cursor, height: 0 },
    { ...cursor, x: 2 },
    { ...cursor, hotX: -1 },
    { ...cursor, visible: 'true' },
    { ...cursor, bgra: 'YQ==' },
    { ...cursor, bgra: '!'.repeat(128) },
  ])('drops an invalid or missing cursor without losing the picture: %j', (value) => {
    const encode = vi.fn(() => png);
    expect(decodeWindowsCursorFrame(frame(value), 1, encode)).toEqual({
      jpeg: 'anBlZw==',
      cursor: null,
    });
    expect(encode).not.toHaveBeenCalled();
  });
  it.each([
    () => Buffer.alloc(49153),
    () => Buffer.from('not png'),
    () => {
      throw new Error('encode');
    },
  ])('retains video when cursor encoding fails', (encode) => {
    expect(decodeWindowsCursorFrame(frame(), 1, encode)).toEqual({
      jpeg: 'anBlZw==',
      cursor: null,
    });
  });
  it.each([
    '[]',
    '{}',
    '{"jpeg":false}',
    '{"jpeg":"data:foo"}',
    'x'.repeat(1_750_001),
    JSON.stringify({ jpeg: 'x'.repeat(1_333_337) }),
  ])('bounds malformed frame payloads', (text) => {
    expect(() => decodeWindowsCursorFrame(text, 1, () => png)).toThrow();
  });
});
