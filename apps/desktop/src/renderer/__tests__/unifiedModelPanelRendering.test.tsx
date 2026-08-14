// @vitest-environment jsdom

/**
 * 统一模型选择器面板(M3 / M4)的**接线锁**:纯逻辑层算出来的东西必须真的到达像素,
 * 且写操作真的落到 M2 的两个 store。
 *
 * 覆盖:
 *   1. 跨引擎联合列表按分组陈列,行 = (来源, 模型);
 *   2. 行右侧常驻三元组(引擎 + 推理强度)——不是只有出错时才显示;
 *   3. hover 行弹出配置浮层,浮层里的引擎胶囊只列候选引擎;
 *   4. 点引擎胶囊 → 写 modelEnginePrefs override,行三元组当场跟着变;
 *   5. 点 ☆ → 写 modelFavorites 配置副本,收藏区置顶出现;
 *   6. 点行 → 按该行生效配置回调 (provider, model, effort)。
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const table: Record<string, string> = {
        'settings.providers.anthropic.title': 'Anthropic',
        'settings.providers.openai.title': 'OpenAI',
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.noResults': '无匹配模型',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.unified.favoritesGroup': '收藏',
        'newChat.modelSelector.unified.addFavorite': '存为收藏',
        'newChat.modelSelector.unified.removeFavorite': '取消收藏',
        'newChat.modelSelector.unified.recommendedConfig': '推荐配置',
        'newChat.modelSelector.unified.customized': '已自定义',
        'newChat.modelSelector.unified.reset': '恢复推荐',
        'newChat.modelSelector.unified.railAll': '全部',
        'newChat.modelSelector.unified.railSameEngine': `仅 ${options?.agent ?? ''}`,
        'newChat.modelSelector.unified.crossEngineWarning': '切换引擎会重建上下文，可能丢失内容',
        'newChat.modelSelector.category.anthropic': 'Anthropic',
        'newChat.modelSelector.category.gpt': 'OpenAI',
        'effortLevels.low': '低',
        'effortLevels.medium': '中',
        'effortLevels.high': '高',
      };
      return table[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  useAgentCapabilities: () => ({
    capabilities: { hasFastMode: true, effortLevels: [], availableModels: [] },
    loading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useApiKey', () => ({ useApiKey: () => ({ hasSavedKey: true }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));

const providersRef = vi.hoisted(() => ({
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': {} },
      connected: true,
      models: {
        'claude-code': [
          {
            id: 'claude-opus-5',
            name: 'Opus 5',
            group: 'anthropic',
            sortOrder: 1,
            contextWindow: 200000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
      },
    },
    {
      // 合并行夹具:同一逻辑模型在 codex 上是 root 条目、在 cc 上是 `chatgpt/` bridge 壳,
      // 两条 wire id 不同 —— 合并成一行后,行身份是归一化 id `gpt-5.6`。
      id: 'openai',
      name: 'OpenAI',
      source: 'builtin',
      agents: ['claude-code', 'codex'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': {}, codex: {} },
      connected: true,
      models: {
        codex: [
          {
            id: 'gpt-5.6',
            name: 'GPT-5.6',
            group: 'gpt',
            sortOrder: 3,
            contextWindow: 400000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
            description: 'A very long English description that must stay on one line and never blow up the panel layout in narrow windows',
          },
        ],
        'claude-code': [
          {
            id: 'chatgpt/gpt-5.6',
            name: 'GPT-5.6',
            group: 'gpt',
            sortOrder: 3,
            contextWindow: 272000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'low',
          },
        ],
      },
    },
    {
      id: 'xd',
      name: 'Cindy AI',
      source: 'builtin',
      agents: ['claude-code', 'codex'],
      auth: { method: 'api-key' },
      routing: {
        'claude-code': { authStrategy: 'gateway-key' },
        codex: { authStrategy: 'gateway-key' },
      },
      connected: true,
      models: {
        'claude-code': [
          {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            group: 'gpt',
            sortOrder: 2,
            contextWindow: 1000000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
        codex: [
          {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            group: 'gpt',
            sortOrder: 2,
            contextWindow: 272000,
            efforts: ['low', 'high'],
            defaultEffort: 'high',
            // 只有这一条 (来源, 模型, 引擎) 具备 Fast —— 让「Fast 是按条目判定、不是按
            // 模型名」这件事在夹具里就成立(cc 那条同 id 的条目没有,行三元组也不该显示)。
            supportsFastMode: true,
          },
        ],
      },
    },
  ] as unknown[],
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: providersRef.providers, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: () => ({
    providers: [],
    loading: false,
    error: null,
    unsupported: false,
  }),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));
vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));

import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import {
  __resetForTest as resetEnginePrefs,
  getModelEngineOverride,
} from '@/state/modelEnginePrefs';
import {
  __resetForTest as resetFavorites,
  addModelFavorite,
  listModelFavorites,
} from '@/state/modelFavorites';
import { setModelEngineOverride } from '@/state/modelEnginePrefs';
import { PRICE_TIER_COLORS } from '@/themes/effortTierColors';

const onProviderChange = vi.fn();

function renderPanel(
  props: Partial<React.ComponentProps<typeof ModelSelectorContent>> = {},
): void {
  render(
    React.createElement(ModelSelectorContent, {
      modelId: 'claude-opus-5',
      effort: 'medium',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'anthropic',
      onProviderChange,
      unifiedPanel: true,
      ...props,
    }),
  );
}

// 浮层里也会出现同一个模型名,故只在列表内定位行。
function rowFor(name: string): HTMLElement {
  const list = screen.getByRole('listbox');
  return within(list).getByText(name).closest('[data-unified-anchor]') as HTMLElement;
}

beforeEach(() => {
  onProviderChange.mockClear();
  resetEnginePrefs();
  resetFavorites();
});

describe('统一模型选择器面板', () => {
  it('按分组陈列跨引擎联合列表,每行右侧常驻三元组', () => {
    renderPanel();
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Opus 5')).toBeTruthy();
    expect(within(list).getByText('GPT-5.5')).toBeTruthy();

    const opusTriple = rowFor('Opus 5').querySelector('[data-unified-triple]');
    // 三元组恒显示:引擎(推荐 = Claude)+ 推理强度(目录默认 medium)。
    expect(opusTriple?.textContent).toContain('中');
    expect(opusTriple?.getAttribute('title')).toContain('Claude');

    // 网关上的 GPT-5.5 同时在 cc / codex 下:gpt 家族主场 codex,推荐随主场
    // (2026-08-14 改判 —— 此前落 null 走 cc 优先回落,整列显示「底座 Claude」)。
    const gptTriple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
    expect(gptTriple?.getAttribute('title')).toContain('Codex');
  });

  it('hover 行弹出配置浮层,只列该行的候选引擎', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    expect(within(flyout).getByText('GPT-5.5')).toBeTruthy();
    expect(flyout.querySelector('[data-engine-capsule="cc"]')).toBeTruthy();
    expect(flyout.querySelector('[data-engine-capsule="codex"]')).toBeTruthy();
    // Pi 不在候选(目录里没有 pi 条目)→ 不渲染,不做假按钮。
    expect(flyout.querySelector('[data-engine-capsule="pi"]')).toBeNull();
  });

  it('浮层里切引擎 → 写 override,行三元组与档位集合当场跟着变', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    await waitFor(() => {
      const triple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
      expect(triple?.getAttribute('title')).toContain('Claude');
      // cc 那条目录条目的默认档是 medium(codex 那条是 high)—— 能力按引擎现查。
      expect(triple?.textContent).toContain('中');
    });
    // 已自定义 → 底栏出现「恢复推荐」。
    expect(within(await screen.findByTestId('unified-model-config-flyout')).getByText('恢复推荐'))
      .toBeTruthy();
  });

  it('点 ☆ 把当前生效配置存成收藏副本,收藏区置顶出现', async () => {
    renderPanel();
    const star = within(rowFor('Opus 5')).getByRole('button', { name: '存为收藏' });
    await act(async () => {
      fireEvent.click(star);
    });
    expect(listModelFavorites()).toHaveLength(1);
    expect(listModelFavorites()[0]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      agent: 'cc',
      effort: 'medium',
    });
    const groups = screen.getAllByRole('group');
    expect(groups[0].textContent).toContain('收藏');
  });

  it('点行按该行生效配置回调 (provider, model, effort)', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    // 生效引擎按家族主场落 codex,档位取 codex 条目的默认 high。
    expect(onProviderChange).toHaveBeenCalledWith('xd', 'gpt-5.5', 'high');
  });

  it('← 键打开该行的配置浮层(键盘入口)', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.keyDown(rowFor('Opus 5'), { key: 'ArrowLeft' });
    });
    expect(await screen.findByTestId('unified-model-config-flyout')).toBeTruthy();
  });

  it('followSession 行等价渲染并回调', async () => {
    const onFollow = vi.fn();
    renderPanel({ followSession: { active: true, label: '跟随会话', onFollow } });
    const row = screen.getByText('跟随会话').closest('button') as HTMLElement;
    expect(row.getAttribute('aria-selected')).toBe('true');
    await act(async () => {
      fireEvent.click(row);
    });
    expect(onFollow).toHaveBeenCalledTimes(1);
  });
});

describe('统一面板 · 会话内形态', () => {
  const onCrossEngineSelect = vi.fn();
  const sessionEngineFilter = { currentAgent: 'codex' as const, onCrossEngineSelect };

  beforeEach(() => {
    onCrossEngineSelect.mockClear();
  });

  it('默认停在「同引擎」视图:只列当前引擎能跑的模型,且不显示有损警示', () => {
    renderPanel({ sessionEngineFilter, currentProviderId: 'xd', modelId: 'gpt-5.5' });
    const list = screen.getByRole('listbox');
    // GPT-5.5 在 xd 上 cc / codex 都有 → 留在 codex 会话里是无损的。
    expect(within(list).getByText('GPT-5.5')).toBeTruthy();
    // Opus 5 只在 anthropic/cc 上 → 同引擎视图里不出现。
    expect(within(list).queryByText('Opus 5')).toBeNull();
    expect(list.querySelector('[data-cross-engine-warning]')).toBeNull();
    // 行落在**会话引擎**上(pinnedEngine):三元组显示 Codex 而不是推荐的 Claude。
    const triple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
    expect(triple?.getAttribute('title')).toContain('Codex');
  });

  it('显式切到「全部」后出现有损警示,且能看到跨引擎模型', async () => {
    renderPanel({ sessionEngineFilter, currentProviderId: 'xd', modelId: 'gpt-5.5' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    const list = screen.getByRole('listbox');
    expect(list.querySelector('[data-cross-engine-warning]')?.textContent).toContain(
      '切换引擎会重建上下文',
    );
    expect(within(list).getByText('Opus 5')).toBeTruthy();
  });

  it('选中跨引擎行走 onCrossEngineSelect,不走普通 onSelect', async () => {
    renderPanel({ sessionEngineFilter, currentProviderId: 'xd', modelId: 'gpt-5.5' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    await act(async () => {
      fireEvent.click(rowFor('Opus 5'));
    });
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      targetAgent: 'claude-code',
      effort: 'medium',
    });
  });

  it('会话内选中行的引擎胶囊 = 跨引擎切换事务,不预写全局 override', async () => {
    // 2026-08-14:选中行强制按会话引擎显示,只写 override 的话显示纹丝不动(假按钮);
    // 且用户取消切换确认时不该留下任何全局痕迹。
    renderPanel({ sessionEngineFilter, currentProviderId: 'xd', modelId: 'gpt-5.5' });
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      targetAgent: 'claude-code',
      effort: 'medium',
    });
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
  });

  it('同引擎行照常走 onSelect(无损直切)', async () => {
    renderPanel({ sessionEngineFilter, currentProviderId: 'anthropic', modelId: 'claude-opus-5' });
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    expect(onCrossEngineSelect).not.toHaveBeenCalled();
    // codex 那条目录条目的默认档是 high。
    expect(onProviderChange).toHaveBeenCalledWith('xd', 'gpt-5.5', 'high');
  });
});

/**
 * M5 新会话接线的**面板侧契约**:草稿把整行直通接走。撤掉 AgentSelect 之后,「换引擎」
 * 只剩这一条路径 —— 回传的 engine 一旦不是行上显示的那个,用户就会看着 Codex 建出
 * 一个 Claude 会话。
 */
describe('统一面板 · 新会话选中直通', () => {
  const onUnifiedSelect = vi.fn();

  beforeEach(() => {
    onUnifiedSelect.mockClear();
  });

  it('选中直通时不走 onProviderChange,并回传该行生效引擎与 Fast', async () => {
    renderPanel({ onUnifiedSelect });
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onUnifiedSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      // 推荐引擎 = gpt 家族主场 codex;草稿换引擎无损,直接落(档位取 codex 条目默认)。
      engine: 'codex',
      effort: 'high',
      fast: false,
      favoriteUid: null,
    });
  });

  it('草稿选中行的引擎胶囊:override 落库 + 新引擎整份配置立即写回草稿', async () => {
    // 草稿换引擎无损:选中行按草稿引擎强制显示,胶囊点完必须把草稿一起切过去,
    // 否则显示纹丝不动(假按钮)。
    renderPanel({ onUnifiedSelect, currentProviderId: 'xd', modelId: 'gpt-5.5' });
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    expect(onUnifiedSelect).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'xd', modelId: 'gpt-5.5', engine: 'cc', effort: 'medium' }),
    );
  });

  it('引擎 override 生效后,直通回传的是 override 后的引擎(不是推荐)', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'codex');
    renderPanel({ onUnifiedSelect });
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    expect(onUnifiedSelect).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'codex', modelId: 'gpt-5.5', effort: 'high' }),
    );
  });

  it('选中收藏条目按该条副本配置回传,并带上锚点 uid', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
      fast: true,
    });
    renderPanel({ onUnifiedSelect });
    const favoritesGroup = screen.getAllByRole('group')[0];
    const favoriteRow = within(favoritesGroup)
      .getByText('GPT-5.5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(favoriteRow);
    });
    expect(onUnifiedSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      engine: 'codex',
      fast: true,
      favoriteUid: uid,
    });
  });

  it('收藏锚点选中态:命中时只有该收藏行打勾,锚点失效时回落模型行', () => {
    const uid = addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' });
    const { unmount } = render(
      React.createElement(ModelSelectorContent, {
        modelId: 'gpt-5.5',
        effort: 'medium',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'xd',
        onProviderChange,
        unifiedPanel: true,
        selectedFavoriteUid: uid,
      }),
    );
    let selected = screen
      .getByRole('listbox')
      .querySelectorAll('[data-model-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-unified-anchor')).toBe(`fav::${uid}`);
    unmount();

    // 锚点在当前 owner 的收藏里查无此条(删除 / 切账号)→ 不许两头落空。
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'gpt-5.5',
        effort: 'medium',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'xd',
        onProviderChange,
        unifiedPanel: true,
        selectedFavoriteUid: 'fav-does-not-exist',
      }),
    );
    selected = screen.getByRole('listbox').querySelectorAll('[data-model-selected="true"]');
    expect(selected.length).toBeGreaterThan(0);
    expect(
      [...selected].every((el) => el.getAttribute('data-unified-anchor')?.startsWith('model::')),
    ).toBe(true);
  });
});

/**
 * 2026-08-13 沙盒实测回归锁 —— 五个 bug 里与 DOM 契约有关的四个。
 * 每条都写清「原来错在哪」,避免以后有人把这些属性 / 类当装饰删掉。
 */
describe('统一面板 · 实测回归', () => {
  it('浮层子树带 data-radix-popper-content-wrapper —— 外层收起判定认它是自己人', async () => {
    // 原 bug:浮层 portal 到 body 后,MorphPopover 的 document pointerdown 把浮层内的
    // 点击当 outside,点一下深度档整个选择器连浮层一起消失。morph-popover.tsx 的豁免
    // 判据就是这个属性(`target.closest('[data-radix-popper-content-wrapper]')`)。
    renderPanel();
    await act(async () => {
      fireEvent.pointerEnter(rowFor('Opus 5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    const slider = flyout.querySelector('[role="slider"]') as HTMLElement;
    expect(slider).toBeTruthy();
    // 浮层内**任意深处**的节点都要能沿祖先链找到这个标记,外层才不会误判 outside。
    expect(slider.closest('[data-radix-popper-content-wrapper]')).not.toBeNull();
    expect(flyout.closest('[data-radix-popper-content-wrapper]')).not.toBeNull();
  });

  it('在浮层里改深度:值落到调用方,浮层与列表都还在', async () => {
    const onEffortChange = vi.fn();
    renderPanel({ onEffortChange });
    // 选中行(Opus 5)的深度是会话实时状态 → 走 onEffortChange。
    await act(async () => {
      fireEvent.pointerEnter(rowFor('Opus 5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    const slider = flyout.querySelector('[role="slider"]') as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(slider, { key: 'ArrowRight' });
    });
    expect(onEffortChange).toHaveBeenCalledWith('high');
    // 关键回归点:改完档,浮层与列表都不许消失。
    expect(screen.queryByTestId('unified-model-config-flyout')).not.toBeNull();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('「恢复推荐」删掉 override,行与浮层当场回落推荐引擎', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    renderPanel();
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    expect(flyout.querySelector('[data-engine-capsule="cc"]')?.getAttribute('data-engine-active'))
      .toBe('true');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    // 1) override 表真的删了(不是写了一份「等于推荐」的快照)
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    // 2) 浮层内引擎胶囊回到推荐项(家族主场 codex),底栏不再是「已自定义」
    await waitFor(() => {
      const current = screen.getByTestId('unified-model-config-flyout');
      expect(current.querySelector('[data-engine-capsule="codex"]')?.getAttribute('data-engine-active'))
        .toBe('true');
      expect(within(current).queryByText('恢复推荐')).toBeNull();
    });
    // 3) 行内三元组跟着回落
    const triple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
    expect(triple?.getAttribute('title')).toContain('Codex');
  });

  it('浮层贴着面板左外侧,不会飘到远处', async () => {
    renderPanel();
    const panel = document.querySelector('[data-unified-model-panel]') as HTMLElement;
    const row = rowFor('Opus 5');
    // jsdom 不排版,给面板与行喂真实矩形,才能验证定位算的是**面板**而不是行。
    panel.getBoundingClientRect = () =>
      ({ top: 100, bottom: 620, left: 900, right: 1360, width: 460, height: 520 }) as DOMRect;
    row.getBoundingClientRect = () =>
      ({ top: 240, bottom: 280, left: 1100, right: 1340, width: 240, height: 40 }) as DOMRect;
    await act(async () => {
      fireEvent.pointerEnter(row);
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    const wrapper = flyout.closest('[data-unified-flyout-wrapper]') as HTMLElement;
    await waitFor(() => {
      expect(wrapper.style.left).not.toBe('-9999px');
    });
    // 面板左缘 900 − 间隙 4 − 浮层宽 264 = 632;若误用行矩形会得到 832,一眼可辨。
    expect(wrapper.style.left).toBe('632px');
    expect(wrapper.style.top).toBe('228px');
  });

  it('列表带 min-h-0(面板高度受限时能收缩并滚到底)', () => {
    renderPanel();
    expect(screen.getByRole('listbox').className).toContain('min-h-0');
    const panel = document.querySelector('[data-unified-model-panel]') as HTMLElement;
    expect(panel.className).toContain('max-h-[min(560px,calc(100vh-120px))]');
  });

  it('rail 选中格用反色实心块,一眼看得出当前视图', async () => {
    addModelFavorite({ providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc' });
    renderPanel();
    const all = screen.getByRole('button', { name: '全部' });
    expect(all.className).toContain('bg-[var(--accent-cta-bg)]');
    expect(all.className).toContain('text-[var(--accent-pure-cta-fg)]');
  });
});

/**
 * 合并行接入(归一化行身份 + 每引擎 wire id)。锁的是**两个 id 各走各的路**:
 * 交出去 / 写记忆表的一律是 wire id,记住这一行(override / 收藏 / 锚点)的一律是行身份。
 */
describe('统一面板 · 合并行与 wire id', () => {
  it('bridge 壳与 root 条目合并成一行,浮层里两个引擎都在候选里', async () => {
    renderPanel();
    const list = screen.getByRole('listbox');
    // 合并前这里会是两行(GPT-5.6 与 chatgpt/GPT-5.6),合并后只剩一行。
    expect(within(list).getAllByText('GPT-5.6')).toHaveLength(1);
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.6'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    expect(flyout.querySelector('[data-engine-capsule="codex"]')).toBeTruthy();
    expect(flyout.querySelector('[data-engine-capsule="cc"]')).toBeTruthy();
  });

  it('选中合并行交出去的是**该引擎的 wire id**,行身份另放在 rowModelId', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.6'));
    });
    // 推荐引擎 = codex(openai root)→ 发 root 条目的 id。
    expect(onProviderChange).toHaveBeenCalledWith('openai', 'gpt-5.6', 'medium');
  });

  it('切到 cc 后交出去的换成 bridge 壳的 wire id(override 仍按行身份记)', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.6'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    // override 表的 key 是**归一化行身份**,不是任何一条 wire id。
    expect(getModelEngineOverride('openai', 'gpt-5.6')).toBe('cc');
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.6'));
    });
    expect(onProviderChange).toHaveBeenCalledWith('openai', 'chatgpt/gpt-5.6', 'low');
  });

  it('深度记忆按 wire id 读写(不把归一化 id 写进记忆表)', async () => {
    const setEffort = vi.fn();
    const getEffort = vi.fn(() => undefined);
    renderPanel({
      modelMemory: {
        getEffort,
        setEffort,
        getFast: () => undefined,
        setFast: vi.fn(),
      },
    });
    // 非选中行(选中的是 Opus 5)→ 改深度落全局记忆。
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.6'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    const slider = flyout.querySelector('[role="slider"]') as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(slider, { key: 'ArrowRight' });
    });
    expect(setEffort).toHaveBeenCalledWith('codex', 'openai', 'gpt-5.6', 'high');
    // 读侧同样按 wire id,且**只问生效引擎那一面**:codex 生效时问 root 条目的 id。
    expect(getEffort.mock.calls).toContainEqual(['codex', 'openai', 'gpt-5.6']);
    expect(getEffort.mock.calls).not.toContainEqual(['codex', 'openai', 'chatgpt/gpt-5.6']);
  });

  it('override 到 cc 后,记忆读写换成 bridge 壳的 wire id', async () => {
    setModelEngineOverride('openai', 'gpt-5.6', 'cc');
    const getEffort = vi.fn(() => undefined);
    renderPanel({
      modelMemory: { getEffort, setEffort: vi.fn(), getFast: () => undefined, setFast: vi.fn() },
    });
    expect(getEffort.mock.calls).toContainEqual(['claude-code', 'openai', 'chatgpt/gpt-5.6']);
    expect(getEffort.mock.calls).not.toContainEqual(['claude-code', 'openai', 'gpt-5.6']);
  });

  it('长描述单行截断并挂 title,长模型名同理', () => {
    renderPanel();
    const row = rowFor('GPT-5.6');
    const desc = row.querySelector('[title^="A very long English"]') as HTMLElement;
    expect(desc).toBeTruthy();
    expect(desc.className).toContain('truncate');
    const name = within(row).getByText('GPT-5.6');
    expect(name.getAttribute('title')).toBe('GPT-5.6');
    expect(name.className).toContain('truncate');
  });

  it('没有折扣的行不渲染折扣徽标', () => {
    renderPanel();
    expect(rowFor('GPT-5.6').querySelector('[data-discount-badge]')).toBeNull();
  });

  it('服务端默认种子提到顶部「默认」小节并带标识', () => {
    renderPanel();
    const groups = screen.getAllByRole('group');
    // 夹具里没有 newSessionDefault 标记 → 不该凭空造出默认小节。
    expect(groups.every((group) => group.getAttribute('aria-label') !== '默认')).toBe(true);
    expect(document.querySelector('[data-default-badge]')).toBeNull();
  });
});

/** 行内折扣徽标是纯展示契约:只在调用方给了已本地化文案时渲染,不自己算折扣。 */
describe('统一面板 · 行内折扣徽标', () => {
  it('给了文案才渲染,没给就一个节点都不多', async () => {
    const { UnifiedModelRow } = await import('@/components/new-chat/UnifiedModelRow');
    const entry = {
      providerId: 'xd',
      modelId: 'gpt-5.5',
      displayName: 'GPT-5.5',
      sourceConnected: true,
      candidates: ['codex' as const],
      recommended: 'codex' as const,
      nativeAgent: 'codex' as const,
      capabilities: {
        codex: {
          agent: 'codex' as const,
          wireModelId: 'gpt-5.5',
          efforts: ['low', 'high'] as const,
          defaultEffort: 'high' as const,
          defaultEffortSource: 'catalog' as const,
          supportsFastMode: false,
          contextWindow: 272000,
          contextWindowVerified: false,
        },
      },
    };
    const config = {
      engine: 'codex' as const,
      agent: 'codex' as const,
      efforts: ['low', 'high'] as const,
      effort: 'high' as const,
      fast: false,
      fastCapable: false,
      customized: false,
      capability: entry.capabilities.codex,
      wireModelId: 'gpt-5.5',
    };
    const common = {
      entry,
      anchor: { kind: 'model' as const, providerId: 'xd', modelId: 'gpt-5.5' },
      config,
      selected: false,
      active: false,
      isFavoriteRow: false,
      emphasizeTriple: false,
      justFavorited: false,
      interactionDisabled: false,
      effortLabelOf: (_agent: 'claude-code' | 'codex' | 'pi', effort: string) => effort,
      providers: [],
      onReveal: vi.fn(),
      onRevealForKeyboard: vi.fn(),
      onLeave: vi.fn(),
      onBlurAway: vi.fn(),
      onSelect: vi.fn(),
      onStar: vi.fn(),
    };
    // 设计稿 v4 定稿(F):折扣行 = $ 串亮段填充(亮段宽度 = 折后价比例)+ ↓X% 小字。
    const withBadge = render(
      React.createElement(UnifiedModelRow, {
        ...common,
        priceDisplay: {
          kind: 'tier' as const,
          tier: 2 as const,
          paidPct: 40,
          discountPct: 60,
          title: '立省 60%',
        },
      }),
    );
    const badge = withBadge.container.querySelector('[data-discount-badge]') as HTMLElement;
    expect(badge?.textContent).toBe('↓60%');
    const tierNode = withBadge.container.querySelector('[data-price-tier]') as HTMLElement;
    expect(tierNode.getAttribute('title')).toBe('立省 60%');
    // 整格点亮(Chris 2026-08-14 第二版):$$ 实付 40% → round(0.8)=1 格亮 → 裁掉右侧 50%。
    expect(tierNode.innerHTML).toContain('inset(0 50% 0 0)');
    withBadge.unmount();

    // 颜色只由点亮格数决定:亮 1 格绿 / 2 格黄 / 3 格红,与模型档位无关。
    // jsdom 把 hex 序列化成 rgb —— 按常量换算后断言,不写死魔法数字。
    const hexToRgb = (hex: string) =>
      `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    // $$$ 六折(实付 60%)→ round(1.8)=2 格亮 → 黄(t2),裁掉右侧 1/3。
    const solLike = render(
      React.createElement(UnifiedModelRow, {
        ...common,
        priceDisplay: {
          kind: 'tier' as const,
          tier: 3 as const,
          paidPct: 60,
          discountPct: 40,
          title: '立省 40%',
        },
      }),
    );
    const solNode = solLike.container.querySelector('[data-price-tier]') as HTMLElement;
    expect(solNode.innerHTML).toContain(hexToRgb(PRICE_TIER_COLORS.t2));
    expect(solNode.innerHTML).not.toContain(hexToRgb(PRICE_TIER_COLORS.t3));
    solLike.unmount();

    // $$$ 一折(实付 10%)→ 至少 1 格亮 → 绿(t1)。
    const deepDiscount = render(
      React.createElement(UnifiedModelRow, {
        ...common,
        priceDisplay: {
          kind: 'tier' as const,
          tier: 3 as const,
          paidPct: 10,
          discountPct: 90,
          title: '立省 90%',
        },
      }),
    );
    const deepNode = deepDiscount.container.querySelector('[data-price-tier]') as HTMLElement;
    expect(deepNode.textContent).toContain('$$$');
    expect(deepNode.innerHTML).toContain(hexToRgb(PRICE_TIER_COLORS.t1));
    expect(deepNode.innerHTML).not.toContain(hexToRgb(PRICE_TIER_COLORS.t3));
    deepDiscount.unmount();

    // 无折扣付费行:$ 串按档位色渲染,无 ↓ 徽标。
    const plain = render(
      React.createElement(UnifiedModelRow, {
        ...common,
        priceDisplay: { kind: 'tier' as const, tier: 3 as const },
      }),
    );
    expect(plain.container.querySelector('[data-discount-badge]')).toBeNull();
    expect(plain.container.querySelector('[data-price-tier]')?.textContent).toBe('$$$');
    plain.unmount();

    // 限时免费:淡染小徽标。
    const free = render(
      React.createElement(UnifiedModelRow, {
        ...common,
        priceDisplay: { kind: 'free' as const },
      }),
    );
    expect(free.container.querySelector('[data-price-free]')).not.toBeNull();
    free.unmount();

    // 不传 = 无报价,不渲染任何价格节点。
    const without = render(React.createElement(UnifiedModelRow, common));
    expect(without.container.querySelector('[data-discount-badge]')).toBeNull();
    expect(without.container.querySelector('[data-price-tier]')).toBeNull();
    expect(without.container.querySelector('[data-price-free]')).toBeNull();
  });
});
