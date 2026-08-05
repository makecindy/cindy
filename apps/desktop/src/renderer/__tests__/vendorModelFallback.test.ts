/**
 * vendorModelFallback.test.ts
 * ---------------------------------------------------------------------------
 * 回归 features/cc-agent/lib/vendorModelFallback.ts 的核心约定 —— 这套判定取代了
 * CCAgentSessionView「M35 vendor fallback」effect 里基于 maker-core 冻结快照的旧校验。
 *
 * 关键 case(对应历史踩过的坑):
 *   1. 自定义供应商(mimo)的 codex 模型 → 不回退(本次修复:之前会被 reset 成 gpt)
 *   2. `gpt-5.4` 等两端同名 id,在 codex 会话下被 codex 来源 offer → 不回退
 *      (之前压平快照里被 cc 抢走 → 误判跨 vendor)
 *   3. 明确跨 vendor:codex 会话存了 cc 才有的 claude 模型 → 回退
 *   4. 上古脏 id / 目录未加载(两端都不 offer)→ 保守不动,避免 load race 误杀
 *   5. cc 会话对称成立
 */

import { describe, it, expect } from 'vitest';
import type { CatalogModel, Provider, ProviderView } from '@cindy/model-providers';

import { shouldFallbackVendorModel } from '@/features/cc-agent/lib/vendorModelFallback';

/** 造一个最小 CatalogModel(只填 providerOffersModel 关心的 id + 类型必填字段)。 */
function model(id: string): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null };
}

/** 造一个最小 ProviderView,按 agent 挂模型 id。 */
function provider(
  id: string,
  source: Provider['source'],
  models: Partial<Record<'claude-code' | 'codex', string[]>>,
): ProviderView {
  const agents = Object.keys(models) as Array<'claude-code' | 'codex'>;
  return {
    id,
    name: id,
    source,
    agents,
    auth: { method: source === 'user' ? 'apiKey' : 'managed' },
    routing: {},
    models: {
      ...(models['claude-code'] ? { 'claude-code': models['claude-code'].map(model) } : {}),
      ...(models.codex ? { codex: models.codex.map(model) } : {}),
    },
    connected: true,
  };
}

// 典型 live 目录:内置三家 + 一个自定义 mimo(同时配了 cc / codex runtime)。
// - anthropic 只 offer claude 模型
// - openai 只 offer gpt 原生
// - xd 网关两端都 offer(含两端同名的 gpt-5.4 —— 模拟 cc 经 proxy 也注册了它)
// - mimo 自定义:cc 端 claude-mimo、codex 端 mimo-codex
const PROVIDERS: ProviderView[] = [
  provider('anthropic', 'builtin', { 'claude-code': ['claude-opus-4-8', 'claude-haiku-4-5'] }),
  provider('openai', 'builtin', { codex: ['gpt-5.5', 'gpt-5.4'] }),
  provider('xd', 'builtin', { 'claude-code': ['gpt-5.4'], codex: ['gpt-5.5', 'gpt-5.4'] }),
  provider('mimo', 'user', { 'claude-code': ['claude-mimo'], codex: ['mimo-codex'] }),
];

describe('shouldFallbackVendorModel', () => {
  it('keeps a custom (mimo) codex model in a codex session (the fixed bug)', () => {
    expect(shouldFallbackVendorModel(PROVIDERS, 'mimo-codex', 'codex')).toBe(false);
  });

  it('keeps gpt-5.4 in a codex session even though cc also offers it (no id-collision misfire)', () => {
    expect(shouldFallbackVendorModel(PROVIDERS, 'gpt-5.4', 'codex')).toBe(false);
  });

  it('falls back when a codex session holds a claude-only model (genuine cross-vendor)', () => {
    expect(shouldFallbackVendorModel(PROVIDERS, 'claude-opus-4-8', 'codex')).toBe(true);
  });

  it('does NOT fall back for an id unknown to both vendors (stale / legacy / not-loaded)', () => {
    expect(shouldFallbackVendorModel(PROVIDERS, 'gpt-4-turbo-removed', 'codex')).toBe(false);
    expect(shouldFallbackVendorModel(PROVIDERS, 'gpt-5-codex', 'codex')).toBe(false);
  });

  it('does NOT fall back when providers are empty (catalog not loaded yet)', () => {
    expect(shouldFallbackVendorModel([], 'mimo-codex', 'codex')).toBe(false);
  });

  it('is symmetric for cc sessions: custom claude model kept, codex-only model falls back', () => {
    expect(shouldFallbackVendorModel(PROVIDERS, 'claude-mimo', 'claude-code')).toBe(false);
    // gpt-5.5 is codex-only here (cc offers gpt-5.4 but not gpt-5.5) → cross-vendor for a cc session.
    expect(shouldFallbackVendorModel(PROVIDERS, 'gpt-5.5', 'claude-code')).toBe(true);
    // gpt-5.4 is offered under cc too → kept.
    expect(shouldFallbackVendorModel(PROVIDERS, 'gpt-5.4', 'claude-code')).toBe(false);
  });
});
