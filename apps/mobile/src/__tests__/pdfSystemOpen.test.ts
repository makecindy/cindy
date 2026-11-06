import { describe, expect, it } from 'vitest';

import { lacksInlinePreview, pdfPreviewsInline } from '@/session/pdfSystemOpen';

describe('pdfSystemOpen', () => {
  it("iOS 和 Android 都在应用内预览 PDF", () => {
    expect(pdfPreviewsInline('ios')).toBe(true);
    expect(pdfPreviewsInline('android')).toBe(true);
  });

  it("已支持平台不会隐藏 PDF 快速预览(完整路径与大写扩展名)", () => {
    expect(lacksInlinePreview('documents/大型IPO的投资者问答.pdf', 'android')).toBe(false);
    expect(lacksInlinePreview('/w/REPORT.PDF', 'android')).toBe(false);
    expect(lacksInlinePreview('report.pdf', 'ios')).toBe(false);
    expect(lacksInlinePreview('notes.md', 'android')).toBe(false);
    expect(lacksInlinePreview('photo.png', 'android')).toBe(false);
  });
});
