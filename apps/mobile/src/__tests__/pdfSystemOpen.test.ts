import { describe, expect, it } from 'vitest';

import { lacksInlinePreview, pdfPreviewsInline } from '@/session/pdfSystemOpen';

describe('pdfSystemOpen', () => {
  it('只有 Android 不在应用内预览 PDF', () => {
    expect(pdfPreviewsInline('ios')).toBe(true);
    expect(pdfPreviewsInline('android')).toBe(false);
  });

  it('Android 上仅 PDF 缺少应用内预览(扩展名大小写不敏感,支持完整路径)', () => {
    expect(lacksInlinePreview('documents/大型IPO的投资者问答.pdf', 'android')).toBe(true);
    expect(lacksInlinePreview('/w/REPORT.PDF', 'android')).toBe(true);
    expect(lacksInlinePreview('report.pdf', 'ios')).toBe(false);
    expect(lacksInlinePreview('notes.md', 'android')).toBe(false);
    expect(lacksInlinePreview('photo.png', 'android')).toBe(false);
  });
});
