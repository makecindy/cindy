import { describe, expect, it } from 'vitest';

import { hookReplyTarget } from '../autoReviewReferences';

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
