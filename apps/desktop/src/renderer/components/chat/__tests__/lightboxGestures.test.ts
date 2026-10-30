import { describe, expect, it } from 'vitest';
import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_WHEEL_DELTA_CLAMP,
  LIGHTBOX_ZOOM_WHEEL_SENSITIVITY,
  clampScale,
  wheelZoomFactor,
  zoomAtPoint,
  classifyWheelSample,
  createWheelSourceTracker,
  imageLightboxWheelIntent,
} from '../lightboxGestures';

describe('lightboxGestures', () => {
  it('clamps scale to the configured bounds', () => {
    expect(clampScale(0)).toBe(LIGHTBOX_MIN_SCALE);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(100)).toBe(LIGHTBOX_MAX_SCALE);
  });

  it('keeps the content point under the cursor fixed while zooming', () => {
    const viewport = { scale: 2, tx: 30, ty: -20 };
    const point = { cx: 140, cy: 80 };
    const beforeX = (point.cx - viewport.tx) / viewport.scale;
    const beforeY = (point.cy - viewport.ty) / viewport.scale;

    const next = zoomAtPoint(viewport, point, 1.4);

    expect((point.cx - next.tx) / next.scale).toBeCloseTo(beforeX, 12);
    expect((point.cy - next.ty) / next.scale).toBeCloseTo(beforeY, 12);
  });

  it('does not move translate when zoom is clamped at a scale boundary', () => {
    const viewport = { scale: LIGHTBOX_MAX_SCALE, tx: 30, ty: -20 };

    const next = zoomAtPoint(viewport, { cx: 140, cy: 80 }, 1.4);

    expect(next).toBe(viewport);
  });

  it('maps negative wheel delta to zoom in and positive delta to zoom out', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
  });

  it('clamps large wheel deltas before applying the exponential factor', () => {
    expect(wheelZoomFactor(400)).toBeCloseTo(wheelZoomFactor(40), 12);
    expect(wheelZoomFactor(-400)).toBeCloseTo(wheelZoomFactor(-40), 12);
  });

  it('applies the exponential factor at the clamped delta boundary', () => {
    const boundary =
      LIGHTBOX_WHEEL_DELTA_CLAMP * LIGHTBOX_ZOOM_WHEEL_SENSITIVITY;
    expect(wheelZoomFactor(-LIGHTBOX_WHEEL_DELTA_CLAMP)).toBeCloseTo(
      Math.exp(boundary),
      12,
    );
    expect(wheelZoomFactor(LIGHTBOX_WHEEL_DELTA_CLAMP)).toBeCloseTo(
      Math.exp(-boundary),
      12,
    );
  });

  it('normalizes line-mode wheel deltas before clamping', () => {
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(wheelZoomFactor(16), 12);
  });
});

describe('classifyWheelSample', () => {
  const sample = (over: Partial<Parameters<typeof classifyWheelSample>[0]>) => ({
    deltaMode: 0,
    deltaX: 0,
    deltaY: 0,
    shiftKey: false,
    ...over,
  });

  it('treats notched wheels as a mouse', () => {
    // Windows / Linux:每格 wheelDeltaY ±120。
    expect(classifyWheelSample(sample({ deltaY: 100, wheelDeltaY: -120 }))).toBe('mouse');
    expect(classifyWheelSample(sample({ deltaY: 125, wheelDeltaY: -120 }))).toBe('mouse');
    // macOS 无加速的一格:deltaY 40、wheelDeltaY 120。
    expect(classifyWheelSample(sample({ deltaY: -40, wheelDeltaY: 120 }))).toBe('mouse');
    // macOS 加速滚轮:小数像素。
    expect(classifyWheelSample(sample({ deltaY: 4.000244140625, wheelDeltaY: -12 }))).toBe('mouse');
    // 行 / 页单位只来自滚轮。
    expect(classifyWheelSample(sample({ deltaMode: 1, deltaY: 3 }))).toBe('mouse');
    // Shift+滚轮的横向滚动仍是鼠标。
    expect(classifyWheelSample(sample({ deltaX: 100, shiftKey: true, wheelDeltaY: 0 }))).toBe('mouse');
  });

  it('treats continuous two-finger scrolling as a trackpad', () => {
    expect(classifyWheelSample(sample({ deltaY: 2, wheelDeltaY: -6 }))).toBe('trackpad');
    expect(classifyWheelSample(sample({ deltaY: -7, wheelDeltaY: 21 }))).toBe('trackpad');
    expect(classifyWheelSample(sample({ deltaX: 3, deltaY: 1 }))).toBe('trackpad');
  });

  it('falls back to mouse (zoom) when undecidable', () => {
    expect(classifyWheelSample(sample({ deltaY: 7 }))).toBe('mouse');
  });
});

describe('createWheelSourceTracker', () => {
  const sample = (over: Partial<Parameters<typeof classifyWheelSample>[0]>) => ({
    deltaMode: 0,
    deltaX: 0,
    deltaY: 0,
    shiftKey: false,
    ...over,
  });

  it('keeps one classification for a whole stream and re-classifies after idle', () => {
    const track = createWheelSourceTracker(250);
    expect(track(sample({ deltaY: 3, wheelDeltaY: -9 }), 0)).toBe('trackpad');
    // 惯性尾巴里偶发一个恰好是 40 倍数的大 delta,不翻转。
    expect(track(sample({ deltaY: 40, wheelDeltaY: -120 }), 16)).toBe('trackpad');
    // 停顿后重新判定。
    expect(track(sample({ deltaY: 100, wheelDeltaY: -120 }), 1000)).toBe('mouse');
  });

  it('upgrades a stream to trackpad once a horizontal component shows up', () => {
    const track = createWheelSourceTracker(250);
    expect(track(sample({ deltaY: 7 }), 0)).toBe('mouse');
    expect(track(sample({ deltaX: 2, deltaY: 5 }), 16)).toBe('trackpad');
    expect(track(sample({ deltaY: 5 }), 32)).toBe('trackpad');
  });
});

describe('imageLightboxWheelIntent', () => {
  const wheel = (over: Partial<{ ctrlKey: boolean; metaKey: boolean; deltaX: number; deltaY: number }>) => ({
    ctrlKey: false,
    metaKey: false,
    deltaX: 0,
    deltaY: 0,
    ...over,
  });

  it('pinch (ctrl) and ⌘ + wheel zoom regardless of source', () => {
    expect(imageLightboxWheelIntent(wheel({ ctrlKey: true, deltaY: -3 }), 'trackpad', 1)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ metaKey: true, deltaY: 40 }), 'mouse', 2)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ ctrlKey: true, deltaX: 5 }), 'trackpad', 2)).toBe('none');
  });

  it('a mouse wheel zooms (same on every OS)', () => {
    expect(imageLightboxWheelIntent(wheel({ deltaY: 100 }), 'mouse', 1)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ deltaY: -100 }), 'mouse', 3)).toBe('zoom');
    expect(imageLightboxWheelIntent(wheel({ deltaX: 30 }), 'mouse', 2)).toBe('none');
  });

  it('a trackpad two-finger scroll pans only while zoomed in', () => {
    expect(imageLightboxWheelIntent(wheel({ deltaY: 12 }), 'trackpad', 1)).toBe('none');
    expect(imageLightboxWheelIntent(wheel({ deltaX: -8 }), 'trackpad', 2)).toBe('pan');
    expect(imageLightboxWheelIntent(wheel({ deltaY: 12 }), 'trackpad', 2)).toBe('pan');
    expect(imageLightboxWheelIntent(wheel({}), 'trackpad', 2)).toBe('none');
  });
});
