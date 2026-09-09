import { describe, expect, it } from 'vitest';

import {
  createVllmResponsesCompatibilityRule,
  normalizeVllmResponsesRequest,
} from './vllm-responses-compatibility.js';

describe('vLLM Responses compatibility', () => {
  it('maps the rejected effort and standardizes rejected message roles', () => {
    const request = {
      model: 'qwen3.8-27b-fp8',
      instructions: 'base instructions',
      reasoning: { effort: 'high', summary: 'auto' },
      input: [
        { type: 'message', role: 'developer', content: 'permissions' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
      stream: true,
    };

    expect(normalizeVllmResponsesRequest(request)).toEqual({
      model: 'qwen3.8-27b-fp8',
      reasoning: { effort: 'xhigh', summary: 'auto' },
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'system', content: 'permissions' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
      stream: true,
    });
  });

  it('keeps string input as an explicit user message when instructions move into the list', () => {
    // Greptile P1: 合法 Responses 请求的字符串 input 在重试中被
    // instructions 的 system 消息覆盖，用户提示词会被静默丢弃。
    const request = {
      model: 'qwen3.8-27b-fp8',
      instructions: 'base instructions',
      reasoning: { effort: 'high' },
      input: '帮我总结这份文档',
    };

    expect(normalizeVllmResponsesRequest(request)).toEqual({
      model: 'qwen3.8-27b-fp8',
      reasoning: { effort: 'xhigh' },
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: '帮我总结这份文档' },
      ],
    });
  });

  it('leaves accepted requests unchanged', () => {
    const request = {
      model: 'qwen3.8-27b-fp8',
      reasoning: { effort: 'xhigh' },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    };
    expect(normalizeVllmResponsesRequest(request)).toBeNull();
  });

  it('matches only the two reported upstream rejections', () => {
    const rule = createVllmResponsesCompatibilityRule();
    expect(rule.matches('{"error":{"message":"Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low."}}')).toBe(true);
    expect(rule.matches('{"error":{"message":"Unexpected message role."}}')).toBe(true);
    expect(rule.matches('{"error":{"message":"System message must be at the beginning."}}')).toBe(false);
  });

  it('does not retry a role error when no incompatible role is present', () => {
    const rule = createVllmResponsesCompatibilityRule();
    const body = Buffer.from(JSON.stringify({
      model: 'qwen3.8-27b-fp8',
      reasoning: { effort: 'medium' },
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    }));
    expect(rule.strip(body)).toBeNull();
  });
});
