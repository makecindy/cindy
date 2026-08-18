import { describe, expect, it } from 'vitest';

import type { MemoryRecord } from '@cindy/maker-core';

import type { ChatMessage } from '@/hooks/useCCAgentChat';

import {
  botGrowthNoteLabel,
  collectBotGrowthNotes,
  parseMemoryWriteToolUse,
  partitionBotMemoryRecords,
  summarizeBotGrowthEvents,
} from '../botGrowth';
import { buildBotGrowthSettingsPath, resolveBotSettingsHighlight } from '../botSettingsNav';

const MEMORY_TOOL = 'mcp__cindy_memory__call_tool';

function writeInput(args: Record<string, unknown>): Record<string, unknown> {
  return { name: 'memory_write', args };
}

function message(
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'clientId' | 'role'>,
): ChatMessage {
  return { content: '', createdAt: 0, ...partial } as ChatMessage;
}

function assistant(clientId: string, content = 'ok'): ChatMessage {
  return message({ clientId, role: 'assistant', content });
}

function user(clientId: string): ChatMessage {
  return message({ clientId, role: 'user', content: 'hi' });
}

function memoryWrite(clientId: string, args: Record<string, unknown>): ChatMessage {
  return message({
    clientId,
    role: 'tool_use',
    toolName: MEMORY_TOOL,
    toolInput: writeInput(args),
  });
}

describe('parseMemoryWriteToolUse — 记忆写入的判定', () => {
  it('认得当前真实形态:cindy_memory 二级分派下的 memory_write', () => {
    expect(
      parseMemoryWriteToolUse(
        MEMORY_TOOL,
        writeInput({ type: 'user', name: 'reply-style', title: '结论在前' }),
      ),
    ).toEqual({ learned: false, title: '结论在前' });
  });

  it('按 learned- 前缀把「本事」和「记忆」分开', () => {
    expect(
      parseMemoryWriteToolUse(
        MEMORY_TOOL,
        writeInput({ type: 'reference', name: 'learned-shrink-email', title: '把长邮件缩成三行' }),
      ),
    ).toEqual({ learned: true, title: '把长邮件缩成三行' });
  });

  it('同一个 MCP 的其它操作不算成长', () => {
    expect(
      parseMemoryWriteToolUse(MEMORY_TOOL, { name: 'memory_search', args: { query: 'x' } }),
    ).toBeNull();
    expect(parseMemoryWriteToolUse(MEMORY_TOOL, { name: 'memory_delete', args: {} })).toBeNull();
    expect(parseMemoryWriteToolUse(MEMORY_TOOL, { name: 'list_tools', args: {} })).toBeNull();
  });

  it('别的工具一律不认 —— 尾注宁可不出,也不能对着 Read/Bash 编一句「记住了」', () => {
    expect(parseMemoryWriteToolUse('Read', { file_path: '/tmp/a' })).toBeNull();
    expect(parseMemoryWriteToolUse('Bash', { command: 'ls' })).toBeNull();
    expect(
      parseMemoryWriteToolUse('mcp__cindy_helper__call_tool', writeInput({ title: 'x' })),
    ).toBeNull();
    expect(parseMemoryWriteToolUse(undefined, writeInput({ title: 'x' }))).toBeNull();
    expect(parseMemoryWriteToolUse(MEMORY_TOOL, undefined)).toBeNull();
    expect(parseMemoryWriteToolUse(MEMORY_TOOL, 'not-an-object')).toBeNull();
  });

  it('digest 是系统内部压缩分片,不是「TA 记得的事」', () => {
    expect(
      parseMemoryWriteToolUse(
        MEMORY_TOOL,
        writeInput({ type: 'digest', name: 'auto', title: '压缩摘要' }),
      ),
    ).toBeNull();
  });

  it('标题缺失 / 空白时降级成 null,由文案兜底而不是显示空引号', () => {
    expect(parseMemoryWriteToolUse(MEMORY_TOOL, writeInput({ type: 'user', name: 'x' }))).toEqual({
      learned: false,
      title: null,
    });
    expect(
      parseMemoryWriteToolUse(MEMORY_TOOL, writeInput({ type: 'user', name: 'x', title: '   ' })),
    ).toEqual({ learned: false, title: null });
  });

  it('MCP 投影换成直挂工具名时仍然认得(前向兼容)', () => {
    expect(
      parseMemoryWriteToolUse('mcp__cindy_memory__memory_write', {
        type: 'user',
        name: 'a',
        title: 'T',
      }),
    ).toEqual({ learned: false, title: 'T' });
    expect(parseMemoryWriteToolUse('memory_write', { name: 'learned-a', title: 'T' })).toEqual({
      learned: true,
      title: 'T',
    });
  });
});

describe('summarizeBotGrowthEvents — 同轮合并', () => {
  it('没有写入就没有尾注', () => {
    expect(summarizeBotGrowthEvents([])).toBeNull();
  });

  it('单条保留标题', () => {
    expect(summarizeBotGrowthEvents([{ learned: false, title: 'A' }])).toEqual({
      count: 1,
      title: 'A',
      target: 'memory',
    });
  });

  it('多条合并成一条,不再逐条列标题', () => {
    expect(
      summarizeBotGrowthEvents([
        { learned: false, title: 'A' },
        { learned: false, title: 'B' },
      ]),
    ).toEqual({ count: 2, title: null, target: 'memory' });
  });

  it('全是本事才算「学会」,混合按记忆处理', () => {
    expect(
      summarizeBotGrowthEvents([
        { learned: true, title: 'A' },
        { learned: true, title: 'B' },
      ])?.target,
    ).toBe('learned');
    expect(
      summarizeBotGrowthEvents([
        { learned: true, title: 'A' },
        { learned: false, title: 'B' },
      ])?.target,
    ).toBe('memory');
  });
});

describe('collectBotGrowthNotes — 尾注挂在哪句话上', () => {
  it('挂在这一轮的收尾正文末尾,不挂中间过程句', () => {
    const messages = [
      user('u1'),
      assistant('a-mid', '我看一下'),
      memoryWrite('t1', { type: 'user', name: 'reply-style', title: '结论在前' }),
      assistant('a-final', '好了'),
    ];
    const notes = collectBotGrowthNotes(messages, new Set(['a-final']));
    expect(notes.get('a-final')).toEqual({ count: 1, title: '结论在前', target: 'memory' });
    expect(notes.has('a-mid')).toBe(false);
  });

  it('同一轮写了两条,合并成一条尾注', () => {
    const messages = [
      user('u1'),
      memoryWrite('t1', { type: 'user', name: 'a', title: 'A' }),
      memoryWrite('t2', { type: 'user', name: 'b', title: 'B' }),
      assistant('a-final'),
    ];
    expect(collectBotGrowthNotes(messages, new Set(['a-final'])).get('a-final')).toEqual({
      count: 2,
      title: null,
      target: 'memory',
    });
  });

  it('没写记忆的轮次没有尾注', () => {
    const messages = [
      user('u1'),
      message({
        clientId: 't1',
        role: 'tool_use',
        toolName: 'Read',
        toolInput: { file_path: '/a' },
      }),
      assistant('a-final'),
    ];
    expect(collectBotGrowthNotes(messages, new Set(['a-final'])).size).toBe(0);
  });

  it('写入被下一条用户消息截断(中途打断)时不顺延到下一轮的答复上', () => {
    const messages = [
      user('u1'),
      memoryWrite('t1', { type: 'user', name: 'a', title: 'A' }),
      user('u2'),
      assistant('a-final'),
    ];
    expect(collectBotGrowthNotes(messages, new Set(['a-final'])).size).toBe(0);
  });

  it('每轮各挂各的,不会把上一轮的写入累加到下一轮', () => {
    const messages = [
      user('u1'),
      memoryWrite('t1', { type: 'user', name: 'a', title: 'A' }),
      assistant('a1'),
      user('u2'),
      memoryWrite('t2', { type: 'reference', name: 'learned-b', title: 'B' }),
      assistant('a2'),
    ];
    const notes = collectBotGrowthNotes(messages, new Set(['a1', 'a2']));
    expect(notes.get('a1')).toEqual({ count: 1, title: 'A', target: 'memory' });
    expect(notes.get('a2')).toEqual({ count: 1, title: 'B', target: 'learned' });
  });

  it('steer(插话)不算新一轮,写入仍挂在这一轮的收尾正文上', () => {
    const messages = [
      user('u1'),
      memoryWrite('t1', { type: 'user', name: 'a', title: 'A' }),
      message({ clientId: 'u2', role: 'user', content: '快点', delivery: 'steer' }),
      assistant('a-final'),
    ];
    expect(collectBotGrowthNotes(messages, new Set(['a-final'])).get('a-final')?.count).toBe(1);
  });

  it('收尾正文还没出现(仍在流式执行)时先不挂,等它出现', () => {
    const messages = [user('u1'), memoryWrite('t1', { type: 'user', name: 'a', title: 'A' })];
    expect(collectBotGrowthNotes(messages, new Set()).size).toBe(0);
  });
});

describe('botGrowthNoteLabel — 文案降级', () => {
  it('单条带标题', () => {
    expect(botGrowthNoteLabel({ count: 1, title: 'A', target: 'memory' })).toEqual({
      key: 'bots.growth.rememberedOne',
      params: { title: 'A' },
    });
    expect(botGrowthNoteLabel({ count: 1, title: 'A', target: 'learned' }).key).toBe(
      'bots.growth.learnedOne',
    );
  });

  it('标题提不出来时退化为「记住了一件事」,不显示空标题', () => {
    expect(botGrowthNoteLabel({ count: 1, title: null, target: 'memory' })).toEqual({
      key: 'bots.growth.rememberedFallback',
      params: {},
    });
  });

  it('多条走计数文案', () => {
    expect(botGrowthNoteLabel({ count: 3, title: null, target: 'memory' })).toEqual({
      key: 'bots.growth.rememberedMany',
      params: { count: 3 },
    });
    expect(botGrowthNoteLabel({ count: 2, title: null, target: 'learned' }).key).toBe(
      'bots.growth.learnedMany',
    );
  });
});

describe('partitionBotMemoryRecords — 两个列表的切分', () => {
  const record = (slug: string, type = 'user'): MemoryRecord =>
    ({
      filename: `${type}_${slug}.md`,
      slug,
      frontmatter: { title: slug, description: '', type, updatedAt: '2026-01-01T00:00:00.000Z' },
      body: '',
      sizeBytes: 1,
    }) as MemoryRecord;

  it('learned- 前缀进「TA 学会的」,其余进「TA 记得的」', () => {
    const { memories, learned } = partitionBotMemoryRecords([
      record('reply-style'),
      record('learned-shrink-email', 'reference'),
      record('learned-self-check', 'reference'),
    ]);
    expect(memories.map((item) => item.slug)).toEqual(['reply-style']);
    expect(learned.map((item) => item.slug)).toEqual([
      'learned-shrink-email',
      'learned-self-check',
    ]);
  });

  it('digest 两边都不展示', () => {
    const { memories, learned } = partitionBotMemoryRecords([
      record('auto-1', 'digest'),
      record('learned-x', 'digest'),
    ]);
    expect(memories).toEqual([]);
    expect(learned).toEqual([]);
  });

  it('空输入给空列表,而不是编造条目', () => {
    expect(partitionBotMemoryRecords([])).toEqual({ memories: [], learned: [] });
  });
});

describe('尾注跳转 —— 设置页高亮参数', () => {
  it('只认两个合法值,其余一律不高亮', () => {
    expect(resolveBotSettingsHighlight('memory')).toBe('memory');
    expect(resolveBotSettingsHighlight('learned')).toBe('learned');
    expect(resolveBotSettingsHighlight('who')).toBeNull();
    expect(resolveBotSettingsHighlight(null)).toBeNull();
    expect(resolveBotSettingsHighlight(undefined)).toBeNull();
    expect(resolveBotSettingsHighlight('')).toBeNull();
  });

  it('跳转路径落到「TA 是谁」并带上要高亮的列表', () => {
    expect(buildBotGrowthSettingsPath('bot-1', 'memory')).toBe(
      '/bots/bot-1?settings=1&anchor=who&highlight=memory',
    );
    expect(buildBotGrowthSettingsPath('bot-1', 'learned')).toBe(
      '/bots/bot-1?settings=1&anchor=who&highlight=learned',
    );
  });

  it('botId 进 URL 前转义', () => {
    expect(buildBotGrowthSettingsPath('a/b', 'memory')).toContain('/bots/a%2Fb?');
  });
});
