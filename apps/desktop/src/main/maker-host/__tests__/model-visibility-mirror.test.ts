/**
 * model-visibility-mirror 单测 —— renderer 镜像到 main 的可见性 override 缓存。
 * 覆盖:整表替换、脏数据过滤、key 维度命中、未设 ⇒ undefined(回落目录默认)、重置。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetModelVisibilityMirrorForTest,
  getModelVisibilityOverride,
  setModelVisibilityMirror,
  syncModelVisibilityMirror,
} from '../model-visibility-mirror.js';

afterEach(() => {
  __resetModelVisibilityMirrorForTest();
});

describe('model-visibility-mirror', () => {
  it('未推送任何 override 时,任意查询返回 undefined(调用方回落目录默认)', () => {
    expect(getModelVisibilityOverride('claude-code', 'xd', 'gpt-5.5')).toBeUndefined();
  });

  it('按 `${agent}:${providerId}:${modelId}` 命中对应 override', () => {
    setModelVisibilityMirror({
      'claude-code:xd:gpt-5.5': false,
      'codex:openai:gpt-5.5': true,
    });
    expect(getModelVisibilityOverride('claude-code', 'xd', 'gpt-5.5')).toBe(false);
    expect(getModelVisibilityOverride('codex', 'openai', 'gpt-5.5')).toBe(true);
    // 维度不同(agent/provider)不串
    expect(getModelVisibilityOverride('codex', 'xd', 'gpt-5.5')).toBeUndefined();
    expect(getModelVisibilityOverride('claude-code', 'openai', 'gpt-5.5')).toBeUndefined();
  });

  it('整表替换语义:后一次推送完全覆盖前一次', () => {
    setModelVisibilityMirror({ 'claude-code:xd:a': false });
    setModelVisibilityMirror({ 'claude-code:xd:b': true });
    expect(getModelVisibilityOverride('claude-code', 'xd', 'a')).toBeUndefined();
    expect(getModelVisibilityOverride('claude-code', 'xd', 'b')).toBe(true);
  });

  it('仅在净化后的整表实际变化时返回 true，供调用方广播目录失效事件', () => {
    expect(setModelVisibilityMirror({
      'claude-code:xd:a': false,
      dirty: 'ignored',
    })).toBe(true);
    expect(setModelVisibilityMirror({
      dirty: 1,
      'claude-code:xd:a': false,
    })).toBe(false);
    expect(setModelVisibilityMirror({
      'claude-code:xd:a': true,
    })).toBe(true);
    expect(setModelVisibilityMirror(null)).toBe(true);
    expect(setModelVisibilityMirror([])).toBe(false);
  });

  it('只在镜像实变时调用目录失效回调', () => {
    const invalidate = vi.fn();

    expect(syncModelVisibilityMirror({ 'codex:openai:gpt-5': false }, invalidate)).toBe(true);
    expect(syncModelVisibilityMirror(
      { dirty: 'ignored', 'codex:openai:gpt-5': false },
      invalidate,
    )).toBe(false);
    expect(syncModelVisibilityMirror({ 'codex:openai:gpt-5': true }, invalidate)).toBe(true);

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('过滤非 boolean 脏值;非对象入参清空镜像', () => {
    setModelVisibilityMirror({ 'claude-code:xd:a': false, 'claude-code:xd:bad': 'nope' as unknown as boolean });
    expect(getModelVisibilityOverride('claude-code', 'xd', 'a')).toBe(false);
    expect(getModelVisibilityOverride('claude-code', 'xd', 'bad')).toBeUndefined();

    setModelVisibilityMirror(null);
    expect(getModelVisibilityOverride('claude-code', 'xd', 'a')).toBeUndefined();
  });
});
