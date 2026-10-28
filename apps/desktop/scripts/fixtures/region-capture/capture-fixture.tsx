import { useMemo, useState } from 'react';
import type { RegionScreenshotBitmap } from '../../../src/shared/regionScreenshot';
import { mountPage } from '../../ui-page/harness';
import { RecordingPreview } from '../../../src/renderer/features/region-screenshot/RecordingPreview';
import { RegionScreenshotOverlay } from '../../../src/renderer/features/region-screenshot/RegionScreenshotOverlay';
import { imageDataToBitmap, type RegionScreenshotOverlayBridge } from '../../../src/renderer/features/region-screenshot/bridge';
import { recordingControlsBounds, scrollCaptureLayout, type RecordingPreviewDocument, type RegionCaptureMode } from '../../../src/shared/regionCapture';

const qa = { frames: 0, firstFrameAt: 0, keysRequested: false, closed: false, copyAttempts: 0, copied: false, scrollFrames: 0, scrollLimit: 180, manualScroll: null as number | null, idle: false, automatic: false, saved: null as Uint8Array | null, saveAttempts: 0, format: '', exportedHeight: 0, annotationPixels: 0, restored: false };
Object.assign(window, { captureQa: qa });

function frame(scroll = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 480; canvas.height = 240;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#f8f8f6'; context.fillRect(0, 0, 480, 240);
  context.font = '16px sans-serif';
  for (let row = 0; row < 30; row++) {
    const y = row * 30 - scroll;
    context.fillStyle = row % 2 ? '#dddddd' : '#ffffff'; context.fillRect(0, y, 480, 30);
    context.fillStyle = '#262626'; context.fillText(`${String(row + 1).padStart(2, '0')}  Cindy capture — ${row * 7919}   ${row * 541}   ${row * 1237}`, 12, y + 21);
  }
  return imageDataToBitmap(context.getImageData(0, 0, 480, 240));
}

// The native handoff is covered in windows.test.ts and the real Desktop run.
// This adapter mounts the actual independent editor after the capture exports its image.
function ScrollFixture({ bridge, locale }: { bridge: RegionScreenshotOverlayBridge; locale: string }) {
  const [image, setImage] = useState<RegionScreenshotBitmap | null>(null);
  const [clip, setClip] = useState<RecordingPreviewDocument | null>(null);
  const captureBridge = useMemo(() => ({ ...bridge,
    previewRecording: async (_token: string, bytes: Uint8Array, format: 'webm' | 'gif') => { setClip({ token: 'clip', locale, bytes: new Uint8Array(bytes), format }); return true; },
    restoreEditor: async (_token: string, next: RegionScreenshotBitmap) => { qa.restored = true; setImage(next); return true; },
  }), [bridge, locale]);
  const editorBridge = useMemo(() => {
    let begin: Parameters<RegionScreenshotOverlayBridge['onBegin']>[0] | undefined;
    return { ...bridge,
      onBegin: (callback: typeof begin) => { begin = callback; return () => { begin = undefined; }; },
      shellReady: () => { if (image) queueMicrotask(() => begin?.({ token: 'editor', locale, viewport: image, frame: image, scaleFactor: 1, windows: [], cursor: null, lastRegion: { x: 100, y: 100, width: 480, height: 240 }, safeArea: { x: 0, y: 0, width: image.width, height: image.height } })); },
    };
  }, [bridge, image, locale]);
  if (clip) return <RecordingPreview document={clip} bridge={{
    ready() {}, failed() {}, onBegin: () => () => {}, onEnd: () => () => {}, painted() {}, close() { qa.closed = true; }, minimize() {},
    copy: async () => { if (++qa.copyAttempts === 1) return false; qa.copied = true; return true; },
    save: async () => { if (++qa.saveAttempts === 1) return false; qa.saved = clip.bytes; qa.format = clip.format; return true; },
  }} />;
  return image ? <RegionScreenshotOverlay key="editor" imageEditor bridge={editorBridge} /> : <RegionScreenshotOverlay key="capture" bridge={captureBridge} />;
}

mountPage({
  render: (ctx) => {
    const mode = (['default', 'idle', 'inactive', 'drag', 'preview-motion'].includes(ctx.case) ? 'scroll' : ctx.case) as RegionCaptureMode;
    qa.idle = ctx.case === 'idle';
    qa.manualScroll = ctx.case === 'preview-motion' ? 300 : null;
    let begin: Parameters<RegionScreenshotOverlayBridge['onBegin']>[0] | undefined;
    let selected = { x: 100, y: 100, width: 480, height: 240 };
    const bridge: RegionScreenshotOverlayBridge = {
      autoScroll: async (_token, enabled) => { qa.automatic = enabled; return true; },
      shellReady() { queueMicrotask(() => begin?.({ token: 'fixture', locale: ctx.locale, viewport: { width: innerWidth, height: innerHeight }, scaleFactor: 1, frame: frame(), windows: [], lastRegion: null, cursor: ctx.case === 'inactive' ? null : { x: 0, y: 0 }, safeArea: { x: 0, y: 0, width: innerWidth, height: innerHeight } })); },
      onBegin: (callback) => { begin = callback; return () => { begin = undefined; }; }, onEnd: () => () => {}, onClear: () => () => {},
      painted() {}, focused() {}, selectionStarted() {}, copyText() {}, cancel() {}, abandon() {},
      elementsAt: async () => [], startLive: async (_token, captureMode, selection) => { selected = selection; return { mode: captureMode, selection, first: frame(qa.manualScroll ?? 0), scrollLayout: scrollCaptureLayout(selection, { width: innerWidth, height: innerHeight })!, recordingLayout: { viewport: { width: innerWidth, height: innerHeight }, controls: recordingControlsBounds(selection, { width: innerWidth, height: innerHeight }, false)! } }; },
      recordingControls: async (_token, expanded, point) => recordingControlsBounds(selected, { width: innerWidth, height: innerHeight }, expanded, point),
      previewRecording: async () => false,
      restoreEditor: async () => { qa.restored = true; return true; },
      holdCapture: async () => {},
      liveFrame: async (_token, keys) => {
        qa.keysRequested ||= keys;
        if (!qa.frames) qa.firstFrameAt = performance.now();
        qa.frames++;
        if (!qa.idle) qa.scrollFrames++;
        const image = frame(qa.manualScroll ?? (mode === 'scroll' ? Math.min(qa.scrollLimit, qa.scrollFrames * 30) : qa.frames % 10));
        // A source window repaints after the frozen selection, before any scroll.
        // Deliberately larger than a caret so this also exercises unmatched startup.
        if (qa.idle) image.data.fill(255, 480 * 4 * 60, 480 * 4 * 140);
        return { image, autoScrolling: qa.automatic, cursor: { x: 100 + qa.frames, y: 80 }, keys: ['Ctrl', 'C'] };
      },
      saveRecording: async (_token, bytes, format) => { qa.saved = bytes; qa.format = format; return true; },
      exportImage: async (_token, payload) => {
        qa.exportedHeight = payload.image.height;
        for (let i = 0; i < payload.image.data.length; i += 4) if (payload.image.data[i + 2] > 180 && payload.image.data[i] < 100) qa.annotationPixels++;
        return true;
      },
    };
    return <ScrollFixture bridge={bridge} locale={ctx.locale} />;
  },
});
