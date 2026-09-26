import { describe, expect, it } from 'vitest';
import { notificationPreview } from '../notificationPreview';
import { selectNotificationReply, type NotificationMessage } from '../localDb/sessionNotificationPreview.logic';

describe('notification plain text', () => {
  it.each([
    ['纯文本 hello 2 * 3 foo_bar', '纯文本 hello 2 * 3 foo_bar'],
    ['# 标题\n\n**加粗 _斜体_** [报告 **完成**](https://example.com)', '标题 加粗 斜体 报告 完成'],
    ['`a_b * 2`\n\n```ts\nconst a_b = 2 * 3;\n```', 'a_b * 2 const a_b = 2 * 3;'],
    ['> 已完成\n\n- 第一项\n- 第二项\n\n~~旧内容~~', '已完成 第一项 第二项 旧内容'],
    ['![private filename](/private/file.png)', ''],
    ['**日本語** / _한국어_ / [繁體中文](url)', '日本語 / 한국어 / 繁體中文'],
  ])('converts %s', (markdown, expected) => expect(notificationPreview(markdown)).toBe(expected));
  it('shortens after parsing, without splitting Unicode characters', () => {
    expect(notificationPreview('**😀中文abc**', 4)).toBe('😀中文');
    expect(notificationPreview('abc😀', 4)).toBe('abc');
    expect(notificationPreview('😀', 1)).toBe('');
    expect(notificationPreview('😀'.repeat(240))).toBe('😀'.repeat(120));
  });
});

const row = (clientId: string, text: string, agentMeta: Record<string, unknown> = {}, createdAt = 20): NotificationMessage => ({ clientId, text, role: 'assistant', topLevel: true, agentMeta, createdAt });
describe('current final reply selection', () => {
  it('selects the latest sealed final, skipping host results and unsealed tool commentary', () => {
    expect(selectNotificationReply([
      row('receipt', 'task contents', { botCollaboration: { role: 'delegation-result' } }),
      row('final', 'latest', { turnCompleted: true, assistantPhase: 'final_answer' }),
      row('other-block', 'first block'),
      row('old', 'old answer', { turnCompleted: true }, 1),
    ], 10)).toEqual({ clientId: 'final', text: 'latest' });
  });
  it('does not present a pre-tool preamble as the reply when no answer followed', () => {
    expect(selectNotificationReply([{ ...row('tool', 'tool output'), role: 'tool_result' },
      row('preamble', 'Let me check', { turnCompleted: true })], 10)).toBeUndefined();
  });
  it('never falls back to commentary, subagents, failed turns or historical finals', () => {
    expect(selectNotificationReply([row('comment', 'working', { turnCompleted: true, assistantPhase: 'commentary' })], 10)).toBeUndefined();
    expect(selectNotificationReply([row('failed', 'partial', { turnCompleted: false }), row('old', 'old answer', { turnCompleted: true }, 1)], 10)).toBeUndefined();
    expect(selectNotificationReply([{ ...row('subagent', 'secret', { turnCompleted: true }), topLevel: false }], 10)).toBeUndefined();
    expect(selectNotificationReply([{ ...row('input', 'new user input'), role: 'user' }, row('old', 'old', { turnCompleted: true })], 10)).toBeUndefined();
  });
});
