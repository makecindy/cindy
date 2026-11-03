import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_TOTAL_CHAR_BUDGET,
  formatConversationBlock,
  isBareLearnInvocationText,
} from '../evidence.pure';

describe('formatConversationBlock', () => {
  it('renders roles in order and returns empty for no items', () => {
    expect(formatConversationBlock([])).toBe('');
    const block = formatConversationBlock([
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', text: 'done' },
    ]);
    expect(block).toBe('User: do the thing\n\nAssistant: done');
  });

  it('drops EARLIEST messages over budget and notes the omission', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      role: 'user',
      text: `msg-${i} ${'x'.repeat(1400)}`,
    }));
    const block = formatConversationBlock(items);
    expect(block.length).toBeLessThanOrEqual(CONVERSATION_TOTAL_CHAR_BUDGET + 200);
    expect(block).toContain('earlier message(s) omitted');
    // 最新一条必在,最早一条必不在
    expect(block).toContain('msg-39');
    expect(block).not.toContain('msg-0 ');
  });
});

describe('isBareLearnInvocationText', () => {
  it('recognizes only bare Learn triggers regardless of later history rows', () => {
    expect(isBareLearnInvocationText('/learn')).toBe(true);
    expect(isBareLearnInvocationText('  /SKILL:Learn  ')).toBe(true);
    expect(isBareLearnInvocationText('/learn preserve the release flow')).toBe(false);
    expect(isBareLearnInvocationText('please run /learn')).toBe(false);
  });
});
