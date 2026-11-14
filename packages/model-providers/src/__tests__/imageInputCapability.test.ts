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

  it.each([
    ['xai', 'grok-4'],
    ['zhipu-glm-cn', 'glm-5.2'],
    ['zhipu-glm-global', 'glm-5.2'],
  ])('rejects WebP for %s', (providerId, modelId) => {
    expect(acceptsWebpImageInput({ providerId, modelId })).toBe(false);
  });

  it('fails closed for unknown routes', () => {
    expect(acceptsWebpImageInput({ providerId: 'future-provider', modelId: 'future-model' })).toBe(false);
    expect(acceptsWebpImageInput({})).toBe(false);
  });
});
