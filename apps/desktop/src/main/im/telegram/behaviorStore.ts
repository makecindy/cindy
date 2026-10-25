import { normalizeTelegramBehavior, normalizeTelegramPersona, normalizeTelegramBehaviorPatch, TELEGRAM_PERSONA_DEFAULTS, BOT_NAME_MAX, SOUL_MAX, type TelegramPersonaConfig } from '@cindy/im-runtime/channels/telegram/behavior';
export type { TelegramPersonaConfig } from '@cindy/im-runtime/channels/telegram/behavior';
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
  normalize: normalizeTelegramBehavior,
  log,
  label: 'telegram-bot-behavior',
});

const personaFile = createOverrideSettingsFile<TelegramPersonaConfig>({
  filePath: () => ownerScopedImUserDataPath('telegram-bot-persona.json'),
  defaults: TELEGRAM_PERSONA_DEFAULTS,
  normalize: normalizeTelegramPersona,
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
  file.writePatch(normalizeTelegramBehaviorPatch(patch));
  return file.read();
}
