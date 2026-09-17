import type { IpcMainInvokeEvent, NativeImage } from 'electron';

import { MAX_CLIPBOARD_PNG_BYTES } from '../shared/pngClipboard.js';
import { requireObject, throwIpcError } from './utils/ipcValidate.js';

/** Native clipboard dependencies keep validation testable without Electron. */
interface PngClipboardDependencies {
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  decode: (bytes: Buffer) => NativeImage;
  write: (data: { image: NativeImage; text?: string }) => void;
}

/** Validate before decoding; a small PNG must not allocate an unbounded bitmap. */
export function copyPngToClipboard(
  event: IpcMainInvokeEvent,
  input: unknown,
  deps: PngClipboardDependencies,
): void {
  deps.assertTrustedSender(event);
  const { png, plainText } = requireObject(input);
  if (
    !(png instanceof ArrayBuffer) ||
    png.byteLength < 33 ||
    png.byteLength > MAX_CLIPBOARD_PNG_BYTES
  ) {
    throwIpcError('INVALID_PARAMS', 'Invalid clipboard PNG size');
  }
  if (
    plainText !== undefined &&
    (typeof plainText !== 'string' || plainText.length > 4 * 1024 * 1024)
  ) {
    throwIpcError('INVALID_PARAMS', 'Invalid clipboard text');
  }
  const bytes = Buffer.from(png);
  if (
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throwIpcError('INVALID_PARAMS', 'Invalid clipboard PNG');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // Export uses a 4096² pixel budget; leave room for integer canvas rounding.
  if (
    !width ||
    !height ||
    width > 16_384 ||
    height > 16_384 ||
    width * height > 4096 ** 2 + 16_384
  ) {
    throwIpcError('INVALID_PARAMS', 'Clipboard PNG dimensions exceed export limits');
  }
  let image: NativeImage;
  try {
    image = deps.decode(bytes);
  } catch {
    throwIpcError('INVALID_PARAMS', 'Invalid clipboard PNG data');
  }
  if (image.isEmpty()) throwIpcError('INVALID_PARAMS', 'Invalid clipboard PNG data');
  const size = image.getSize();
  if (size.width !== width || size.height !== height) {
    throwIpcError('INVALID_PARAMS', 'Unexpected clipboard PNG dimensions');
  }
  try {
    // One write preserves image + source text together, without a focus check.
    deps.write({ image, ...(plainText ? { text: plainText } : {}) });
  } catch {
    throwIpcError('INTERNAL', 'Unable to write PNG to clipboard');
  }
}
