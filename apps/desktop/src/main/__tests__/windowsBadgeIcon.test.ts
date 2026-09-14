import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';

const { addRepresentation, icon } = vi.hoisted(() => {
  const addRepresentation = vi.fn();
  return { addRepresentation, icon: { addRepresentation } };
});
vi.mock('electron', () => ({ nativeImage: { createEmpty: () => icon } }));

import { createWindowsBadgeIcon, renderWindowsBadgePng } from '../windowsBadgeIcon';

describe('Windows numeric taskbar badge', () => {
  it('provides PNGs at common Windows display scales and clears at zero', () => {
    expect(createWindowsBadgeIcon(3)).toBe(icon);
    expect(addRepresentation.mock.calls.map(([rep]) => rep.scaleFactor)).toEqual([
      1, 1.25, 1.5, 2, 3,
    ]);
    for (const [rep] of addRepresentation.mock.calls) {
      const png = Buffer.from(rep.dataURL.split(',')[1], 'base64');
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(16 * rep.scaleFactor);
      expect(png.readUInt32BE(20)).toBe(16 * rep.scaleFactor);
    }
    addRepresentation.mockClear();
    expect(createWindowsBadgeIcon(0)).toBeNull();
    expect(addRepresentation).not.toHaveBeenCalled();
  });

  it('renders different numbers and caps only the visible label at 99+', () => {
    expect(renderWindowsBadgePng(1, 2).equals(renderWindowsBadgePng(2, 2))).toBe(false);
    expect(renderWindowsBadgePng(99, 2).equals(renderWindowsBadgePng(100, 2))).toBe(false);
    expect(renderWindowsBadgePng(100, 2).equals(renderWindowsBadgePng(12345, 2))).toBe(true);
  });

  it('contains red fill, white digits and transparent corners in the actual PNG', async () => {
    const canvas = createCanvas(32, 32);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(await loadImage(renderWindowsBadgePng(3, 2)), 0, 0);
    const { data } = ctx.getImageData(0, 0, 32, 32);
    expect(data[3]).toBe(0);
    let redPixels = 0;
    let whitePixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 217 && data[i + 1] === 31 && data[i + 2] === 55 && data[i + 3] === 255)
        redPixels++;
      if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255 && data[i + 3] === 255)
        whitePixels++;
    }
    expect(redPixels).toBeGreaterThan(100);
    expect(whitePixels).toBeGreaterThan(10);
  });
});
