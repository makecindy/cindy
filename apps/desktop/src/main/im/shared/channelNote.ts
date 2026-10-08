import type { IMMessageEvent } from '@cindy/im';
import { formatSourceRef, sanitizeSourceName } from '@cindy/maker-shared/message-source';

import { imChannelDisplayName } from '../../../shared/imMessageSource';

/**
 * 本机 IM 渠道的逐条来源说明（只进发给模型的正文）。
 *
 * 2026-10-05 用户确认：模型需要知道「这一条」来自哪个渠道、私聊还是哪个群、群里谁说的，
 * 才能把界面上的来源标签和它收到的内容对上。`<cindy_delivery_context>` 仍是与渠道无关的
 * 投递规则（见 inboundMessage.ts），渠道事实单独用这一行写，且措辞只描述本条消息，
 * 不暗示后续消息的目的地。
 *
 * 规则（docs/dev-rules/maker-core-and-agent-behavior.md §3.1）：
 *  - 只陈述事实、尽量短；名字一律配 id，只写确实拿得到的 id；
 *  - 首句声明不是用户消息，否则模型会把说明当请求回应或复述（hook 渠道说明踩过）；
 *  - 群名、发言人名是平台可改字段，按不可信展示文本消毒（sanitizeSourceName）；
 *  - 不进落库正文、不进 rawChannelText / imSource，不进系统提示词。
 */
export interface ImChannelNoteSource {
  chatKind: 'direct' | 'group';
  chatId?: string;
  chatName?: string;
  senderId?: string;
  senderName?: string;
}

/** 中文语境里拉丁字母渠道名两侧补空格，中文渠道名直接相连。 */
function channelLabel(channel: string): string | null {
  const name = imChannelDisplayName(channel);
  if (!name) return null;
  return /^[A-Za-z]/.test(name) ? ` ${name} ` : name;
}

/**
 * `[渠道说明] 系统追加，不是用户消息。本条来自飞书私聊 (chat_id: oc_x)。`
 * `[渠道说明] 系统追加，不是用户消息。本条来自飞书群「产品群」(chat_id: oc_x)，发言人「张三」(user_id: ou_y)。`
 * 未知渠道返回 null（不猜渠道名）。
 */
export function buildImChannelNote(channel: string, source: ImChannelNoteSource): string | null {
  const label = channelLabel(channel);
  if (!label) return null;
  const chatRef = formatSourceRef(
    source.chatKind === 'group' ? source.chatName : undefined,
    'chat_id',
    source.chatId,
  );
  const where = source.chatKind === 'group' ? `${label}群${chatRef}` : `${label}私聊${chatRef}`;
  const senderRef =
    source.chatKind === 'group'
      ? formatSourceRef(source.senderName, 'user_id', source.senderId)
      : '';
  const sender = senderRef ? `，发言人${senderRef}` : '';
  return `[渠道说明] 系统追加，不是用户消息。本条来自${where}${sender}。`.replace(/ {2,}/g, ' ');
}

/** 平台把 id 当显示名回填时（如钉钉缺群名、企业微信发言人）视为没有名字。 */
function distinctName(name: string | undefined, id: string | undefined): string | undefined {
  const safe = sanitizeSourceName(name);
  if (!safe) return undefined;
  return id && safe === id.trim() ? undefined : safe;
}

/**
 * 从入站事件读出的通用来源：有 `speaker` 即群/多人对话（与 controlCommands 的群轮判据一致），
 * 否则是私聊。渠道有更准确的数据时由 adapter.channelNoteSourceFor 覆盖。
 * `omitSender`：渠道已在正文里写了 `[发言人]` 行（Telegram / 钉钉群），说明里不再重复。
 */
export function imChannelNoteSourceFromEvent(
  event: Pick<IMMessageEvent, 'chatId' | 'speaker' | 'interactionSource'>,
  options: { omitSender?: boolean } = {},
): ImChannelNoteSource {
  const chatId = event.chatId?.trim() || undefined;
  if (!event.speaker) return { chatKind: 'direct', ...(chatId ? { chatId } : {}) };
  const chatName = distinctName(event.interactionSource?.chatName, chatId);
  const group: ImChannelNoteSource = {
    chatKind: 'group',
    ...(chatId ? { chatId } : {}),
    ...(chatName ? { chatName } : {}),
  };
  if (options.omitSender) return group;
  const senderId = event.speaker.id?.trim() || undefined;
  const senderName = distinctName(
    event.speaker.name || event.interactionSource?.senderName,
    senderId,
  );
  return {
    ...group,
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
  };
}
