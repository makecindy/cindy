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
  };
}

const file = createOverrideSettingsFile<TelegramBehaviorConfig>({
  filePath: () => ownerScopedImUserDataPath('telegram-bot-behavior.json'),
  defaults: TELEGRAM_DEFAULT_BEHAVIOR,
  normalize,
  log,
  label: 'telegram-bot-behavior',
});

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
  return next;
}
