/**
 * main/im/telegram/behaviorStore.ts
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 行为配置的持久化(设置卡可视化操作面的存储层)。
 *
 * 设计 v3 §五点四/五点五: 配置的权威操作面是设置卡 UI, 存储用 owner-scoped
 * JSON override 文件(与 im-default-settings 同模式); transport 通过 getter
 * 每次使用时读 → 改动即生效, 不需要重启 bot。
 */

import { desktopMakerLogger } from '../../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';
import {
  TELEGRAM_DEFAULT_BEHAVIOR,
  type TelegramBehaviorConfig,
} from '@cindy/im';

const log = desktopMakerLogger.child('telegram-behavior-store');

const EMOJI_LEVELS = new Set(['off', 'minimal', 'expressive']);
const GROUP_QUOTE_MODES = new Set(['off', 'first', 'all']);
const DM_QUOTE_MODES = new Set(['off', 'first']);

function normalize(raw: unknown): TelegramBehaviorConfig {
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

/** 单个群的参与模式覆写(always=全响应·自主判断; mention=回默认并从表中清除)。 */
export function setTelegramGroupActivation(
  chatId: string,
  mode: 'mention' | 'always',
): TelegramBehaviorConfig {
  const current = file.read().groupActivation ?? {};
  const next = { ...current };
  if (mode === 'mention') delete next[chatId];
  else next[chatId] = mode;
  file.writePatch({ groupActivation: next });
  return file.read();
}

const file = createOverrideSettingsFile<TelegramBehaviorConfig>({
  filePath: () => ownerScopedImUserDataPath('telegram-bot-behavior.json'),
  defaults: TELEGRAM_DEFAULT_BEHAVIOR,
  normalize,
  log,
  label: 'telegram-bot-behavior',
});

/** 人格配置(soul.md 语义): 名字进 Telegram 资料页同步与 persona 块, soul 每轮注入。 */
export interface TelegramPersonaConfig {
  botName: string;
  soul: string;
}

const PERSONA_DEFAULTS: TelegramPersonaConfig = { botName: '', soul: '' };
const BOT_NAME_MAX = 64; // Telegram setMyName 上限
const SOUL_MAX = 4000;

function normalizePersona(raw: unknown): TelegramPersonaConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    botName: typeof r.botName === 'string' ? r.botName.slice(0, BOT_NAME_MAX) : '',
    soul: typeof r.soul === 'string' ? r.soul.slice(0, SOUL_MAX) : '',
  };
}

const personaFile = createOverrideSettingsFile<TelegramPersonaConfig>({
  filePath: () => ownerScopedImUserDataPath('telegram-bot-persona.json'),
  defaults: PERSONA_DEFAULTS,
  normalize: normalizePersona,
  log,
  label: 'telegram-bot-persona',
});

export function readTelegramPersona(): TelegramPersonaConfig {
  return personaFile.read();
}

export function patchTelegramPersona(
  patch: Partial<TelegramPersonaConfig>,
): TelegramPersonaConfig {
  const next: Partial<TelegramPersonaConfig> = {};
  if (typeof patch.botName === 'string') next.botName = patch.botName.trim().slice(0, BOT_NAME_MAX);
  if (typeof patch.soul === 'string') next.soul = patch.soul.slice(0, SOUL_MAX);
  personaFile.writePatch(next);
  return personaFile.read();
}

export function readTelegramBehavior(): TelegramBehaviorConfig {
  return file.read();
}

export function patchTelegramBehavior(
  patch: Partial<TelegramBehaviorConfig>,
): TelegramBehaviorConfig {
  file.writePatch(normalizePatch(patch));
  return file.read();
}

function normalizePatch(
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
