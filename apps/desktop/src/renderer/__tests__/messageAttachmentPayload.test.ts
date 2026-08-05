import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AttachedFile, SerializedAttachedFile } from '@/lib/fileTypes';
import {
  buildMakerUserContentBlocks,
  buildMakerUserMessage,
  buildUserMessageAttachmentPayload,
} from '@/lib/messageAttachmentPayload';

type AttachmentFixture = AttachedFile & {
  base64?: string;
  textContent?: string;
  truncated?: boolean;
};

function attachment(overrides: Partial<AttachmentFixture>): AttachmentFixture {
  const name = overrides.name ?? 'file.txt';
  return {
    id: overrides.id ?? `att-${name}`,
    name,
    path: overrides.path ?? join('repo', name),
    ext: overrides.ext ?? '.txt',
    size: overrides.size ?? 42,
    category: overrides.category ?? 'text',
    mimeType: overrides.mimeType ?? 'text/plain',
    ...overrides,
  };
}

describe('messageAttachmentPayload', () => {
  it('keeps cached image URLs as the primary render, persist, and SDK source', () => {
    const image = attachment({
      name: 'shot.png',
      path: 'clipboard://paste-1',
      ext: '.png',
      category: 'image',
      mimeType: 'image/png',
      url: 'xdt-image://session/shot.png',
      originalName: 'original.png',
      base64: 'legacy-inline-should-not-win',
    });

    const payload = buildUserMessageAttachmentPayload([image]);

    expect(payload.serializedFiles).toEqual([
      expect.objectContaining({
        name: 'shot.png',
        path: 'clipboard://paste-1',
        url: 'xdt-image://session/shot.png',
        originalName: 'original.png',
      }),
    ]);
    expect(payload.imageAttachments).toEqual([
      {
        url: 'xdt-image://session/shot.png',
        mimeType: 'image/png',
        originalName: 'original.png',
      },
    ]);
    expect(payload.persistImageRefs).toEqual(payload.imageAttachments);

    expect(buildMakerUserContentBlocks('', undefined, payload.serializedFiles)).toEqual([
      {
        type: 'image',
        path: 'xdt-image://session/shot.png',
        mimeType: 'image/png',
      },
    ]);
  });

  it('uses base64 only for image fallback and keeps it out of persisted refs', () => {
    const image = attachment({
      name: 'fallback.png',
      path: 'clipboard://paste-2',
      ext: '.png',
      category: 'image',
      mimeType: 'image/png',
      base64: 'inline-image',
    });

    const payload = buildUserMessageAttachmentPayload([image]);

    expect(payload.imageAttachments).toEqual([
      {
        base64: 'inline-image',
        mimeType: 'image/png',
        originalName: 'fallback.png',
      },
    ]);
    expect(payload.persistImageRefs).toEqual([]);
    expect(buildMakerUserContentBlocks('', undefined, payload.serializedFiles)).toEqual([
      {
        type: 'image',
        base64: 'inline-image',
        mimeType: 'image/png',
      },
    ]);
  });

  it('passes non-image files by path for render, persist, and SDK send', () => {
    const pdfPath = join('repo', 'doc.pdf');
    const pdf = attachment({
      name: 'doc.pdf',
      path: pdfPath,
      ext: '.pdf',
      category: 'pdf',
      mimeType: 'application/pdf',
    });

    const payload = buildUserMessageAttachmentPayload([pdf]);

    expect(payload.fileAttachments).toEqual([{ name: 'doc.pdf', path: pdfPath }]);
    expect(payload.persistFileRefs).toEqual([{ name: 'doc.pdf', path: pdfPath }]);
    expect(buildMakerUserMessage('read it', undefined, payload.serializedFiles)).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'read it' },
        { type: 'file', path: pdfPath, mimeType: 'application/pdf' },
      ],
    });
  });

  it('keeps GIF previewable but sends it as a file path so the agent can inspect all frames', () => {
    const gifPath = join('repo', 'clip.gif');
    const gif = attachment({
      name: 'clip.gif',
      path: gifPath,
      ext: '.gif',
      category: 'image',
      mimeType: 'image/gif',
      url: 'xdt-image://session/clip.gif',
      originalName: 'clip.gif',
    });

    const payload = buildUserMessageAttachmentPayload([gif]);

    expect(payload.imageAttachments).toEqual([
      {
        url: 'xdt-image://session/clip.gif',
        mimeType: 'image/gif',
        originalName: 'clip.gif',
      },
    ]);
    expect(payload.persistImageRefs).toEqual(payload.imageAttachments);
    expect(buildMakerUserMessage('inspect gif', undefined, payload.serializedFiles)).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'inspect gif' },
        { type: 'file', path: 'xdt-image://session/clip.gif', mimeType: 'image/gif', originalPath: gifPath },
      ],
    });
  });

  it('passes generic media files by path for SDK send', () => {
    const videoPath = join('repo', 'recording.mp4');
    const video = attachment({
      name: 'recording.mp4',
      path: videoPath,
      ext: '.mp4',
      category: 'file',
      mimeType: 'video/mp4',
    });

    const payload = buildUserMessageAttachmentPayload([video]);

    expect(payload.fileAttachments).toEqual([{ name: 'recording.mp4', path: videoPath }]);
    expect(payload.persistFileRefs).toEqual([{ name: 'recording.mp4', path: videoPath }]);
    expect(buildMakerUserMessage('summarize video', undefined, payload.serializedFiles)).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: 'summarize video' },
        { type: 'file', path: videoPath, mimeType: 'video/mp4' },
      ],
    });
  });

  it('drops clipboard placeholders that have no real source before SDK send', () => {
    const file: SerializedAttachedFile = {
      id: 'att-empty',
      name: 'empty.txt',
      path: 'clipboard://missing',
      ext: '.txt',
      size: 1,
      category: 'text',
      mimeType: 'text/plain',
    };

    expect(buildMakerUserContentBlocks('', undefined, [file])).toEqual([]);
  });
});
