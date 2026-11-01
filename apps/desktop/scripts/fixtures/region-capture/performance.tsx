// Explicit benchmark/E2E fixture: actual overlay, Canvas and keyboard export.
// Only the native bridge is replaced. No captured user pixels or clipboard writes.
import { flushSync } from 'react-dom';
import { mountPage } from '../../ui-page/harness';
import { RegionScreenshotOverlay } from '../../../src/renderer/features/region-screenshot/RegionScreenshotOverlay';
import type { RegionScreenshotOverlayBridge } from '../../../src/renderer/features/region-screenshot/bridge';
import type { RegionRect, RegionScreenshotBitmap, RegionScreenshotExport } from '../../../src/shared/regionScreenshot';
import { matchScrollFrames, ScrollCapture } from '../../../src/shared/scrollCapture';
import * as annotationDrawing from '../../../src/renderer/features/region-screenshot/annotations';
import type { Annotation } from '../../../src/renderer/features/region-screenshot/annotations';
import { CaptureRecorder } from '../../../src/renderer/features/region-screenshot/captureRecorder';

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
let canvasResizes = 0;
for (const property of ['width', 'height'] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property)!;
  Object.defineProperty(HTMLCanvasElement.prototype, property, { ...descriptor,
    set(value: number) { canvasResizes++; descriptor.set!.call(this, value); },
  });
}
const put = CanvasRenderingContext2D.prototype.putImageData;
CanvasRenderingContext2D.prototype.putImageData = function (...args: Parameters<typeof put>) {
  if (frame && args[0].width === frame.width && args[0].height === frame.height) frameWrites++;
  return put.apply(this, args);
};
const key = (value: string) => flushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));

Object.assign(window, { screenshotPerf: {
  async begin(width: number, height: number, scale = 1, crop?: RegionRect, alpha = false, oversample = 1, selected = true) {
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
    if (selected) key('r');
    return { syncMs, paintedMs, frameWrites };
  },
  hoverProbe(reset = false) {
    if (reset) canvasResizes = 0;
    const canvases = document.querySelectorAll('canvas');
    if (canvases.length < 3) throw new Error('Hover probe did not render the magnifier');
    const magnifier = canvases[canvases.length - 1];
    const pixels = magnifier.getContext('2d')!.getImageData(0, 0, magnifier.width, magnifier.height).data;
    let hash = 2166136261;
    for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
    return { canvasResizes, hash: hash >>> 0, width: magnifier.width, height: magnifier.height };
  },
  annotations(count: number, readFrequently = true) {
    const { drawAnnotations } = annotationDrawing;
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = 3840; sourceCanvas.height = 2160;
    const sourceCtx = sourceCanvas.getContext('2d')!;
    const pixels = new ImageData(3840, 2160);
    for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = (i * 31 + (i >>> 12)) % 256;
    sourceCtx.putImageData(pixels, 0, 0);
    const source = { frame: sourceCanvas, ratioX: 2, ratioY: 2 };
    const canvas = document.createElement('canvas'); canvas.width = 3840; canvas.height = 2160;
    const ctx = canvas.getContext('2d', { willReadFrequently: readFrequently })!;
    const marks: Annotation[] = Array.from({ length: 8 }, (_, i) => ({
      id: String(i), kind: i % 2 ? 'mosaic' : 'blur', color: 'red', size: 2,
      from: { x: i * 120 - 10.5, y: i * 50 - 3.5 }, to: { x: i * 120 + 450.25, y: i * 50 + 240.75 },
    }));
    for (let i = 0; i < 40; i++) marks.push({ id: `pen-${i}`, kind: i % 2 ? 'pen' : 'marker', color: 'yellow', size: 1,
      points: Array.from({ length: 500 }, (_, j) => ({ x: 20 + j * 6, y: 20 + i * 20 + Math.sin(j / 4) * 15 })) });
    const raw: number[] = [], synchronous: number[] = [];
    let drawingMs = 0, drawScale = 2, translate = 0;
    let hash = 2166136261;
    // Force raster completion in both versions, not merely Canvas command enqueue.
    const render = (list: Annotation[], cached = true, draft: Annotation | null = null) => {
      ctx.resetTransform(); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.setTransform(drawScale, 0, 0, drawScale, translate, translate);
      const started = performance.now();
      const all = draft ? [...list, draft] : list;
      drawAnnotations(ctx, cached ? all : all.map(a => 'points' in a ? { ...a, points: a.points.map(p => ({ ...p })) } : a), source);
      drawingMs = performance.now() - started;
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    for (let i = -3; i < count; i++) {
      const draft: Annotation = { id: 'draft', kind: 'marker', color: 'yellow', size: 2,
        points: [{ x: 30, y: 40 }, { x: 200 + i, y: 150 + i }] };
      const start = performance.now();
      const actual = render(marks, true, draft);
      if (i >= 0) { raw.push(performance.now() - start); synchronous.push(drawingMs); }
      if (i === count - 1) {
        const expected = render(marks, false, draft);
        for (let j = 0; j < actual.length; j++) {
          if (actual[j] !== expected[j]) throw new Error(`Cached annotation changed byte ${j}`);
          hash = Math.imul(hash ^ actual[j], 16777619);
        }
      }
    }
    // Edit, undo, reorder, source replacement and coordinate changes all preserve pixels.
    const regression: number[] = [];
    const verify = (list: Annotation[]) => {
      const actual = render(list), expected = render(list, false);
      if (actual.some((byte, i) => byte !== expected[i])) throw new Error('Annotation path reuse changed pixels');
      let value = 2166136261; for (const byte of actual) value = Math.imul(value ^ byte, 16777619);
      regression.push(value >>> 0);
    };
    verify(marks.map(a => 'points' in a ? { ...a, points: a.points.map(p => ({ x: p.x + 2.25, y: p.y - 3.5 })) } : a));
    verify(marks.slice().reverse());
    verify(marks.slice(1)); verify(marks);
    verify(marks.map(a => 'from' in a ? { ...a, to: { x: a.to.x + 3.25, y: a.to.y + 5.5 } } : a));
    source.ratioX = 1.5; source.ratioY = 1.5; verify(marks);
    drawScale = 1.5; translate = -17.25; verify(marks);
    drawScale = 0.75; translate = 13.5; verify(marks);
    sourceCtx.clearRect(0, 0, 3840, 2160); verify(marks);
    return { raw, synchronous, regression, hash: hash >>> 0, pixelsIdentical: true, width: 3840, height: 2160, effects: marks.length };
  },
  async gifMotion(count: number) {
    const width = 960, height = 540;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const original = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < original.length; i += 4) {
      let seed = Math.imul(i + 1, 2654435761) >>> 0; seed ^= seed >>> 13;
      original[i] = seed & 255; original[i + 1] = seed >>> 8 & 255;
      original[i + 2] = seed >>> 16 & 255; original[i + 3] = 255;
    }
    const raw: number[] = [];
    const recorder = new CaptureRecorder(canvas, 'gif', () => { throw new Error('Unexpected size limit'); });
    for (let i = 0; i < count; i++) {
      // Move all colors without changing their distribution. This is deliberately
      // separate from the existing changing-distribution stress scenario.
      const data = new Uint8ClampedArray(original.length), shift = i * 4 * 97;
      data.set(original.subarray(shift)); data.set(original.subarray(0, shift), original.length - shift);
      ctx.putImageData(new ImageData(data, width, height), 0, 0);
      const start = performance.now(); await recorder.add(i * 130); raw.push(performance.now() - start);
    }
    const bytes = await recorder.finish(count * 130); recorder.dispose();
    let hash = 2166136261; for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
    return { raw, bytes: bytes.length, hash: hash >>> 0 };
  },
  async pipeline(count: number) {
    // Deterministic opaque texture, with independent rows to avoid ambiguous
    // scrolling matches. Generation and putImageData are outside encode timing.
    const texture = (width: number, height: number, offset = 0): RegionScreenshotBitmap => {
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let seed = ((y + offset + 1) * 2654435761 + x * 2246822519) >>> 0;
        seed ^= seed >>> 13;
        const at = (y * width + x) * 4;
        data[at] = seed & 255; data[at + 1] = seed >>> 8 & 255;
        data[at + 2] = seed >>> 16 & 255; data[at + 3] = 255;
      }
      return { width, height, data };
    };
    const first = texture(960, 1600), next = texture(960, 1600, 240), unrelated = texture(960, 1600, 6000);
    const scroll = [];
    for (const [name, a, b] of [['stationary', first, first], ['forward', first, next], ['reverse', next, first], ['unmatched', first, unrelated]] as const) {
      const raw: number[] = [];
      let result;
      for (let i = -3; i < count; i++) {
        const started = performance.now();
        result = matchScrollFrames(a, b);
        if (i >= 0) raw.push(performance.now() - started);
      }
      scroll.push({ name, raw, result });
    }
    const capture = new ScrollCapture(first);
    capture.add(next);
    const output = capture.image();
    const hash = (data: Uint8Array) => {
      let value = 2166136261;
      for (const byte of data) value = Math.imul(value ^ byte, 16777619);
      return value >>> 0;
    };
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const pixels = new ImageData(new Uint8ClampedArray(texture(960, 540).data), 960, 540);
    const recorder = new CaptureRecorder(canvas, 'gif', () => { throw new Error('Unexpected GIF limit'); });
    const gif: number[] = [];
    const mainThread: number[] = [], timerDelay: number[] = [];
    for (let i = 0; i < count; i++) {
      ctx.putImageData(pixels, 0, 0);
      ctx.fillStyle = 'white'; ctx.fillRect(20 + i * 2, 30, 10, 20);
      const started = performance.now();
      // Same-thread timer cannot run until synchronous encoding returns. Worker
      // completion is awaited separately, preserving the production backpressure.
      const responsive = new Promise<void>(resolve => setTimeout(() => { timerDelay.push(performance.now() - started); resolve(); }, 0));
      const pending = recorder.add(i * 100);
      mainThread.push(performance.now() - started);
      await pending;
      gif.push(performance.now() - started);
      await responsive;
    }
    const finishStarted = performance.now();
    const bytes = await recorder.finish(count * 100);
    const gifFinishMs = performance.now() - finishStarted;
    recorder.dispose();
    return { scroll, stitched: { height: output.height, hash: hash(output.data) },
      gif: { raw: gif, mainThread, timerDelay, finishMs: gifFinishMs, bytes: bytes.length, hash: hash(bytes) } };
  },
  async gifParity() {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const recorder = new CaptureRecorder(canvas, 'gif', () => { throw new Error('Unexpected GIF limit'); });
    // No timing mocks: actual worker + canvas. Fixed supplied times make the
    // complete old/new GIF comparable, including identical frames and pause.
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 64, 48);
    ctx.fillStyle = 'black'; ctx.fillText('GIF 文字', 2, 20);
    await recorder.add(0); await recorder.add(100);
    ctx.fillStyle = 'red'; ctx.fillRect(63, 47, 1, 1);
    const changing = recorder.add(230);
    recorder.pause(370);
    await changing;
    recorder.resume();
    await recorder.add(370);
    const pixels = ctx.createImageData(64, 48);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = i * 17 % 251; pixels.data[i + 1] = i * 29 % 253;
      pixels.data[i + 2] = i * 37 % 255; pixels.data[i + 3] = (i / 4) % 2 ? 127 : 255;
    }
    ctx.putImageData(pixels, 0, 0);
    await recorder.add(480); await recorder.add(520);
    ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 64, 48);
    const last = recorder.add(690);
    const finishing = recorder.finish(810);
    await last;
    const bytes = await finishing;
    recorder.dispose();
    return Array.from(bytes);
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
