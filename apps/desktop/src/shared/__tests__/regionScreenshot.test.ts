import { describe, expect, it } from 'vitest';
import { ScrollCapture, matchScrollFrames } from '../scrollCapture';
import { recordingControlsBounds, scrollCaptureLayout, scrollPreviewBounds, validRecordingBytes } from '../regionCapture';
import type { RegionScreenshotBitmap } from '../regionScreenshot';

import {
  normalizeRegionSelection,
  nudgeRegion,
  regionChromeArea,
  regionSelectionToImageCrop,
  resizeRegion,
  snapCandidates,
  validateRegionBitmap,
} from '../regionScreenshot';

// Phase 5/6 contract (unit): the production stitcher must not duplicate fixed chrome,
// accept uncertain overlap, or exceed its memory budget. Previous geometry tests never
// supplied successive frames. Minimal input: two 64x96 crops with a 24-row scroll.
function scrollingFrame(offset: number, header = 0, footer = 0): RegionScreenshotBitmap {
  const width = 64, height = 96;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = y < header || y >= height - footer ? y : y + offset;
    let seed = ((row + 1) * 2654435761 + x * 2246822519) >>> 0;
    seed ^= seed >>> 13;
    const i = (y * width + x) * 4;
    data[i] = seed & 255; data[i + 1] = (seed >>> 8) & 255; data[i + 2] = (seed >>> 16) & 255; data[i + 3] = 255;
  }
  return { width, height, data };
}

describe('continuous region capture', () => {
  // Preview must copy only visible rows, including across stitched parts; full
  // export must remain identical after scrolling both ways. tier: unit.
  it('reads bounded preview rows across appended and prepended seams without changing export', () => {
    const capture = new ScrollCapture(scrollingFrame(24, 8, 8));
    capture.add(scrollingFrame(0, 8, 8));
    capture.add(scrollingFrame(48, 8, 8));
    const full = capture.image();
    for (const start of [0, 15, 75, 130]) {
      const image = capture.image(start, 20);
      expect(image.height).toBe(Math.min(20, full.height - start));
      expect(image.data).toEqual(full.data.slice(start * 64 * 4, (start + 20) * 64 * 4));
    }
    expect(capture.image()).toEqual(full);
  });

  // User report: preview started at the top instead of the selection bottom.
  // Cover right-first placement, left fallback and viewport clipping. tier: unit.
  it('anchors the side preview to the selection bottom and grows upwards', () => {
    for (const selection of [{ x: 300, y: 200, width: 600, height: 600 }, { x: 1400, y: 20, width: 500, height: 950 }]) {
      const layout = scrollCaptureLayout(selection, { width: 1920, height: 1080 })!;
      expect(layout.preview.y + layout.preview.height).toBe(selection.y + selection.height);
      expect(layout.preview.y).toBeGreaterThanOrEqual(8);
      for (const height of [80, 400, 2000]) {
        const bounds = scrollPreviewBounds(layout, height);
        expect(bounds.y + bounds.height).toBe(selection.y + selection.height);
        expect(bounds.height).toBe(Math.min(height, layout.preview.height));
      }
    }
    const layout = scrollCaptureLayout({ x: 900, y: 200, width: 600, height: 600 }, { width: 1920, height: 1080 })!;
    expect(layout.preview.x).toBeGreaterThanOrEqual(1500);
  });
  it('stitches downward motion while keeping fixed header and footer exactly once', () => {
    const first = scrollingFrame(0, 8, 8);
    const capture = new ScrollCapture(first);
    expect(capture.add(scrollingFrame(24, 8, 8))).toBe('append');
    expect(capture.add(scrollingFrame(48, 8, 8))).toBe('append');
    const output = capture.image();
    expect(output.height).toBe(144);
    const expected = new Uint8Array(144 * 64 * 4);
    expected.set(first.data.subarray(0, 88 * 64 * 4));
    expected.set(scrollingFrame(24, 8, 8).data.subarray(64 * 64 * 4, 88 * 64 * 4), 88 * 64 * 4);
    expected.set(scrollingFrame(48, 8, 8).data.subarray(64 * 64 * 4), 112 * 64 * 4);
    expect(output.data).toEqual(expected);
    const reverse = new ScrollCapture(scrollingFrame(48, 8, 8));
    expect(reverse.add(scrollingFrame(24, 8, 8))).toBe('prepend');
    expect(reverse.add(first)).toBe('prepend');
    expect(reverse.image()).toEqual(output);
  });

  it('extends upwards and downwards without duplicating revisited content or losing the anchor on a gap', () => {
    const capture = new ScrollCapture(scrollingFrame(24));
    expect(capture.add(scrollingFrame(24))).toBe('same');
    expect(capture.add(scrollingFrame(0))).toBe('prepend');
    expect(capture.add(scrollingFrame(300))).toBe('unmatched');
    expect(capture.add(scrollingFrame(48))).toBe('append');
    expect(capture.height).toBe(144);
    expect(capture.add(scrollingFrame(24))).toBe('same');
    expect(capture.height).toBe(144);
    expect(capture.add(scrollingFrame(72))).toBe('append');
    expect(capture.height).toBe(168);
    const forward = new ScrollCapture(scrollingFrame(0));
    for (const offset of [24, 48, 72]) forward.add(scrollingFrame(offset));
    expect(capture.image()).toEqual(forward.image());
  });

  // User report: the overlap warning appears before scrolling. Unit: a blinking
  // caret or a small hover change must remain stationary, without replacing the
  // accepted image. Existing tests only used byte-identical stationary frames.
  it('ignores local repainting at rest and still stitches the next scroll', () => {
    const first = scrollingFrame(0);
    const capture = new ScrollCapture(first);
    for (const width of [2, 20]) {
      const repaint = { ...first, data: first.data.slice() };
      for (let y = 40; y < 48; y++) for (let x = 8; x < 8 + width; x++) {
        repaint.data.fill(255, (y * first.width + x) * 4, (y * first.width + x + 1) * 4);
      }
      expect(capture.add(repaint)).toBe('same');
      expect(capture.image()).toEqual(first);
    }
    expect(capture.add(scrollingFrame(24))).toBe('append');
    expect(capture.height).toBe(120);
  });

  // Native QA found that whitespace diluted the confidence gap between paragraphs.
  // Unit: repeated text shapes with a small unique suffix must still stitch at the
  // exact offset. The dense-noise frames above never exercised this input.
  it('stitches sparse text-like paragraphs without accumulating blank footer rows', () => {
    const sparse = (offset: number): RegionScreenshotBitmap => {
      const width = 240, height = 240, data = new Uint8Array(width * height * 4).fill(255);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const row = y + offset, block = Math.floor(row / 40);
        if (row % 40 >= 10 && row % 40 < 18 && ((x < 100 && x % 8 < 3) || (x >= 120 && x < 140 && ((block * 7919) >> (x % 12) & 1)))) {
          const at = (y * width + x) * 4;
          data[at] = data[at + 1] = data[at + 2] = 40;
        }
      }
      return { width, height, data };
    };
    const capture = new ScrollCapture(sparse(0));
    for (const offset of [17, 34, 51, 68]) expect(capture.add(sparse(offset))).toBe('append');
    expect(capture.height).toBe(308);
    expect(capture.add(sparse(28))).toBe('unmatched');
    expect(capture.add(sparse(68))).toBe('same');
    expect(capture.height).toBe(308);
  });

  // User report: ordinary scrolling stays on the mismatch notice. Unit coverage
  // previously had no stationary side pane or small capture colour drift.
  // Minimal production input: 64x96, a fixed left half, a 24-row scroll and +2 RGB.
  it('matches scrolling content beside a stationary pane with small capture drift', () => {
    const paneFrame = (offset: number, drift: number) => {
      const bitmap = scrollingFrame(offset);
      const fixed = scrollingFrame(0);
      for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
        const at = (y * bitmap.width + x) * 4;
        for (let c = 0; c < 3; c++) bitmap.data[at + c] = Math.min(255, (x < 32 ? fixed.data[at + c] : bitmap.data[at + c]) + drift);
      }
      return bitmap;
    };
    const capture = new ScrollCapture(paneFrame(0, 0));
    expect(capture.add(paneFrame(24, 2))).toBe('append');
    expect(capture.height).toBe(120);
    expect(capture.add(paneFrame(0, 0))).toBe('same');
    expect(capture.height).toBe(120);
  });

  // PR #7300 native reproduction: chat text scrolls over a fixed wallpaper.
  // The existing stationary-pane test separates background and content by column;
  // here they share pixels. Unit: two overlapping crops must extend the image,
  // while revisiting them must not add duplicate rows or alter exported colours.
  it('stitches text over a stationary wallpaper without duplicating a return scroll', () => {
    const chat = (offset: number, light: boolean): RegionScreenshotBitmap => {
      const width = 240, height = 240, data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const row = y + offset, line = Math.floor(row / 29);
        const background = 25 + 35 * (1 + Math.sin(y / 23 + x / 80));
        const ink = x > 45 && x < 210 && row % 29 < 9 && x % 11 < 5
          && ((line * 7919 + Math.floor(x / 11) * 3571) >>> (row % 9) & 1);
        const value = Math.round(ink ? 200 + background * 0.15 : background);
        const at = (y * width + x) * 4;
        data[at] = data[at + 1] = data[at + 2] = light ? 255 - value : value;
        data[at + 3] = 255;
      }
      return { width, height, data };
    };
    for (const light of [false, true]) {
      const first = chat(0, light), next = chat(47, light);
      const capture = new ScrollCapture(first);
      expect(capture.add(next)).toBe('append');
      expect(capture.height).toBe(287);
      const output = capture.image();
      expect(output.data.slice(-47 * 240 * 4)).toEqual(next.data.slice(-47 * 240 * 4));
      expect(capture.add(first)).toBe('same');
      expect(capture.image()).toEqual(output);
      expect(capture.add(chat(94, light))).toBe('append');
      expect(capture.height).toBe(334);
      expect(['same', 'unmatched']).toContain(capture.add(chat(3000, light)));
      expect(capture.height).toBe(334);
    }
  });

  it('rejects ambiguous repeated content and preserves the result at its size limit', () => {
    const a = scrollingFrame(0), b = scrollingFrame(24);
    const capture = new ScrollCapture(a, 64 * 100);
    expect(capture.add(b)).toBe('limit');
    expect(capture.image()).toEqual(a);
    const repeated = scrollingFrame(0);
    for (let y = 0; y < 96; y++) repeated.data.copyWithin(y * 256, (y % 8) * 256, (y % 8 + 1) * 256);
    const shifted = { ...repeated, data: repeated.data.slice() };
    for (let y = 0; y < 96; y++) shifted.data.set(repeated.data.subarray(((y + 3) % 8) * 256, ((y + 3) % 8 + 1) * 256), y * 256);
    expect(matchScrollFrames(repeated, shifted)).toEqual({ kind: 'unmatched' });
  });

  it('keeps the control panel outside the capture, or refuses an impossible placement', () => {
    const display = { x: -1920, y: 0, width: 1920, height: 1080 };
    // Layout uses display-local coordinates on negative-origin monitors too.
    const selection = { x: 20, y: 20, width: 1200, height: 700 };
    const panel = recordingControlsBounds(selection, display, false)!;
    expect(panel).not.toBeNull();
    expect(panel.y >= selection.y + selection.height || panel.x >= selection.x + selection.width).toBe(true);
    expect(recordingControlsBounds({ ...display, x: 0, y: 0 }, display, false)).toBeNull();
    // The former tall panel rejected this region; compact controls fit while annotations do not.
    const wide = { x: 0, y: 0, width: 1920, height: 980 };
    expect(recordingControlsBounds(wide, display, false)?.y).toBeGreaterThanOrEqual(980);
    expect(recordingControlsBounds(wide, display, true)).toBeNull();
    // The scrolling preview must remain reachable even beside a low selection.
    const viewport = { width: 1920, height: 1080 };
    for (const region of [{ x: 300, y: 800, width: 600, height: 200 }, { x: 10, y: 20, width: 1900, height: 700 }]) {
      const layout = scrollCaptureLayout(region, viewport)!;
      expect(layout.auto.x + layout.auto.width).toBeLessThanOrEqual(layout.actions.x);
      for (const rect of [layout.preview, layout.auto, layout.actions]) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
        expect(rect.x >= region.x + region.width || rect.x + rect.width <= region.x || rect.y >= region.y + region.height || rect.y + rect.height <= region.y).toBe(true);
      }
    }
  });

  // User report (macOS): screenshot chrome sat under the camera housing and over the Dock;
  // live layouts only knew the display size. Minimal input: a 1470x956 notched display with
  // a 33pt menu bar, 32pt notch and 70pt Dock. tier: unit.
  it('keeps live controls out of the menu bar, notch and Dock while room remains', () => {
    const bounds = { x: 0, y: 0, width: 1470, height: 956 };
    const area = regionChromeArea(bounds, { x: 0, y: 33, width: 1470, height: 853 }, 32);
    expect(area).toEqual({ x: 0, y: 33, width: 1470, height: 853 });
    // An auto-hidden menu bar leaves the notch; negative-origin displays stay display-local.
    expect(regionChromeArea({ ...bounds, x: -1470 }, { ...bounds, x: -1470 }, 32)).toEqual({ x: 0, y: 32, width: 1470, height: 924 });
    expect(regionChromeArea(bounds, { x: 0, y: 0, width: 100, height: 956 })).toEqual(bounds);
    const viewport = { width: 1470, height: 956 };
    const inside = (r: { x: number; y: number; width: number; height: number }) =>
      r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;
    const nearTop = { x: 200, y: 40, width: 700, height: 500 };
    const layout = scrollCaptureLayout(nearTop, viewport, area)!;
    for (const rect of [layout.preview, layout.auto, layout.actions]) expect(inside(rect)).toBe(true);
    // Without the area the controls fit under this selection only by covering the Dock.
    const nearDock = { x: 200, y: 300, width: 700, height: 530 };
    expect(inside(recordingControlsBounds(nearDock, viewport, false)!)).toBe(false);
    expect(inside(recordingControlsBounds(nearDock, viewport, false, undefined, area)!)).toBe(true);
    // A selection filling the chrome area still gets controls on the display.
    const filling = { x: 0, y: 33, width: 1470, height: 800 };
    expect(recordingControlsBounds(filling, viewport, false, undefined, area)!.y).toBeGreaterThanOrEqual(833);
  });

  it('rejects mismatched recording formats and unbounded export buffers', () => {
    const gif = new Uint8Array(20);
    gif.set(new TextEncoder().encode('GIF89a')); gif[19] = 0x3b;
    expect(validRecordingBytes(gif, 'gif')).toBe(true);
    expect(validRecordingBytes(gif, 'webm')).toBe(false);
    expect(validRecordingBytes(Array.from(gif), 'gif')).toBe(false);
    gif[19] = 0;
    expect(validRecordingBytes(gif, 'gif')).toBe(false);
  });
});

/**
 * 框选截图的坐标与 payload 契约: 浮层上报 DIP 选区与最终像素, main 校验后写剪贴板 /
 * 保存 / 贴图。原图来自 desktopCapturer 缩略图, 多屏共用一个尺寸上限, 混合 DPI 时较小
 * 的屏会被放大; 裁剪若按 bounds × scaleFactor 计算会截错位置, 不缩回则是放大后的模糊图。
 */
describe('region screenshot geometry', () => {
  it('maps DIP selections onto the frozen image and keeps physical output size', () => {
    // 1x 屏的缩略图被 4K 副屏的尺寸上限放大到 2 倍
    expect(
      regionSelectionToImageCrop(
        { x: 100, y: 50, width: 200, height: 100 },
        { width: 1280, height: 720 },
        { width: 2560, height: 1440 },
        1,
      ),
    ).toEqual({
      crop: { x: 200, y: 100, width: 400, height: 200 },
      output: { width: 200, height: 100 },
    });
    // Retina 屏缩略图即物理分辨率: 原样输出, 不缩放
    expect(
      regionSelectionToImageCrop(
        { x: 10, y: 10, width: 300, height: 200 },
        { width: 1440, height: 900 },
        { width: 2880, height: 1800 },
        2,
      ),
    ).toEqual({
      crop: { x: 20, y: 20, width: 600, height: 400 },
      output: { width: 600, height: 400 },
    });
  });

  it('normalizes reverse drags, clamps to the display, and rejects bad payloads', () => {
    const viewport = { width: 1280, height: 720 };
    expect(
      normalizeRegionSelection({ x: 1300, y: 700, width: -400, height: -100.4 }, viewport),
    ).toEqual({ x: 900, y: 600, width: 380, height: 100 });
    expect(normalizeRegionSelection({ x: 0, y: 0, width: Number.NaN, height: 10 }, viewport)).toBeNull();
    expect(normalizeRegionSelection({ x: 1290, y: 10, width: 50, height: 50 }, viewport)).toBeNull();
    expect(normalizeRegionSelection('10,10,20,20', viewport)).toBeNull();
  });

  // 150% 缩放下 1 DIP = 1.5 物理像素: 选区必须落在物理像素网格上, 键盘微调 1 个物理像素
  // (1/1.5 DIP) 才不会被取整吞掉, 裁剪也不会多 / 少一列像素。
  it('aligns selections to the physical pixel grid on fractional scale factors', () => {
    const viewport = { width: 1707, height: 960 };
    const selection = normalizeRegionSelection(
      { x: 10.3, y: 20.1, width: 100.2, height: 50 },
      viewport,
      1.5,
    );
    expect(selection).not.toBeNull();
    for (const value of Object.values(selection!)) {
      expect(Math.abs(value * 1.5 - Math.round(value * 1.5))).toBeLessThan(1e-9);
    }
    // 不足一个物理像素的选区视为空
    expect(normalizeRegionSelection({ x: 5, y: 5, width: 0.2, height: 10 }, viewport, 2)).toBeNull();
  });

  it('resizes through the opposite edge, keeps corner squares inside the display, and nudges', () => {
    const viewport = { width: 800, height: 600 };
    const start = { x: 100, y: 100, width: 200, height: 100 };
    // 左边手柄拖过右边: 翻转而不是出现负宽度
    expect(resizeRegion(start, 'w', { x: 350, y: 0 }, viewport)).toEqual({
      x: 300,
      y: 100,
      width: 50,
      height: 100,
    });
    // Shift + 角手柄: 以对角为锚点的正方形, 被屏幕边缘截住时整体缩小
    expect(resizeRegion(start, 'se', { x: 900, y: 150 }, viewport, true)).toEqual({
      x: 100,
      y: 100,
      width: 500,
      height: 500,
    });
    // Alt + 方向键缩小时至少保留一步, 平移不越出屏幕
    expect(nudgeRegion(start, 'ArrowLeft', 300, viewport, true).width).toBe(300);
    expect(nudgeRegion({ ...start, x: 795 }, 'ArrowRight', 10, viewport).x).toBe(600);
  });

  // 滚轮在候选里逐级切换: 顺序必须由内到外、末尾是整块屏, 重复或越级变小的项会让滚轮「卡住」或跳回内层。
  it('orders snap candidates from the innermost element out to the whole display', () => {
    const viewport = { width: 1000, height: 800 };
    const window = { id: 3, rect: { x: 100, y: 100, width: 600, height: 500 } };
    const candidates = snapCandidates(
      { x: 150, y: 150 },
      window,
      [
        { x: 140, y: 140, width: 40, height: 20 },
        { x: 140, y: 140, width: 40, height: 20 },
        { x: 120, y: 120, width: 300, height: 200 },
        // 识别程序偶发的异常外层: 比内层还小, 跳过
        { x: 145, y: 145, width: 10, height: 10 },
        // 不包含指针的区域不可能被选中
        { x: 500, y: 500, width: 50, height: 50 },
      ],
      viewport,
    );
    expect(candidates).toEqual([
      { x: 140, y: 140, width: 40, height: 20 },
      { x: 120, y: 120, width: 300, height: 200 },
      window.rect,
      { x: 0, y: 0, width: 1000, height: 800 },
    ]);
  });
});

/**
 * 页面导出的最终像素直接进 nativeImage.createFromBitmap; 尺寸与字节数对不上会得到错乱
 * 图像, 超出显示器的尺寸是异常 payload (electron-security: IPC 入参在 main 侧重新校验)。
 */
describe('region screenshot export payload', () => {
  const limit = { width: 100, height: 50 };
  it.each([
    ['accepts an exact BGRA buffer', { width: 2, height: 3, data: new Uint8Array(24) }, true],
    ['rejects a short buffer', { width: 2, height: 3, data: new Uint8Array(23) }, false],
    ['rejects sizes beyond the display', { width: 101, height: 1, data: new Uint8Array(404) }, false],
    ['rejects fractional sizes', { width: 1.5, height: 2, data: new Uint8Array(12) }, false],
    ['rejects plain arrays', { width: 1, height: 1, data: [0, 0, 0, 0] }, false],
  ])('%s', (_name, payload, accepted) => {
    expect(validateRegionBitmap(payload, limit) !== null).toBe(accepted);
  });
});
