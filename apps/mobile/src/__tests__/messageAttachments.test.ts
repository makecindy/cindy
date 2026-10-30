import { describe, expect, it } from 'vitest';
import { partitionMessageAttachments, svgAttachmentForDisplay } from '@/session/messageAttachments';
import type { NormalizedAttachment } from '@/session/messageNormalize';

describe('partitionMessageAttachments', () => {
  it('displays persisted SVG files as images using the existing SSH media route', () => {
    const attachment: NormalizedAttachment = {
      kind: 'file', name: 'diagram.SVG', path: '/repo/diagram.SVG', previewable: false,
    };
    const display = svgAttachmentForDisplay(attachment, '/repo', 'm1', 'ssh-host', 'session-1');
    expect(display).toMatchObject({ kind: 'image', previewable: false, path: attachment.path });
    const url = new URL(display.uri!);
    expect(url.protocol).toBe('xdt-file:');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: attachment.path, v: 'm1', workdir: '/repo', remoteHostId: 'ssh-host', sessionId: 'session-1',
    });
    expect(partitionMessageAttachments([display]).imageAttachments).toEqual([display]);
    expect(attachment.kind).toBe('file');
    expect(svgAttachmentForDisplay(attachment, '/repo', 'm1', 'ssh-host')).toBe(attachment);
    expect(svgAttachmentForDisplay(attachment)).toBe(attachment);
  });

  it('recognizes SVG MIME without changing other files or trusting unsupported URLs', () => {
    const svg: NormalizedAttachment = {
      kind: 'file', name: 'diagram', path: 'https://example.com/download?id=1',
      mimeType: 'image/svg+xml; charset=utf-8', previewable: false,
    };
    expect(svgAttachmentForDisplay(svg)).toMatchObject({ kind: 'image', uri: svg.path, previewable: true });
    const unsupported = { ...svg, path: 'javascript:alert(1)' };
    expect(svgAttachmentForDisplay(unsupported, '/repo')).toBe(unsupported);
    const text = { ...svg, name: 'diagram.svg.txt', mimeType: 'text/plain' };
    expect(svgAttachmentForDisplay(text)).toBe(text);
  });

  it('separates images from files while preserving order within each presentation group', () => {
    const attachments: NormalizedAttachment[] = [
      { kind: 'file', name: 'brief.pdf', path: '/repo/brief.pdf', previewable: false },
      { kind: 'image', name: 'screen.png', uri: 'https://example.com/screen.png', previewable: true },
      { kind: 'file', name: 'notes.md', path: '/repo/notes.md', previewable: false },
      { kind: 'image', name: 'detail.png', uri: 'xdt-image://local/detail.png', previewable: false },
    ];

    expect(partitionMessageAttachments(attachments)).toEqual({
      imageAttachments: [
        { kind: 'image', name: 'screen.png', uri: 'https://example.com/screen.png', previewable: true },
        { kind: 'image', name: 'detail.png', uri: 'xdt-image://local/detail.png', previewable: false },
      ],
      fileAttachments: [
        { kind: 'file', name: 'brief.pdf', path: '/repo/brief.pdf', previewable: false },
        { kind: 'file', name: 'notes.md', path: '/repo/notes.md', previewable: false },
      ],
    });
  });
});
