import { describe, expect, it } from 'vitest';

import { CINDY_OFFICIAL_AVATAR, isCindyOfficialAvatar, parsePresetAvatarId } from '../BotAvatar';
import { NEW_BOT_DEFAULT_PERMISSIONS } from '../botCapabilityDefaults';
import {
  BOT_MEMORY_SEED_TYPES,
  normalizeBotMemorySeedEntries,
} from '../../../../shared/botMemorySeed';
import {
  BOT_TEMPLATE_CHOICE_IDS,
  BOT_TEMPLATES,
  botTemplateForName,
  botTemplateSeedEntries,
  getBotTemplate,
  isBotSeedMemorySlug,
} from '../botTemplates';

describe('Bot roster templates', () => {
  it('ships the eight characters in roster order, blank card last', () => {
    expect(BOT_TEMPLATES.map((template) => template.id)).toEqual([
      'cindy',
      'shiba',
      'melody',
      'designer',
      'counsel',
      'butler',
      'star',
      'ashu',
    ]);
    expect(BOT_TEMPLATE_CHOICE_IDS[BOT_TEMPLATE_CHOICE_IDS.length - 1]).toBe('custom');
  });

  // 产品裁决(2026-08-21):界面文案里女角色用「她」、男角色用「他」,不用「TA」。
  // 每个模板都必须显式声明性别,否则文案会退回用名字指代 —— 那是给自建伙伴的
  // 兜底,不该落到阵容角色头上。
  it('every roster character declares a gender', () => {
    for (const template of BOT_TEMPLATES) {
      expect(['female', 'male']).toContain(template.gender);
    }
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
      capabilities: { sessionControlMode: 'coordinate' },
    });
    expect(getBotTemplate('butler')).toMatchObject({
      autoSubscribeToTaskEvents: true,
      capabilities: { sessionControlMode: 'coordinate' },
    });
    for (const id of ['cindy', 'shiba', 'melody', 'designer', 'counsel', 'star'] as const) {
      expect(getBotTemplate(id)).toMatchObject({
        autoSubscribeToTaskEvents: false,
        capabilities: { sessionControlMode: 'none' },
      });
    }
  });

  /*
    「定时干活」是标配(裁决 2026-08-19):模板不再分档,读取侧也统一归一。
    这条一红就说明有人又把某个角色的自动化写回了 false —— 那个伙伴建好 Routine
    到点也不会跑,而用户在界面上完全看不到原因(开关已经下线)。
  */
  it('ships every template with automation on — it is standard, not a per-role perk', () => {
    for (const template of BOT_TEMPLATES) {
      expect(template.capabilities.automation, template.id).toBe(true);
    }
  });

  /*
    模板不只是一段身份说明:选一张角色卡时,那个角色的「开场笔记」也要跟着落地,
    否则新伙伴的「TA 记得的」永远是空的,用户看不出这块是干什么用的。
  */
  it('ships every character with 0-2 starting notes under its own copy namespace', () => {
    for (const template of BOT_TEMPLATES) {
      expect(template.seedMemories.length, template.id).toBeLessThanOrEqual(2);
      for (const seed of template.seedMemories) {
        // slug 是文件名兼幂等键,必须是存储层认的形状。
        expect(seed.slug, `${template.id}/${seed.slug}`).toMatch(/^[a-z0-9-]{1,64}$/);
        expect(BOT_MEMORY_SEED_TYPES).toContain(seed.type);
        const base = `bots.createWizard.templates.${template.id}.seedMemories.${seed.slug.replace(/-/g, '_')}`;
        expect(seed.titleKey).toBe(`${base}.title`);
        expect(seed.descriptionKey).toBe(`${base}.description`);
        expect(seed.bodyKey).toBe(`${base}.body`);
      }
    }
    // 至少有一个角色真的带了笔记 —— 全空等于这条能力没落地。
    expect(BOT_TEMPLATES.some((template) => template.seedMemories.length > 0)).toBe(true);
  });

  it('resolves those notes into shards the memory store will accept', () => {
    const identity = (key: string) => key;
    for (const template of BOT_TEMPLATES) {
      const entries = botTemplateSeedEntries(template, identity);
      expect(entries).toHaveLength(template.seedMemories.length);
      // 规整层不许把任何一条丢掉:丢掉就是用户少看到一条,而且是静默的。
      expect(normalizeBotMemorySeedEntries(entries)).toHaveLength(entries.length);
    }
  });

  /*
    设置页要靠这条判据决定记忆脚注说哪一句。判错的代价是对着一个空列表说
    「有几条是 TA 加入时自带的」—— 一句用户看得见的假话。
  */
  it('tells a starting note apart from a memory the teammate grew on its own', () => {
    for (const template of BOT_TEMPLATES) {
      for (const seed of template.seedMemories) {
        expect(isBotSeedMemorySlug(seed.slug), seed.slug).toBe(true);
        expect(isBotSeedMemorySlug(seed.slug.toUpperCase())).toBe(true);
      }
    }
    // AI 生成路径本地派生的 slug。
    expect(isBotSeedMemorySlug('start-1')).toBe(true);
    expect(isBotSeedMemorySlug('start-3')).toBe(true);
    // 用户自己攒出来的记忆,以及形似但不是的 slug。
    expect(isBotSeedMemorySlug('likes-short-replies')).toBe(false);
    expect(isBotSeedMemorySlug('learned-release-notes')).toBe(false);
    expect(isBotSeedMemorySlug('start-0')).toBe(false);
    expect(isBotSeedMemorySlug('started')).toBe(false);
    expect(isBotSeedMemorySlug('')).toBe(false);
  });

  it('reverse-looks-up a template by the name the user sees, the same way the roster does', () => {
    const identity = (key: string) => key;
    for (const template of BOT_TEMPLATES) {
      expect(botTemplateForName(identity(template.nameKey), identity)?.id).toBe(template.id);
      // 大小写与空白不该让补写入口消失。
      expect(botTemplateForName(`  ${identity(template.nameKey).toUpperCase()} `, identity)?.id).toBe(
        template.id,
      );
    }
    // 改过名 / 自己捏的伙伴查不到 —— 此时宁可不提供补写入口,也不给它塞别人的笔记。
    expect(botTemplateForName('Ops buddy', identity)).toBeNull();
    expect(botTemplateForName('   ', identity)).toBeNull();
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
