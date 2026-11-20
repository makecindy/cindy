import { ButtonStyle, ComponentType } from 'discord.js';
import type { EmbedData } from 'discord.js';

import type {
  IMCardActionEvent,
  InteractiveCardButton,
  InteractiveCardSpec,
} from '../types.js';
import { decodeCustomId, encodeCustomId, encodeMessageId } from './codec.js';
import { discordLaneOfChannel, encodeDiscordLaneUserId } from './lane.js';
import { markdownToDiscord } from './markdown.js';

const BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;
const MAX_BUTTONS = BUTTONS_PER_ROW * MAX_ROWS;
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4096;
export const DISCORD_CARD_PAGE_BUTTON_ID = 'discord:card-page';
const TERMINAL_CONTROL_BUTTON_IDS = new Set([
  'control:new',
  'control:back',
  'control:exit',
  'control:thread-exit',
  'control:start',
]);

interface DiscordButtonData {
  type: ComponentType.Button;
  style: ButtonStyle;
  label: string;
  custom_id: string;
}

interface DiscordActionRowData {
  type: ComponentType.ActionRow;
  components: DiscordButtonData[];
}

export interface ButtonInteractionLike {
  customId: string;
  user: { id: string };
  channelId: string;
  message: { id: string };
  /** 服务器内的点击才有；私聊为空。 */
  guildId?: string | null;
  channel?: { type?: number; parentId?: string | null } | null;
}

export interface BuildCardMessageOptions {
  page?: number;
}

export function buildCardMessage(
  spec: InteractiveCardSpec,
  opts: BuildCardMessageOptions = {},
): { embeds: [EmbedData]; components: DiscordActionRowData[] } {
  const { text } = markdownToDiscord(spec.body);
  const embed: EmbedData = {
    ...(spec.title ? { title: capEmbedTitle(spec.title) } : {}),
    description: capEmbedDescription(text || ' '),
  };
  const components: DiscordActionRowData[] = [];
  const buttons = selectButtonsForDiscord(spec.buttons, opts.page ?? 0);

  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    components.push({
      type: ComponentType.ActionRow,
      components: buttons.slice(i, i + BUTTONS_PER_ROW).map((button) => ({
        type: ComponentType.Button,
        style: buttonStyle(button.type),
        label: button.label.slice(0, 80),
        custom_id: encodeCustomId(button.id, button.payload ?? {}),
      })),
    });
  }

  return { embeds: [embed], components };
}

export function parseInteraction(i: ButtonInteractionLike): IMCardActionEvent | null {
  const decoded = decodeCustomId(i.customId);
  if (!decoded) return null;

  // 服务器频道里的卡片：senderId 折成该频道的 lane（与入站消息同一路由键），点击人的身份
  // 由 handleButtonInteraction 单独核验；认不出 lane（thread 缺父频道）就当作无效交互。
  let senderId = i.user.id;
  if (i.guildId) {
    const lane = discordLaneOfChannel(i.guildId, i.channelId, i.channel);
    if (!lane) return null;
    senderId = encodeDiscordLaneUserId(lane);
  }

  return {
    channelName: 'discord',
    senderId,
    chatId: i.channelId,
    messageId: encodeMessageId(i.channelId, i.message.id),
    buttonId: decoded.buttonId,
    payload: decoded.payload,
    threadTs: undefined,
    scopeKey: undefined,
  };
}

function buttonStyle(type: 'primary' | 'default' | 'danger' | undefined): ButtonStyle {
  if (type === 'primary') return ButtonStyle.Primary;
  if (type === 'danger') return ButtonStyle.Danger;
  return ButtonStyle.Secondary;
}

function selectButtonsForDiscord(
  buttons: InteractiveCardButton[],
  requestedPage: number,
): InteractiveCardButton[] {
  if (buttons.length <= MAX_BUTTONS) return buttons;

  const reservedTail: InteractiveCardButton[] = [];
  for (let i = buttons.length - 1; i >= 0; i -= 1) {
    const button = buttons[i];
    if (!TERMINAL_CONTROL_BUTTON_IDS.has(button.id)) break;
    reservedTail.unshift(button);
  }

  const candidates = buttons.slice(0, buttons.length - reservedTail.length);
  if (candidates.length === 0) return reservedTail.slice(-MAX_BUTTONS);

  const reserved = reservedTail.slice(-(MAX_BUTTONS - 3));
  const pageSize = Math.max(1, MAX_BUTTONS - reserved.length - 2);
  const totalPages = Math.ceil(candidates.length / pageSize);
  if (totalPages <= 1) {
    return [
      ...candidates.slice(0, MAX_BUTTONS - reserved.length),
      ...reserved,
    ];
  }

  const page = clampPage(requestedPage, totalPages);
  const start = page * pageSize;
  const pageButtons = candidates.slice(start, start + pageSize);
  const paginationButtons = buildPaginationButtons(page, totalPages);
  return [
    ...pageButtons,
    ...paginationButtons,
    ...reserved,
  ];
}

function buildPaginationButtons(page: number, totalPages: number): InteractiveCardButton[] {
  const buttons: InteractiveCardButton[] = [];
  if (page > 0) {
    buttons.push({
      id: DISCORD_CARD_PAGE_BUTTON_ID,
      label: `Prev ${page}/${totalPages}`,
      payload: { page: page - 1 },
    });
  }
  if (page < totalPages - 1) {
    buttons.push({
      id: DISCORD_CARD_PAGE_BUTTON_ID,
      label: `Next ${page + 2}/${totalPages}`,
      payload: { page: page + 1 },
    });
  }
  return buttons;
}

function clampPage(page: number, totalPages: number): number {
  if (!Number.isInteger(page) || page < 0) return 0;
  return Math.min(page, totalPages - 1);
}

function capEmbedTitle(text: string): string {
  return text.length > EMBED_TITLE_MAX ? `${text.slice(0, EMBED_TITLE_MAX - 1)}…` : text;
}

function capEmbedDescription(text: string): string {
  return text.length > EMBED_DESCRIPTION_MAX ? `${text.slice(0, 4093)}…` : text;
}
