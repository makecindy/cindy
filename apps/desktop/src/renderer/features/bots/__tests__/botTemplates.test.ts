import { describe, expect, it } from 'vitest';

import {
  BOT_AVATAR_EMOJIS,
  CINDY_OFFICIAL_AVATAR,
  isCindyOfficialAvatar,
} from '../BotAvatar';
import { NEW_BOT_DEFAULT_PERMISSIONS } from '../botCapabilityDefaults';
import { BOT_TEMPLATES, getBotTemplate } from '../botTemplates';

describe('Bot product templates', () => {
  it('keeps Hermes-style identity separate from structured capabilities', () => {
    expect(BOT_TEMPLATES.map((template) => template.id)).toEqual([
      'control',
      'pr-steward',
      'assistant',
    ]);
    for (const template of BOT_TEMPLATES) {
      expect(template.identitySource.trim()).not.toBe('');
      expect(template.identitySource).not.toMatch(
        /Telegram token|MCP server|workingDir|userContext/i,
      );
      // 产品裁决 2026-08-18:新建伙伴默认放手做,风险由名字旁的 ⚠ 徽标事后表达。
      // 三个模板必须走同一个常量,不许各自写死,否则改默认值会漏掉其中一个。
      expect(template.capabilities.permissions).toBe(NEW_BOT_DEFAULT_PERMISSIONS);
      expect(NEW_BOT_DEFAULT_PERMISSIONS).toBe('trusted');
    }
  });

  it('makes control templates event-aware without granting that power to a normal assistant', () => {
    expect(getBotTemplate('control')).toMatchObject({
      autoSubscribeToTaskEvents: true,
      capabilities: { automation: true, sessionControlMode: 'coordinate' },
    });
    expect(getBotTemplate('pr-steward')).toMatchObject({
      autoSubscribeToTaskEvents: true,
      capabilities: { automation: true, sessionControlMode: 'coordinate' },
    });
    expect(getBotTemplate('assistant')).toMatchObject({
      autoSubscribeToTaskEvents: false,
      capabilities: { automation: false, sessionControlMode: 'none' },
    });
  });

  it('gives the standard assistant the official Cindy identity', () => {
    const assistant = getBotTemplate('assistant');
    expect(assistant.avatar).toBe(CINDY_OFFICIAL_AVATAR);
    expect(assistant.nameKey).toBe('bots.createWizard.templates.assistant.defaultName');
    // Only the standard assistant is Cindy herself; the control templates stay
    // on curated emoji so users can tell a task-controlling Bot apart.
    for (const template of BOT_TEMPLATES) {
      if (template.id === 'assistant') continue;
      expect(isCindyOfficialAvatar(template.avatar)).toBe(false);
      expect(BOT_AVATAR_EMOJIS).toContain(template.avatar as (typeof BOT_AVATAR_EMOJIS)[number]);
    }
  });
});
