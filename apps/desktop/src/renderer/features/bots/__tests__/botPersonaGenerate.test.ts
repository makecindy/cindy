import { describe, expect, it } from 'vitest';

import type { BotPersonaDraft } from '../../../../shared/botPersonaDraft';
import { BOT_AVATAR_HUES, parsePresetAvatarId, presetAvatarValue } from '../BotAvatar';
import { normalizeBotMemorySeedEntries } from '../../../../shared/botMemorySeed';
import {
  GENERIC_BOT_WELCOME_KEY,
  ROLE_BOT_WELCOME_KEY,
  botManualWelcome,
  botPersonaCreateInput,
  botPersonaGenerateErrorKey,
  botPersonaSeedEntries,
  botPersonaWelcome,
  resolveDraftAvatar,
} from '../botPersonaGenerate';
import { extractPersonaFromIdentitySource, readBotBackground } from '../botPersona';
import { ASSISTANT_BASELINE_CAPABILITIES } from '../botTemplates';

const draft: BotPersonaDraft = {
  name: '阿橘',
  description: '你的设计搭子',
  skill: '视觉设计',
  identity: '你是阿橘，设计搭子。界面、配图、走查都归你。',
  greeting: '嗨，我是阿橘。配图和走查都可以丢给我。',
  style: 'lively',
  proactivity: 'proactive',
  call: 'boss',
  avatarPreset: 'whitecat',
  avatarHue: 'amber',
  memories: [
    { title: '先给三版', description: '不一上来就定稿', body: '每次先出三版。' },
    { title: '走查后再交', description: '交付前自己走一遍', body: '' },
  ],
};

describe('botPersonaGenerate', () => {
  it('gives every failure its own sentence — none of them may be silent', () => {
    const codes = ['empty-input', 'provider-not-ready', 'invalid-output', 'generation-failed'] as const;
    const keys = codes.map(botPersonaGenerateErrorKey);
    expect(new Set(keys).size).toBe(codes.length);
    for (const key of keys) expect(key.startsWith('bots.roster.generate.errors.')).toBe(true);
  });

  it('takes the suggested face when this build actually ships it', () => {
    expect(resolveDraftAvatar(draft)).toEqual({
      avatar: presetAvatarValue('whitecat'),
      hue: 'amber',
    });
  });

  it('falls back to the hashed assignment for a face or hue it cannot resolve', () => {
    const unknown = resolveDraftAvatar({ ...draft, avatarPreset: 'unicorn', avatarHue: 'chartreuse' });
    // 认不出来时不能留一个空头像或把原始字符串画上去。
    expect(parsePresetAvatarId(unknown.avatar)).not.toBeNull();
    expect(BOT_AVATAR_HUES).toContain(unknown.hue);
    const empty = resolveDraftAvatar({ ...draft, avatarPreset: '', avatarHue: '' });
    expect(parsePresetAvatarId(empty.avatar)).not.toBeNull();
    expect(BOT_AVATAR_HUES).toContain(empty.hue);
  });

  /*
    生成出来的伙伴必须和从模板建出来的**同构**:背景正文进「背景设定」子块,三档
    口气进向导自己的 marker 段。否则用户一进设置页就会看到一个读不回自己选择的
    向导,和一段混着口气指令的背景正文。
  */
  it('lands the draft in the same two segments a template teammate uses', () => {
    const input = botPersonaCreateInput(draft);
    expect(input.name).toBe('阿橘');
    expect(input.description).toBe('你的设计搭子');
    expect(readBotBackground(input.identitySource)).toBe(draft.identity);
    expect(extractPersonaFromIdentitySource(input.identitySource)).toEqual({
      style: 'lively',
      proactivity: 'proactive',
      call: 'boss',
    });
  });

  it('reuses the ordinary assistant capability baseline instead of inventing one', () => {
    expect(botPersonaCreateInput(draft).capabilities).toBe(ASSISTANT_BASELINE_CAPABILITIES);
  });

  it('carries whatever the user edited on the preview card, not the model original', () => {
    const edited = { ...draft, name: '  小橘  ', identity: '你是小橘，只做走查。' };
    const input = botPersonaCreateInput(edited);
    expect(input.name).toBe('小橘');
    expect(readBotBackground(input.identitySource)).toBe('你是小橘，只做走查。');
  });

  it('derives stable local slugs — the model never names a file', () => {
    const entries = botPersonaSeedEntries(draft);
    expect(entries.map((entry) => entry.slug)).toEqual(['start-1', 'start-2']);
    // 空 body 用 description 顶上,不写一条空正文的分片。
    expect(entries[1].body).toBe('交付前自己走一遍');
    // 生成出来的分片必须能原样通过落库前的规整,否则它到不了「TA 记得的」。
    expect(normalizeBotMemorySeedEntries(entries)).toHaveLength(2);
  });

  it('produces nothing to seed when the user deleted every starting note', () => {
    expect(botPersonaSeedEntries({ ...draft, memories: [] })).toEqual([]);
  });
});

/*
  阵容页脚注对所有创建路径承诺「加入后 TA 会先跟你打个招呼」。这一组钉的是那句
  开场白从哪儿来,以及什么时候必须**放弃**模型那句。
*/
describe('botPersonaGenerate — 开场白', () => {
  it('speaks the model\'s own line when the draft was left as generated', () => {
    expect(botPersonaWelcome(draft, draft.name)).toEqual({
      key: ROLE_BOT_WELCOME_KEY,
      text: draft.greeting,
    });
    // 前后空白不能带进对话。
    expect(
      botPersonaWelcome({ ...draft, greeting: '  嗨。  ' }, draft.name).text,
    ).toBe('嗨。');
  });

  it('falls back to a template line once the user renamed the teammate', () => {
    // 模型那句里念的是「阿橘」;改名之后再用它,TA 一进门就会自我介绍成一个
    // 不存在的人。
    expect(botPersonaWelcome({ ...draft, name: '小橘' }, draft.name)).toEqual({
      key: ROLE_BOT_WELCOME_KEY,
      params: { name: '小橘', description: draft.description },
    });
  });

  it('falls back when the model gave no opening line at all', () => {
    expect(botPersonaWelcome({ ...draft, greeting: '' }, draft.name)).toEqual({
      key: ROLE_BOT_WELCOME_KEY,
      params: { name: draft.name, description: draft.description },
    });
  });

  it('drops to the generic line when there is no one-liner to quote', () => {
    expect(
      botPersonaWelcome({ ...draft, greeting: '', description: '  ' }, draft.name),
    ).toEqual({ key: GENERIC_BOT_WELCOME_KEY, params: { name: draft.name } });
  });

  it('gives a hand-made teammate a line of its own, with the name the user just typed', () => {
    expect(botManualWelcome('  Ops buddy ')).toEqual({
      key: GENERIC_BOT_WELCOME_KEY,
      params: { name: 'Ops buddy' },
    });
  });
});
