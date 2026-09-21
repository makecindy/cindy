/**
 * PDF.js detects Electron utility processes as a non-Node environment because
 * `process.type` is `utility`. Its built-in Node bootstrap therefore skips the
 * DOM geometry polyfills even though the worker bundle constructs a DOMMatrix
 * during module evaluation. Install the same canvas implementation PDF.js uses
 * in ordinary Node before either PDF.js bundle is evaluated.
 */
import {
  DOMMatrix as CanvasDOMMatrix,
  ImageData as CanvasImageData,
  Path2D as CanvasPath2D,
} from '@napi-rs/canvas';

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = CanvasDOMMatrix as unknown as typeof globalThis.DOMMatrix;
}
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = CanvasImageData as unknown as typeof globalThis.ImageData;
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = CanvasPath2D as unknown as typeof globalThis.Path2D;
}
