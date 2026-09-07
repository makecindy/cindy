/**
 * model-visibility-mirror 单测 —— renderer 镜像到 main 的可见性 override 缓存。
 * 覆盖:整表替换、脏数据过滤、key 维度命中、未设 ⇒ undefined(回落目录默认)、重置。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModelVisible, type ProviderView } from '@cindy/model-providers';

import {
  __resetModelVisibilityMirrorForTest,
  clearModelVisibilityMirror,
  getModelVisibilityOverride,
  getModelVisibilityMirrorSnapshot,
  setModelVisibilityMirror,
  syncModelVisibilityMirror,
  syncModelVisibilityMirrorForOwner,
} from '../model-visibility-mirror.js';

afterEach(() => {
  __resetModelVisibilityMirrorForTest();
});

describe('model-visibility-mirror', () => {
  it('尚未收到账号配置时不自动显示默认模型', () => {
    expect(getModelVisibilityOverride('claude-code', 'xd', 'gpt-5.5')).toBe(false);
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

  it('账号边界同步清空旧 owner 的进程内镜像', () => {
    setModelVisibilityMirror({ 'codex:openai:gpt-5.6': false });
    clearModelVisibilityMirror();
    expect(getModelVisibilityOverride('codex', 'openai', 'gpt-5.6')).toBe(false);
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

  it('只接受当前稳定 owner 的快照，拒绝切换中和迟到 generation', () => {
    const invalidate = vi.fn();
    const activeOwner = { dataOwnerId: 'owner-b', ownerGeneration: 2 };

    expect(syncModelVisibilityMirrorForOwner(
      { 'codex:openai:gpt-5.6': false },
      { dataOwnerId: 'owner-a', ownerGeneration: 1 },
      activeOwner,
      false,
      invalidate,
    )).toBe(false);
    expect(syncModelVisibilityMirrorForOwner(
      { 'codex:openai:gpt-5.6': false },
      { dataOwnerId: 'owner-b', ownerGeneration: 1 },
      { dataOwnerId: 'owner-b', ownerGeneration: 3 },
      false,
      invalidate,
    )).toBe(false);
    expect(syncModelVisibilityMirrorForOwner(
      { 'codex:openai:gpt-5.6': false },
      activeOwner,
      activeOwner,
      true,
      invalidate,
    )).toBe(false);
    expect(getModelVisibilityOverride('codex', 'openai', 'gpt-5.6')).toBe(false);

    expect(syncModelVisibilityMirrorForOwner(
      { 'codex:openai:gpt-5.6': false },
      activeOwner,
      activeOwner,
      false,
      invalidate,
    )).toBe(true);
    expect(getModelVisibilityOverride('codex', 'openai', 'gpt-5.6')).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});


describe('initialized model visibility policy', () => {
  it('keeps old on/off switches and rejects unseen models even when catalog defaults are on', () => {
    setModelVisibilityMirror({ 'claude-code:xd:fable-5': true, 'claude-code:xd:fable-5-1': false }, { fallback: false, followCatalogKeys: [] });
    expect(getModelVisibilityOverride('claude-code', 'xd', 'fable-5')).toBe(true);
    expect(getModelVisibilityOverride('claude-code', 'xd', 'fable-5-1')).toBe(false);
    expect(isModelVisible(getModelVisibilityOverride('pi', 'xd', 'brand-new'), true)).toBe(false);
  });

  it('expands late catalog models into ordinary off overrides for old remote clients', () => {
    setModelVisibilityMirror({ 'claude-code:xd:fable-5': true }, { fallback: false, followCatalogKeys: [] });
    const providers = [{ id: 'xd', agents: ['claude-code', 'pi'], models: {
      'claude-code': [{ id: 'fable-5', defaultEnabled: false }],
      pi: [{ id: 'brand-new', defaultEnabled: true }],
    } }] as unknown as ProviderView[];
    const snapshot = getModelVisibilityMirrorSnapshot(providers);
    expect(snapshot['claude-code:xd:fable-5']).toBe(true);
    expect(isModelVisible(snapshot['pi:xd:brand-new'], true)).toBe(false);
  });

  it('follows defaults only for explicit reset targets and still honors a later off override', () => {
    const policy = { fallback: false, followCatalogKeys: ['pi:xd:gemini'] };
    setModelVisibilityMirror({}, policy);
    expect(getModelVisibilityOverride('pi', 'xd', 'gemini')).toBeUndefined();
    expect(getModelVisibilityOverride('pi', 'xd', 'other')).toBe(false);
    setModelVisibilityMirror({ 'pi:xd:gemini': false }, policy);
    expect(getModelVisibilityOverride('pi', 'xd', 'gemini')).toBe(false);
  });

  it('invalidates on policy-only changes, rejects stale-owner policy, and clears at account boundary', () => {
    const notify = vi.fn();
    setModelVisibilityMirror({}); // Older renderer retains its legacy default semantics.
    expect(syncModelVisibilityMirror({}, notify, { fallback: false, followCatalogKeys: [] })).toBe(true);
    expect(syncModelVisibilityMirror({}, notify, { fallback: false, followCatalogKeys: [] })).toBe(false);
    expect(notify).toHaveBeenCalledOnce();
    expect(syncModelVisibilityMirrorForOwner({}, { dataOwnerId: 'old', ownerGeneration: 1 },
      { dataOwnerId: 'new', ownerGeneration: 2 }, false, notify, undefined)).toBe(false);
    expect(getModelVisibilityOverride('pi', 'xd', 'new')).toBe(false);
    clearModelVisibilityMirror();
    expect(getModelVisibilityOverride('pi', 'xd', 'new')).toBe(false);
  });
});
