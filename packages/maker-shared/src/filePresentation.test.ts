import { describe, expect, it } from 'vitest';
import { FILE_VISUAL_GLYPHS, getFileVisualKind } from './filePresentation';

describe('file identity across clients and entry points', () => {
  it.each([
    ['src/APP.TSX', 'code'], ['C:\\work\\chart.XLSX', 'sheet'], ['docs/README.md', 'text'],
    ['photo.SVG', 'image'], ['audio.flac', 'audio'], ['video.MOV', 'video'], ['report.pdf', 'pdf'],
    ['letter.docx', 'document'], ['slides.pptx', 'slide'], ['backup.tar.gz', 'archive'],
    ['store.sqlite3', 'database'], ['Dockerfile', 'code'], ['.env.production', 'code'],
    ['.gitignore', 'code'], ['LICENSE', 'text'], ['/directory.ts/unknown', 'file'],
    ['C:\\directory.png\\unknown.xyz', 'file'], ['unknown', 'file'], ['', 'file'],
    ['report#draft.pdf', 'pdf'], ['report?v=1.pdf', 'pdf'], ['report.pdf#draft', 'file'],
  ])('%s → %s', (name, kind) => {
    expect(getFileVisualKind({ name })).toBe(kind);
  });

  it('keeps the same identity when uploads add broad or contradictory MIME hints', () => {
    for (const name of ['main.ts', 'photo.svg', 'report.pdf', 'sheet.csv']) {
      expect(getFileVisualKind({ name, mimeType: 'text/plain' })).toBe(getFileVisualKind({ name }));
      expect(getFileVisualKind({ name, mimeType: 'application/octet-stream' })).toBe(getFileVisualKind({ name }));
    }
  });

  it.each([
    ['application/pdf', 'pdf'], ['Image/PNG; charset=binary', 'image'], ['audio/mpeg', 'audio'],
    ['video/mp4', 'video'], ['text/plain; charset=utf-8', 'text'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slide'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
    ['application/zip', 'archive'], ['application/octet-stream', 'file'],
  ])('uses %s only when the name does not identify a known type', (mimeType, kind) => {
    expect(getFileVisualKind({ name: 'opaque-id', mimeType })).toBe(kind);
  });

  it('groups document formats into a readable compact glyph, keeping media distinct', () => {
    expect(FILE_VISUAL_GLYPHS.pdf).toBe(FILE_VISUAL_GLYPHS.document);
    expect(FILE_VISUAL_GLYPHS.image).toBe('FileImage');
    expect(FILE_VISUAL_GLYPHS.code).toBe('FileCode');
  });
});
