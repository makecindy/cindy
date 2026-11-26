/**
 * Pi models.json 的 `input` 缺省值（#11296）。
 *
 * 缺省必须是「乐观」的（未声明 ≠ 不能看图），否则新发现的视觉模型会被误禁；
 * 但已知纯文本型号必须落到 ['text']，否则图片会被送到明确拒图的端点。
 */
import { describe, expect, it } from 'vitest';

import { piNativeModelInput } from '../model-input.js';

describe('piNativeModelInput', () => {
  it('keeps an explicit declaration as-is', () => {
    expect(piNativeModelInput({ id: 'glm-5.3', input: ['text', 'image'] })).toEqual(['text', 'image']);
    expect(piNativeModelInput({ id: 'some-vision-model', input: ['text'] })).toEqual(['text']);
  });

  it('defaults a known text-only model to text', () => {
    expect(piNativeModelInput({ id: 'glm-5.3' })).toEqual(['text']);
    expect(piNativeModelInput({ id: 'z-ai/glm-5.3' })).toEqual(['text']);
    // 请求实际发的是 wireId 形态。
    expect(piNativeModelInput({ id: 'my-router-glm', wireId: 'glm-5.3' })).toEqual(['text']);
  });

  it('stays optimistic for models without capability metadata', () => {
    expect(piNativeModelInput({ id: 'some-new-model' })).toEqual(['text', 'image']);
    // 同家族的视觉变体不受纯文本名单牵连。
    expect(piNativeModelInput({ id: 'glm-5.3-flash' })).toEqual(['text', 'image']);
  });
});
