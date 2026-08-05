/**
 * sections 单测 —— 「按供应商分段」列表派生 + 可见性决策(renderer 与 IM /model 共享的 SSoT)。
 */

import { describe, expect, it } from 'vitest';

import {
  buildProviderSections,
  isModelVisible,
  resolveModelIconKind,
  visibleModelUnion,
} from '../sections.js';
import type { ProviderView } from '../registry.js';
import type { CatalogModel } from '../types.js';

function model(id: string, name: string, defaultEnabled?: boolean, description?: string): CatalogModel {
  return {
    id,
    name,
    contextWindow: 200_000,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    ...(defaultEnabled !== undefined ? { defaultEnabled } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function provider(id: string, name: string, ccModels: CatalogModel[]): ProviderView {
  return {
    id,
    name,
    source: id === 'xd' || id === 'anthropic' || id === 'openai' ? 'builtin' : 'user',
    agents: ['claude-code'],
    auth: { method: 'managed' },
    routing: {
      'claude-code': {
        upstream: 'https://example.test',
        authStrategy: 'gateway-key',
      },
    },
    models: { 'claude-code': ccModels },
    connected: true,
  };
}

describe('isModelVisible', () => {
  it('用户 override 优先于目录默认', () => {
    expect(isModelVisible(false, true)).toBe(false);
    expect(isModelVisible(true, false)).toBe(true);
  });
  it('无 override 时跟随目录默认(缺省 ⇒ 可见)', () => {
    expect(isModelVisible(undefined, undefined)).toBe(true);
    expect(isModelVisible(undefined, true)).toBe(true);
    expect(isModelVisible(undefined, false)).toBe(false);
  });
});

describe('buildProviderSections', () => {
  const anthropic = provider('anthropic', 'Anthropic', [model('claude-opus-4-8', 'Opus 4.8')]);
  const xd = provider('xd', 'XD', [
    model('claude-opus-4-8', 'Opus 4.8'),
    model('gpt-5.5', 'GPT-5.5'),
  ]);

  it('每个供应商各列其模型;同一模型多供应商各成一行', () => {
    const sections = buildProviderSections({
      providers: [anthropic, xd],
      agent: 'claude-code',
      isVisible: () => true,
    });
    expect(sections.map((s) => s.provider.id)).toEqual(['anthropic', 'xd']);
    // Opus 在 anthropic + xd 各出现一次
    expect(sections[0].models.map((m) => m.id)).toEqual(['claude-opus-4-8']);
    expect(sections[1].models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'gpt-5.5']);
  });

  it('保留模型介绍供分段选择器展示', () => {
    const described = provider('anthropic', 'Anthropic', [
      model('claude-opus-4-8', 'Opus 4.8', undefined, 'Most capable for ambitious work'),
    ]);
    const sections = buildProviderSections({
      providers: [described],
      agent: 'claude-code',
      isVisible: () => true,
    });

    expect(sections[0].models[0].description).toBe('Most capable for ambitious work');
  });

  it('isVisible 过滤隐藏模型,但当前选中的 (供应商, 模型) 即便隐藏也保留', () => {
    const sections = buildProviderSections({
      providers: [xd],
      agent: 'claude-code',
      selectedModelId: 'gpt-5.5',
      selectedProviderId: 'xd',
      isVisible: () => false, // 全部隐藏
    });
    // 仅保留当前选中那行
    expect(sections).toHaveLength(1);
    expect(sections[0].models.map((m) => m.id)).toEqual(['gpt-5.5']);
  });

  it('query 命中 displayName / id(大小写不敏感)', () => {
    const sections = buildProviderSections({
      providers: [xd],
      agent: 'claude-code',
      isVisible: () => true,
      query: 'gpt',
    });
    expect(sections[0].models.map((m) => m.id)).toEqual(['gpt-5.5']);
  });

  it('过滤后无模型的供应商段不返回', () => {
    const sections = buildProviderSections({
      providers: [anthropic, xd],
      agent: 'claude-code',
      isVisible: (pid) => pid === 'xd', // 只放行 xd
    });
    expect(sections.map((s) => s.provider.id)).toEqual(['xd']);
  });

  it('非聊天模型(mode 权威判定)不进分段列表(issue #882 第 3 点,2026-07 review:三个调用方——桌面选择器/IM /model 卡片/mobile——都靠这一个函数挡住)', () => {
    const withNonChat = provider('xd', 'XD', [
      model('gpt-5.5', 'GPT-5.5'),
      { ...model('gpt-image-2', 'GPT Image 2'), mode: 'image_generation' },
    ]);
    const sections = buildProviderSections({
      providers: [withNonChat],
      agent: 'claude-code',
      isVisible: () => true,
    });
    expect(sections[0].models.map((m) => m.id)).toEqual(['gpt-5.5']);
  });

  it('非聊天模型即便是"当前选中"也不会被 keepSelected 豁免带回(防御性:选中态不应覆盖能力判定)', () => {
    const withNonChat = provider('xd', 'XD', [
      { ...model('gpt-image-2', 'GPT Image 2'), mode: 'image_generation' },
    ]);
    const sections = buildProviderSections({
      providers: [withNonChat],
      agent: 'claude-code',
      selectedModelId: 'gpt-image-2',
      selectedProviderId: 'xd',
      isVisible: () => false,
    });
    expect(sections).toHaveLength(0);
  });

  it('目录条目的 icon(AI Gateway 设定)透传进 SectionModel;缺省不带字段', () => {
    const withIcon = provider('xd', 'XD', [
      { ...model('claude-fable-5', 'Fable 5'), icon: 'claude' },
      model('gpt-5.5', 'GPT-5.5'),
    ]);
    const sections = buildProviderSections({
      providers: [withIcon],
      agent: 'claude-code',
      isVisible: () => true,
    });
    const models = sections[0].models;
    expect(models.find((m) => m.id === 'claude-fable-5')?.icon).toBe('claude');
    expect('icon' in (models.find((m) => m.id === 'gpt-5.5') ?? {})).toBe(false);
  });
});

describe('resolveModelIconKind', () => {
  it('已知取值与别名(大小写不敏感)映射到客户端图标种类', () => {
    expect(resolveModelIconKind('claude')).toBe('claude');
    expect(resolveModelIconKind('Anthropic')).toBe('claude');
    expect(resolveModelIconKind('codex')).toBe('codex');
    expect(resolveModelIconKind('openai')).toBe('codex');
    expect(resolveModelIconKind('GPT')).toBe('codex');
    expect(resolveModelIconKind('cindy')).toBe('cindy');
    expect(resolveModelIconKind(' xd ')).toBe('cindy');
  });
  it('缺省 / 空串 / 未知值返回 null(渲染层回落来源供应商标)', () => {
    expect(resolveModelIconKind(undefined)).toBeNull();
    expect(resolveModelIconKind('')).toBeNull();
    expect(resolveModelIconKind('grok')).toBeNull();
    expect(resolveModelIconKind('https://evil.example/icon.svg')).toBeNull();
  });
});

describe('visibleModelUnion', () => {
  const anthropic = provider('anthropic', 'Anthropic', [model('claude-opus-4-8', 'Opus 4.8')]);
  const xd = provider('xd', 'XD', [
    model('claude-opus-4-8', 'Opus 4.8'),
    { ...model('codex/gpt-5.5', 'GPT-5.5'), group: 'gpt-budget' },
    model('gpt-5.5', 'GPT-5.5'),
  ]);

  it('拍平并集: 按供应商序 first-wins 去重, 保留 group 等目录元数据', () => {
    const out = visibleModelUnion([anthropic, xd], 'claude-code', () => true);
    expect(out.map((m) => m.id)).toEqual(['claude-opus-4-8', 'codex/gpt-5.5', 'gpt-5.5']);
    expect(out.find((m) => m.id === 'codex/gpt-5.5')?.group).toBe('gpt-budget');
  });

  it('未连接供应商的模型不出现(与选择器同口径)', () => {
    const offline: ProviderView = { ...xd, connected: false };
    const out = visibleModelUnion([anthropic, offline], 'claude-code', () => true);
    expect(out.map((m) => m.id)).toEqual(['claude-opus-4-8']);
  });

  it('isVisible 过滤按 (供应商, 模型) 判定: A 家隐藏、B 家可见的模型仍出现(取 B 家元数据)', () => {
    const out = visibleModelUnion(
      [anthropic, xd],
      'claude-code',
      (pid, m) => !(pid === 'anthropic' && m.id === 'claude-opus-4-8'),
    );
    // anthropic 下被隐藏, 但 xd 下可见 -> 仍在清单里
    expect(out.map((m) => m.id)).toEqual(['claude-opus-4-8', 'codex/gpt-5.5', 'gpt-5.5']);
  });

  it('不支持该 agent 的供应商被跳过', () => {
    const codexOnly: ProviderView = { ...xd, agents: ['codex'] };
    const out = visibleModelUnion([codexOnly], 'claude-code', () => true);
    expect(out).toEqual([]);
  });

  it('非聊天模型不进并集(issue #882 第 3 点,2026-07 review):Orca sub-agent 可用性判定 /' +
    ' Slack /model 卡片 / hook session-runner 共用这一个函数,漏过滤会让非聊天模型被当成可执行模型选中', () => {
    const withNonChat = provider('xd', 'XD', [
      model('gpt-5.5', 'GPT-5.5'),
      { ...model('gpt-image-2', 'GPT Image 2'), mode: 'image_generation' },
    ]);
    const out = visibleModelUnion([withNonChat], 'claude-code', () => true);
    expect(out.map((m) => m.id)).toEqual(['gpt-5.5']);
  });
});
