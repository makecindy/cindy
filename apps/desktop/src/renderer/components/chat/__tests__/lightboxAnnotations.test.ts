import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_STROKE_COLOR,
  annotationStrokeWidth,
  drawStrokesOnCanvas,
  extendDraftSvgPath,
  normalizePoint,
  shouldAppendPoint,
  strokeToSvgPath,
  type StrokeCanvasContext,
} from '../lightboxAnnotations';

describe('normalizePoint', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it('maps client coordinates into the 0..1 image space', () => {
    expect(normalizePoint(300, 150, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('clamps out-of-bounds points to the edge', () => {
    expect(normalizePoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(normalizePoint(9999, 9999, rect)).toEqual({ x: 1, y: 1 });
  });

  it('returns null for a degenerate rect', () => {
    expect(normalizePoint(1, 1, { left: 0, top: 0, width: 0, height: 100 })).toBeNull();
  });

  it('quantizes captured coordinates to 4 decimals (shared core)', () => {
    expect(normalizePoint(100 + 400 / 3, 50 + 200 / 7, rect)).toEqual({ x: 0.3333, y: 0.1429 });
  });
});

describe('shouldAppendPoint', () => {
  it('always accepts the first point and rejects sub-threshold moves', () => {
    const stroke = { points: [] as Array<{ x: number; y: number }> };
    expect(shouldAppendPoint(stroke, { x: 0.5, y: 0.5 })).toBe(true);
    stroke.points.push({ x: 0.5, y: 0.5 });
    expect(shouldAppendPoint(stroke, { x: 0.5005, y: 0.5 })).toBe(false);
    expect(shouldAppendPoint(stroke, { x: 0.51, y: 0.5 })).toBe(true);
  });
});

describe('annotationStrokeWidth', () => {
  it('scales with the short edge within [4, 24]', () => {
    expect(annotationStrokeWidth(200, 100)).toBe(4); // 0.5 → floor 4
    expect(annotationStrokeWidth(4000, 2000)).toBe(10);
    expect(annotationStrokeWidth(20000, 20000)).toBe(24); // capped
  });

  it('thickens very long screenshots so the mark survives model downscaling', () => {
    // 1000×8000:旧公式只有 5px,缩到 1568 长边后不足 1px;共享核心保证 ≥3px。
    expect(annotationStrokeWidth(1000, 8000)).toBeGreaterThan(5);
  });
});

describe('strokeToSvgPath', () => {
  it('maps normalized points into pixel space', () => {
    const d = strokeToSvgPath({ points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }] }, 200, 100);
    expect(d).toBe('M 0.0 0.0 L 100.0 100.0');
  });

  it('renders a single tap as a dot-length segment', () => {
    const d = strokeToSvgPath({ points: [{ x: 0.5, y: 0.5 }] }, 200, 100);
    expect(d).toContain('M 100.0 50.0 L 100.1 50.0');
  });

  it('returns empty string for empty strokes', () => {
    expect(strokeToSvgPath({ points: [] }, 200, 100)).toBe('');
  });
});

describe('drawStrokesOnCanvas', () => {
  function fakeCtx() {
    const calls: string[] = [];
    const ctx: StrokeCanvasContext = {
      lineCap: '',
      lineJoin: '',
      strokeStyle: '',
      lineWidth: 0,
      beginPath: () => calls.push('beginPath'),
      moveTo: (x, y) => calls.push(`moveTo(${x},${y})`),
      lineTo: (x, y) => calls.push(`lineTo(${x},${y})`),
      stroke: () => calls.push(`stroke:${String(ctx.strokeStyle)}:${ctx.lineWidth}`),
    };
    return { ctx, calls };
  }

  it('draws the white outline pass before the red pass, wider than it', () => {
    const { ctx, calls } = fakeCtx();
    drawStrokesOnCanvas(ctx, [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], 100, 100);
    const strokeCalls = calls.filter((c) => c.startsWith('stroke:'));
    expect(strokeCalls).toHaveLength(2);
    expect(strokeCalls[0]).toContain(ANNOTATION_OUTLINE_COLOR);
    expect(strokeCalls[1]).toContain(ANNOTATION_STROKE_COLOR);
    const outlineWidth = Number(strokeCalls[0].split(':').pop());
    const mainWidth = Number(strokeCalls[1].split(':').pop());
    expect(outlineWidth).toBeGreaterThan(mainWidth);
    expect(ctx.lineCap).toBe('round');
  });

  it('replays coordinates scaled to natural size', () => {
    const { ctx, calls } = fakeCtx();
    drawStrokesOnCanvas(ctx, [{ points: [{ x: 0.5, y: 0.25 }, { x: 1, y: 1 }] }], 400, 200);
    expect(calls).toContain('moveTo(200,50)');
    expect(calls).toContain('lineTo(400,200)');
  });

  it('skips empty strokes without emitting paths', () => {
    const { ctx, calls } = fakeCtx();
    drawStrokesOnCanvas(ctx, [{ points: [] }], 100, 100);
    expect(calls.filter((c) => c === 'beginPath')).toHaveLength(0);
  });
});

describe('extendDraftSvgPath', () => {
  it('builds the in-progress path incrementally, identical to strokeToSvgPath', () => {
    const points: Array<{ x: number; y: number }> = [];
    let cache = null as ReturnType<typeof extendDraftSvgPath> | null;
    const samples = [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.15 },
      { x: 0.33333, y: 0.4 },
      { x: 0.9, y: 0.95 },
      { x: 1, y: 0 },
    ];
    for (const sample of samples) {
      points.push(sample);
      cache = extendDraftSvgPath(points, 640, 480, cache);
      expect(cache.d).toBe(strokeToSvgPath({ points: [...points] }, 640, 480));
    }
    // 尺寸变化时全量重算。
    cache = extendDraftSvgPath(points, 320, 240, cache);
    expect(cache.d).toBe(strokeToSvgPath({ points: [...points] }, 320, 240));
  });
});
