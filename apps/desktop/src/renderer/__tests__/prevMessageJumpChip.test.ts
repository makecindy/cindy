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
