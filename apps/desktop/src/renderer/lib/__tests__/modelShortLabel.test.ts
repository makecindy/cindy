/**
 * modelShortLabel.test.ts
 * ---------------------------------------------------------------------------
 * 锁住 raw model id → 短品牌标签的折算(subagent-model-chip 用)。纯函数,node env。
 */

import { describe, it, expect } from 'vitest';

import { formatModelShortLabel } from '../modelShortLabel';

describe('formatModelShortLabel', () => {
  it.each([
    // Claude:family + major.minor,dated 后缀 / [1m] 长上下文后缀都剥掉
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-haiku-4-5', 'Haiku 4.5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-opus-4-8[1m]', 'Opus 4.8'],
    ['claude-opus-4-8-20251101[1m]', 'Opus 4.8'],
    ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-fable-5', 'Fable 5'],
    // 前瞻:Fable 若引入 major.minor、或出现未来新族,通用正则都能整洁命中
    ['claude-fable-5-0', 'Fable 5.0'],
    ['claude-nova-5-0', 'Nova 5.0'],
    // vendor/route 前缀剥掉后仍能识别
    ['us.anthropic.claude-haiku-4-5-20251001', 'Haiku 4.5'],
    // GPT:版本 + 可选 mini/nano,折扣版 codex/ 前缀剥掉
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-5.4-mini', 'GPT-5.4 Mini'],
    ['codex/gpt-5.5', 'GPT-5.5'],
    // 未知 / 未来模型:Title Case 兜底,永不抛错
    ['some-future-model', 'Some Future Model'],
    ['', ''],
  ])('formats %s → %s', (input, expected) => {
    expect(formatModelShortLabel(input)).toBe(expected);
  });

  it('tolerates null / undefined', () => {
    expect(formatModelShortLabel(undefined)).toBe('');
    expect(formatModelShortLabel(null)).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(formatModelShortLabel('  claude-haiku-4-5  ')).toBe('Haiku 4.5');
  });
});
