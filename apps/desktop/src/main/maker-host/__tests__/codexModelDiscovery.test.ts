/**
 * codex-model-discovery mapper 单测 —— 用真实 codex models_cache.json 的字段形状,
 * 验证筛选(visibility/supported_in_api)+ 规范化映射 + capability 字段。
 */
import fsp from 'node:fs/promises';
import type { CodexModelListItem } from '@cindy/maker-core';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// codex-model-discovery 顶层 import electron(readCodexDiscoveredModels 用 app.getPath);
// 本套件只测纯 mapper,但按 main 侧测试惯例显式 mock,避免依赖 Node 下 electron 包的
// 「名导出恰好是 undefined 不炸」这种脆弱行为。
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/xdt-codex-model-discovery-test' } }));
vi.mock('node:fs/promises', () => ({ default: { readFile: vi.fn() } }));

import {
  mapCodexModelsToCatalog,
  mapCodexAppServerModelsToCatalog,
  readCodexDiscoveredModels,
  readCodexDiscoveredModelsForAuthRefresh,
} from '../codex-model-discovery.js';

// 取自本机 ~/.codex/models_cache.json 的真实结构(裁剪到关键字段)。
const SAMPLE = {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', description: 'Frontier model.', visibility: 'list', supported_in_api: true, context_window: 272000, default_reasoning_level: 'medium', priority: 7, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_in_api: true, context_window: 272000, default_reasoning_level: 'medium', priority: 16, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], service_tiers: [] },
    // 未来新模型:应被自动纳入(这正是 live 发现要解决的"下周出 5.6")
    { slug: 'gpt-5.6', display_name: 'GPT-5.6', visibility: 'list', supported_in_api: true, context_window: 400000, default_reasoning_level: 'high', priority: 3, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }] },
    // 隐藏 / 非 api 的内部货:应被过滤
    { slug: 'gpt-5.3-codex-spark', display_name: 'Spark', visibility: 'list', supported_in_api: false, context_window: 128000, supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide', supported_in_api: true, context_window: 272000, supported_reasoning_levels: [{ effort: 'medium' }] },
  ],
};
const OAUTH_AUTH = JSON.stringify({ tokens: { access_token: 'oauth-token' } });

describe('mapCodexModelsToCatalog', () => {
  it('只留 visibility:list && supported_in_api:true,保留规范 slug', () => {
    const out = mapCodexModelsToCatalog(SAMPLE);
    expect(out.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.6']);
    // spark(api:false)与 auto-review(hide)被过滤
    expect(out.find((m) => m.id.includes('spark'))).toBeUndefined();
    expect(out.find((m) => m.id.includes('auto-review'))).toBeUndefined();
  });

  it('未来新模型(gpt-5.6)自动纳入并带正确 capability —— 印证"下周出 5.6 零手改"', () => {
    const m56 = mapCodexModelsToCatalog(SAMPLE).find((m) => m.id === 'gpt-5.6');
    expect(m56).toBeDefined();
    expect(m56).toMatchObject({
      id: 'gpt-5.6',
      name: 'GPT-5.6',
      group: 'gpt',
      contextWindow: 400000,
      efforts: ['low', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'high',
      status: 'active',
      defaultEnabled: true,
    });
    expect(m56!.effortDisplayNames).toEqual({ xhigh: 'Extra High' });
  });

  it('service_tiers 含 priority → supportsFastMode:true;空/缺省不标(数据驱动,不猜)', () => {
    const out = mapCodexModelsToCatalog(SAMPLE);
    expect(out.find((m) => m.id === 'gpt-5.5')?.supportsFastMode).toBe(true);
    expect(out.find((m) => m.id === 'gpt-5.4')?.supportsFastMode).toBeUndefined();
    expect(out.find((m) => m.id === 'gpt-5.6')?.supportsFastMode).toBeUndefined();
  });

  it('display name 保持纯净,保留模型自报的全部合法 effort(含 max/ultra),priority 对齐静态排序锚点', () => {
    const out = mapCodexModelsToCatalog(SAMPLE);
    expect(out.every((m) => !m.name.includes('订阅'))).toBe(true);
    // issue #352:max/ultra 是合法 Codex 档,不再被 CODEX_EFFORTS 白名单过滤掉。
    expect(out.find((m) => m.id === 'gpt-5.6')?.efforts).toEqual(['low', 'high', 'xhigh', 'max', 'ultra']);
    expect(out.find((m) => m.id === 'gpt-5.6')?.sortOrder).toBe(19);
    expect(out.find((m) => m.id === 'gpt-5.5')?.sortOrder).toBe(20);
    expect(out.find((m) => m.id === 'gpt-5.4')?.sortOrder).toBe(21);
  });

  it('只放行 CODEX_EFFORTS 白名单内的档(含 max/ultra),未知 effort id 仍被过滤', () => {
    const out = mapCodexModelsToCatalog({
      models: [
        {
          slug: 'gpt-5.7',
          display_name: 'GPT-5.7',
          visibility: 'list',
          supported_in_api: true,
          context_window: 400000,
          default_reasoning_level: 'high',
          supported_reasoning_levels: [
            { effort: 'high' },
            { effort: 'max' },
            { effort: 'ultra' },
            { effort: 'giga' },
          ],
        },
      ],
    });
    expect(out[0].efforts).toEqual(['high', 'max', 'ultra']);
  });

  it('legacy 默认隐藏策略:gpt-5.4-mini defaultEnabled:false(旧目录可见性不因清单动态化漂移)', () => {
    const out = mapCodexModelsToCatalog({
      models: [
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', supported_in_api: true, context_window: 272000, priority: 23, supported_reasoning_levels: [{ effort: 'high' }] },
      ],
    });
    expect(out[0].defaultEnabled).toBe(false);
  });

  it('坏输入(非对象 / 无 models / 空)→ 空数组,不抛', () => {
    expect(mapCodexModelsToCatalog(null)).toEqual([]);
    expect(mapCodexModelsToCatalog({})).toEqual([]);
    expect(mapCodexModelsToCatalog({ models: 'nope' })).toEqual([]);
    expect(mapCodexModelsToCatalog({ models: [{ slug: 'x', visibility: 'list', supported_in_api: true }] })[0].efforts).toEqual([]);
  });
});

describe('mapCodexAppServerModelsToCatalog', () => {
  it('保留 app-server 顺序、过滤隐藏/重复项并映射 effort 与 fast tier', () => {
    const out = mapCodexAppServerModelsToCatalog([
      {
        id: 'gpt-5.6',
        model: 'gpt-5.6',
        displayName: 'GPT-5.6',
        description: 'Newest',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: '' },
          { reasoningEffort: 'xhigh', description: '' },
        ],
        defaultReasoningEffort: 'xhigh',
        additionalSpeedTiers: [],
        serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
        isDefault: true,
      },
      {
        id: 'hidden', model: 'hidden', displayName: 'Hidden', description: '', hidden: true,
        supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', additionalSpeedTiers: [],
        serviceTiers: [], isDefault: false,
      },
      {
        id: 'duplicate', model: 'gpt-5.6', displayName: 'Duplicate', description: '', hidden: false,
        supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', additionalSpeedTiers: [],
        serviceTiers: [], isDefault: false,
      },
      {
        id: 'gpt-5.4-mini', model: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', description: '', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
        defaultReasoningEffort: 'high', additionalSpeedTiers: [], serviceTiers: [], isDefault: false,
      },
    ] as CodexModelListItem[]);

    expect(out.map((model) => model.id)).toEqual(['gpt-5.6', 'gpt-5.4-mini']);
    expect(out[0]).toMatchObject({
      contextWindow: 272_000,
      efforts: ['low', 'xhigh'],
      defaultEffort: 'xhigh',
      supportsFastMode: true,
      sortOrder: 17,
    });
    expect(out[1].defaultEnabled).toBe(false);
    expect(out[1].sortOrder).toBe(17.003);
    // live 协议不给 context_window,这 272k 是统一兜底 → 一律不得标记为已核实。
    // 标了它就会被拿去收敛运行期上报的窗口,把真实更大的窗口压成 272k。
    expect(out.every((model) => model.contextWindowVerified === undefined)).toBe(true);
  });
});

describe('readCodexDiscoveredModels', () => {
  beforeEach(() => {
    vi.mocked(fsp.readFile).mockReset();
  });

  it('已登录但 XDMaker 自管 cache 不可读时返回 null,让调用方决定保留或清空', async () => {
    vi.mocked(fsp.readFile)
      .mockResolvedValueOnce(OAUTH_AUTH)
      .mockRejectedValueOnce(new Error('missing'));
    await expect(readCodexDiscoveredModels()).resolves.toBeNull();
  });

  it('结构有效的空 cache 返回 [],与读取失败区分', async () => {
    vi.mocked(fsp.readFile)
      .mockResolvedValueOnce(OAUTH_AUTH)
      .mockResolvedValueOnce(JSON.stringify({ models: [] }));
    await expect(readCodexDiscoveredModels()).resolves.toEqual([]);
  });

  it('没有 XDMaker OAuth 时忽略结构有效的旧 cache,不把上一账号模型重新发布', async () => {
    vi.mocked(fsp.readFile)
      .mockRejectedValueOnce(new Error('auth missing'))
      .mockResolvedValueOnce(JSON.stringify(SAMPLE));

    await expect(readCodexDiscoveredModels()).resolves.toEqual([]);
    expect(fsp.readFile).toHaveBeenCalledTimes(1);
  });
});

describe('readCodexDiscoveredModelsForAuthRefresh', () => {
  it('鉴权边界 cache miss / 读取异常都清成空快照,不沿用上一账号模型', async () => {
    await expect(
      readCodexDiscoveredModelsForAuthRefresh(vi.fn().mockResolvedValue(null)),
    ).resolves.toEqual([]);
    await expect(
      readCodexDiscoveredModelsForAuthRefresh(vi.fn().mockRejectedValue(new Error('locked'))),
    ).resolves.toEqual([]);
  });

  it('鉴权边界读到有效快照时原样交给 active-catalog', async () => {
    const discovered = mapCodexModelsToCatalog(SAMPLE);
    await expect(
      readCodexDiscoveredModelsForAuthRefresh(vi.fn().mockResolvedValue(discovered)),
    ).resolves.toBe(discovered);
  });
});
