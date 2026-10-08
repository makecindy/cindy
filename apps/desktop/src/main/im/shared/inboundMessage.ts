import type { UserContentBlock, UserMessage } from '@cindy/maker-core';
import type { IMAttachment } from '@cindy/im';

const TAKEOVER_DELIVERY_CONTEXT =
  '<cindy_delivery_context>' +
  'Reply normally to the user message in this turn. Cindy automatically delivers your final response ' +
  'to the conversation that sent it. Do not ask the user to configure a bot, webhook, or outbound ' +
  'integration, and do not use a proactive outbound tool unless the user explicitly requests a separate ' +
  'outbound message. This delivery rule is transport-independent; never infer a persistent destination ' +
  'from earlier turns.' +
  '</cindy_delivery_context>';

/**
 * Build the model-facing message for an IM turn.
 *
 * Attached desktop sessions are created without channel vendor options, so the
 * model needs to know that normal replies are already delivered. Native agents
 * may retain this UserMessage in their own history; consequently the delivery
 * hint stays a transport-invariant rule and contains no vendor or destination.
 *
 * Channel facts travel separately in `channelNote` (`[渠道说明] 系统追加，不是用户消息。本条来自…`, see
 * channelNote.ts). That line is worded about this one message only, so a later
 * turn from another surface cannot read it as a persistent reply destination.
 * Splitting the two was approved by the user on 2026-10-05; before that no
 * IM turn told the model its channel at all.
 *
 * Order: delivery rule → channel note → channel-prepared text (persona /
 * ambient / group / reply blocks + user text) → attachments. The local
 * transcript still receives the original user text in turnRunner.
 */
export function buildImUserMessage(
  text: string,
  attachments: IMAttachment[],
  attachedTakeover = false,
  channelNote: string | null = null,
): UserMessage {
  const deliveryContext = attachedTakeover ? TAKEOVER_DELIVERY_CONTEXT : null;

  if (attachments.length === 0) {
    return {
      type: 'user',
      content: [deliveryContext, channelNote || null, text].filter((part) => part !== null).join('\n\n'),
    };
  }

  const blocks: UserContentBlock[] = [];
  if (deliveryContext) blocks.push({ type: 'text', text: deliveryContext });
  if (channelNote) blocks.push({ type: 'text', text: channelNote });
  if (text) blocks.push({ type: 'text', text });
  for (const att of attachments) {
    blocks.push({
      type: att.kind === 'image' ? 'image' : 'file',
      path: att.absPath,
      mimeType: att.mimeType,
    });
  }
  return { type: 'user', content: blocks };
}
