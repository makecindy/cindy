import { describe, expect, it } from 'vitest';
import {
  compactVoiceInputHistoryIfNeeded,
  estimateVoiceInputHistoryContextChars,
  formatVoiceInputHistoryContext,
  takeRefinementContextHead,
  takeRefinementContextTail,
  truncateRefinementReply,
} from '../refinementContext';

describe('shared refinement context', () => {
  it('keeps history append-only until 12k and leaves room after compaction', () => {
    const entries = Array.from({ length: 32 }, (_, i) => ({ text: `${i}:`.padEnd(360, '字') }));
    expect(estimateVoiceInputHistoryContextChars(entries)).toBeLessThanOrEqual(12_000);
    expect(compactVoiceInputHistoryIfNeeded(entries)).toBe(entries);
    const overflow = [{ text: '最新'.repeat(180) }, ...entries];
    const compacted = compactVoiceInputHistoryIfNeeded(overflow);
    expect(compacted.length).toBeLessThanOrEqual(40);
    expect(estimateVoiceInputHistoryContextChars(compacted)).toBeLessThanOrEqual(8_000);
    expect(compacted[0]).toBe(overflow[0]);
    expect(overflow).toHaveLength(33);
    const next = [{ text: '下一句' }, ...compacted];
    expect(compactVoiceInputHistoryIfNeeded(next)).toBe(next);
    expect(formatVoiceInputHistoryContext(next)).toBe(`${formatVoiceInputHistoryContext(compacted)}\n- 下一句`);
  });

  it('does not slide at 100 short phrases and limits each history entry to 360 chars', () => {
    const entries = Array.from({ length: 105 }, (_, i) => ({ text: `entry ${i}` }));
    expect(compactVoiceInputHistoryIfNeeded(entries)).toBe(entries);
    expect(formatVoiceInputHistoryContext([{ text: 'x'.repeat(500) }])).toContain(`- ${'x'.repeat(360)}`);
    expect(formatVoiceInputHistoryContext([{ text: '  ' }])).toBe('');
  });

  it('preserves line structure, indentation and whitespace at the cursor within the budget', () => {
    const before = `old${'x'.repeat(1200)}\r\n  - one\r\n\t`;
    expect(takeRefinementContextTail(before)).toHaveLength(1200);
    expect(takeRefinementContextTail(before).endsWith('\n  - one\n\t')).toBe(true);
    const after = `\r\n    next\r\n${'x'.repeat(1300)}`;
    expect(takeRefinementContextHead(after)).toHaveLength(1200);
    expect(takeRefinementContextHead(after).startsWith('\n    next\n')).toBe(true);
    expect(takeRefinementContextHead('    ')).toBe('    ');
  });

  it('keeps both the reply subject and closing question within 500 chars, idempotently', () => {
    const reply = `方案结论\n${'说明'.repeat(400)}\n你选 A 还是 B？`;
    const result = truncateRefinementReply(reply);
    expect(result).toHaveLength(500);
    expect(result.startsWith('方案结论\n')).toBe(true);
    expect(result.endsWith('\n你选 A 还是 B？')).toBe(true);
    expect(result).toContain('\n…\n');
    expect(truncateRefinementReply(result)).toBe(result);
    expect(truncateRefinementReply('第一行\r\n  第二行')).toBe('第一行\n  第二行');
  });
});
