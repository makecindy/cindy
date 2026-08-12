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

    // 网关上的 GPT-5.5 同时在 cc / codex 下:推荐引擎按条目判定落 Claude(非折扣路由)。
    const gptTriple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
    expect(gptTriple?.getAttribute('title')).toContain('Claude');
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
      fireEvent.click(flyout.querySelector('[data-engine-capsule="codex"]') as HTMLElement);
    });
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('codex');
    await waitFor(() => {
      const triple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
      expect(triple?.getAttribute('title')).toContain('Codex');
      // codex 那条目录条目的默认档是 high(cc 那条是 medium)—— 能力按引擎现查。
      expect(triple?.textContent).toContain('高');
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
    expect(onProviderChange).toHaveBeenCalledWith('xd', 'gpt-5.5', 'medium');
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
      effort: 'medium',
      // 推荐引擎(该条目的生效来源主 root)= cc;草稿换引擎无损,直接落。
      engine: 'cc',
      fast: false,
      favoriteUid: null,
    });
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
