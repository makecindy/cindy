import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { DictationRefiner } from '@cindy/voice-input-core';

import {
  buildReplyToMessageFromChatMessages,
  buildVoiceInputHistoryContext,
  buildEditorSelectionContext,
} from '../refinementContext';

describe('buildReplyToMessageFromChatMessages', () => {
  it('retains the opening subject and the closing question from a long reply', () => {
    const reply = buildReplyToMessageFromChatMessages([
      { role: 'assistant', content: `结论：可以修。\n${'详细解释'.repeat(200)}\n选择方案 A 还是 B？` },
    ]);
    expect(reply).toHaveLength(500);
    expect(reply).toContain('结论：可以修。');
    expect(reply).toContain('选择方案 A 还是 B？');
  });

  it('uses the latest completed assistant reply as the message being replied to', () => {
    const replyToMessage = buildReplyToMessageFromChatMessages([
      { role: 'assistant', content: '旧回复。' },
      { role: 'user', content: '继续。' },
      { role: 'assistant', content: '正在生成到一半', isStreaming: true },
      { role: 'assistant', content: '这是最新完成的 AI 回复。'.repeat(80) },
    ]);

    expect(replyToMessage).toBeDefined();
    expect(replyToMessage).toContain('这是最新完成的 AI 回复。');
    expect(replyToMessage?.length).toBeLessThanOrEqual(500);
  });
});

describe('editor cursor context delivered to refinement', () => {
  const schema = new Schema({ nodes: {
    doc: { content: 'paragraph+' }, paragraph: { content: 'inline*' }, text: { group: 'inline' },
    hard_break: { inline: true, group: 'inline' },
  } });
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('前文'), schema.node('hard_break'), schema.text('  光标选中后文')]),
    schema.node('paragraph', null, [schema.text('    下一段')]),
  ]);

  it('reads both sides of a real ProseMirror selection and preserves structure through the refiner', async () => {
    const context = buildEditorSelectionContext(doc, { from: 8, to: 10 });
    expect(context).toEqual({ selectionBefore: '前文\n  光标', selectedText: '选中', selectionAfter: '后文\n    下一段' });
    let sent: unknown;
    const refiner = new DictationRefiner({
      model: 'test', contextProvider: () => context,
      client: { async requestJson<T>(input: { user: unknown }) { sent = input.user; return { text: '新的文字。' } as T; } },
    });
    await refiner.refine({ text: '新的文字', runId: 'test', segmentIds: ['segment'] });
    expect(sent).toMatchObject({ context });
    expect(refiner.buildWarmupRequest().user).toMatchObject({ context });
  });

  it('handles a collapsed cursor, an empty editor and long text on both sides', () => {
    expect(buildEditorSelectionContext(doc, { from: 8, to: 8 })).toMatchObject({ selectedText: '', selectionAfter: '选中后文\n    下一段' });
    const empty = schema.node('doc', null, [schema.node('paragraph')]);
    expect(buildEditorSelectionContext(empty, { from: 1, to: 1 })).toEqual({ selectionBefore: '', selectedText: '', selectionAfter: '' });
    const long = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('前'.repeat(1500) + '后'.repeat(1500))])]);
    expect(buildEditorSelectionContext(long, { from: 1501, to: 1501 })).toEqual({ selectionBefore: '前'.repeat(1200), selectedText: '', selectionAfter: '后'.repeat(1200) });
  });
});

describe('buildVoiceInputHistoryContext', () => {
  it('builds one bounded voice-input history block oldest to newest', () => {
    const context = buildVoiceInputHistoryContext([
      { text: '最新一次语音输入' },
      { text: '中间一次语音输入' },
      { text: '最早一次语音输入' },
    ]);

    expect(context).toEqual({
      voiceInputHistory: [
        '语音输入历史（旧到新，仅作术语、别名和用词风格参考）：',
        '- 最早一次语音输入',
        '- 中间一次语音输入',
        '- 最新一次语音输入',
      ].join('\n'),
    });
  });

  it('does not slide-truncate the voice-input history block below compaction threshold', () => {
    const context = buildVoiceInputHistoryContext(
      Array.from({ length: 30 }, (_, index) => ({
        text: `第 ${index + 1} 条语音输入 ${'内容'.repeat(160)}`,
      })),
    );

    expect(context.voiceInputHistory).toContain('第 1 条语音输入');
    expect(context.voiceInputHistory).toContain('第 30 条语音输入');
    expect((context.voiceInputHistory?.length ?? 0)).toBeGreaterThan(8_000);
  });

  it('does not include normal chat messages in the voice-input history block', () => {
    const context = buildVoiceInputHistoryContext([]);

    expect(context).toEqual({});
  });
});
