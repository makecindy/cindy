import type { WebContents } from 'electron';

// Keep identity through destroyed/gone event ordering without retaining windows.
// Only the main-owned capture factory can register these isolated renderers.
const captureContents = new WeakSet<WebContents>();

export function markCaptureWindowWebContents(contents: WebContents): void {
  captureContents.add(contents);
}

export function isCaptureWindowWebContents(contents: WebContents): boolean {
  return captureContents.has(contents);
}
