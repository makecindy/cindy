/**
 * visionCapability 三态判定测试。
 *
 * 覆盖：deepseek 系列 → no-vision（含带命名空间 / 裸 id / [1m] 后缀各种形态）；
 * claude/gpt/gemini → vision；未知 → unknown；codex/ 前缀归一化。
 */
import { describe, expect, it } from 'vitest';

import {
  classifyVisionCapability,
  isKnownNoVisionModel,
  normalizeVisionModelId,
} from '../visionCapability.js';

describe('normalizeVisionModelId', () => {
  it('strips [1m] suffix', () => {
    expect(normalizeVisionModelId('deepseek/deepseek-v4-flash[1m]')).toBe(
      'deepseek/deepseek-v4-flash',
    );
  });

  it('strips codex/ prefix', () => {
    expect(normalizeVisionModelId('codex/gpt-5.5')).toBe('gpt-5.5');
  });
});

describe('classifyVisionCapability', () => {
  it('classifies deepseek v4 series as no-vision (namespace + bare + suffix)', () => {
    expect(classifyVisionCapability('deepseek/deepseek-v4-pro')).toBe('no-vision');
    expect(classifyVisionCapability('deepseek/deepseek-v4-flash')).toBe('no-vision');
    expect(classifyVisionCapability('deepseek/deepseek-v4-flash[1m]')).toBe('no-vision');
    // 裸 id（部分 runtime body.model 形态）
    expect(classifyVisionCapability('deepseek-v4-flash')).toBe('no-vision');
  });

  it('classifies known vision models', () => {
    expect(classifyVisionCapability('anthropic/claude-opus-4-8')).toBe('vision');
    expect(classifyVisionCapability('openai/gpt-5.5')).toBe('vision');
    expect(classifyVisionCapability('google/gemini-3.5-flash')).toBe('vision');
    expect(classifyVisionCapability('xai/grok-4.5')).toBe('vision');
  });

  it('classifies glm-5.2 as no-vision (namespace + bare + suffix)', () => {
    expect(classifyVisionCapability('z-ai/glm-5.2')).toBe('no-vision');
    // 裸 id / 带 [1m] 后缀的 runtime body.model 形态（normalize 已剥 [1m]）。
    expect(classifyVisionCapability('glm-5.2')).toBe('no-vision');
    expect(classifyVisionCapability('glm-5.2[1m]')).toBe('no-vision');
  });

  it('classifies unknown models as unknown', () => {
    expect(classifyVisionCapability('foo/bar-model')).toBe('unknown');
    expect(classifyVisionCapability('qwen/qwen3.7-max')).toBe('unknown');
  });

  it('isKnownNoVisionModel helper', () => {
    expect(isKnownNoVisionModel('deepseek/deepseek-v4-flash')).toBe(true);
    expect(isKnownNoVisionModel('anthropic/claude-opus-4-8')).toBe(false);
  });
});
