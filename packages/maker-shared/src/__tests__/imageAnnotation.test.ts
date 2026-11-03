import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_CANVAS_SCRIPT,
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_STROKE_COLOR,
  MAX_ANNOTATION_REGIONS,
  INTERRUPTED_STROKE_DISCARD_SCREEN_PX,
  annotationOutlineWidth,
  annotationStrokeScreenLength,
  annotationStrokeToSvgPath,
  annotationStrokeWidth,
  drawAnnotationStrokes,
  formatAnnotationRegion,
  normalizeAnnotationPoint,
  sanitizeAnnotationRegions,
  shouldAppendAnnotationPoint,
  summarizeAnnotationRegions,
  type AnnotationCanvasContext,
  type AnnotationStroke,
} from '../imageAnnotation';

/** 旧版(单一短边)公式:常规比例图片的线宽必须与它完全一致。 */
function legacyStrokeWidth(w: number, h: number): number {
  return Math.min(24, Math.max(4, Math.round(Math.min(w, h) * 0.005)));
}

function recordingContext(): AnnotationCanvasContext & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const ctx = {
    calls,
    _lineCap: '',
    _lineJoin: '',
    _strokeStyle: '' as unknown,
    _lineWidth: 0,
    get lineCap() { return this._lineCap; },
    set lineCap(v: string) { this._lineCap = v; calls.push(['lineCap', v]); },
    get lineJoin() { return this._lineJoin; },
    set lineJoin(v: string) { this._lineJoin = v; calls.push(['lineJoin', v]); },
    get strokeStyle() { return this._strokeStyle; },
    set strokeStyle(v: unknown) { this._strokeStyle = v; calls.push(['strokeStyle', v]); },
    get lineWidth() { return this._lineWidth; },
    set lineWidth(v: number) { this._lineWidth = v; calls.push(['lineWidth', v]); },
    beginPath() { calls.push(['beginPath']); },
    moveTo(x: number, y: number) { calls.push(['moveTo', x, y]); },
    lineTo(x: number, y: number) { calls.push(['lineTo', x, y]); },
    stroke() { calls.push(['stroke']); },
  };
  return ctx;
}

function loadScript(): {
  width: (w: number, h: number) => number;
  draw: (ctx: unknown, strokes: unknown, w: number, h: number) => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    `${ANNOTATION_CANVAS_SCRIPT}\nreturn { width: cindyAnnotationStrokeWidth, draw: cindyDrawAnnotationStrokes };`,
  );
  return factory();
}

const STROKES: AnnotationStroke[] = [
  { points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.2 }, { x: 0.6, y: 0.7 }] },
  { points: [{ x: 0.3, y: 0.3 }] },
  { points: [] },
  { points: [{ x: 0.9, y: 0.05 }, { x: 0.95, y: 0.1 }] },
];

describe('annotationStrokeWidth', () => {
  it('keeps the legacy width for ordinary aspect ratios', () => {
    const sizes: Array<[number, number]> = [
      [320, 240], [800, 600], [1179, 2556], [1920, 1080], [2560, 1600],
      [3024, 4032], [4000, 3000], [6000, 4000], [8000, 6000], [1000, 2500],
      [10000, 10000], [20000, 20000], [6000, 13000], [30000, 12000],
    ];
    for (const [w, h] of sizes) {
      expect(annotationStrokeWidth(w, h)).toBe(legacyStrokeWidth(w, h));
      expect(annotationStrokeWidth(h, w)).toBe(legacyStrokeWidth(w, h));
    }
  });

  it('thickens strokes on very long screenshots so they survive model downscaling', () => {
    const width = annotationStrokeWidth(1000, 8000);
    expect(width).toBeGreaterThan(legacyStrokeWidth(1000, 8000));
    // 缩到长边 1568 后仍至少约 3px。
    expect((width * 1568) / 8000).toBeGreaterThanOrEqual(2.9);
  });

  it('caps the long-edge term relative to the short edge', () => {
    expect(annotationStrokeWidth(1000, 200_000)).toBe(20);
  });

  it('never goes below 4px', () => {
    expect(annotationStrokeWidth(10, 10)).toBe(4);
  });
});

describe('normalizeAnnotationPoint', () => {
  it('clamps to the image and quantizes to 4 decimals', () => {
    const rect = { left: 10, top: 20, width: 300, height: 200 };
    expect(normalizeAnnotationPoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(normalizeAnnotationPoint(1000, 1000, rect)).toEqual({ x: 1, y: 1 });
    expect(normalizeAnnotationPoint(110, 70, rect)).toEqual({ x: 0.3333, y: 0.25 });
  });

  it('rejects empty rects', () => {
    expect(normalizeAnnotationPoint(1, 1, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
    expect(normalizeAnnotationPoint(1, 1, { left: 0, top: 0, width: Number.NaN, height: 10 })).toBeNull();
  });
});

describe('shouldAppendAnnotationPoint', () => {
  it('always accepts the first point and filters jitter', () => {
    expect(shouldAppendAnnotationPoint({ points: [] }, { x: 0.5, y: 0.5 })).toBe(true);
    const stroke = { points: [{ x: 0.5, y: 0.5 }] };
    expect(shouldAppendAnnotationPoint(stroke, { x: 0.5005, y: 0.5 })).toBe(false);
    expect(shouldAppendAnnotationPoint(stroke, { x: 0.51, y: 0.5 })).toBe(true);
  });
});

describe('annotationStrokeToSvgPath', () => {
  it('renders single points as a tiny segment', () => {
    expect(annotationStrokeToSvgPath({ points: [{ x: 0.5, y: 0.5 }] }, 100, 100)).toBe('M 50.0 50.0 L 50.1 50.0');
  });
  it('renders polylines', () => {
    expect(
      annotationStrokeToSvgPath({ points: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] }, 200, 100),
    ).toBe('M 0.0 0.0 L 200.0 50.0');
  });
  it('returns empty for empty strokes', () => {
    expect(annotationStrokeToSvgPath({ points: [] }, 100, 100)).toBe('');
  });
});

describe('drawAnnotationStrokes', () => {
  it('draws every outline before any red stroke', () => {
    const ctx = recordingContext();
    drawAnnotationStrokes(ctx, STROKES, 1000, 800);
    const styles = ctx.calls.filter((c) => c[0] === 'strokeStyle').map((c) => c[1]);
    expect(styles).toEqual([ANNOTATION_OUTLINE_COLOR, ANNOTATION_STROKE_COLOR]);
    const widths = ctx.calls.filter((c) => c[0] === 'lineWidth').map((c) => c[1]);
    const w = annotationStrokeWidth(1000, 800);
    expect(widths).toEqual([annotationOutlineWidth(w), w]);
    // 3 条非空笔迹 × 2 遍。
    expect(ctx.calls.filter((c) => c[0] === 'stroke')).toHaveLength(6);
  });
});

describe('ANNOTATION_CANVAS_SCRIPT (mobile WebView copy)', () => {
  const script = loadScript();

  it('computes the same stroke width as the TS implementation', () => {
    for (const w of [10, 320, 799, 1000, 1179, 1920, 3024, 4096, 8000, 20_000]) {
      for (const h of [10, 240, 1080, 2556, 4032, 8000, 12_000, 200_000]) {
        expect(script.width(w, h)).toBe(annotationStrokeWidth(w, h));
      }
    }
  });

  it('issues the exact same canvas calls as drawAnnotationStrokes', () => {
    for (const [w, h] of [[1000, 800], [1000, 8000], [4096, 3072]] as const) {
      const expected = recordingContext();
      drawAnnotationStrokes(expected, STROKES, w, h);
      const actual = recordingContext();
      script.draw(actual, STROKES, w, h);
      expect(actual.calls).toEqual(expected.calls);
    }
  });
});

describe('summarizeAnnotationRegions', () => {
  it('returns one box per separate mark, sorted top-to-bottom', () => {
    const regions = summarizeAnnotationRegions([
      { points: [{ x: 0.6, y: 0.7 }, { x: 0.8, y: 0.9 }] },
      { points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.15 }] },
    ]);
    expect(regions).toEqual([
      { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.15 },
      { x0: 0.6, y0: 0.7, x1: 0.8, y1: 0.9 },
    ]);
  });

  it('merges strokes that overlap or nearly touch (chained merges included)', () => {
    const regions = summarizeAnnotationRegions([
      { points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
      { points: [{ x: 0.5, y: 0.1 }, { x: 0.6, y: 0.2 }] },
      // 桥接前两处。
      { points: [{ x: 0.21, y: 0.15 }, { x: 0.49, y: 0.15 }] },
    ]);
    expect(regions).toEqual([{ x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.2 }]);
  });

  it('handles taps, invalid points and empty input', () => {
    expect(summarizeAnnotationRegions(undefined)).toEqual([]);
    expect(summarizeAnnotationRegions([{ points: [] }])).toEqual([]);
    expect(
      summarizeAnnotationRegions([{ points: [{ x: Number.NaN, y: 0 }, { x: 0.5, y: 0.5 }] }]),
    ).toEqual([{ x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 }]);
  });

  it('keeps only the largest regions when there are too many', () => {
    const strokes: AnnotationStroke[] = [];
    for (let i = 0; i < MAX_ANNOTATION_REGIONS + 3; i++) {
      const x = i * 0.1;
      const size = i === 0 ? 0.001 : 0.05;
      strokes.push({ points: [{ x, y: 0.5 }, { x: x + size, y: 0.5 + size }] });
    }
    const regions = summarizeAnnotationRegions(strokes);
    expect(regions).toHaveLength(MAX_ANNOTATION_REGIONS);
    expect(regions.some((r) => r.x0 === 0)).toBe(false);
  });
});

describe('sanitizeAnnotationRegions', () => {
  it('drops malformed entries and clamps values', () => {
    expect(
      sanitizeAnnotationRegions([
        { x0: -1, y0: 0.2, x1: 0.5, y1: 2 },
        { x0: 0.5, y0: 0.5, x1: 0.1, y1: 0.9 },
        { x0: 'a', y0: 0, x1: 1, y1: 1 },
        null,
      ]),
    ).toEqual([{ x0: 0, y0: 0.2, x1: 0.5, y1: 1 }]);
    expect(sanitizeAnnotationRegions('nope')).toBeUndefined();
    expect(sanitizeAnnotationRegions([])).toBeUndefined();
  });
});

describe('formatAnnotationRegion', () => {
  it('formats with two decimals', () => {
    expect(formatAnnotationRegion({ x0: 0.1, y0: 0.25, x1: 0.5, y1: 1 })).toBe(
      'x 0.10–0.50, y 0.25–1.00',
    );
  });
});

describe('annotationStrokeScreenLength', () => {
  it('sums segment lengths in display pixels', () => {
    expect(annotationStrokeScreenLength([{ x: 0, y: 0 }], 100, 100)).toBe(0);
    expect(annotationStrokeScreenLength([{ x: 0, y: 0 }, { x: 0.03, y: 0.04 }], 100, 100)).toBeCloseTo(5);
    expect(
      annotationStrokeScreenLength([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.1 }], 200, 100),
    ).toBeCloseTo(30);
    expect(INTERRUPTED_STROKE_DISCARD_SCREEN_PX).toBe(12);
  });
});
