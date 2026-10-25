import { TELEGRAM_DEFAULT_BEHAVIOR, type TelegramBehaviorConfig } from '@cindy/im';

const EMOJI_LEVELS = new Set(['off', 'minimal', 'expressive']);
const GROUP_QUOTE_MODES = new Set(['off', 'first', 'all']);
const DM_QUOTE_MODES = new Set(['off', 'first']);

export function normalizeTelegramBehavior(raw: unknown): TelegramBehaviorConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    emojiReactions: EMOJI_LEVELS.has(String(r.emojiReactions))
      ? (r.emojiReactions as TelegramBehaviorConfig['emojiReactions'])
      : TELEGRAM_DEFAULT_BEHAVIOR.emojiReactions,
    replyQuoteGroup: GROUP_QUOTE_MODES.has(String(r.replyQuoteGroup))
      ? (r.replyQuoteGroup as TelegramBehaviorConfig['replyQuoteGroup'])
      : TELEGRAM_DEFAULT_BEHAVIOR.replyQuoteGroup,
    replyQuoteDm: DM_QUOTE_MODES.has(String(r.replyQuoteDm))
      ? (r.replyQuoteDm as TelegramBehaviorConfig['replyQuoteDm'])
      : TELEGRAM_DEFAULT_BEHAVIOR.replyQuoteDm,
    ...(isRecordOfActivation(r.groupActivation)
      ? { groupActivation: r.groupActivation }
      : {}),
  };
}

function isRecordOfActivation(
  raw: unknown,
): raw is Record<string, 'mention' | 'always'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.entries(raw as Record<string, unknown>).every(
    ([chatId, mode]) => /^-?\d+$/.test(chatId) && (mode === 'mention' || mode === 'always'),
  );
}

/** 人格配置(soul.md 语义): 名字进 Telegram 资料页同步与 persona 块, soul 每轮注入。 */
export interface TelegramPersonaConfig {
  botName: string;
  soul: string;
}

export const TELEGRAM_PERSONA_DEFAULTS: TelegramPersonaConfig = { botName: '', soul: '' };
export const BOT_NAME_MAX = 64; // Telegram setMyName 上限
export const SOUL_MAX = 4000;

export function normalizeTelegramPersona(raw: unknown): TelegramPersonaConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    botName: typeof r.botName === 'string' ? r.botName.slice(0, BOT_NAME_MAX) : '',
    soul: typeof r.soul === 'string' ? r.soul.slice(0, SOUL_MAX) : '',
  };
}

export function normalizeTelegramBehaviorPatch(
  patch: Partial<TelegramBehaviorConfig>,
): Partial<TelegramBehaviorConfig> {
  const next: Partial<TelegramBehaviorConfig> = {};
  if (patch.emojiReactions && EMOJI_LEVELS.has(patch.emojiReactions)) {
    next.emojiReactions = patch.emojiReactions;
  }
  if (patch.replyQuoteGroup && GROUP_QUOTE_MODES.has(patch.replyQuoteGroup)) {
    next.replyQuoteGroup = patch.replyQuoteGroup;
  }
  if (patch.replyQuoteDm && DM_QUOTE_MODES.has(patch.replyQuoteDm)) {
    next.replyQuoteDm = patch.replyQuoteDm;
  }
  if (isRecordOfActivation(patch.groupActivation)) {
    next.groupActivation = patch.groupActivation;
  }
  return next;
}
