import { describe, expect, it } from 'vitest';

import { CINDY_OFFICIAL_AVATAR, isCindyOfficialAvatar, parsePresetAvatarId } from '../BotAvatar';
import { NEW_BOT_DEFAULT_PERMISSIONS } from '../botCapabilityDefaults';
import { BOT_TEMPLATE_CHOICE_IDS, BOT_TEMPLATES, getBotTemplate } from '../botTemplates';

describe('Bot roster templates', () => {
  it('ships the six characters in roster order, blank card last', () => {
    expect(BOT_TEMPLATES.map((template) => template.id)).toEqual([
      'cindy',
      'shiba',
      'melody',
      'butler',
      'star',
      'ashu',
    ]);
    expect(BOT_TEMPLATE_CHOICE_IDS[BOT_TEMPLATE_CHOICE_IDS.length - 1]).toBe('custom');
  });

  it('keeps Hermes-style identity separate from structured capabilities', () => {
    for (const template of BOT_TEMPLATES) {
      expect(template.identitySource.trim()).not.toBe('');
      expect(template.identitySource).not.toMatch(
        /Telegram token|MCP server|workingDir|userContext/i,
      );
      // 产品裁决 2026-08-18:新建伙伴默认放手做。每个模板必须走同一个常量,
      // 不许各自写死,否则改默认值会漏掉其中一个。
      expect(template.capabilities.permissions).toBe(NEW_BOT_DEFAULT_PERMISSIONS);
      expect(NEW_BOT_DEFAULT_PERMISSIONS).toBe('trusted');
    }
  });

  it('gives every character a card copy set and a greeting to say on arrival', () => {
    for (const template of BOT_TEMPLATES) {
      expect(template.nameKey).toBe(`bots.createWizard.templates.${template.id}.name`);
      expect(template.descriptionKey).toBe(
        `bots.createWizard.templates.${template.id}.description`,
      );
      expect(template.skillKey).toBe(`bots.createWizard.templates.${template.id}.skill`);
      expect(template.introKey).toBe(`bots.createWizard.templates.${template.id}.intro`);
      // 入伙即打招呼:没有欢迎语的角色卡等于加进来就冷场。
      expect(template.welcomeKey).toBe(`bots.createWizard.templates.${template.id}.welcome`);
    }
  });

  it('keeps coordination powers with the two stewards only', () => {
    expect(getBotTemplate('ashu')).toMatchObject({
      autoSubscribeToTaskEvents: true,
      capabilities: { automation: true, sessionControlMode: 'coordinate' },
    });
    expect(getBotTemplate('butler')).toMatchObject({
      autoSubscribeToTaskEvents: true,
      capabilities: { automation: true, sessionControlMode: 'coordinate' },
    });
    for (const id of ['cindy', 'shiba', 'melody', 'star'] as const) {
      expect(getBotTemplate(id)).toMatchObject({
        autoSubscribeToTaskEvents: false,
        capabilities: { automation: false, sessionControlMode: 'none' },
      });
    }
  });

  it('reserves the official Cindy mark for Cindy and gives the rest shipped portraits', () => {
    const cindy = getBotTemplate('cindy');
    expect(cindy.avatar).toBe(CINDY_OFFICIAL_AVATAR);
    for (const template of BOT_TEMPLATES) {
      if (template.id === 'cindy') continue;
      expect(isCindyOfficialAvatar(template.avatar)).toBe(false);
      // 角色卡画的是真人像,不是 emoji:解析不出预置立绘就说明这张卡会退化成首字母。
      expect(parsePresetAvatarId(template.avatar)).not.toBeNull();
    }
    // 阿枢就是原来的「总控」,用猫头鹰立绘。
    expect(parsePresetAvatarId(getBotTemplate('ashu').avatar)).toBe('owl');
  });
});
