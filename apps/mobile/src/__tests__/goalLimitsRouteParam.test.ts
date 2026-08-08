import { describe, expect, it } from 'vitest';
import { parseGoalLimitsRouteParam } from '@/session/goalLimitsRouteParam';

describe('parseGoalLimitsRouteParam —— goal.set 失败接回 limits 严格解析(独立审核者 P2)', () => {
  it('parses a valid full limits payload', () => {
    expect(parseGoalLimitsRouteParam('{"maxTurns":5,"budgetTokens":100000,"noProgressLimit":3}'))
      .toEqual({ maxTurns: 5, budgetTokens: 100000, noProgressLimit: 3 });
  });

  it('ignores an all-null payload (no actual limit = same as not carrying limits)', () => {
    // 全 null 与空对象同义:显式提交「全部无限」会覆盖被控端默认 noProgressLimit: 3
    expect(parseGoalLimitsRouteParam('{"maxTurns":null,"budgetTokens":null,"noProgressLimit":null}'))
      .toBeUndefined();
  });

  it('accepts a payload with only some fields set', () => {
    expect(parseGoalLimitsRouteParam('{"maxTurns":8}'))
      .toEqual({ maxTurns: 8, budgetTokens: null, noProgressLimit: null });
  });

  it('returns undefined for missing / empty input', () => {
    expect(parseGoalLimitsRouteParam(undefined)).toBeUndefined();
    expect(parseGoalLimitsRouteParam(null)).toBeUndefined();
    expect(parseGoalLimitsRouteParam('')).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseGoalLimitsRouteParam('{bad json')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('not-json')).toBeUndefined();
  });

  it('returns undefined for non-object JSON (array / scalar)', () => {
    expect(parseGoalLimitsRouteParam('[1,2,3]')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('"str"')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('42')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('null')).toBeUndefined();
  });

  it('ignores the whole limits when any field is invalid (never rewrites to null)', () => {
    // 空对象 / 坏字段值 → 整体忽略,避免 limitsTouched=true 显式提交「全部无限」
    // 覆盖被控端默认 noProgressLimit: 3(独立审核者 P2)。
    expect(parseGoalLimitsRouteParam('{}')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('{"maxTurns":"bad"}')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('{"maxTurns":0}')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('{"maxTurns":-1}')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('{"maxTurns":1.5}')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('{"maxTurns":1e999}')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('{"maxTurns":5,"noProgressLimit":1.5}')).toBeUndefined();
    expect(parseGoalLimitsRouteParam('{"maxTurns":5,"budgetTokens":true}')).toBeUndefined();
  });
});
