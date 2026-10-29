import { describe, expect, it } from 'vitest';

import {
  captureComposerSendSnapshot,
  isComposerSendSnapshotCurrent,
} from '../composerSendSnapshot';

const document = { type: 'doc', content: [{ type: 'paragraph', content: [
  { type: 'composerQuote', attrs: { text: 'original', comment: 'bound opinion' } },
] }] };
const attachment = {
  id: 'file-1',
  name: 'one.txt',
  path: '/tmp/one.txt',
  ext: '.txt',
  size: 3,
  category: 'text' as const,
  mimeType: 'text/plain',
};
const comment = {
  id: 'comment-1',
  markerNumber: 1,
  pageUrl: 'https://example.com/page',
  target: {
    kind: 'element' as const,
    point: { x: 10, y: 10 },
    viewport: { width: 1280, height: 800 },
    region: null,
    selectedText: null,
    immediate: false,
    targetTag: 'div',
    targetLabel: null,
    targetRole: null,
    targetSelector: '#one',
    targetPath: null,
    nearbyText: null,
    themeVariant: null,
    designBaseline: null,
    markerNumber: 1,
  },
  comment: 'keep this',
  screenshot: attachment,
};

describe('composer send snapshot', () => {
  it('accepts unchanged editor and object versions', () => {
    const attachments = [attachment];
    const comments = [comment];
    const snapshot = captureComposerSendSnapshot(document, attachments, comments);

    // #7387: editing an annotation while sending must protect the newer draft.
    const edited = structuredClone(document);
    edited.content[0].content[0].attrs.comment = 'updated opinion';
    expect(isComposerSendSnapshotCurrent(snapshot, edited, attachments, comments)).toBe(false);
    expect(
      isComposerSendSnapshotCurrent(snapshot, structuredClone(document), attachments, comments),
    ).toBe(true);
  });

  it('changes when text, attachments, or comments change during send', () => {
    const attachments = [attachment];
    const comments = [comment];
    const snapshot = captureComposerSendSnapshot(document, attachments, comments);

    expect(
      isComposerSendSnapshotCurrent(
        snapshot,
        {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new' }] }],
        },
        attachments,
        comments,
      ),
    ).toBe(false);
    expect(
      isComposerSendSnapshotCurrent(
        snapshot,
        document,
        [attachment, { ...attachment, id: 'file-2' }],
        comments,
      ),
    ).toBe(false);
    expect(
      isComposerSendSnapshotCurrent(
        snapshot,
        document,
        attachments,
        [{ ...comment, comment: 'new' }],
      ),
    ).toBe(false);
  });
});
