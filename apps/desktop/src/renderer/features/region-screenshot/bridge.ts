import type {
  RegionRect,
  RegionScreenshotBegin,
  RegionScreenshotBitmap,
  RegionScreenshotExport,
  RegionScreenshotPinCommand,
  RegionScreenshotPinInit,
  RegionScreenshotPinState,
} from '../../../shared/regionScreenshot';
import type { RegionCaptureBegin, RegionCaptureFrame, RegionCaptureMode } from '../../../shared/regionCapture';

/** 框选浮层 preload (regionScreenshotPreload) 暴露的能力。 */
export interface RegionScreenshotOverlayBridge {
  recordingControls(token: string, expanded: boolean, point?: { x: number; y: number }, dragging?: boolean): Promise<RegionRect | null>;
  previewRecording(token: string, bytes: Uint8Array, format: 'webm' | 'gif'): Promise<boolean>;
  /** `'accessibility'`: macOS 缺少辅助功能权限, 系统已弹出授权询问。 */
  autoScroll(token: string, enabled: boolean): Promise<boolean | 'accessibility'>;
  restoreEditor(token: string, image: RegionScreenshotBitmap): Promise<boolean>;
  holdCapture(token: string): Promise<void>;
  startLive(token: string, mode: RegionCaptureMode, selection: RegionRect): Promise<RegionCaptureBegin | null>;
  liveFrame(token: string, keys: boolean, previewHeight?: number): Promise<RegionCaptureFrame | null>;
  saveRecording(token: string, bytes: Uint8Array, format: 'webm' | 'gif'): Promise<boolean>;
  shellReady(): void;
  onBegin(callback: (payload: RegionScreenshotBegin) => void): () => void;
  onEnd(callback: () => void): () => void;
  onClear(callback: () => void): () => void;
  painted(token: string): void;
  focused(token: string): void;
  selectionStarted(token: string): void;
  copyText(token: string, text: string): void;
  cancel(token: string): void;
  abandon(): void;
  elementsAt(token: string, windowId: number, x: number, y: number): Promise<RegionRect[]>;
  exportImage(token: string, payload: RegionScreenshotExport): Promise<boolean>;
}

/** 贴图 preload (regionScreenshotPinPreload) 暴露的能力。 */
export interface RegionScreenshotPinBridge {
  shellReady(): void;
  onInit(callback: (payload: RegionScreenshotPinInit) => void): () => void;
  onState(callback: (state: RegionScreenshotPinState) => void): () => void;
  painted(): void;
  dragStart(): void;
  dragMove(): void;
  zoom(steps: number, x: number, y: number): void;
  opacity(steps: number): void;
  menu(): void;
  command(command: RegionScreenshotPinCommand): void;
  unlockHover(hovering: boolean): void;
}

declare global {
  interface Window {
    regionScreenshot?: RegionScreenshotOverlayBridge;
    regionScreenshotEditor?: Pick<RegionScreenshotOverlayBridge, 'shellReady' | 'onBegin' | 'onEnd' | 'painted' | 'cancel' | 'exportImage'> & { failed(): void; minimize(token: string): void };
    regionScreenshotPin?: RegionScreenshotPinBridge;
  }
}

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Swap whole pixels when aligned; keep byte views and in-place export supported. */
function swapRedBlue(source: Uint8Array | Uint8ClampedArray, target: Uint8Array | Uint8ClampedArray): void {
  if (littleEndian && source.byteOffset % 4 === 0 && target.byteOffset % 4 === 0) {
    const input = new Uint32Array(source.buffer, source.byteOffset, source.length / 4);
    const output = new Uint32Array(target.buffer, target.byteOffset, target.length / 4);
    for (let i = 0; i < input.length; i++) {
      const pixel = input[i];
      output[i] = (pixel & 0xff00ff00) | ((pixel & 0xff) << 16) | ((pixel >>> 16) & 0xff);
    }
    return;
  }
  for (let i = 0; i < source.length; i += 4) {
    const blue = source[i];
    target[i] = source[i + 2];
    target[i + 1] = source[i + 1];
    target[i + 2] = blue;
    target[i + 3] = source[i + 3];
  }
}

/** BGRA → RGBA. A caller-owned destination may be reused; source stays immutable. */
export function bitmapToImageData(bitmap: RegionScreenshotBitmap, reuse?: ImageData): ImageData {
  const source = bitmap.data;
  const image = reuse?.width === bitmap.width && reuse.height === bitmap.height
    ? reuse
    : new ImageData(bitmap.width, bitmap.height);
  swapRedBlue(source, image.data);
  return image;
}

/** 画布像素 (RGBA) → Electron 位图 (BGRA), 原地交换后复用同一块内存。 */
export function imageDataToBitmap(image: ImageData): RegionScreenshotBitmap {
  const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  swapRedBlue(data, data);
  return { width: image.width, height: image.height, data: data as Uint8Array<ArrayBuffer> };
}
