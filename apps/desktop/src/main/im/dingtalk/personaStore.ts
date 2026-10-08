/**
 * 钉钉渠道「人格」配置的持久化（名字 + soul 文本）。
 *
 * 与个人 Telegram bot 的人格同模式：owner-scoped JSON override 文件，adapter 每轮
 * 现读 → 设置卡改动即生效。机器人应用与钉钉账号两种连接方式共用同一份人格。
 */

import { desktopMakerLogger } from '../../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';

const log = desktopMakerLogger.child('dingtalk-persona-store');

export interface DingTalkPersonaConfig {
  botName: string;
  soul: string;
}

const PERSONA_DEFAULTS: DingTalkPersonaConfig = { botName: '', soul: '' };
const BOT_NAME_MAX = 64;
const SOUL_MAX = 4000;

export function normalizeDingTalkPersona(raw: unknown): DingTalkPersonaConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    botName: typeof r.botName === 'string' ? r.botName.slice(0, BOT_NAME_MAX) : '',
    soul: typeof r.soul === 'string' ? r.soul.slice(0, SOUL_MAX) : '',
  };
}

const personaFile = createOverrideSettingsFile<DingTalkPersonaConfig>({
  filePath: () => ownerScopedImUserDataPath('dingtalk-bot-persona.json'),
  defaults: PERSONA_DEFAULTS,
  normalize: normalizeDingTalkPersona,
  log,
  label: 'dingtalk-bot-persona',
});

export function readDingTalkPersona(): DingTalkPersonaConfig {
  return personaFile.read();
}

export function patchDingTalkPersona(patch: unknown): DingTalkPersonaConfig {
  const r = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  const next: Partial<DingTalkPersonaConfig> = {};
  if (typeof r.botName === 'string') next.botName = r.botName.trim().slice(0, BOT_NAME_MAX);
  if (typeof r.soul === 'string') next.soul = r.soul.slice(0, SOUL_MAX);
  personaFile.writePatch(next);
  return personaFile.read();
}

/**
 * 人格块（soul.md 语义）：每轮注入送模型文本、不落 transcript。与 Telegram 的
 * `<bot_persona>` 同一标签，两个渠道的模型侧语义一致。
 */
export function buildDingTalkPersonaBlock(persona: DingTalkPersonaConfig): string {
  const soul = persona.soul.trim();
  const name = persona.botName.trim();
  if (!name && !soul) return '';
  const nameLine = name ? `你的名字: ${name}\n` : '';
  return `<bot_persona>\n${nameLine}${soul}\n</bot_persona>\n\n`;
}
