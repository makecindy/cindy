import { describe, expect, it } from 'vitest';

import type { QueuedMessage } from '@/lib/makerChatStore';
import {
  isQueueComposerEditCurrent,
  queueComposerEditDraftKey,
  queueMessageToComposerEditDraft,
  rebaseQueueComposerEditContentAfterSlashCommandRewrite,
} from '@/lib/queueComposerEdit';

function queuedMessage(): QueuedMessage {
  return {
    clientId: 'queue-1',
    text: 'queued text',
    persistedContent: JSON.stringify({ text: 'queued text' }),
    model: 'model',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: 'C:\\workspace',
    files: [
      {
        id: 'existing-image',
        name: 'existing.png',
        path: 'C:\\images\\existing.png',
        ext: 'png',
        size: 10,
        category: 'image',
        mimeType: 'image/png',
        url: 'xdt-image://session/existing.png',
        pathOrigin: 'desktop-host',
      },
    ],
    chatMessage: {
      clientId: 'queue-1',
      role: 'user',
      content: 'queued text',
      isStreaming: false,
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: 'C:\\workspace',
      model: 'model',
    },
  };
}

describe('queueMessageToComposerEditDraft', () => {
  it('uses an isolated draft key and treats queued image caches as shared', () => {
    const prepared = queueMessageToComposerEditDraft('session-1', queuedMessage());

    expect(prepared.draftKey).toBe(queueComposerEditDraftKey('session-1', 'queue-1'));
    expect(prepared.originalAttachmentIds).toEqual(['existing-image']);
    expect(prepared.draft.attachments).toEqual([
      expect.objectContaining({
        id: 'existing-image',
        cacheUrlShared: true,
        stagedPathShared: true,
      }),
    ]);
    expect(prepared.draft.attachments[0]).not.toHaveProperty('pathOrigin');
    expect(prepared.draft.text).toEqual(expect.objectContaining({ type: 'doc' }));
    expect(prepared.draft.focusAtEnd).toBe(true);
  });

  it('keeps attachment-only queue rows editable', () => {
    const entry = queuedMessage();
    entry.text = '';
    entry.chatMessage.content = '';

    const prepared = queueMessageToComposerEditDraft('session-1', entry);

    expect(prepared.draft.text).toBeNull();
    expect(prepared.draft.attachments).toHaveLength(1);
  });

  it('restores queued annotations as an editable source image plus vector strokes', () => {
    const entry = queuedMessage();
    const burnedUrl = 'xdt-image://session/annotated.png';
    const sourceUrl = 'xdt-image://session/source.jpg';
    const strokes = [{ points: [{ x: 0.25, y: 0.75 }] }];
    entry.files = [
      {
        ...entry.files![0],
        path: 'C:\\images\\annotated.png',
        url: burnedUrl,
        annotated: true,
      },
    ];
    entry.chatMessage.retryFiles = [
      {
        ...entry.files[0],
        annotationSourceUrl: sourceUrl,
        annotationStrokes: strokes,
      },
    ];

    const prepared = queueMessageToComposerEditDraft('session-1', entry);

    expect(prepared.draft.attachments[0]).toMatchObject({
      id: 'existing-image',
      path: sourceUrl,
      url: sourceUrl,
      ext: '.jpg',
      mimeType: 'image/jpeg',
      annotationStrokes: strokes,
      cacheUrlShared: true,
      stagedPathShared: true,
    });
    expect(prepared.draft.attachments[0]).not.toHaveProperty('annotated');
    expect(prepared.draft.attachments[0]?.annotationStrokes).not.toBe(strokes);
  });

  it('restores structured references, file mentions and pasted text chips', () => {
    const entry = queuedMessage();
    const messageHref = 'cindy://session/source?message=message-1';
    const projectHref = 'cindy://project/C%3A%2Fworkspace';
    const text =
      `See ${messageHref} and [Workspace](${projectHref}) with @src/app.ts and pasted selection`;
    const messageStart = text.indexOf(messageHref);
    const projectText = `[Workspace](${projectHref})`;
    const projectStart = text.indexOf(projectText);
    const pastedText = 'pasted selection';
    const pastedStart = text.indexOf(pastedText);
    entry.text = text;
    entry.chatMessage.content = text;
    entry.mentions = [{ type: 'file', name: 'app.ts', path: 'src/app.ts' }];
    entry.chatMessage.agentReferences = [
      {
        kind: 'message',
        start: messageStart,
        end: messageStart + messageHref.length,
        href: messageHref,
        sessionId: 'source',
        messageClientId: 'message-1',
        text: 'Referenced message',
      },
      {
        kind: 'project',
        start: projectStart,
        end: projectStart + projectText.length,
        href: projectHref,
        name: 'Workspace',
        workingDir: 'C:\\workspace',
      },
    ];
    entry.chatMessage.pastedTextRanges = [
      { start: pastedStart, end: pastedStart + pastedText.length, display: 'selection' },
    ];

    const prepared = queueMessageToComposerEditDraft('session-1', entry);
    const inline = prepared.draft.text?.content?.[0]?.content ?? [];

    expect(inline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mentionChip',
          attrs: expect.objectContaining({ kind: 'session', path: messageHref }),
        }),
        expect.objectContaining({
          type: 'mentionChip',
          attrs: expect.objectContaining({ kind: 'project', path: projectHref, label: 'Workspace', titled: true }),
        }),
        expect.objectContaining({
          type: 'mentionChip',
          attrs: expect.objectContaining({ kind: 'file', path: 'src/app.ts', label: 'app.ts' }),
        }),
        expect.objectContaining({
          type: 'pastedTextChip',
          attrs: expect.objectContaining({ text: pastedText, display: 'selection' }),
        }),
      ]),
    );
  });

  it('prefers the longest mention when directory and file references start together', () => {
    const entry = queuedMessage();
    entry.text = '@src/app.ts';
    entry.chatMessage.content = entry.text;
    entry.mentions = [
      { type: 'dir', name: 'src', path: 'src' },
      { type: 'file', name: 'app.ts', path: 'src/app.ts' },
    ];

    const prepared = queueMessageToComposerEditDraft('session-1', entry);
    const inline = prepared.draft.text?.content?.[0]?.content ?? [];

    expect(inline).toEqual([
      expect.objectContaining({
        type: 'mentionChip',
        attrs: expect.objectContaining({ kind: 'file', path: 'src/app.ts', label: 'app.ts' }),
      }),
    ]);
  });
});

describe('isQueueComposerEditCurrent', () => {
  const edit = {
    sessionId: 'session-1',
    clientId: 'queue-1',
    draftKey: 'queue-edit:session-1:queue-1',
    originalAttachmentIds: [],
  };

  it('rejects a stale save after switching sessions or replacing the edit', () => {
    expect(isQueueComposerEditCurrent(edit, 'session-2', edit)).toBe(false);
    expect(
      isQueueComposerEditCurrent(
        { ...edit, clientId: 'queue-2', draftKey: 'queue-edit:session-1:queue-2' },
        'session-1',
        edit,
      ),
    ).toBe(false);
    expect(isQueueComposerEditCurrent(edit, 'session-1', edit)).toBe(true);
  });
});

describe('rebaseQueueComposerEditContentAfterSlashCommandRewrite', () => {
  it('preserves Pi runtime skill aliases and rebases inline ranges before saving', () => {
    const content = {
      text: '/git inspect pasted',
      mentions: [],
      hasQuotes: false,
      agentReferences: [{
        kind: 'session' as const,
        start: 13,
        end: 19,
        href: 'cindy://session/source',
        sessionId: 'source',
      }],
      pastedTextRanges: [{ start: 13, end: 19, display: 'selection' }],
      slashCommandRanges: [{ start: 0, end: 4 }],
    };

    expect(
      rebaseQueueComposerEditContentAfterSlashCommandRewrite(
        content,
        '/skill:git inspect pasted',
      ),
    ).toEqual({
      ...content,
      text: '/skill:git inspect pasted',
      agentReferences: [{ ...content.agentReferences[0], start: 19, end: 25 }],
      pastedTextRanges: [{ start: 19, end: 25, display: 'selection' }],
      slashCommandRanges: [{ start: 0, end: 10 }],
    });
  });
});
