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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const table: Record<string, string> = {
        'settings.providers.anthropic.title': 'Anthropic',
        'settings.providers.openai.title': 'OpenAI',
        'settings.providers.xd.title': 'Cindy AI',
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
        'newChat.modelSelector.unified.layoutBadge': '尝试样式B',
        'newChat.modelSelector.unified.layoutClassic': '切回样式A',
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
): ReturnType<typeof render> {
  return render(
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
  const sessionEngineFilter = {
    currentAgent: 'codex' as const,
    runtimeAgent: 'codex' as const,
    onCrossEngineSelect,
  };

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

  /**
   * Chris 2026-08-23:同引擎视图列出所有候选含当前引擎的模型,并钉在轨上点选。
   * xd 的 GPT-5.5 主场在 codex,仍出现在兼容段(Opus 之后);在 Claude 轨里点它走无损直切。
   */
  it('同引擎视图把兼容行排在优先行后面,点下去留在当前轨', async () => {
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'claude-code' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Opus 5')).toBeTruthy();
    expect(within(list).getByText('GPT-5.5')).toBeTruthy();
    const ids = within(list)
      .getAllByRole('option')
      .map((row) => row.textContent);
    expect(ids.findIndex((text) => text?.includes('Opus 5'))).toBeLessThan(
      ids.findIndex((text) => text?.includes('GPT-5.5')),
    );
    const triple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
    expect(triple?.getAttribute('title')).toContain('Claude');
    const sizer = document.querySelector('[data-width-sizer]');
    const sizerGpt = Array.from(sizer?.querySelectorAll('[data-unified-anchor]') ?? []).find(
      (node) => node.textContent?.includes('GPT-5.5'),
    );
    expect(sizerGpt?.querySelector('[data-unified-triple]')?.getAttribute('title')).toContain(
      'Codex',
    );
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    expect(onCrossEngineSelect).not.toHaveBeenCalled();
    expect(onProviderChange).toHaveBeenCalledWith('xd', 'gpt-5.5', 'medium');
  });

  it('同引擎轨未选中兼容行:浮层显式换引擎后 override 不被钉轨盖掉,再点行走跨引擎确认', async () => {
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'claude-code' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="codex"]') as HTMLElement);
    });
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('codex');
    expect(onCrossEngineSelect).not.toHaveBeenCalled();
    const triple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
    expect(triple?.getAttribute('title')).toContain('Codex');
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'xd',
        modelId: 'gpt-5.5',
        targetAgent: 'codex',
      }),
    );
  });

  it('同引擎轨选中行:全局 override 指向别的引擎时仍显示并点选 live 引擎', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'codex');
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'claude-code' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
    });
    const triple = rowFor('GPT-5.5').querySelector('[data-unified-triple]');
    expect(triple?.getAttribute('title')).toContain('Claude');
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    // 选中行再点是同引擎重选,绝不能被 leftover override 误判成跨引擎。
    expect(onCrossEngineSelect).not.toHaveBeenCalled();
  });

  /**
   * Chris 2026-08-19 实测「一次打开内切 rail,面板弹开一些,感觉有点怪」:面板是 `w-max`
   * 且 morph 宿主 stickyWidth 只进不退,默认停在**最窄**的同引擎视图,切「全部」时二次撑宽。
   * 定宽 sizer = 打开第一帧就渲染一份不可见的全量视图供量宽。
   */
  it('非全量视图挂一份不可见的定宽 sizer(全量视图不挂)', async () => {
    const { container } = renderPanel({
      sessionEngineFilter,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
    });
    const sizer = container.querySelector('[data-width-sizer]');
    expect(sizer).toBeTruthy();
    // 量的是**全量视图**:同引擎视图里看不到的 Opus 5 也在 sizer 里。
    expect(sizer?.textContent).toContain('Opus 5');
    expect(sizer?.textContent).toContain('GPT-5.5');
    // 不可见、零高度、不进 listbox、不带选中标记(自动对齐永远不会挑中它)。
    expect(sizer?.getAttribute('aria-hidden')).toBe('true');
    expect(sizer?.className).toContain('invisible');
    expect(sizer?.className).toContain('h-0');
    // ★ 纵向 padding 一点不能带(2026-08-19 预审 P1-2):border-box 下 h-0 只钳内容盒,
    // p-2/pb-3 会让 sizer 实占 20px,把「切视图宽度抖」换成「切视图高度抖」。
    expect(sizer?.className).toContain('px-2');
    expect(sizer?.className).not.toContain('p-2 ');
    expect(sizer?.className).not.toContain('pb-3');
    expect(sizer?.className).not.toContain('py-');
    expect(screen.getByRole('listbox').contains(sizer)).toBe(false);
    expect(sizer?.querySelector('[data-model-selected="true"]')).toBeNull();

    // 已经是全量视图 → 不必再量自己一遍。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    expect(container.querySelector('[data-width-sizer]')).toBeNull();
  });

  it('跨引擎警示行不参与撑宽(w-0 min-w-full)', async () => {
    renderPanel({ sessionEngineFilter, currentProviderId: 'xd', modelId: 'gpt-5.5' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    const warning = screen
      .getByRole('listbox')
      .querySelector('[data-cross-engine-warning]') as HTMLElement;
    // truncate 只管画的时候截断;max-content 布局算的是全文宽度,不压住它整行文案会成为
    // 面板里最宽的内容(Chris 2026-08-19「切到全部又弹开一截」)。
    expect(warning.className).toContain('w-0');
    expect(warning.className).toContain('min-w-full');
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
      // 行上显示的目标 Fast 显式随事务交出(2026-08-17 review;该条目无 Fast 能力 → false)。
      fast: false,
      // 选的是普通模型行 → 锚点为 null(会话侧据此把上一条收藏锚点清掉)。
      favoriteUid: null,
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
      // 浮层展示的目标配置里的 Fast(cc 那条无 Fast 能力 → false)。
      fast: false,
      // 改的是**模型行**的引擎,与收藏无关 → 显式清锚点(2026-08-17 review K3:三类调用点
      // 的传值语义各不相同,一律显式给,不靠调用方的缺省)。
      favoriteUid: null,
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

  it('挂着待切换意图时点回真实引擎行:走 onCrossEngineSelect 清意图,不走普通 onSelect', async () => {
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'pi',
        runtimeAgent: 'claude-code',
        onCrossEngineSelect,
      },
      vendorKey: 'cc',
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    await act(async () => {
      fireEvent.click(rowFor('Opus 5'));
    });
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        targetAgent: 'claude-code',
      }),
    );
  });

  it('真实引擎未知且挂着意图:点意图目标行仍走确认事务,不走普通 onSelect', async () => {
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      vendorKey: 'cc',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
    });
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'xd',
        modelId: 'gpt-5.5',
        targetAgent: 'codex',
      }),
    );
  });

  it('真实引擎未知且挂着意图:点另一引擎的模型行同样走确认事务', async () => {
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      vendorKey: 'cc',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    await act(async () => {
      fireEvent.click(rowFor('Opus 5'));
    });
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        targetAgent: 'claude-code',
      }),
    );
  });

  it('真实引擎未知且挂着意图:点意图目标收藏仍走确认事务', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'high',
    });
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      vendorKey: 'cc',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'high',
    });
    const favoriteRow = within(screen.getAllByRole('group')[0])
      .getByText('GPT-5.5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(favoriteRow);
    });
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'xd',
        targetAgent: 'codex',
        favoriteUid: uid,
      }),
    );
  });

  it('真实引擎未知且挂着意图:点引擎胶囊仍走切换事务,不直接 return', async () => {
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      vendorKey: 'cc',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
    });
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'xd',
        targetAgent: 'claude-code',
        favoriteUid: null,
      }),
    );
  });

  it('挂着待切换意图时点回真实引擎胶囊:仍走切换事务,不直接 return', async () => {
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex',
        runtimeAgent: 'claude-code',
        onCrossEngineSelect,
      },
      vendorKey: 'cc',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
    });
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'xd',
        targetAgent: 'claude-code',
        favoriteUid: null,
      }),
    );
  });

  /**
   * 引擎口径分裂 = 跨引擎**待切换意图期**(2026-08-17 review):ChatInput 在意图登记后把
   * `currentAgent` 换成意图目标,而 vendorKey(→ liveAgentKind)仍是旧引擎。面板的
   * live / keep / pinned 必须统一采用 sessionAgent —— 混用会把意图中的目标模型画成旧
   * 引擎:三元组显示旧引擎、浮层摆出旧引擎的档位集合(cc 有 medium),而意图期的深度 /
   * Fast 回调按**目标**引擎(codex 无 medium)校验,用户点的档位被静默回落。
   */
  it('sessionAgent 与 liveAgentKind 分裂(意图期)时以 sessionAgent 为准解析选中行与浮层', async () => {
    const onEffortChange = vi.fn();
    renderPanel({
      sessionEngineFilter,
      // 旧引擎身份:vendorKey 在真切换落地前仍是 cc → liveAgentKind='claude-code'。
      vendorKey: 'cc',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange,
    });
    // 选中行在(keepModel 按目标引擎命中)且三元组按目标引擎(Codex)显示。
    const row = rowFor('GPT-5.5');
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(row.querySelector('[data-unified-triple]')?.getAttribute('title')).toContain('Codex');
    // 浮层档位集合是 codex 那格(low/high):low 右移一格直接到 high,不经过 cc 才有的
    // medium;live 回调收到的就是目标引擎真实支持的档。
    await act(async () => {
      fireEvent.pointerEnter(row);
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    expect(onEffortChange).toHaveBeenCalledWith('high');
  });
});

/**
 * 「恢复推荐」作用在 **live 选中行**上(2026-08-17 review):会话的实时深度 / Fast 与草稿的
 * vendor 配置都**不读记忆表**,只清记忆等于只改了浮层的样子 —— 用户点完仍在用旧引擎 / 旧档
 * 跑,UI 却已经显示成推荐态。这一组锁的就是「真的应用出去」。
 */
describe('统一面板 · 恢复推荐应用到 live 配置', () => {
  async function openFlyoutFor(name: string): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.pointerEnter(rowFor(name));
    });
    return await screen.findByTestId('unified-model-config-flyout');
  }

  it('草稿 live 选中行:清 override 之外,深度 / Fast 走实时回调真的落下去', async () => {
    // 行落在 codex(= 草稿当前引擎,推荐引擎也是 codex),live 深度 low、Fast 开着。
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      vendorKey: 'codex',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange,
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    // codex 那条目录条目的默认档是 high;推荐态恒无 Fast。
    expect(onEffortChange).toHaveBeenCalledWith('high');
    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });

  it('会话内同引擎:同样走实时回调,不走跨引擎事务', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onCrossEngineSelect = vi.fn();
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange,
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(onCrossEngineSelect).not.toHaveBeenCalled();
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    expect(onEffortChange).toHaveBeenCalledWith('high');
    expect(onFastModeChange).toHaveBeenCalledWith(false);
  });

  it('会话内跨引擎:走既有切换事务(带推荐引擎的 wire id 与推荐档)', async () => {
    // 会话在 cc 上跑 xd 的 GPT-5.5,而该行的推荐引擎是 codex → 恢复推荐 = 一次跨引擎切换。
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onCrossEngineSelect = vi.fn(() => true);
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'claude-code' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(),
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      targetAgent: 'codex',
      effort: 'high',
      // 推荐态显式关 Fast:留给事务重解析会读回目标记忆里残留的开(2026-08-17 review)。
      fast: false,
      // 恢复推荐 = 不再跟着任何收藏副本跑 → 清锚点。
      favoriteUid: null,
    });
    // 事务成功 → override 收掉(行回到跟随推荐)。
    await waitFor(() => {
      expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    });
  });

  it('会话内跨引擎被取消:override 不落地,不留半套状态', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onCrossEngineSelect = vi.fn(() => false);
    const onFastModeChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'claude-code' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(),
      onFastModeChange,
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(onCrossEngineSelect).toHaveBeenCalledTimes(1);
    // 取消 = 什么都没应用:override 仍在,live 的 Fast 也没被顺手关掉。
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
    expect(onFastModeChange).not.toHaveBeenCalled();
  });

  it('非 live 行不动实时状态(只清记忆,回归保护)', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    // 选中的是 Opus 5,GPT-5.5 那一行不是 live 行。
    renderPanel({
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
      onEffortChange,
      onFastModeChange,
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
  });
});

/**
 * 删除**当前选中的**收藏(2026-08-17 review):收藏是一份配置副本,选中它 = 草稿 / 会话
 * 正按那份副本(自定义引擎 / 深度 / Fast)在跑。只删记录的话,视觉上选中态回落到模型行,
 * 正在跑的那一份配置却纹丝不动 —— 与「恢复推荐只清记忆」是同一个病。
 * 这一组锁的是「先把该模型的默认配置真的应用出去,再删记录」,以及跨引擎被拒时收藏不丢。
 */
describe('统一面板 · 删除选中的收藏回落到模型默认', () => {
  /** 收藏区恒置顶(buildUnifiedListSections),第一个 group 就是它。 */
  function favoriteStar(): HTMLElement {
    return within(screen.getAllByRole('group')[0]).getByRole('button', { name: '取消收藏' });
  }

  it('删的不是当前选中锚点:行为不变,只删记录', async () => {
    addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'cc', effort: 'low' });
    const onUnifiedSelect = vi.fn();
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    // 选中的是 Opus 5,那条收藏不是当前锚点 → 删它不影响「正在跑什么」。
    renderPanel({
      onUnifiedSelect,
      onEffortChange,
      onFastModeChange,
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    expect(listModelFavorites()).toHaveLength(0);
    expect(onUnifiedSelect).not.toHaveBeenCalled();
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
  });

  it('草稿选中的收藏:默认配置经既有选中链路写回草稿(favoriteUid 置空),记录同时删除', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'cc',
      effort: 'low',
    });
    const onUnifiedSelect = vi.fn();
    renderPanel({
      onUnifiedSelect,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'cc',
      // 选中的收藏 = 草稿正在跑它的副本:live 深度/Fast 必须与**解析后的副本**一致。
      // cc 那条没有 Fast 能力,副本 Fast 恒为关 —— 不能拿收藏条目里的 fast:true 去对。
      effort: 'low',
      fastMode: false,
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    // 默认 = 推荐引擎(gpt 家族主场 codex)+ 目录默认档 high + 无 Fast;锚点必须一起清掉,
    // 否则草稿还指着一个已经不存在的 uid。
    expect(onUnifiedSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      engine: 'codex',
      effort: 'high',
      fast: false,
      favoriteUid: null,
    });
    expect(listModelFavorites()).toHaveLength(0);
  });

  it('选中收藏后 live 配置已改:删收藏只删记录,不把后来的选择覆盖成旧收藏默认', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'high',
      fast: true,
    });
    const onUnifiedSelect = vi.fn();
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      onUnifiedSelect,
      onEffortChange,
      onFastModeChange,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      // 正在跑的是 Claude + low,和这条 Codex 收藏对不上。
      vendorKey: 'cc',
      effort: 'low',
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    expect(listModelFavorites()).toHaveLength(0);
    expect(onUnifiedSelect).not.toHaveBeenCalled();
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
  });

  it('选中收藏后只改了思维档:删收藏只删记录,不覆盖当前思维', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onUnifiedSelect = vi.fn();
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      onUnifiedSelect,
      onEffortChange,
      onFastModeChange,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      // composer / 其它入口把思维改到 high,uid 还在。
      effort: 'high',
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    expect(listModelFavorites()).toHaveLength(0);
    expect(onUnifiedSelect).not.toHaveBeenCalled();
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
  });

  it('选中收藏后只改了 Fast:删收藏只删记录,不覆盖当前 Fast', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onUnifiedSelect = vi.fn();
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      onUnifiedSelect,
      onEffortChange,
      onFastModeChange,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      effort: 'low',
      fastMode: true,
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    expect(listModelFavorites()).toHaveLength(0);
    expect(onUnifiedSelect).not.toHaveBeenCalled();
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
  });

  it('挂着待切换意图时删除回落到真实引擎的收藏:走切换事务清意图', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'cc',
      effort: 'medium',
    });
    const onCrossEngineSelect = vi.fn(() => true);
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      effort: 'medium',
      onEffortChange,
      onFastModeChange,
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    // 默认回落 gpt 家族主场 Codex = 正在跑的引擎,但面板正挂着切到 Claude 的意图:
    // 必须走 same-engine 切换事务清意图,不能只复位深度 / Fast。
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      targetAgent: 'codex',
      effort: 'high',
      fast: false,
      favoriteUid: null,
    });
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(listModelFavorites()).toHaveLength(0);
    });
  });

  it('真实引擎未知时删除选中收藏:走切换事务,不走同引擎 live 回落', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
      fast: true,
    });
    const onCrossEngineSelect = vi.fn(() => true);
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange,
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'xd',
        targetAgent: 'codex',
        favoriteUid: null,
      }),
    );
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(listModelFavorites()).toHaveLength(0);
    });
  });

  it('会话内同引擎:深度 / Fast 经实时回调复位,记录同时删除', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
      fast: true,
    });
    const onCrossEngineSelect = vi.fn();
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange,
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    // 默认引擎(codex)== 会话引擎 → 无损,不该弹跨引擎确认。
    expect(onCrossEngineSelect).not.toHaveBeenCalled();
    expect(onEffortChange).toHaveBeenCalledWith('high');
    expect(onFastModeChange).toHaveBeenCalledWith(false);
    expect(listModelFavorites()).toHaveLength(0);
  });

  it('会话内跨引擎:走既有切换事务,事务真成功才删收藏', async () => {
    const uid = addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'cc' });
    const onCrossEngineSelect = vi.fn(() => true);
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'claude-code' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      onEffortChange: vi.fn(),
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    // gpt 家族主场 codex ≠ 会话的 claude-code → 回落默认 = 一次跨引擎切换。
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      targetAgent: 'codex',
      effort: 'high',
      // 回落默认配置 = 显式无 Fast(与恢复推荐同族)。
      fast: false,
      // 这条收藏马上就没了 → 清锚点(留着会让面板在一条已删的收藏上打勾)。
      favoriteUid: null,
    });
    await waitFor(() => {
      expect(listModelFavorites()).toHaveLength(0);
    });
  });

  it('会话内跨引擎被拒:收藏原样保留,配置一点不动', async () => {
    const uid = addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'cc' });
    const onCrossEngineSelect = vi.fn(() => false);
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'claude-code' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      onEffortChange,
      onFastModeChange,
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    expect(onCrossEngineSelect).toHaveBeenCalledTimes(1);
    // 取消 / 失败 = 一点都没应用:收藏是用户手存的东西,不可逆,绝不能先删再切。
    expect(listModelFavorites()).toHaveLength(1);
    expect(listModelFavorites()[0]?.uid).toBe(uid);
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onFastModeChange).not.toHaveBeenCalled();
  });
});

/**
 * 「先实时写入成功,后清存储」(2026-08-17 review 第三轮 G2)。恢复推荐 / 删选中收藏的
 * **同引擎**路径此前是先同步清存储、再 fire-and-forget 甩出两个 live 回调:远程 setEffort /
 * setFastMode 或本地持久化一失败,override / 记忆 / 收藏已经没了且不回滚 —— 面板显示推荐态,
 * 任务还在旧配置上跑。跨引擎那条早就是「事务真成功才收尾」,这一组把同引擎路径拉齐。
 */
describe('统一面板 · 同引擎实时写入成功才清存储', () => {
  async function openFlyoutFor(name: string): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.pointerEnter(rowFor(name));
    });
    return await screen.findByTestId('unified-model-config-flyout');
  }
  function favoriteStar(): HTMLElement {
    return within(screen.getAllByRole('group')[0]).getByRole('button', { name: '取消收藏' });
  }

  it('恢复推荐:深度写入失败 → override 保留,Fast 也不顺手关掉', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onEffortChange = vi.fn(() => false);
    const onFastModeChange = vi.fn();
    renderPanel({
      vendorKey: 'codex',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange,
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(onEffortChange).toHaveBeenCalledWith('high');
    // 深度没写成 → 整件事放弃:不该留下用户从没选过的「旧档 + 无 Fast」。
    expect(onFastModeChange).not.toHaveBeenCalled();
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
  });

  it('恢复推荐:Fast 写入失败 → override 同样保留', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onFastModeChange = vi.fn(async () => false);
    renderPanel({
      vendorKey: 'codex',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange: vi.fn(),
      onFastModeChange,
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(onFastModeChange).toHaveBeenCalledWith(false);
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
  });

  it('恢复推荐:两笔都成功才清 override(成功路径回归)', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    renderPanel({
      vendorKey: 'codex',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange: vi.fn(async () => true),
      onFastModeChange: vi.fn(async () => true),
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    await waitFor(() => {
      expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    });
  });

  it('删除选中收藏(会话同引擎):实时写入失败 → 收藏原样保留', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
      fast: true,
    });
    const onEffortChange = vi.fn(() => false);
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange: vi.fn(),
    });
    await act(async () => {
      fireEvent.click(favoriteStar());
    });
    expect(onEffortChange).toHaveBeenCalledWith('high');
    // 收藏是用户手存的东西,不可逆:回落配置没落成就绝不能把记录删了。
    expect(listModelFavorites()).toHaveLength(1);
    expect(listModelFavorites()[0]?.uid).toBe(uid);
  });
});

/**
 * 两笔实时写入的**原子性**(2026-08-17 review 第五轮 M1)。恢复推荐 / 删选中收藏的同引擎路径
 * 要连写深度与 Fast:此前第二笔失败只是返回 false 走「不清存储」,可第一笔已经落到正在跑的
 * 那一份上 —— 任务当场变成「推荐深度 + 旧 Fast」这个用户从没选过的组合,与保留下来的
 * override / 收藏再度分离。现在第二笔失败要把第一笔按进入前的实时值写回去。
 */
describe('统一面板 · 两笔实时写入要么都落要么回滚', () => {
  async function openFlyoutFor(name: string): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.pointerEnter(rowFor(name));
    });
    return await screen.findByTestId('unified-model-config-flyout');
  }

  it('恢复推荐:Fast 写入失败 → 已落下的深度被写回原值,存储照旧不清', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn(async () => false);
    renderPanel({
      vendorKey: 'codex',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange,
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    // 第一笔写推荐档 high,第二笔关 Fast 失败 → 第一笔按进入前的实时深度 low 回滚。
    expect(onEffortChange.mock.calls).toEqual([['high'], ['low']]);
    expect(onFastModeChange).toHaveBeenCalledWith(false);
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
  });

  it('回滚本身也失败:两侧都脏,但存储仍然不清(行为明确,用户重试整段)', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    let effortCalls = 0;
    const onEffortChange = vi.fn(() => {
      effortCalls += 1;
      // 第一笔成功、回滚那一笔失败(隧道断了 / 本地持久化失败)。
      return effortCalls === 1 ? undefined : false;
    });
    renderPanel({
      vendorKey: 'codex',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange: vi.fn(() => false),
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(onEffortChange.mock.calls).toEqual([['high'], ['low']]);
    // 回滚失败不改变结论:这次「恢复推荐」没成功,override / 记忆一律原样留着。
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBe('cc');
  });

  it('两笔都成功不触发回滚(成功路径回归)', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const onEffortChange = vi.fn(async () => true);
    renderPanel({
      vendorKey: 'codex',
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange: vi.fn(async () => true),
    });
    const flyout = await openFlyoutFor('GPT-5.5');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    await waitFor(() => {
      expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    });
    expect(onEffortChange.mock.calls).toEqual([['high']]);
  });
});

/**
 * 在**同模型的普通模型行**上改实时配置要清掉收藏锚点(2026-08-17 review 第五轮 M2)。
 * isLiveRow 只比 (来源, 模型, 引擎),选中一条收藏时同模型的模型行同样判成 live 行:用户在
 * 那一行的浮层里改深度 / Fast,写的是正在跑的那一份,而锚点校验不看深度 / Fast —— 收藏行
 * 继续打勾、配置却已经不是它了,之后删这条收藏还会被误判成「删的是正在用的那一份」。
 */
describe('统一面板 · 改模型行的实时配置后收藏不再选中', () => {
  /** 同一个模型同时有收藏行与模型行时,`rowFor` 会撞两条 —— 这里只取非收藏区的那一条。 */
  function modelRowFor(name: string): HTMLElement {
    for (const group of screen.getAllByRole('group').slice(1)) {
      const hit = within(group).queryByText(name);
      if (hit) return hit.closest('[data-unified-anchor]') as HTMLElement;
    }
    throw new Error(`model row not found: ${name}`);
  }
  async function openModelRowFlyout(name: string): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.pointerEnter(modelRowFor(name));
    });
    return await screen.findByTestId('unified-model-config-flyout');
  }

  it('草稿:改模型行深度 → 经既有直通链路把 favoriteUid 置空(面板不收起)', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onUnifiedSelect = vi.fn();
    const onEffortChange = vi.fn();
    renderPanel({
      onUnifiedSelect,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      effort: 'low',
      onEffortChange,
    });
    const flyout = await openModelRowFlyout('GPT-5.5');
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    expect(onEffortChange).toHaveBeenCalledWith('high');
    await waitFor(() => {
      expect(onUnifiedSelect).toHaveBeenCalledWith({
        providerId: 'xd',
        modelId: 'gpt-5.5',
        effort: 'high',
        engine: 'codex',
        fast: false,
        favoriteUid: null,
      });
    });
    // 这不是一次行选择:收藏本身一个字不动,浮层与列表都还在。
    expect(listModelFavorites()[0]?.effort).toBe('low');
    expect(screen.queryByTestId('unified-model-config-flyout')).not.toBeNull();
  });

  it('会话:改模型行 Fast → 回传空锚点', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onFastModeChange = vi.fn();
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(),
      onFastModeChange,
      onSessionFavoriteAnchorChange,
    });
    const flyout = await openModelRowFlyout('GPT-5.5');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-fast-toggle]') as HTMLElement);
    });
    expect(onFastModeChange).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(onSessionFavoriteAnchorChange).toHaveBeenCalledWith(null);
    });
    expect(listModelFavorites()[0]?.fast).toBeUndefined();
  });

  it('实时写入失败 → 锚点原样保留(没改成配置就没有分家)', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(() => false),
      onSessionFavoriteAnchorChange,
    });
    const flyout = await openModelRowFlyout('GPT-5.5');
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    expect(onSessionFavoriteAnchorChange).not.toHaveBeenCalled();
  });

  it('收藏行自己的编辑不清锚(回归保护:那是「编辑选中的这一条」)', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(),
      onSessionFavoriteAnchorChange,
    });
    const favoriteRow = within(screen.getAllByRole('group')[0])
      .getByText('GPT-5.5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(favoriteRow);
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    await waitFor(() => {
      expect(listModelFavorites()[0]?.effort).toBe('high');
    });
    expect(onSessionFavoriteAnchorChange).not.toHaveBeenCalled();
  });
});

/**
 * 会话内选中「同来源 + 同模型 + 同引擎、只有深度 / Fast 不同」的收藏(2026-08-17 review
 * 第五轮 M3),以及**锚点只在选择真的应用之后才记**(M4)。前者此前被按 (来源, 模型) 判重的
 * handleRowSelect 当成「点了当前行」直接收起 —— 界面勾上收藏,任务还是旧配置;后者此前把
 * 异步选择的结果丢掉,取消 / 失败时面板照样勾上新收藏。
 */
describe('统一面板 · 会话内选中收藏要真正应用', () => {
  function favoriteRowFor(name: string): HTMLElement {
    return within(screen.getAllByRole('group')[0])
      .getByText(name)
      .closest('[data-unified-anchor]') as HTMLElement;
  }

  it('同模型不同配置的收藏:深度 / Fast 经实时回调应用,锚点随后记下', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'high',
      fast: true,
    });
    const onEffortChange = vi.fn();
    const onFastModeChange = vi.fn();
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: false,
      onEffortChange,
      onFastModeChange,
      onSessionFavoriteAnchorChange,
    });
    await act(async () => {
      fireEvent.click(favoriteRowFor('GPT-5.5'));
    });
    // 模型这一维无事可做 → 不走单引擎选择链路,差的两格按实时通道写下去。
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onEffortChange).toHaveBeenCalledWith('high');
    expect(onFastModeChange).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(onSessionFavoriteAnchorChange).toHaveBeenCalledWith({
        uid,
        wireModelId: 'gpt-5.5',
        engine: 'codex',
        providerId: 'xd',
      });
    });
  });

  it('同模型不同配置的收藏:实时写入失败 → 不记锚点', async () => {
    addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'high',
      fast: true,
    });
    const onFastModeChange = vi.fn(() => false);
    const onEffortChange = vi.fn();
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      fastMode: false,
      onEffortChange,
      onFastModeChange,
      onSessionFavoriteAnchorChange,
    });
    await act(async () => {
      fireEvent.click(favoriteRowFor('GPT-5.5'));
    });
    // Fast 那笔没落 → 深度回滚回 low,锚点一个字不记。
    expect(onEffortChange.mock.calls).toEqual([['high'], ['low']]);
    expect(onSessionFavoriteAnchorChange).not.toHaveBeenCalled();
  });

  it('换模型的选择被拒(取消 / 写穿失败)→ 不记锚点', async () => {
    addModelFavorite({ providerId: 'openai', modelId: 'gpt-5.6', agent: 'codex' });
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onProviderChange: vi.fn(async () => false),
      onSessionFavoriteAnchorChange,
    });
    await act(async () => {
      fireEvent.click(favoriteRowFor('GPT-5.6'));
    });
    await waitFor(() => {
      expect(onSessionFavoriteAnchorChange).not.toHaveBeenCalled();
    });
  });

  it('换模型的选择成功 → 记下这条收藏的锚点', async () => {
    const uid = addModelFavorite({ providerId: 'openai', modelId: 'gpt-5.6', agent: 'codex' });
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onProviderChange: vi.fn(async () => true),
      onSessionFavoriteAnchorChange,
    });
    await act(async () => {
      fireEvent.click(favoriteRowFor('GPT-5.6'));
    });
    await waitFor(() => {
      expect(onSessionFavoriteAnchorChange).toHaveBeenCalledWith({
        uid,
        wireModelId: 'gpt-5.6',
        engine: 'codex',
        providerId: 'openai',
      });
    });
  });
});

/**
 * 编辑**当前选中的**收藏要同步 live(2026-08-17 review 第三轮 G3)。此前收藏行的深度 / Fast
 * 只更新收藏 store 就返回:行上显示新档、锚点仍打勾,实际提交却还是旧配置。
 */
describe('统一面板 · 编辑选中的收藏同步到 live', () => {
  async function openFavoriteFlyout(): Promise<HTMLElement> {
    const favoritesGroup = screen.getAllByRole('group')[0];
    const row = within(favoritesGroup)
      .getByText('GPT-5.5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(row);
    });
    return await screen.findByTestId('unified-model-config-flyout');
  }

  it('草稿选中的收藏改深度:live 回调收到新档,收藏副本同步更新', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onEffortChange = vi.fn();
    renderPanel({
      onUnifiedSelect: vi.fn(),
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      effort: 'low',
      onEffortChange,
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    expect(onEffortChange).toHaveBeenCalledWith('high');
    await waitFor(() => {
      expect(listModelFavorites()[0]?.effort).toBe('high');
    });
  });

  it('选中收藏已不是 live 配置:改深度只更新收藏记录,不写回正在跑的配置', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onEffortChange = vi.fn();
    const onUnifiedSelect = vi.fn();
    renderPanel({
      onUnifiedSelect,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'cc',
      effort: 'medium',
      onEffortChange,
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    await waitFor(() => {
      expect(listModelFavorites()[0]?.effort).toBe('high');
    });
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onUnifiedSelect).not.toHaveBeenCalled();
  });

  it('选中收藏后只改了思维档:编辑深度只更新收藏记录,不写回正在跑的配置', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onEffortChange = vi.fn();
    const onUnifiedSelect = vi.fn();
    renderPanel({
      onUnifiedSelect,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      effort: 'high',
      onEffortChange,
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    await waitFor(() => {
      expect(listModelFavorites()[0]?.effort).toBe('high');
    });
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(onUnifiedSelect).not.toHaveBeenCalled();
  });

  it('选中收藏后只改了 Fast:编辑 Fast 只更新收藏记录,不写回正在跑的配置', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onFastModeChange = vi.fn();
    const onEffortChange = vi.fn();
    const onUnifiedSelect = vi.fn();
    renderPanel({
      onUnifiedSelect,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      effort: 'low',
      fastMode: true,
      onEffortChange,
      onFastModeChange,
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-fast-toggle]') as HTMLElement);
    });
    await waitFor(() => {
      expect(listModelFavorites()[0]?.fast).toBe(true);
    });
    expect(onFastModeChange).not.toHaveBeenCalled();
    expect(onUnifiedSelect).not.toHaveBeenCalled();
  });

  it('草稿选中的收藏改 Fast:live 回调收到新值,收藏副本同步更新', async () => {
    const uid = addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex' });
    const onFastModeChange = vi.fn();
    renderPanel({
      onUnifiedSelect: vi.fn(),
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      // 副本无显式档 → 解析成 codex 目录默认 high;live 深度须与之一致,锚点才成立
      // (2026-08-19 review P2 的完整配置校验)。
      effort: 'high',
      onEffortChange: vi.fn(),
      onFastModeChange,
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-fast-toggle]') as HTMLElement);
    });
    expect(onFastModeChange).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(listModelFavorites()[0]?.fast).toBe(true);
    });
  });

  it('live 写入失败 → 收藏副本不留半套(这次编辑不落)', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onEffortChange = vi.fn(() => false);
    renderPanel({
      onUnifiedSelect: vi.fn(),
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      effort: 'low',
      onEffortChange,
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    expect(onEffortChange).toHaveBeenCalledWith('high');
    expect(listModelFavorites()[0]?.effort).toBe('low');
  });

  it('非选中的收藏只改副本,不动正在跑的那一份(回归保护)', async () => {
    addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex', effort: 'low' });
    const onEffortChange = vi.fn();
    // 选中的是 Opus 5,那条收藏不是当前锚点。
    renderPanel({
      onUnifiedSelect: vi.fn(),
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
      onEffortChange,
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.keyDown(flyout.querySelector('[role="slider"]') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    expect(onEffortChange).not.toHaveBeenCalled();
    expect(listModelFavorites()[0]?.effort).toBe('high');
  });

  /**
   * **引擎**编辑并进同一结构(2026-08-17 review H2)。此前收藏行的引擎胶囊只
   * `updateModelFavorite` 就返回:收藏行当场显示新引擎,草稿 vendor 纹丝不动、会话也没执行
   * 跨引擎切换 —— 与深度 / Fast 是同一个病的第三个入口。
   */
  it('草稿选中的收藏改引擎:整份副本按新引擎写回草稿(锚点保持),副本同步更新', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onUnifiedSelect = vi.fn();
    renderPanel({
      onUnifiedSelect,
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      vendorKey: 'codex',
      effort: 'low',
      onEffortChange: vi.fn(),
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    // 草稿换引擎无损:整份副本(新引擎 + 该引擎仍支持的旧档 low + 无 Fast)按既有选中链路
    // 写回草稿;favoriteUid **保持** —— 编辑不改变「选中的是这一条收藏」。
    expect(onUnifiedSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      engine: 'cc',
      effort: 'low',
      fast: false,
      favoriteUid: uid,
    });
    await waitFor(() => {
      expect(listModelFavorites()[0]?.agent).toBe('cc');
    });
  });

  it('会话内选中的收藏改引擎:走跨引擎切换事务,事务真成功才落副本', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onCrossEngineSelect = vi.fn(() => true);
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(),
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    // ★ 锚点随事务一起交出去(2026-08-17 review K3):配置切到新引擎了,选中的**还是这一条
    // 收藏**。缺了它,会话侧把缺省当 null,事务成功后锚点被清掉 —— 面板退回选中模型行,
    // 之后再删这条仍在用的收藏就走不到「先回落默认配置」那条路。
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      targetAgent: 'claude-code',
      effort: 'low',
      // 编辑后副本按目标引擎解析的 Fast(cc 那条无 Fast 能力 → false)。
      fast: false,
      favoriteUid: uid,
    });
    await waitFor(() => {
      expect(listModelFavorites()[0]?.agent).toBe('cc');
    });
  });

  it('会话内改引擎被取消:副本不动,这次编辑一点不落', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onCrossEngineSelect = vi.fn(() => false);
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(),
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    expect(onCrossEngineSelect).toHaveBeenCalledTimes(1);
    expect(listModelFavorites()[0]?.agent).toBe('codex');
  });

  it('非选中的收藏改引擎:只改副本,不动正在跑的那一份(回归保护)', async () => {
    addModelFavorite({ providerId: 'xd', modelId: 'gpt-5.5', agent: 'codex', effort: 'low' });
    const onUnifiedSelect = vi.fn();
    const onCrossEngineSelect = vi.fn();
    // 选中的是 Opus 5,那条收藏不是当前锚点。
    renderPanel({
      onUnifiedSelect,
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
      onEffortChange: vi.fn(),
    });
    const flyout = await openFavoriteFlyout();
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    expect(listModelFavorites()[0]?.agent).toBe('cc');
    expect(onUnifiedSelect).not.toHaveBeenCalled();
    expect(onCrossEngineSelect).not.toHaveBeenCalled();
    // 收藏行的引擎编辑绝不写模型默认的 override(那是 modelEnginePrefs 的事)。
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
  });
});

/**
 * 「恢复推荐」写进记忆表的是**删除**,不是这一版目录默认的快照(2026-08-17 review H3)。
 * 记忆表是 override 表:表里没有该键 ⇒ 跟随当前版本的目录默认。写快照会把用户钉死在旧默认上,
 * 与同一个动作里 `clearModelEngineOverride` 的语义(删 key = 随版本跟随新推荐)自相矛盾。
 */
describe('统一面板 · 恢复推荐删记忆键', () => {
  /** 带删除入口的最小记忆实现(本地 providerModelMemory 的形状)。 */
  function makeMemory(seed?: {
    effort?: Record<string, string>;
    fast?: Record<string, boolean>;
  }) {
    const keyOf = (agent: string, providerId: string, modelId: string) =>
      `${agent}|${providerId}|${modelId}`;
    const effort = new Map<string, string>(Object.entries(seed?.effort ?? {}));
    const fast = new Map<string, boolean>(Object.entries(seed?.fast ?? {}));
    return {
      effort,
      fast,
      keyOf,
      accessors: {
        getEffort: (a: string, p: string, m: string) => effort.get(keyOf(a, p, m)),
        setEffort: (a: string, p: string, m: string, e: string) => {
          effort.set(keyOf(a, p, m), e);
        },
        getFast: (a: string, p: string, m: string) => fast.get(keyOf(a, p, m)),
        setFast: (a: string, p: string, m: string, v: boolean) => {
          fast.set(keyOf(a, p, m), v);
        },
        clearEffort: (a: string, p: string, m: string) => {
          effort.delete(keyOf(a, p, m));
        },
        clearFast: (a: string, p: string, m: string) => {
          fast.delete(keyOf(a, p, m));
        },
      },
    };
  }

  it('恢复推荐后记忆槽里没有该键(不是写了一份「等于当前默认」的快照)', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const memory = makeMemory({
      effort: { 'codex|xd|gpt-5.5': 'low' },
      fast: { 'codex|xd|gpt-5.5': true },
    });
    // 选中的是 Opus 5 → GPT-5.5 那一行不是 live 行,只走持久化那一半。
    renderPanel({
      modelMemory: memory.accessors,
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(getModelEngineOverride('xd', 'gpt-5.5')).toBeUndefined();
    // 键被**删掉**:留一份 'high' / false 的快照就是把这一版的默认固化成用户配置。
    expect(memory.effort.has('codex|xd|gpt-5.5')).toBe(false);
    expect(memory.fast.has('codex|xd|gpt-5.5')).toBe(false);
  });

  it('恢复推荐之后目录默认档变了 → 行展示跟随新默认(不被旧值钉死)', async () => {
    const memory = makeMemory({ effort: { 'codex|xd|gpt-5.5': 'low' } });
    const first = renderPanel({
      modelMemory: memory.accessors,
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    // 恢复推荐前:行显示用户记忆里的 low。
    expect(rowFor('GPT-5.5').querySelector('[data-unified-triple]')?.textContent).toContain('低');
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    first.unmount();
    // 重开面板(夹具里的记忆是纯 Map,不发变更通知,重挂载才重读)—— 回到目录默认 high。
    const second = renderPanel({
      modelMemory: memory.accessors,
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    expect(rowFor('GPT-5.5').querySelector('[data-unified-triple]')?.textContent).toContain('高');
    second.unmount();

    // 服务端把 codex 那条的推荐档改成 low —— 记忆表里没有该键,所以行必须跟着变。
    // (旧做法把 'high' 快照写进了记忆槽,这里就会仍然显示「高」。)
    const codexModels = (providersRef.providers[2] as { models: { codex: { defaultEffort: string }[] } })
      .models.codex;
    const restore = codexModels[0].defaultEffort;
    codexModels[0].defaultEffort = 'low';
    try {
      renderPanel({
        modelMemory: memory.accessors,
        currentProviderId: 'anthropic',
        modelId: 'claude-opus-5',
      });
      expect(rowFor('GPT-5.5').querySelector('[data-unified-triple]')?.textContent).toContain('低');
    } finally {
      codexModels[0].defaultEffort = restore;
    }
  });

  it('注入方没有删除入口(device-link 镜像)→ 退回既有快照写法,行为不变', async () => {
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const setEffort = vi.fn();
    const setFast = vi.fn();
    renderPanel({
      modelMemory: {
        getEffort: () => undefined,
        setEffort,
        getFast: () => undefined,
        setFast,
      },
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
    });
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(setEffort).toHaveBeenCalledWith('codex', 'xd', 'gpt-5.5', 'high');
    expect(setFast).toHaveBeenCalledWith('codex', 'xd', 'gpt-5.5', false);
  });
});

/**
 * 会话路径的收藏锚点(2026-08-17 review 第三轮 G4)。会话内选中一条收藏时,单引擎链路
 * (onProviderChange)只认 (来源, 模型),锚点被丢掉 —— 重开面板选中的是模型行而不是刚用的
 * 那条收藏,「删除选中收藏回落默认」在会话内也永远走不到。
 */
describe('统一面板 · 会话内回传收藏锚点', () => {
  it('同引擎选中收藏 → 回传锚点(带这次落下的 wire id 与引擎)', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
      onSessionFavoriteAnchorChange,
    });
    const favoriteRow = within(screen.getAllByRole('group')[0])
      .getByText('GPT-5.5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(favoriteRow);
    });
    expect(onSessionFavoriteAnchorChange).toHaveBeenCalledWith({
      uid,
      wireModelId: 'gpt-5.5',
      engine: 'codex',
      providerId: 'xd',
    });
  });

  it('选中普通模型行 → 回传 null(把上一条锚点清掉)', async () => {
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect: vi.fn(),
      },
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
      onSessionFavoriteAnchorChange,
    });
    await act(async () => {
      fireEvent.click(rowFor('GPT-5.5'));
    });
    expect(onSessionFavoriteAnchorChange).toHaveBeenCalledWith(null);
  });

  it('跨引擎选中收藏:锚点随切换事务的入参交出去,由调用方按真实结果决定记不记', async () => {
    const uid = addModelFavorite({ providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'cc' });
    const onCrossEngineSelect = vi.fn(() => true);
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      onSessionFavoriteAnchorChange,
    });
    // 跨引擎收藏只在「全部」视图里出现(同引擎视图按定义只列无损可切的行)。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    const favoriteRow = within(screen.getAllByRole('group')[0])
      .getByText('Opus 5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(favoriteRow);
    });
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      targetAgent: 'claude-code',
      effort: 'medium',
      // 收藏副本的 Fast(未存 = false)同样显式交给事务。
      fast: false,
      favoriteUid: uid,
    });
    // 跨引擎不走这个回调:记不记由 ChatInput 在事务返回非 false 之后自己决定(取消不记)。
    expect(onSessionFavoriteAnchorChange).not.toHaveBeenCalled();
  });

  /**
   * Fast 收藏的跨引擎选中(2026-08-17 review):副本的 Fast **开**必须显式进事务入参 ——
   * 此前入参不带 Fast,事务按目标引擎的旧记忆重解析,收藏 Fast 与记忆值不同时,
   * 锚点照记、界面照勾,任务却按记忆里的另一个 Fast 在跑。
   */
  it('跨引擎选中 Fast 收藏:副本的 Fast 开显式随事务交出', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      fast: true,
    });
    const onCrossEngineSelect = vi.fn(() => true);
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'claude-code' as const,
        runtimeAgent: 'claude-code' as const,
        onCrossEngineSelect,
      },
      currentProviderId: 'anthropic',
      modelId: 'claude-opus-5',
      vendorKey: 'cc',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部' }));
    });
    const favoriteRow = within(screen.getAllByRole('group')[0])
      .getByText('GPT-5.5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(favoriteRow);
    });
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      targetAgent: 'codex',
      // 副本未存档位 → 目标条目默认 high;Fast 开(xd/codex 条目具备 Fast 能力)。
      effort: 'high',
      fast: true,
      favoriteUid: uid,
    });
  });

  /**
   * K3(2026-08-17 review 第四轮):**编辑**选中收藏的引擎也是一次跨引擎事务,但它与
   * 「选中另一行」「恢复推荐」「删收藏」的锚点语义相反 —— 配置切过去了,选中的**还是这一条
   * 收藏**。此前这条链路不带 favoriteUid,会话侧把缺省当 null,于是事务成功后锚点被清掉:
   * 面板退回选中模型行,之后删这条仍在用的收藏也走不到「先回落默认配置」那条路。
   */
  it('编辑选中收藏的引擎:锚点随事务交出去且仍是同一条收藏(带事务后的目标值)', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onCrossEngineSelect = vi.fn(() => true);
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(),
      onSessionFavoriteAnchorChange,
    });
    const favoritesGroup = screen.getAllByRole('group')[0];
    const row = within(favoritesGroup)
      .getByText('GPT-5.5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(row);
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    // 交出去的是**编辑后**的目标值(目标引擎 + 该引擎的 wire id + 仍被支持的旧档),
    // 锚点仍指向这条收藏 —— 会话侧据此在事务成功后按目标值重记锚点。
    expect(onCrossEngineSelect).toHaveBeenCalledWith({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      targetAgent: 'claude-code',
      effort: 'low',
      // 编辑后副本按目标引擎解析的 Fast(cc 那条无 Fast 能力 → false)。
      fast: false,
      favoriteUid: uid,
    });
    // 记不记仍由 ChatInput 按事务真实结果决定,面板不抢这一步。
    expect(onSessionFavoriteAnchorChange).not.toHaveBeenCalled();
  });

  it('编辑选中收藏的引擎被取消:锚点与收藏副本都一点不动', async () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'low',
    });
    const onCrossEngineSelect = vi.fn(() => false);
    const onSessionFavoriteAnchorChange = vi.fn();
    renderPanel({
      sessionEngineFilter: {
        currentAgent: 'codex' as const,
        runtimeAgent: 'codex' as const,
        onCrossEngineSelect,
      },
      selectedFavoriteUid: uid,
      currentProviderId: 'xd',
      modelId: 'gpt-5.5',
      effort: 'low',
      onEffortChange: vi.fn(),
      onSessionFavoriteAnchorChange,
    });
    const favoritesGroup = screen.getAllByRole('group')[0];
    const row = within(favoritesGroup)
      .getByText('GPT-5.5')
      .closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.pointerEnter(row);
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(flyout.querySelector('[data-engine-capsule="cc"]') as HTMLElement);
    });
    // 入参照样带锚点(取消与否是调用方的事),但副本不落、锚点回调不触发。
    expect(onCrossEngineSelect).toHaveBeenCalledWith(
      expect.objectContaining({ favoriteUid: uid }),
    );
    expect(listModelFavorites()[0]?.agent).toBe('codex');
    expect(onSessionFavoriteAnchorChange).not.toHaveBeenCalled();
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
        // 选中的收藏 = 草稿正在跑它的副本(2026-08-19 review P2 的完整配置校验):
        // 引擎对齐副本(vendorKey codex),深度对齐副本解析值(无显式档 → codex 目录默认 high)。
        vendorKey: 'codex',
        effort: 'high',
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

  it('收藏是独立选中项:live 思维/引擎对不上副本,勾仍在收藏行,不落到下面同名模型', () => {
    const uid = addModelFavorite({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'codex',
      effort: 'high',
    });
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'gpt-5.5',
        vendorKey: 'cc',
        effort: 'low',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'xd',
        onProviderChange,
        unifiedPanel: true,
        selectedFavoriteUid: uid,
      }),
    );
    const selected = screen
      .getByRole('listbox')
      .querySelectorAll('[data-model-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-unified-anchor')).toBe(`fav::${uid}`);
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

  it('「恢复推荐」把 Fast 收回**推荐引擎**那一格,即便当前生效引擎的 Fast 是关的', async () => {
    // 行落在 cc(override)上,而 cc 那条目录条目没有 Fast 能力 → 行上的生效 fast 恒 false;
    // 推荐引擎(codex)的记忆槽里却留着上次开的 Fast。按生效引擎的值当门就会漏掉这一路:
    // 恢复推荐后行翻回 codex,⚡ 当场复活。
    setModelEngineOverride('xd', 'gpt-5.5', 'cc');
    const setFast = vi.fn();
    renderPanel({
      modelMemory: {
        getEffort: () => undefined,
        setEffort: vi.fn(),
        getFast: (agent: string) => agent === 'codex',
        setFast,
      },
    });
    await act(async () => {
      fireEvent.pointerEnter(rowFor('GPT-5.5'));
    });
    const flyout = await screen.findByTestId('unified-model-config-flyout');
    await act(async () => {
      fireEvent.click(within(flyout).getByText('恢复推荐'));
    });
    expect(setFast).toHaveBeenCalledWith('codex', 'xd', 'gpt-5.5', false);
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

describe('列表样式试用开关(badge · v7 引擎徽标行)', () => {
  afterEach(async () => {
    const { __resetForTest } = await import('@/state/modelPickerLayout');
    __resetForTest();
  });

  it('badge 行:引擎徽标(可点快切)、来源字签、价格按实付比例上色且 0.5 字符钳制', async () => {
    const { UnifiedModelRow } = await import('@/components/new-chat/UnifiedModelRow');
    const entry = {
      providerId: 'xd',
      modelId: 'gpt-5.5',
      displayName: 'GPT-5.5',
      candidates: ['claude-code' as const, 'codex' as const],
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
    const onSelect = vi.fn();
    const onEngineCycle = vi.fn();
    const common = {
      entry,
      anchor: { kind: 'model' as const, providerId: 'xd', modelId: 'gpt-5.5' },
      config,
      selected: false,
      active: false,
      isFavoriteRow: false,
      justFavorited: false,
      interactionDisabled: false,
      effortLabelOf: (_agent: 'claude-code' | 'codex' | 'pi', effort: string) => effort,
      providers: [],
      onReveal: vi.fn(),
      onRevealForKeyboard: vi.fn(),
      onLeave: vi.fn(),
      onBlurAway: vi.fn(),
      onSelect,
      onStar: vi.fn(),
      layout: 'badge' as const,
      channelLabel: 'Cindy AI',
    };
    const hexToRgb = (hex: string) =>
      `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

    // $1 档 ↓85%(实付 15%):比例只有 0.15 字符 → 钳到 0.5,裁掉右侧 50%,颜色 t1 绿。
    const clamped = render(
      React.createElement(UnifiedModelRow, {
        ...common,
        onEngineCycle,
        priceDisplay: {
          kind: 'tier' as const,
          tier: 1 as const,
          paidPct: 15,
          discountPct: 85,
          title: '立省 85%',
        },
      }),
    );
    const badgeEl = clamped.container.querySelector('[data-engine-badge]') as HTMLElement;
    expect(badgeEl.getAttribute('data-engine-badge')).toBe('codex');
    expect(clamped.container.querySelector('[data-channel-tag]')?.textContent).toBe('Cindy AI');
    // 引擎在行首徽标承载,badge 行不再渲染旧三元组结构。
    expect(clamped.container.querySelector('[data-unified-triple]')).toBeNull();
    const lit = clamped.container.querySelector('[data-price-lit]') as HTMLElement;
    expect(lit.getAttribute('data-price-lit')).toBe('0.50');
    expect(lit.getAttribute('style')).toContain('inset(0 50.0% 0 0)');
    expect(lit.getAttribute('style')).toContain(hexToRgb(PRICE_TIER_COLORS.t1));
    // 徽标是按钮:点击走快切回调,且不触发行选中(stopPropagation)。
    fireEvent.click(badgeEl);
    expect(onEngineCycle).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    clamped.unmount();

    // $$$ ↓40%(实付 60%):1.8 字符按比例点亮(裁掉右侧 40%),颜色 round(1.8)=2 黄。
    const proportional = render(
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
    const propLit = proportional.container.querySelector('[data-price-lit]') as HTMLElement;
    expect(propLit.getAttribute('data-price-lit')).toBe('1.80');
    expect(propLit.getAttribute('style')).toContain('inset(0 40.0% 0 0)');
    expect(propLit.getAttribute('style')).toContain(hexToRgb(PRICE_TIER_COLORS.t2));
    proportional.unmount();

    // 不传 onEngineCycle(单候选)→ 徽标是纯标识 span,不可点。
    const single = render(React.createElement(UnifiedModelRow, common));
    expect(single.container.querySelector('button[data-engine-badge]')).toBeNull();
    expect(single.container.querySelector('span[data-engine-badge]')).not.toBeNull();
  });

  it('面板级:footer 按钮切换样式,行进入 badge 布局并带来源字签', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByText('尝试样式B'));
    });
    const { getModelPickerLayout } = await import('@/state/modelPickerLayout');
    expect(getModelPickerLayout()).toBe('badge');
    expect(screen.getByText('切回样式A')).toBeTruthy();
    const row = rowFor('GPT-5.5');
    expect(row.querySelector('[data-engine-badge]')).not.toBeNull();
    expect(row.querySelector('[data-channel-tag]')?.textContent).toBe('Cindy AI');
    // 组名常驻改由列表顶部覆盖层题头承载(sticky 会在滚动容器 padding 上沿漏行,
    // 2026-08-16 实测废弃);组头保持普通元素,仅挂 data-group-label 供覆盖层测量。
    const header = document.querySelector(
      '[role="group"][aria-label="Cindy AI"] > div',
    ) as HTMLElement;
    expect(header.className).not.toContain('sticky');
    expect(header.getAttribute('data-group-label')).toBe('Cindy AI');
  });
});
