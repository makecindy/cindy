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

  /**
   * 回归（2026-09-04）：家族级 no-vision 前缀曾把同家族的**视觉变体**一并判成不能看图 ——
   * `deepseek-` / `glm-5.2` 是家族前缀，而 `deepseek-vl2`、`deepseek-v4-flash-vision-exp`、
   * `glm-5.2-vision` 都以它们开头。当时四个型号全部误判，后果不只是设置页标错：
   * isKnownNoVisionModel 是视觉桥「未自定义时默认勾选」的依据，误判会让本可直接吃图的
   * 模型被迫走桥，图片降级成文字描述。
   */
  it('lets an explicit vision marker override the family-level no-vision verdict', () => {
    expect(classifyVisionCapability('deepseek/deepseek-vl2')).toBe('vision');
    expect(classifyVisionCapability('deepseek/deepseek-v4-flash-vision-exp')).toBe('vision');
    expect(classifyVisionCapability('deepseek-v4-flash-vision-exp')).toBe('vision');
    expect(classifyVisionCapability('z-ai/glm-5.2-vision')).toBe('vision');
    // 同家族的非视觉型号不受影响 —— 标记必须真的出现在 id 里。
    expect(classifyVisionCapability('deepseek/deepseek-v4-flash')).toBe('no-vision');
    expect(classifyVisionCapability('z-ai/glm-5.2')).toBe('no-vision');
    // [1m] 后缀先被 normalize 剥掉,不影响标记匹配。
    expect(classifyVisionCapability('deepseek/deepseek-vl2[1m]')).toBe('vision');
  });

  it('does not treat vision / vl inside a longer word as a marker', () => {
    // 段边界约束:标记必须自成一段(前后是 ^ / - / / 或 . / 结尾),
    // 否则「名字里恰好含这两个字母」的纯文本模型会被误判成多模态。
    expect(classifyVisionCapability('deepseek/deepseek-vllm-runtime')).toBe('no-vision');
    expect(classifyVisionCapability('foo/invision-model')).toBe('unknown');
    expect(classifyVisionCapability('foo/bar-vlad')).toBe('unknown');
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
