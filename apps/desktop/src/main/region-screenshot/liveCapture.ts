import { desktopCapturer, nativeImage, screen, type Display } from 'electron';
import type { SnapshotHelper } from './snapshotHost';
import { NativeDesktopCapture } from '../remote-desktop/nativeCapture';
import { regionSelectionToImageCrop, type RegionRect, type RegionScreenshotBitmap } from '../../shared/regionScreenshot';
import type { RegionCaptureMode } from '../../shared/regionCapture';
import { enumerateDesktopSources } from '../remote-desktop/captureSource';

/** Main crops before crossing IPC. No whole-display pixels reach the live panel. */
export async function captureLiveRegion(display: Display, selection: RegionRect, mode: RegionCaptureMode, helper?: SnapshotHelper): Promise<RegionScreenshotBitmap> {
  if (process.platform === 'win32' && helper) {
    const rect = screen.dipToScreenRect(null, { ...selection, x: selection.x + display.bounds.x, y: selection.y + display.bounds.y });
    const image = await helper.capture(rect, mode === 'scroll' ? 32768 : mode === 'gif' ? 960 : 1920);
    if (image) return image;
    // The optional helper may have exited after an accessibility query timed out.
    // Keep capture usable through the bounded, user-session Electron path below.
  }
  const sources = await enumerateDesktopSources(() => desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) },
  }), 5000);
  const source = sources.find((candidate) => candidate.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error('Display capture unavailable');
  const mapping = regionSelectionToImageCrop(selection, display.bounds, source.thumbnail.getSize(), display.scaleFactor);
  if (!mapping) throw new Error('Invalid capture region');
  let image = source.thumbnail.crop(mapping.crop);
  if (image.getSize().width !== mapping.output.width || image.getSize().height !== mapping.output.height) image = image.resize(mapping.output);
  const maxSide = mode === 'gif' ? 960 : mode === 'video' ? 1920 : 32768;
  const ratio = Math.min(1, maxSide / Math.max(mapping.output.width, mapping.output.height));
  if (ratio < 1) image = image.resize({ width: Math.max(1, Math.round(mapping.output.width * ratio)), height: Math.max(1, Math.round(mapping.output.height * ratio)) });
  const size = image.getSize();
  const pixels = image.toBitmap();
  return { ...size, data: pixels.buffer instanceof ArrayBuffer && pixels.byteLength === pixels.buffer.byteLength ? new Uint8Array(pixels.buffer) : new Uint8Array(pixels) };
}

/** Reuses one user-session capture backend for the recording; never opens the
 * Windows elevated remote-desktop broker or grants a renderer screen access. */
export class RegionVideoCapture {
  private native: NativeDesktopCapture | null = null;
  private generation = 0;
  constructor(private readonly helper: SnapshotHelper) {}

  async frame(display: Display, selection: RegionRect, mode: 'video' | 'gif'): Promise<RegionScreenshotBitmap> {
    const edge = mode === 'gif' ? 960 : 1920;
    const generation = this.generation;
    if (process.platform === 'win32') {
      const result = await captureLiveRegion(display, selection, mode, this.helper);
      if (generation !== this.generation) throw new Error('Region capture unavailable');
      return result;
    }
    if (!this.native) {
      this.native = new NativeDesktopCapture({ encodeOnRequest: true });
    }
    const frame = await this.native.frame(String(display.id), true, { quality: 'hd', fps: 30, audio: false });
    if (generation !== this.generation || !frame || typeof frame === 'string') throw new Error('Region capture unavailable');
    const source = nativeImage.createFromBuffer(Buffer.from(frame.jpeg, 'base64'));
    const mapping = regionSelectionToImageCrop(selection, display.bounds, source.getSize(), display.scaleFactor);
    if (!mapping) throw new Error('Invalid capture region');
    const ratio = Math.min(1, edge / Math.max(mapping.output.width, mapping.output.height));
    const output = { width: Math.max(1, Math.round(mapping.output.width * ratio)), height: Math.max(1, Math.round(mapping.output.height * ratio)) };
    let image = source.crop(mapping.crop);
    if (image.getSize().width !== output.width || image.getSize().height !== output.height) image = image.resize(output);
    // toBitmap owns this buffer; a view avoids copying the entire selected frame
    // again before Electron serializes it. Copy sliced buffers so IPC cannot
    // clone bytes outside the selection from a larger backing buffer.
    const pixels = image.toBitmap();
    return { ...image.getSize(), data: pixels.buffer instanceof ArrayBuffer && pixels.byteLength === pixels.buffer.byteLength ? new Uint8Array(pixels.buffer) : new Uint8Array(pixels) };
  }

  stop(): void { this.generation++; this.native?.stop(); this.native = null; }
}
