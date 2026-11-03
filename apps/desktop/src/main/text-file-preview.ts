import { MAX_TRANSPORT_MESSAGE_BYTES } from '@cindy/device-link';

export const TEXT_PREVIEW_LIMIT_MB = 10;
export const TEXT_PREVIEW_MAX_BYTES = TEXT_PREVIEW_LIMIT_MB * 1024 * 1024;

/** Keep envelope/codec metadata outside the body budget; count UTF-8 JSON, not characters. */
export function textFilePreviewResult(bytes: Buffer, allowFileTransfer: boolean) {
  const metadata = { size: bytes.byteLength, limitMb: TEXT_PREVIEW_LIMIT_MB };
  if (bytes.byteLength > TEXT_PREVIEW_MAX_BYTES)
    return { success: false, reason: 'oversize' as const, ...metadata };
  const result = { success: true, data: bytes.toString('utf8'), ...metadata };
  if (
    allowFileTransfer &&
    Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_TRANSPORT_MESSAGE_BYTES - 64 * 1024
  )
    return { success: true, transferRequired: true, ...metadata };
  return result;
}
