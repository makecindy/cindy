import type { IMMessageEvent } from '@cindy/im';
import {
  projectAutoReviewUserReferences,
  type AutoReviewQuotedMessage,
  type AutoReviewUserReferences,
} from '@cindy/maker-shared/auto-review-intent';
import type { TaskSource } from '@cindy/slack-hook-protocol';

/**
 * Auto-review references for a personal IM message: only what the user pointed at
 * with this message — its delivered attachments (adapters merge the quoted message's
 * media in) and the message it replies to, both taken from the channel adapter's
 * event. Group background and `contextAttachments` are not pointed at and stay out.
 */
export function imAutoReviewReferences(
  event: Pick<IMMessageEvent, 'attachments' | 'replyContext'>,
): AutoReviewUserReferences | undefined {
  const reply = event.replyContext;
  return projectAutoReviewUserReferences({
    attachments: countAttachments(event.attachments),
    quotedMessages: reply
      ? [
          {
            author: reply.author,
            text: reply.text,
            isBot: reply.isBot,
            attachmentCount: reply.attachmentCount,
          },
        ]
      : [],
  });
}

/**
 * The message an official Hook task answers, read from the server's raw TaskSource
 * before display bounding (`normalizeTaskSource` keeps only the oldest entries).
 * An explicit `replyToMessageId` on the trigger names the parent; a parent missing from
 * the chain is not guessed. Without one, Telegram sends exactly the replied-to message
 * and X/Slack chains end with the message being answered (the current request excluded).
 */
export function hookReplyTarget(
  source: Pick<TaskSource, 'threadContext' | 'triggerMessageId'> | undefined,
): AutoReviewQuotedMessage | undefined {
  const chain = source?.threadContext ?? [];
  const trigger = source?.triggerMessageId;
  const parentId = trigger
    ? chain.find((entry) => entry.messageId === trigger)?.replyToMessageId
    : undefined;
  const nearest = parentId
    ? chain.find((entry) => entry.messageId === parentId)
    : chain.filter((entry) => !trigger || entry.messageId !== trigger).at(-1);
  return nearest
    ? projectAutoReviewUserReferences({
        quotedMessages: [{ author: nearest.author, text: nearest.text, isBot: nearest.isBot }],
      })?.quotedMessages?.[0]
    : undefined;
}

/**
 * Auto-review references for an official Hook task: the reply target captured by the
 * dispatcher and the attachments actually delivered. Servers merge quoted media into
 * the task attachments without a split count.
 */
export function hookAutoReviewReferences(
  replyTarget: AutoReviewQuotedMessage | undefined,
  delivered: { images: number; files: number },
): AutoReviewUserReferences | undefined {
  return projectAutoReviewUserReferences({
    attachments: delivered,
    quotedMessages: replyTarget ? [replyTarget] : [],
  });
}

function countAttachments(attachments: readonly { kind: 'image' | 'file' }[]): {
  images: number;
  files: number;
} {
  const images = attachments.filter((attachment) => attachment.kind === 'image').length;
  return { images, files: attachments.length - images };
}
