import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/makerChatStore';
import { groupWorkRuns, type MessageRenderItem, type ToolSegmentRenderItem, type RenderItem } from '@/components/chat/messageWorkGroups';
import { simplifyBotRenderItems } from '../botConversationPresentation';

const message = (id: string, role: ChatMessage['role'], content = id,
  extra: Partial<ChatMessage> = {}): MessageRenderItem => ({
  type: 'message', key: `msg-${id}`, message: { clientId: id, role, content, ...extra },
});
const tool = (id: string): ToolSegmentRenderItem => ({ type: 'tool_segment', key: `tools-${id}`,
  toolCalls: [{ clientId: id, role: 'tool_use', toolUseId: id, toolName: 'exec', content: '' }],
  resultMap: new Map([[id, 'error evidence']]), settledIds: new Set([id]), resultTsMap: new Map(),
});
const proseIds = (items: RenderItem[]) => items.flatMap((item) =>
  item.type === 'message' && item.message.role === 'assistant' ? [item.message.clientId] : []);
const allKeys = (items: readonly RenderItem[]): string[] => items.flatMap((item) =>
  item.type === 'work_group' ? allKeys(item.children) : [item.key]);
const project = (items: RenderItem[], streaming: boolean) =>
  simplifyBotRenderItems(groupWorkRuns(items, streaming), streaming);

describe('teammate final-result presentation', () => {
  it('omits all process rows and keeps final answers without mutating history', () => {
    const input = [message('u', 'user'), message('a', 'assistant'), tool('t1'),
      message('b', 'assistant'), tool('t2'), message('final', 'assistant', 'Result', { turnCompleted: true })];
    const result = project(input, false);
    expect(proseIds(result)).toEqual(['final']);
    expect(result.filter((item) => item.type === 'work_group')).toHaveLength(0);
    expect(allKeys(result)).toEqual(['msg-u', 'msg-final']);
    expect(input[1]).toEqual(message('a', 'assistant'));
  });

  it('keeps every unsealed segment collapsed from its first delta, before any tool arrives', () => {
    const start = [message('u', 'user'), message('a', 'assistant', 'A', { isStreaming: true })];
    expect(proseIds(project(start, true))).toEqual([]);
    const work = [...start, tool('t1')];
    expect(proseIds(project(work, true))).toEqual([]);
    expect(project(work, true).some(item => item.type === 'work_group')).toBe(false);
    const continued = project([...work, message('b', 'assistant', 'B', { isStreaming: true })], true);
    expect(proseIds(continued)).toEqual([]);
    expect(proseIds(project([...work, message('b', 'assistant', 'B', { turnCompleted: true })], false))).toEqual(['b']);
    expect(continued.some(item => item.type === 'work_group')).toBe(false);
  });

  it.each(['stopped', 'failed', 'history'])('retains the last useful text with no final: %s', () => {
    const input = [message('u', 'user'), message('a', 'assistant'), tool('t1'),
      message('last', 'assistant'), tool('t2'), message('err', 'error')];
    const result = project(input, false);
    expect(proseIds(result)).toEqual(['last']);
    expect(allKeys(result)).toContain('msg-err');
    expect(allKeys(result)).not.toContain('tools-t2');
  });

  it('keeps all blocks of sealed replies across continuation tools and history reloads', () => {
    const input = [message('u', 'user'), message('progress', 'assistant'), tool('t1'),
      message('first', 'assistant'), message('second', 'assistant', 'Second', { turnCompleted: true }),
      tool('t2'), message('third', 'assistant'),
      message('fourth', 'assistant', 'Fourth', { turnCompleted: true })];
    for (const streaming of [true, false]) {
      const result = project(input, streaming);
      expect(proseIds(result)).toEqual(['first', 'second', 'third', 'fourth']);
      expect(allKeys(result)).toEqual(['msg-u', 'msg-first', 'msg-second', 'msg-third', 'msg-fourth']);
    }
  });

  it('does not extend a seal across thinking removed from public execution', () => {
    const result = simplifyBotRenderItems([message('progress', 'assistant'),
      message('private', 'thinking'), message('first', 'assistant'),
      message('second', 'assistant', 'Second', { turnCompleted: true })], true);
    expect(proseIds(result)).toEqual(['first', 'second']);
    expect(allKeys(result)).not.toContain('msg-private');
  });

  it.each<RenderItem>([
    message('file', 'assistant', '', { files: [{ name: 'report.pdf', path: '/report.pdf' }], turnCompleted: true }),
    message('image', 'assistant', '', {
      images: [{ url: '/picture.png', mimeType: 'image/png', originalName: 'picture.png' }], turnCompleted: true,
    }),
    { type: 'tool_media', key: 'media', items: [{ kind: 'image', url: '/picture.png' }] },
    { type: 'ghost_card', key: 'card', callId: 'call', ghostId: 'plugin', tool: 'render',
      toolCall: { clientId: 'call', role: 'tool_use', content: '' }, settled: true },
  ])('does not restore preambles after delivery: $key', (delivery) => {
    const input = [message('u', 'user'), message('progress', 'assistant', '正在生成'), tool('t'), delivery];
    for (const streaming of [true, false]) {
      const result = project(input, streaming);
      expect(proseIds(result)).not.toContain('progress');
      expect(result.some((item) => item.key === delivery.key)).toBe(true);
      expect(allKeys(result)).not.toContain('msg-progress');
    }
  });

  it('retains a later explanation after partial delivery and ignores unverified file candidates', () => {
    const result = project([message('u', 'user'),
      message('file', 'assistant', '', { files: [{ name: 'partial.pdf', path: '/partial.pdf' }] }),
      message('explanation', 'assistant', 'Only part of the export completed'), tool('failed'),
      { type: 'generated_files', key: 'candidates', files: [
        { name: 'missing.pdf', path: '/missing.pdf', source: 'command' },
      ], turnStartMs: null, turnEndMs: null }, message('error', 'error')], false);
    expect(proseIds(result)).toEqual(['file', 'explanation']);
    expect(allKeys(result)).toContain('msg-error');
  });

  it('confirmed generated output preserves sealed answers and does not suppress a later turn fallback', () => {
    const input: RenderItem[] = [message('u', 'user'), message('progress', 'assistant'), tool('t'),
      message('final', 'assistant', 'Finished', { turnCompleted: true }),
      { type: 'generated_files', key: 'files', files: [{ name: 'report.pdf', path: '/report.pdf', source: 'tool' }],
        turnStartMs: 1000, turnEndMs: 5000 },
      message('u2', 'user'), message('explanation', 'assistant'), tool('failed')];
    const result = simplifyBotRenderItems(groupWorkRuns(input, false), false, new Set(['files']));
    expect(proseIds(result)).toEqual(['final', 'explanation']);
    expect(allKeys(result)).toEqual(['msg-u', 'msg-final', 'files', 'msg-u2', 'msg-explanation']);
  });

  it('does not extend a final seal or delivery fallback across a history gap without tools', () => {
    const first = message('legacy', 'assistant', 'Earlier answer', { createdAt: '2026-07-23T16:31:00Z' });
    const last = message('sealed', 'assistant', 'Latest answer', {
      createdAt: '2026-07-25T15:29:33Z', turnCompleted: true,
    });
    expect(proseIds(project([first, last], true))).toEqual(['legacy', 'sealed']);
    const file = message('file', 'assistant', '', {
      createdAt: '2026-07-25T15:29:33Z', files: [{ name: 'report.pdf', path: '/report.pdf' }],
    });
    expect(proseIds(project([first, file], false))).toEqual(['legacy', 'file']);
  });

  it('does not infer commentary from words, paragraph length or markdown shape', () => {
    const text = '# Report\n' + '先查市场 final result '.repeat(100);
    const input = [message('u', 'user'), message('long', 'assistant', text), tool('t'),
      message('answer', 'assistant', '先安装')];
    const result = project(input, false);
    expect(proseIds(result)).toEqual(['answer']);
    expect(allKeys(result)).not.toContain('msg-long');
  });

  it('keeps completed answers across continuation tools, synthetic triggers and real user turns', () => {
    const input = [message('u', 'user'), message('sealed', 'assistant', 'Done', { turnCompleted: true }),
      tool('t'), message('trigger', 'user', '', { isSyntheticTrigger: true }),
      message('continuing', 'assistant'), tool('t2'), message('u2', 'user'), message('new', 'assistant')];
    const result = project(input, true);
    expect(proseIds(result)).toEqual(['sealed', 'continuing']);
    expect(allKeys(result)).not.toContain('msg-trigger');
  });

  it('keeps authorization, questions, errors, attachments and tool deliveries while running', () => {
    const cards: RenderItem[] = [
      message('auth', 'assistant', '', { systemCardType: 'bot-authorization' }),
      message('ask', 'ask_user', 'Which?', { askUserStatus: 'answered' }),
      message('err', 'error'),
      message('file', 'assistant', '', { files: [{ name: 'report.pdf', path: '/report.pdf' }] }),
      message('picture', 'assistant', '![Image](/picture.png)'),
      { type: 'tool_media', key: 'media', items: [{ kind: 'image', url: '/generated.png' }] },
      { type: 'generated_files', key: 'files', files: [], turnStartMs: null, turnEndMs: null },
    ];
    const result = project([message('u', 'user'), ...cards, tool('later')], true);
    for (const card of cards) expect(result.some((item) => item.key === card.key)).toBe(true);
  });

  it('removes empty avatar rows and thinking from nested work without changing stored content', () => {
    const thinking = message('private', 'thinking', 'Not public execution');
    const input: RenderItem[] = [message('u', 'user'), message('empty', 'assistant', '  '),
      { type: 'work_group', key: 'work-nested', isStreaming: false, children: [thinking, tool('t')] },
      message('answer', 'assistant')];
    expect(allKeys(project(input, false))).toEqual(['msg-u', 'msg-answer']);
    expect(thinking).toEqual(message('private', 'thinking', 'Not public execution'));
  });

  it('omits unloaded technical history without calling its expansion or retry API', () => {
    const deferred = { owner: {}, key: 'range', expanded: false, loading: false, failed: false,
      toggle: vi.fn(), retry: vi.fn(), setVisible: vi.fn() };
    const group: RenderItem = { type: 'work_group', key: 'work-history', isStreaming: false,
      children: [], deferred };
    const input = [message('u', 'user'), group, message('final', 'assistant')];
    expect(allKeys(simplifyBotRenderItems(input, false))).toEqual(['msg-u', 'msg-final']);
    const loaded = { ...group, children: [message('thinking', 'thinking'), message('public', 'assistant'), tool('t')] };
    const result = simplifyBotRenderItems([input[0], loaded as RenderItem, input[2]], false);
    expect(allKeys(result)).toEqual(['msg-u', 'msg-final']);
    expect(deferred.toggle).not.toHaveBeenCalled();
    expect(deferred.retry).not.toHaveBeenCalled();
    expect(group.deferred).toBe(deferred);
  });
});
