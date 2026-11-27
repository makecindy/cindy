import { describe, expect, it } from 'vitest';
import { projectAutoReviewUserReferences } from '@cindy/maker-shared/auto-review-intent';

import {
  hookAutoReviewReferences,
  hookReplyTarget,
  imAutoReviewReferences,
} from '../autoReviewReferences';

describe('hookReplyTarget', () => {
  const thread = [
    { messageId: 'root', author: 'alice', text: 'please check this link' },
    { messageId: 'later', author: 'bob', text: 'unrelated newer message' },
  ];

  it('resolves the parent the trigger explicitly replies to, not the newest message', () => {
    expect(
      hookReplyTarget({
        triggerMessageId: 'current',
        threadContext: [
          ...thread,
          {
            messageId: 'current',
            replyToMessageId: 'root',
            author: 'owner',
            text: 'is this real?',
          },
        ],
      }),
    ).toEqual({ author: 'alice', text: 'please check this link' });
  });

  it('does not guess when the named parent is missing from the chain', () => {
    expect(
      hookReplyTarget({
        triggerMessageId: 'current',
        threadContext: [
          ...thread,
          {
            messageId: 'current',
            replyToMessageId: 'gone',
            author: 'owner',
            text: 'is this real?',
          },
        ],
      }),
    ).toBeUndefined();
  });

  it('falls back to the nearest entry other than the current request without a reply link', () => {
    expect(
      hookReplyTarget({
        triggerMessageId: 'current',
        threadContext: [
          ...thread,
          { messageId: 'current', replyToMessageId: null, author: 'owner', text: 'hi' },
        ],
      }),
    ).toEqual({ author: 'bob', text: 'unrelated newer message' });
    // Telegram: the server sends exactly the replied-to message, without ids.
    expect(hookReplyTarget({ threadContext: [{ author: '群友', text: '看这个新闻' }] })).toEqual({
      author: '群友',
      text: '看这个新闻',
    });
    expect(hookReplyTarget(undefined)).toBeUndefined();
  });
});

describe('read-only managed attachment paths', () => {
  const macBlob = '/Users/alice/Library/Application Support/Cindy/cindy-media/blobs/a1b2c3d4.mp4';
  const winBlob = 'C:\\Users\\alice\\AppData\\Roaming\\Cindy\\cindy-media\\blobs\\f0e1d2c3.jpg';
  const imStaged = '/Users/alice/Library/Application Support/Cindy/im-attachments/telegram/staging/abc-report.pdf';
  const imSession = '/Users/alice/Library/Application Support/Cindy/im-attachments/telegram/sessions/sess-1/中文报告 (1).pdf';
  const hookFile = '/Users/alice/Library/Application Support/Cindy/hook-attachments/sess-2/1234abcd-clip.txt';

  it('collects exact managed paths from direct and context attachments while keeping counts scoped to direct attachments', () => {
    const refs = imAutoReviewReferences({
      attachments: [
        { kind: 'image', absPath: winBlob, originalName: 'shot.jpg', mimeType: 'image/jpeg' },
      ],
      contextAttachments: [
        { kind: 'file', absPath: macBlob, originalName: 'clip.mp4', mimeType: 'video/mp4' },
        { kind: 'file', absPath: imStaged, originalName: 'report.pdf', mimeType: 'application/pdf' },
        { kind: 'file', absPath: imSession, originalName: '中文报告 (1).pdf', mimeType: 'application/pdf' },
        { kind: 'file', absPath: '/Users/alice/.ssh/id_rsa', originalName: 'id_rsa', mimeType: 'text/plain' },
      ],
    });
    expect(refs).toEqual({
      attachments: { images: 1, files: 0 },
      readOnlyAttachmentPaths: [winBlob, macBlob, imStaged, imSession],
    });
  });

  it('supports contextAttachments-only group videos without fabricating direct attachment counts', () => {
    const refs = imAutoReviewReferences({
      attachments: [],
      contextAttachments: [
        { kind: 'file', absPath: macBlob, originalName: 'clip.mp4', mimeType: 'video/mp4' },
      ],
    });
    expect(refs).toEqual({
      readOnlyAttachmentPaths: [macBlob],
    });
  });

  it('rejects directory roots, traversal, non-managed paths, and wire-supplied paths', () => {
    const projected = hookAutoReviewReferences(undefined, { images: 0, files: 1 }, [
      hookFile,
      '/Users/alice/Library/Application Support/Cindy',
      '/Users/alice/Library/Application Support/Cindy/cindy-media/blobs',
      '/Users/alice/Library/Application Support/Cindy/cindy-media/blobs/',
      '/Users/alice/Library/Application Support/Cindy/cindy-media/blobs/../../local.db',
      '/Users/alice/Library/Application Support/Cindy/cindy-media/blobs/no-ext-dir',
      '/Users/alice/Library/Application Support/Cindy/hook-attachments/sess-2',
      'relative/cindy-media/blobs/a1b2.mp4',
      `${macBlob}\nrm -rf /`,
    ]);
    expect(projected).toEqual({
      attachments: { images: 0, files: 1 },
      readOnlyAttachmentPaths: [hookFile],
    });

    expect(
      projectAutoReviewUserReferences(projected, { allowAttachmentPaths: false }),
    ).toEqual({
      attachments: { images: 0, files: 1 },
    });
  });
});
