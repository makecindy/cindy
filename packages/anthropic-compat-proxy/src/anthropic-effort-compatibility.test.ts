import { describe, expect, it } from 'vitest';

import {
  createAnthropicEffortCompatibilityRule,
  omitUnsupportedAnthropicEffort,
} from './anthropic-effort-compatibility.js';

const REJECTION = '{"type":"error","error":{"type":"invalid_request_error","message":"Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low."}}';

describe('Anthropic Messages effort compatibility (#5032)', () => {
  it('omits output_config.effort and keeps the rest of the request', () => {
    const request = {
      model: 'Qwen3.8-Flash-Next',
      max_tokens: 4096,
      output_config: { effort: 'high', format: { type: 'text' } },
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    };
    expect(omitUnsupportedAnthropicEffort(request)).toEqual({
      model: 'Qwen3.8-Flash-Next',
      max_tokens: 4096,
      output_config: { format: { type: 'text' } },
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
  });

  it('drops an output_config that only carried the rejected effort', () => {
    const next = omitUnsupportedAnthropicEffort({
      model: 'Qwen3.8-Flash-Next',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(next).toEqual({
      model: 'Qwen3.8-Flash-Next',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(next).not.toHaveProperty('output_config');
  });

  it('leaves requests without an effort preference and non-Messages bodies alone', () => {
    expect(omitUnsupportedAnthropicEffort({
      model: 'Qwen3.8-Flash-Next',
      messages: [{ role: 'user', content: 'hello' }],
    })).toBeNull();
    // Responses 形态由 vLLM 规则处理,这里不能碰。
    expect(omitUnsupportedAnthropicEffort({
      model: 'qwen3.8-27b-fp8',
      reasoning: { effort: 'high' },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    })).toBeNull();
    expect(omitUnsupportedAnthropicEffort('not-json-object')).toBeNull();
  });

  it('matches only the unsupported-effort rejection and never joins unrelated retries', () => {
    const rule = createAnthropicEffortCompatibilityRule();
    expect(rule.matches(REJECTION)).toBe(true);
    expect(rule.matches('{"error":{"message":"Unexpected reasoning effort medium. Supported types are xhigh, and low."}}')).toBe(true);
    expect(rule.matches('{"error":{"message":"Unexpected message role."}}')).toBe(false);
    expect(rule.matches('{"error":{"message":"messages.0.output_config: Extra inputs are not permitted"}}')).toBe(false);
    expect(rule.applyOnUnmatchedRetry).toBe(false);
    // 主匹配时不叠加其它清理规则,重试只省略 effort、不改写工具调用历史。
    expect(rule.allowExtraRules).toBe(false);
  });

  it('strips the effort from a matched body and declines bodies with nothing to change', () => {
    const rule = createAnthropicEffortCompatibilityRule();
    const stripped = rule.strip(Buffer.from(JSON.stringify({
      model: 'Qwen3.8-Flash-Next',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hello' }],
    })));
    expect(stripped).not.toBeNull();
    expect(JSON.parse(stripped!.toString('utf8'))).not.toHaveProperty('output_config');
    expect(rule.strip(Buffer.from(JSON.stringify({
      model: 'Qwen3.8-Flash-Next',
      messages: [{ role: 'user', content: 'hello' }],
    })))).toBeNull();
    expect(rule.strip(Buffer.from('{not json'))).toBeNull();
  });
});
