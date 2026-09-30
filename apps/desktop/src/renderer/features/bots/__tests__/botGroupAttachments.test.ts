import { describe, expect, it } from 'vitest';

import type { AttachedFile } from '@/lib/fileTypes';
import {
  botGroupAttachmentScope,
  botGroupAttachmentSignature,
  splitBotGroupMessageAttachments,
  toBotGroupAttachmentInputs,
} from '../botGroupAttachments';

function attached(overrides: Partial<AttachedFile>): AttachedFile {
  return {
    id: 'f1',
    name: 'photo.png',
    path: '/tmp/photo.png',
    ext: '.png',
    size: 12,
    category: 'image',
    mimeType: 'image/png',
    ...overrides,
  };
}

describe('botGroupAttachments', () => {
  it('scopes a group’s tray apart from any task id', () => {
    expect(botGroupAttachmentScope('g1')).toBe('bot-group:g1');
  });

  it('hands main the serialized shape without inline bytes or annotation strokes', () => {
    const inputs = toBotGroupAttachmentInputs([
      attached({
        url: 'cindy-media://blobs/burned.png',
        name: 'photo-annotated.png',
        originalName: 'photo-annotated.png',
        annotated: true,
        annotationStrokes: [{ points: [{ x: 0, y: 0 }] }],
        annotationSourceUrl: 'cindy-media://blobs/original.png',
        annotationRegions: [{ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }],
      }),
      attached({ id: 'f2', name: 'notes.md', path: '/tmp/notes.md', ext: '.md', category: 'text', mimeType: 'text/plain' }),
    ]);
    expect(inputs).toEqual([
      {
        id: 'f1',
        name: 'photo-annotated.png',
        path: '/tmp/photo.png',
        ext: '.png',
        size: 12,
        category: 'image',
        mimeType: 'image/png',
        url: 'cindy-media://blobs/burned.png',
        originalName: 'photo-annotated.png',
        annotated: true,
      },
      {
        id: 'f2',
        name: 'notes.md',
        path: '/tmp/notes.md',
        ext: '.md',
        size: 12,
        category: 'text',
        mimeType: 'text/plain',
        originalName: 'notes.md',
      },
    ]);
  });

  it('changes the send signature when the files or their annotations change', () => {
    const base = [attached({ url: 'cindy-media://blobs/a.png' })];
    const same = [attached({ url: 'cindy-media://blobs/a.png' })];
    const drawn = [attached({ url: 'cindy-media://blobs/a.png', annotationStrokes: [{ points: [{ x: 1, y: 1 }] }] })];
    expect(botGroupAttachmentSignature(same)).toBe(botGroupAttachmentSignature(base));
    expect(botGroupAttachmentSignature(drawn)).not.toBe(botGroupAttachmentSignature(base));
    expect(botGroupAttachmentSignature([])).not.toBe(botGroupAttachmentSignature(base));
  });

  it('shows images with an address as pictures and everything else with a path as chips', () => {
    const { images, files } = splitBotGroupMessageAttachments([
      { id: 'a', name: 'a.png', category: 'image', mimeType: 'image/png', size: 1, url: 'cindy-media://blobs/a.png', path: null },
      { id: 'b', name: 'b.png', category: 'file', mimeType: 'image/png', size: 1, url: null, path: '/tmp/b.png' },
      { id: 'c', name: 'c.mp4', category: 'file', mimeType: 'video/mp4', size: 1, url: null, path: '/tmp/c.mp4' },
      { id: 'd', name: 'd.pdf', category: 'pdf', mimeType: 'application/pdf', size: 1, url: null, path: null },
    ]);
    expect(images.map((image) => image.id)).toEqual(['a']);
    expect(files.map((file) => file.id)).toEqual(['b', 'c']);
  });
});
