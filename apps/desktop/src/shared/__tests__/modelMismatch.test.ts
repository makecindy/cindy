import { describe, expect, it } from 'vitest';

import { canonicalModelFamilyKey, detectClaudeModelMismatch } from '../modelMismatch';

describe('canonicalModelFamilyKey', () => {
  it('剥掉 [1m] 后缀、日期尾缀、vendor 前缀与 claude- 前缀', () => {
    expect(canonicalModelFamilyKey('claude-fable-5[1m]')).toBe('fable-5');
    expect(canonicalModelFamilyKey('claude-opus-4-8-20260301')).toBe('opus-4-8');
    expect(canonicalModelFamilyKey('us.anthropic.claude-fable-5-20260115')).toBe('fable-5');
    expect(canonicalModelFamilyKey('Claude-Sonnet-5-LATEST')).toBe('sonnet-5');
    expect(canonicalModelFamilyKey('claude-opus-5[1m]')).toBe('opus-5');
    expect(canonicalModelFamilyKey('claude-opus-4-5')).toBe('opus-4-5');
  });

  it('点横等价,非字符串 / 空串安全返回空', () => {
    expect(canonicalModelFamilyKey('opus-4.8')).toBe('opus-4-8');
    expect(canonicalModelFamilyKey('')).toBe('');
    expect(canonicalModelFamilyKey(null)).toBe('');
    expect(canonicalModelFamilyKey(undefined)).toBe('');
  });
});

describe('detectClaudeModelMismatch', () => {
  it('所选模型在本轮实际集合中 → 无降级', () => {
    expect(
      detectClaudeModelMismatch('claude-fable-5', [
        { model: 'claude-fable-5[1m]', outputTokens: 900 },
      ]),
    ).toBeNull();
  });

  it('subagent 跑别的模型但主线仍是所选家族 → 无降级', () => {
    expect(
      detectClaudeModelMismatch('claude-fable-5', [
        { model: 'claude-fable-5', outputTokens: 900 },
        { model: 'claude-haiku-4-5-20251001', outputTokens: 300 },
      ]),
    ).toBeNull();
  });

  it('所选家族整轮缺席 → 判定降级,actual 取输出最多的 Anthropic 模型', () => {
    const r = detectClaudeModelMismatch('claude-fable-5', [
      { model: 'claude-haiku-4-5-20251001', outputTokens: 120 },
      { model: 'claude-opus-4-8', outputTokens: 800 },
    ]);
    expect(r).toEqual({ selected: 'claude-fable-5', actual: 'claude-opus-4-8' });
  });

  it('所选串带 [1m] / 日期,与裸 id 视为同家族', () => {
    expect(
      detectClaudeModelMismatch('claude-fable-5[1m]', [
        { model: 'claude-fable-5-20260115', outputTokens: 500 },
      ]),
    ).toBeNull();
    expect(
      detectClaudeModelMismatch('claude-opus-5', [
        { model: 'claude-opus-5[1m]', outputTokens: 500 },
      ]),
    ).toBeNull();
  });

  it('所选非 Anthropic 家族(网关 / 订阅直连)→ 不判定', () => {
    expect(
      detectClaudeModelMismatch('gpt-5.5', [{ model: 'gpt-5.4', outputTokens: 100 }]),
    ).toBeNull();
    expect(
      detectClaudeModelMismatch('chatgpt/gpt-5.5', [{ model: 'claude-opus-4-8', outputTokens: 100 }]),
    ).toBeNull();
  });

  it('实际集合里没有 Anthropic 条目 → 无法判定,返回 null', () => {
    expect(
      detectClaudeModelMismatch('claude-fable-5', [
        { model: '<synthetic>', outputTokens: 10 },
        { model: 'gpt-5.5', outputTokens: 100 },
      ]),
    ).toBeNull();
  });

  it('selected 缺省 / unknown / 空集合 → null', () => {
    expect(detectClaudeModelMismatch('unknown', [{ model: 'claude-opus-4-8' }])).toBeNull();
    expect(detectClaudeModelMismatch('', [{ model: 'claude-opus-4-8' }])).toBeNull();
    expect(detectClaudeModelMismatch(null, [{ model: 'claude-opus-4-8' }])).toBeNull();
    expect(detectClaudeModelMismatch('claude-fable-5', [])).toBeNull();
  });

  it('outputTokens 缺省按 0,平手取首个条目', () => {
    const r = detectClaudeModelMismatch('claude-fable-5', [
      { model: 'claude-opus-4-8' },
      { model: 'claude-sonnet-5' },
    ]);
    expect(r?.actual).toBe('claude-opus-4-8');
  });
});
