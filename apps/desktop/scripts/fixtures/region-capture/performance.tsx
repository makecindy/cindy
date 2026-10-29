// Explicit benchmark/E2E fixture: actual overlay, Canvas and keyboard export.
// Only the native bridge is replaced. No captured user pixels or clipboard writes.
import { flushSync } from 'react-dom';
import { mountPage } from '../../ui-page/harness';
import { RegionScreenshotOverlay } from '../../../src/renderer/features/region-screenshot/RegionScreenshotOverlay';
import type { RegionScreenshotOverlayBridge } from '../../../src/renderer/features/region-screenshot/bridge';
import type { RegionRect, RegionScreenshotBitmap, RegionScreenshotExport } from '../../../src/shared/regionScreenshot';

let begin: Parameters<RegionScreenshotOverlayBridge['onBegin']>[0];
let end: () => void;
let onPaint: () => void = () => {};
let exported: RegionScreenshotExport | null = null;
let frame: RegionScreenshotBitmap;
let selection: RegionRect;
let viewport: { width: number; height: number };
let scaleFactor = 1;
let sequence = 0;
let exportMs = 0;
let exportStart = 0;
let frameWrites = 0;
const put = CanvasRenderingContext2D.prototype.putImageData;
CanvasRenderingContext2D.prototype.putImageData = function (...args: Parameters<typeof put>) {
  if (frame && args[0].width === frame.width && args[0].height === frame.height) frameWrites++;
  return put.apply(this, args);
};
const key = (value: string) => flushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));

Object.assign(window, { screenshotPerf: {
  async begin(width: number, height: number, scale = 1, crop?: RegionRect, alpha = false, oversample = 1) {
    flushSync(() => end?.());
    const w = Math.round(width * oversample), h = Math.round(height * oversample);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 13 + y * 7) % 256;
      data[i + 1] = (x * 3 + y * 11) % 256;
      data[i + 2] = (x * 17 + y) % 256;
      data[i + 3] = alpha ? (x + y) % 256 : 255;
    }
    frame = { width: w, height: h, data };
    viewport = { width: width / scale, height: height / scale };
    scaleFactor = scale;
    selection = crop ?? { x: 0, y: 0, width: width / scale, height: height / scale };
    const painted = new Promise<void>(resolve => { onPaint = resolve; });
    frameWrites = 0;
    // Start each sample at the same compositor phase; otherwise faster export
    // shifts the next sample across a vsync boundary and biases paintedMs.
    await new Promise(requestAnimationFrame);
    const start = performance.now();
    flushSync(() => begin({ token: String(++sequence), locale: 'en', frame,
      viewport, scaleFactor: scale,
      windows: [], cursor: null, lastRegion: selection }));
    const syncMs = performance.now() - start;
    await painted;
    const paintedMs = performance.now() - start;
    key('r');
    return { syncMs, paintedMs, frameWrites };
  },
  async export() {
    exported = null;
    exportStart = performance.now();
    key('Enter');
    // Failed host export is deliberately retryable, allowing repeated samples
    // without conflating capture/setup and export timing.
    await Promise.resolve();
    if (!exported) throw new Error('Overlay did not export');
    return exportMs;
  },
  verify(annotated = false) {
    if (!exported) throw new Error('Missing export');
    const actual = (exported as RegionScreenshotExport).image;
    if (actual.width !== Math.round(selection.width * scaleFactor)
      || actual.height !== Math.round(selection.height * scaleFactor)) throw new Error('Export dimensions changed');
    // Independent Canvas oracle, including scaling and alpha round-tripping.
    const rgba = new ImageData(frame.width, frame.height);
    for (let i = 0; i < frame.data.length; i += 4) {
      rgba.data[i] = frame.data[i + 2]; rgba.data[i + 1] = frame.data[i + 1];
      rgba.data[i + 2] = frame.data[i]; rgba.data[i + 3] = frame.data[i + 3];
    }
    const source = document.createElement('canvas');
    source.width = frame.width; source.height = frame.height;
    source.getContext('2d')!.putImageData(rgba, 0, 0);
    const visible = document.querySelector('canvas')!;
    if (visible.width !== frame.width || visible.height !== frame.height) throw new Error('Frozen canvas dimensions changed');
    // The direct export must not mask an empty/stale first paint. Inspect the
    // actual displayed canvas independently of the in-memory export path.
    for (const [x, y] of [[0, 0], [13, 17], [frame.width - 1, frame.height - 1]]) {
      const actualPixel = visible.getContext('2d')!.getImageData(x, y, 1, 1).data;
      const expectedPixel = source.getContext('2d')!.getImageData(x, y, 1, 1).data;
      if (actualPixel.some((v, i) => v !== expectedPixel[i])) throw new Error('Frozen canvas pixels changed');
    }
    const target = document.createElement('canvas');
    target.width = actual.width; target.height = actual.height;
    const ctx = target.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const rx = frame.width / viewport.width, ry = frame.height / viewport.height;
    ctx.drawImage(source, selection.x * rx, selection.y * ry, selection.width * rx, selection.height * ry,
      0, 0, actual.width, actual.height);
    const expected = ctx.getImageData(0, 0, actual.width, actual.height).data;
    let differences = 0;
    let firstDifference = '';
    let hash = 2166136261;
    // Canvas GPU/CPU unpremultiplication may differ by one colour level at low
    // alpha (also in the untouched baseline). Compare the represented pixels
    // in premultiplied space, exactly; opaque screenshots remain byte-exact.
    const premultiply = (value: number, alpha: number) => Math.round(value * alpha / 255);
    for (let i = 0; i < expected.length; i += 4) {
      const alpha = actual.data[i + 3], expectedAlpha = expected[i + 3];
      const blue = premultiply(actual.data[i], alpha), green = premultiply(actual.data[i + 1], alpha), red = premultiply(actual.data[i + 2], alpha);
      for (const value of [blue, green, red, alpha]) hash = Math.imul(hash ^ value, 16777619);
      if (blue !== premultiply(expected[i + 2], expectedAlpha) || green !== premultiply(expected[i + 1], expectedAlpha)
        || red !== premultiply(expected[i], expectedAlpha) || alpha !== expectedAlpha) {
        differences++;
        firstDifference ||= `pixel=${i / 4} actualBGRA=${actual.data.slice(i, i + 4)} expectedRGBA=${expected.slice(i, i + 4)}`;
      }
    }
    // A composited source canvas can use a different resampling backend from
    // this detached oracle. Scaling is instead checked against the actual old
    // product's export hash by the runner, never against a copied resampler.
    const resampled = rx !== scaleFactor || ry !== scaleFactor;
    if (annotated ? differences === 0 : !resampled && differences !== 0) throw new Error(`Pixel mismatch: ${differences} (annotated=${annotated}); ${firstDifference}`);
    return { width: actual.width, height: actual.height, oracle: resampled ? 'baseline' : 'canvas', hash: hash >>> 0 };
  },
} });

const bridge = {
  onBegin: (callback) => { begin = callback; return () => {}; },
  onEnd: (callback) => { end = callback; return () => {}; }, onClear: () => () => {},
  shellReady() {}, painted() { onPaint(); }, focused() {}, selectionStarted() {}, copyText() {}, cancel() {}, abandon() {},
  elementsAt: async () => null,
  exportImage: async (_token, payload) => { exportMs = performance.now() - exportStart; exported = payload; return false; },
} as RegionScreenshotOverlayBridge;
void mountPage({ render: () => <RegionScreenshotOverlay bridge={bridge} /> });
