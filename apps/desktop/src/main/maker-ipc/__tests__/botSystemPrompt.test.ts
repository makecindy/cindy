/**
 * 伙伴系统提示词三层装配的行为锁。
 *
 * 这些断言存在的理由是一次真机事故:cindy_docs 明明挂载成功(日志
 * instance_resolved),伙伴却从没调用过 make_pptx —— 提示词里一个字都没写它会
 * 做文件,只写了「自己用 list_tools 去发现」。所以这里锁的不是措辞,而是
 * **能力有没有被写进提示词**,以及**没挂的能力有没有被闭嘴**。
 */
import { describe, expect, it } from 'vitest';

import {
  buildBotFolderIndex,
  buildBotSkillIndex,
  buildBotStableTier,
  buildBotSystemPrompt,
  buildBotTodoSection,
  buildBotVolatileTier,
  type BotSystemPromptInput,
} from '../botSystemPrompt';

function input(overrides: Partial<BotSystemPromptInput> = {}): BotSystemPromptInput {
  return {
    displayName: '小满',
    identity: '你是小满,设计师。',
    capabilities: {
      toolsets: [],
      memoryEnabled: false,
      delegationEnabled: false,
      ownSkillsEnabled: false,
    },
    skillIndex: [],
    ...overrides,
  };
}

describe('稳定层:能力必须写进提示词', () => {
  it('挂了 docs 就点名文档工具,并写清 PDF 要自检', () => {
    const stable = buildBotStableTier(
      input({
        capabilities: {
          toolsets: ['docs'],
          memoryEnabled: false,
          delegationEnabled: false,
          ownSkillsEnabled: false,
        },
      }),
    );
    for (const tool of ['make_pptx', 'make_docx', 'make_xlsx', 'render_pdf', 'read_sheet']) {
      expect(stable).toContain(tool);
    }
    expect(stable).toContain('inspect_pdf');
    // 真机事故的直接对策:不许再去找外部库。
    expect(stable).toContain('python-pptx');
  });

  it('没挂 docs 就一个文档工具名都不提(免得调一个不存在的工具)', () => {
    const stable = buildBotStableTier(input());
    expect(stable).not.toContain('make_pptx');
    expect(stable).not.toContain('render_pdf');
  });

  it('记忆 / 技能 / 协作 / 日程各自按信号出现', () => {
    const all = buildBotStableTier(
      input({
        capabilities: {
          toolsets: ['docs', 'scheduler'],
          memoryEnabled: true,
          delegationEnabled: true,
          ownSkillsEnabled: true,
        },
      }),
    );
    expect(all).toContain('你记得住事');
    expect(all).toContain('save_bot_skill');
    expect(all).toContain('叫别的伙伴帮忙');
    expect(all).toContain('定时干活');

    const none = buildBotStableTier(input());
    expect(none).not.toContain('save_bot_skill');
    expect(none).not.toContain('定时干活');
  });

  it('交付纪律恒在:要真做出来,被挡住说实话,不许编', () => {
    const stable = buildBotStableTier(input());
    expect(stable).toContain('把活干完');
    expect(stable).toContain('绝不编造');
    // 「自己去发现有什么工具」那句话必须已经不在了 —— 它正是事故的根源。
    expect(stable).not.toContain('list_tools');
  });

  it('作品集恒挂:任何伙伴都可能产出文件 / 图片 / 视频', () => {
    expect(buildBotStableTier(input())).toContain('作品集');
  });
});

describe('易变层:技能索引全部可见', () => {
  it('每个技能的名字都在索引里,不截断', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      name: `skill-${i}`,
      description: `第 ${i} 个`,
    }));
    const index = buildBotSkillIndex(entries);
    for (const entry of entries) expect(index).toContain(entry.name);
  });

  it('没有技能时不产出空标题', () => {
    expect(buildBotSkillIndex([])).toBe('');
  });

  it('技能索引排在记忆快照之前(易变层内部顺序)', () => {
    const volatile = buildBotVolatileTier(
      input({
        skillIndex: [{ name: 'weekly-report', description: '周报怎么写' }],
        memorySnapshot: '## 记忆\n他偏好先看两版',
      }),
    );
    expect(volatile.indexOf('weekly-report')).toBeLessThan(volatile.indexOf('## 记忆'));
  });
});

describe('三层顺序', () => {
  it('身份在最前、易变层在最后', () => {
    const built = buildBotSystemPrompt(
      input({
        skillIndex: [{ name: 'deck-layout' }],
        contextSections: ['## 会话控制\n只读'],
      }),
    );
    expect(built.full.indexOf('你是小满')).toBe(0);
    expect(built.full.indexOf('## 会话控制')).toBeLessThan(built.full.indexOf('deck-layout'));
  });
});

/*
  家里那几样进提示词。索引口径与技能索引一致(照搬 Hermes):**只报名字,正文按需读** ——
  看得见名字才知道自己有这份东西,全文塞进去则是每轮都付一次钱带一堆多半用不上的字。
*/
describe('家里摊开的那几样', () => {
  const base = {
    displayName: '小柴',
    identity: '你是小柴。',
    capabilities: { toolsets: [], memoryEnabled: false, delegationEnabled: false, ownSkillsEnabled: false },
    skillIndex: [],
  };

  it('写了 system_prompt.md 就完全听它的,不在后面偷偷再叠一份我们的说法', () => {
    const stable = buildBotStableTier({ ...base, systemPromptOverride: '  我自己写的全部  ' });
    expect(stable).toBe('我自己写的全部');
    // 默认组装里的东西一样都不该漏进来。
    expect(stable).not.toContain('你是小柴。');
    expect(stable).not.toContain('# 你会做什么');
  });

  it('没写覆盖时行为逐字不变', () => {
    expect(buildBotStableTier({ ...base, systemPromptOverride: '   ' })).toBe(
      buildBotStableTier(base),
    );
  });

  it('知识与偏好只进索引', () => {
    const volatile = buildBotVolatileTier({
      ...base,
      knowledgeFiles: ['报价口径.md', '客户名单.md'],
      preferenceFiles: ['写作风格.md'],
    });
    expect(volatile).toContain('## 你自己整理的知识');
    expect(volatile).toContain('- 报价口径.md');
    expect(volatile).toContain('## 你记下的偏好');
    expect(volatile).toContain('- 写作风格.md');
  });

  it('空目录一个字都不提', () => {
    expect(buildBotFolderIndex({ knowledgeFiles: [], preferenceFiles: [] })).toBe('');
    expect(buildBotTodoSection([])).toBe('');
    expect(buildBotTodoSection(undefined)).toBe('');
  });

  it('待办只列还没做完的', () => {
    expect(buildBotTodoSection(['写周报', '订机票'])).toContain('- 写周报');
    const volatile = buildBotVolatileTier({ ...base, openTodos: ['写周报'] });
    expect(volatile).toContain('## 你还欠着的事');
  });
});
