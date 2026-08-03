import { describe, expect, it } from 'vitest';

import {
  captureComposerSendSnapshot,
  isComposerSendSnapshotCurrent,
} from '../composerSendSnapshot';

const document = { type: 'doc', content: [{ type: 'paragraph' }] };
const attachment = {
  id: 'file-1',
  name: 'one.txt',
  path: '/tmp/one.txt',
  ext: 'txt',
  size: 3,
  category: 'document' as const,
};
const comment = {
  id: 'comment-1',
  markerNumber: 1,
  comment: 'keep this',
  selector: { type: 'element' as const, value: '#one' },
  screenshot: attachment,
};

describe('composer send snapshot', () => {
  it('accepts unchanged editor and object versions', () => {
    const attachments = [attachment];
    const comments = [comment];
    const snapshot = captureComposerSendSnapshot(document, attachments, comments);

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
