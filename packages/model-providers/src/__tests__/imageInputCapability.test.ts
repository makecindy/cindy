// 测试价值：unit；生产入口 acceptsWebpImageInput。依据 PR 2 网关格式能力合同。
// 原覆盖不识别裸模型和 BYOK；最小输入 byok-openai-codex/gpt-6.1-sol。
// 验证是否允许转换为 WebP，未知/拒绝厂商保守处理；本机执行 0.003s。
import { describe, expect, it } from 'vitest';
import { acceptsWebpImageInput } from '../imageInputCapability.js';

describe('acceptsWebpImageInput', () => {
  it.each([
    ['openai', 'gpt-4o'],
    ['anthropic', 'claude-sonnet-4'],
    ['google', 'gemini-2.5-pro'],
    ['google-gemini', 'gemini-2.5-pro'],
    ['qwen', 'qwen-vl-max'],
    ['minimax-cn', 'minimax-vision'],
  ])('accepts WebP for declared provider %s', (providerId, modelId) => {
    expect(acceptsWebpImageInput({ providerId, modelId })).toBe(true);
  });

  // Unit regression: explicit PNG/JPEG-only declarations must override model
  // family guesses. Existing rows paired rejecting providers only with glm/grok.
  it.each([
    ['xai', 'grok-4'],
    ['zhipu-glm-cn', 'glm-5.2'],
    ['zhipu-glm-global', 'glm-5.2'],
    ['zhipu', 'gpt-4o'],
    ['xai-proxy', 'claude-sonnet-4'],
    [undefined, 'zhipu/gpt-4o'],
  ])('rejects WebP for provider %s / model %s', (providerId, modelId) => {
    expect(acceptsWebpImageInput({ providerId, modelId })).toBe(false);
  });

  it('fails closed for unknown routes', () => {
    expect(acceptsWebpImageInput({ providerId: 'future-provider', modelId: 'future-model' })).toBe(false);
    expect(acceptsWebpImageInput({})).toBe(false);
  });
});

// PR 2 gateway regression: routing IDs are not always the model manufacturer.
it.each(['anthropic/claude-sonnet-5-5', 'openai/gpt-6.1-sol', 'deepseek/deepseek-v4-flash', 'byok-openai-codex/gpt-6.1-sol', 'gpt-6-astra', 'claude-opus-5-5', 'o3', 'relay/pixtral-large'])('recognizes gateway model %s', modelId => {
  expect(acceptsWebpImageInput({ providerId: 'gateway', modelId })).toBe(true);
});
it.each(['relay/glm-5', 'grok-4', 'unknown-model'])('fails closed for %s', modelId => {
  expect(acceptsWebpImageInput({ providerId: 'gateway', modelId })).toBe(false);
});
