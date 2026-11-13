import type { IMMessageEvent } from '@cindy/im';
import { formatSourceRef, sanitizeSourceName } from '@cindy/maker-shared/message-source';

import { imChannelDisplayName, type ImMessageOrigin } from '../../../shared/imMessageSource';

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
  /**
   * 发言人是不是主人。私聊缺省就是主人(不写); 伙伴自有 bot 对外开放后外部用户的
   * 私聊置 false —— 说明里写明发言人并点出不是主人, 模型才不会把陌生人当成主人。
   * 群里 Main 核验过的主人发言置 true, 说明点出是主人(与 Telegram / 钉钉 `[发言人]`
   * 行的「主人」同源); 否则伙伴只能把群里的主人当普通成员。
   */
  senderIsOwner?: boolean;
  /**
   * 本轮可用的渠道工具提示(一句事实, 由渠道 adapter 给出)。Agent 在 IM 轮次里经常
   * 不知道自己手上有渠道 API 可用, 每条消息点一句比只靠工具描述更可靠。
   */
  toolsHint?: string;
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
  const guestDm = source.chatKind === 'direct' && source.senderIsOwner === false;
  const groupOwner = source.chatKind === 'group' && source.senderIsOwner === true;
  const senderRef =
    source.chatKind === 'group' || guestDm
      ? formatSourceRef(source.senderName, 'user_id', source.senderId)
      : '';
  const sender = senderRef
    ? `，发言人${senderRef}${guestDm ? '，不是主人' : groupOwner ? '，是主人' : ''}`
    : guestDm
      ? '，发言人不是主人'
      : groupOwner
        ? '，发言人是主人'
        : '';
  const tools = source.toolsHint?.trim() ? `${source.toolsHint.trim()}` : '';
  return `[渠道说明] 系统追加，不是用户消息。本条来自${where}${sender}。${tools}`.replace(/ {2,}/g, ' ');
}

/**
 * 存给界面的「谁、在哪说的」: 与渠道说明同源。`source` 还没算出来(提前落库)时只写发言人,
 * 派发时再补齐群 / 私聊; 群说明省略了发言人(Telegram 的 `[发言人]` 行)就从 speaker 补。
 * 名字按不可信展示文本消毒, 消毒后为空就只留 id。
 */
export function imMessageOriginFor(
  event: Pick<IMMessageEvent, 'speaker' | 'interactionSource'>,
  source: ImChannelNoteSource | null | undefined,
): ImMessageOrigin | undefined {
  const sender = event.speaker
    ? (() => {
        const id = event.speaker.id?.trim() || undefined;
        const name = distinctName(event.speaker.name || event.interactionSource?.senderName, id);
        return { isOwner: event.speaker.isOwner === true, ...(id ? { id } : {}), ...(name ? { name } : {}) };
      })()
    : undefined;
  const chat = source
    ? {
        kind: source.chatKind,
        ...(source.chatKind === 'group' && source.chatName ? { name: source.chatName } : {}),
      }
    : undefined;
  if (!sender && !chat) return undefined;
  return { ...(chat ? { chat } : {}), ...(sender ? { sender } : {}) };
}

/**
 * 私聊的来源(渠道已判定这是私聊, 不按 speaker 有无猜群): 主人只写 chat_id; 带
 * `speaker.isOwner === false` 的外部用户私聊写明发言人并标记不是主人。
 */
export function imChannelNoteDirectSourceFromEvent(
  event: Pick<IMMessageEvent, 'chatId' | 'speaker' | 'interactionSource'>,
): ImChannelNoteSource {
  const chatId = event.chatId?.trim() || undefined;
  const direct: ImChannelNoteSource = { chatKind: 'direct', ...(chatId ? { chatId } : {}) };
  if (!event.speaker || event.speaker.isOwner) return direct;
  const senderId = event.speaker.id?.trim() || undefined;
  const senderName = distinctName(
    event.speaker.name || event.interactionSource?.senderName,
    senderId,
  );
  return {
    ...direct,
    senderIsOwner: false,
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
  };
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
    ...(event.speaker.isOwner === true ? { senderIsOwner: true } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
  };
}
