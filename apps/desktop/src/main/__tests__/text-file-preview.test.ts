import { describe, expect, it } from 'vitest';
import { textFilePreviewResult, TEXT_PREVIEW_MAX_BYTES } from '../text-file-preview';

// Unit: the IPC response builder must not put a legal 4–10 MiB preview into a
// 4 MiB device message. No earlier test covered UTF-8/JSON expansion or opt-in.
describe('text preview response', () => {
  it.each([
    Buffer.alloc(4 * 1024 * 1024, 97),
    Buffer.alloc(TEXT_PREVIEW_MAX_BYTES, 97),
    Buffer.from('中'.repeat(1_400_000)),
    Buffer.from('"\\'.repeat(1_050_000)),
  ])('offers file transfer for oversized encoded responses', (bytes) => {
    const result = textFilePreviewResult(bytes, true);
    expect('transferRequired' in result).toBe(true);
    expect(result).toEqual({
      success: true,
      transferRequired: true,
      size: bytes.length,
      limitMb: 10,
    });
  });
  it('keeps small and empty texts inline', () => {
    for (const text of ['', '中文 " \\ hello', 'a'.repeat(4 * 1024 * 1024 - 128 * 1024)]) {
      const bytes = Buffer.from(text);
      expect(textFilePreviewResult(bytes, true)).toEqual({
        success: true,
        data: text,
        size: bytes.length,
        limitMb: 10,
      });
    }
  });
  it('preserves local and older callers that did not opt into file transfer', () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 97);
    expect(textFilePreviewResult(bytes, false)).toEqual({
      success: true,
      data: bytes.toString(),
      size: bytes.length,
      limitMb: 10,
    });
  });
  it('rejects files that grew past the preview limit after stat', () => {
    expect(textFilePreviewResult(Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1), true)).toEqual({
      success: false,
      reason: 'oversize',
      size: TEXT_PREVIEW_MAX_BYTES + 1,
      limitMb: 10,
    });
  });
});
