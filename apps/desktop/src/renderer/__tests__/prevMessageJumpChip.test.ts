/**
 * firstNonEmptyLine — 上一条提问 chip 的预览取首行工具。
 *
 * 关键 case:
 *   - 空 / 全空白 → ''(由调用方过滤,这里兜底)
 *   - 单行直接返回(去前后空白)
 *   - 多行取首条非空
 *   - 长度上限交给 CSS truncate,不在这里截断
 */

import { describe, it, expect } from 'vitest';
import { firstNonEmptyLine } from '../components/chat/PrevMessageJumpChip';
import { resolveUserDisplayText } from '../components/chat/userMessageDisplayText';

describe('firstNonEmptyLine', () => {
  it('returns empty string for empty / whitespace-only input', () => {
    expect(firstNonEmptyLine('')).toBe('');
    expect(firstNonEmptyLine('   \n  \t  ')).toBe('');
  });

  it('returns trimmed first line for single-line input', () => {
    expect(firstNonEmptyLine('  短问题  ')).toBe('短问题');
  });

  it('takes only the first non-empty line, trimmed', () => {
    expect(firstNonEmptyLine('\n\n  实际首行  \n后续内容')).toBe('实际首行');
  });

  it('does not truncate long input — CSS handles it', () => {
    const longInput = '这是一个非常非常长的用户提问内容,长度交给 CSS truncate 处理,不在这里截';
    expect(firstNonEmptyLine(longInput)).toBe(longInput);
  });
});

// MessageStream 的 previewById 实际链路 = resolveUserDisplayText → firstNonEmptyLine。
// chip 是导航条缺席/截断时的兜底导航入口,title/aria 与刻度预览同责:hook 消息
// 的隐藏 prompt/<thread_context>、Orca 行的 JSON 原文不能裸奔(PR #830 review)。
describe('chip 预览取显示文本(resolveUserDisplayText → firstNonEmptyLine)', () => {
  it('hook 消息(带 userText):预览取干净原文', () => {
    const text = resolveUserDisplayText({
      content: '<thread_context>群里的历史消息</thread_context>请根据以上上下文回复用户',
      hookSource: { userText: '帮我看下这个报错' },
    });
    expect(firstNonEmptyLine(text)).toBe('帮我看下这个报错');
  });

  it('hook 消息(过渡期,无 userText):剥掉 <thread_context> 块', () => {
    const text = resolveUserDisplayText({
      content: '<thread_context>A: 早\nB: 早</thread_context>\n这个 bug 谁修一下',
      hookSource: {},
    });
    expect(firstNonEmptyLine(text)).toBe('这个 bug 谁修一下');
  });

  it('Orca 通信行:取封装内的 content,不裸奔 JSON', () => {
    const text = resolveUserDisplayText({
      content: JSON.stringify({ orcaSource: 'lead', content: '任务:补齐单测覆盖' }),
    });
    expect(firstNonEmptyLine(text)).toBe('任务:补齐单测覆盖');
  });

  it('正文恰好是 JSON 字面量的普通提问原样保留', () => {
    expect(firstNonEmptyLine(resolveUserDisplayText({ content: '{"cmd":"build"}' }))).toBe(
      '{"cmd":"build"}',
    );
  });
});
