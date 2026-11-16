export type RequestSizeErrorKind = 'request-too-large' | 'image-count' | 'single-image-too-large' | 'unsupported-image-format' | 'unsupported-image' | 'context-too-long' | 'other';

export interface RequestSizeError {
  kind: RequestSizeErrorKind;
  limitBytes?: number;
  limitCount?: number;
  mimeType?: string;
}

const bytes = (value: string, unit: string): number => Math.floor(Number(value.replace(/,/g, '')) * (unit.toLowerCase().startsWith('m') ? 1024 * 1024 : unit.toLowerCase().startsWith('k') ? 1024 : 1));

/** Classify decoded (possibly nested JSON) upstream text without retaining its payload. */
export function classifyRequestSizeError(input: string): RequestSizeError {
  // Limit work before case conversion: 4096 UTF-16 units (about 4 KiB for the
  // ASCII provider messages). Bound every repetition below as well, so repeated
  // keywords cannot cause unbounded overlapping scans of non-digit suffixes.
  const text = input.slice(0, 4096).toLowerCase();
  if (/unsupported image format|image format is not supported|invalid image format/.test(text)) return { kind: 'unsupported-image-format' };
  if (/model does not support image|does not support images|only supports text modality|image modality is not supported/.test(text)) return { kind: 'unsupported-image' };
  if (/context (?:length|window)|prompt is too long|input is too long/.test(text)) return { kind: 'context-too-long' };
  const count = text.match(/(?:maximum number of images|exceeded maximum number of images|too many images)[^\d]{0,64}(\d{1,16})/);
  const max = text.match(/(?:max(?:imum)? size is|request exceeds?[^\d]{0,64}maximum allowed size|request size)[^\d]{0,64}(\d{1,16}(?:[.,]\d{1,16})?)\s{0,16}(kb|mb|bytes?)/);
  if (count) return { kind: 'image-count', limitCount: Number(count[1]), ...(max ? { limitBytes: bytes(max[1], max[2]) } : {}) };
  const single = text.match(/image[^\d]{0,64}(?:exceeds?|maximum|limit)[^\d]{0,64}(\d{1,16}(?:[.,]\d{1,16})?)\s{0,16}(kb|mb|bytes?)/);
  if (single) return { kind: 'single-image-too-large', limitBytes: bytes(single[1], single[2]) };
  if (max) return { kind: 'request-too-large', limitBytes: bytes(max[1], max[2]) };
  if (/too many images|maximum number of images/.test(text)) return { kind: 'image-count' };
  if (/request.{0,50}(?:too large|maximum allowed size)|request_too_large/.test(text)) return { kind: 'request-too-large' };
  return { kind: 'other' };
}
