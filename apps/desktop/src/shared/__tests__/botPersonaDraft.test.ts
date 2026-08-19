import { describe, expect, it } from 'vitest';

import {
  BOT_PERSONA_DRAFT_MAX_MEMORIES,
  BOT_PERSONA_ROLE_MAX_CHARS,
  buildBotPersonaPrompt,
  parseBotPersonaDraft,
} from '../botPersonaDraft';

const full = {
  name: '阿橘',
  description: '你的设计搭子',
  identity: '你是阿橘，设计搭子。\n界面、配图、走查都归你。',
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

describe('bot persona draft schema', () => {
  it('parses a well-formed object', () => {
    const draft = parseBotPersonaDraft(JSON.stringify(full));
    expect(draft).toMatchObject({
      name: '阿橘',
      description: '你的设计搭子',
          style: 'lively',
      proactivity: 'proactive',
      call: 'boss',
      avatarPreset: 'whitecat',
      avatarHue: 'amber',
    });
    expect(draft?.identity).toContain('设计搭子');
    // body 缺失时用 description 顶上,不产生一条空正文的记忆。
    expect(draft?.memories[1].body).toBe('交付前自己走一遍');
  });

  it('digs the object out of a markdown fence or a chatty preamble', () => {
    const wrapped = `Sure! Here you go:\n\`\`\`json\n${JSON.stringify(full)}\n\`\`\`\nHope that helps.`;
    expect(parseBotPersonaDraft(wrapped)?.name).toBe('阿橘');
  });

  /*
    名字和背景是预览卡的主体。缺任何一个都判失败 —— 给用户一句"这次没生成出来"
    比递上一张半空的卡诚实,后者会让人以为模型就只想出了这么点东西。
  */
  it('fails when the two load-bearing fields are missing', () => {
    expect(parseBotPersonaDraft(JSON.stringify({ ...full, name: '   ' }))).toBeNull();
    expect(parseBotPersonaDraft(JSON.stringify({ ...full, identity: '' }))).toBeNull();
  });

  it('fails on anything that is not one JSON object', () => {
    expect(parseBotPersonaDraft('')).toBeNull();
    expect(parseBotPersonaDraft('抱歉，我不能这么做。')).toBeNull();
    expect(parseBotPersonaDraft('{ "name": "x", ')).toBeNull();
    // 顶层 JSON 数组本身不是一个草稿,但把它里面那一个对象捞出来是最外层大括号
    // 切片的自然结果 —— 这是刻意保留的宽容:模型偶尔会把对象裹进数组。
    expect(parseBotPersonaDraft(JSON.stringify([full]))?.name).toBe('阿橘');
    expect(parseBotPersonaDraft(JSON.stringify(['just a string']))).toBeNull();
  });

  it('clamps unknown enum values to a safe default instead of failing the whole draft', () => {
    const draft = parseBotPersonaDraft(
      JSON.stringify({ ...full, style: 'sassy', proactivity: 9, call: 'custom' }),
    );
    // `custom` 是向导里那档「用户自己填一个称呼」——模型编不出用户想被怎么叫,
    // 所以它不在生成器的取值域里,一律回落到直呼名字。
    expect(draft).toMatchObject({ style: 'concise', proactivity: 'reactive', call: 'name' });
  });

  it('keeps at most three starting notes and drops half-written ones', () => {
    const draft = parseBotPersonaDraft(
      JSON.stringify({
        ...full,
        memories: [
          { title: 'a', description: 'a1', body: 'a2' },
          { title: '', description: 'b1', body: 'b2' },
          { title: 'c', description: 'c1', body: 'c2' },
          { title: 'd', description: 'd1', body: 'd2' },
          { title: 'e', description: 'e1', body: 'e2' },
        ],
      }),
    );
    expect(draft?.memories.map((m) => m.title)).toEqual(['a', 'c', 'd']);
    expect(draft?.memories.length).toBeLessThanOrEqual(BOT_PERSONA_DRAFT_MAX_MEMORIES);
  });

  /*
    开场白是可选的:模板伙伴自带 welcome 文案,生成出来的伙伴靠这个字段,拿不到时
    renderer 回落到带名字的模板句 —— 所以它缺席不该让整份草稿作废。
  */
  it('treats the opening line as optional', () => {
    expect(parseBotPersonaDraft(JSON.stringify(full))?.greeting).toBe(full.greeting);
    expect(parseBotPersonaDraft(JSON.stringify({ ...full, greeting: undefined }))?.greeting).toBe(
      '',
    );
    expect(parseBotPersonaDraft(JSON.stringify({ ...full, greeting: 42 }))?.greeting).toBe('');
    expect(parseBotPersonaDraft(JSON.stringify({ ...full, greeting: '  ' }))?.greeting).toBe('');
  });

  it('asks the model for an opening line, spoken by the teammate itself', () => {
    const { system } = buildBotPersonaPrompt('设计师', 'zh-CN');
    expect(system).toContain('"greeting"');
    expect(system).toMatch(/Rules for "greeting"/);
  });

  it('builds a prompt that pins the output language and forbids inventing owner facts', () => {
    const { system, user } = buildBotPersonaPrompt('  设计师  ', 'zh-CN');
    expect(system).toContain('zh-CN');
    expect(system).toContain('ONE JSON object');
    expect(system).toMatch(/Never invent facts about the human owner/);
    expect(user).toBe('Role description: 设计师');
  });

  it('truncates an over-long role description instead of shipping it whole', () => {
    const { user } = buildBotPersonaPrompt('长'.repeat(BOT_PERSONA_ROLE_MAX_CHARS + 50), 'zh-CN');
    expect(user.length).toBe('Role description: '.length + BOT_PERSONA_ROLE_MAX_CHARS);
  });
});
