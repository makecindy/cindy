// @vitest-environment jsdom

/**
 * 统一模型选择器面板(M3 / M4)的**接线锁**:纯逻辑层算出来的东西必须真的到达像素,
 * 且写操作真的落到 M2 的两个 store。
 *
 * 覆盖:
 *   1. 跨引擎联合列表按分组陈列,行 = (来源, 模型);
 *   2. 行右侧常驻三元组(引擎 + 推理强度)——不是只有出错时才显示;
 *   3. 点自定义 / 右键弹出配置浮层,浮层里的引擎胶囊只列候选引擎;
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
        'modelDescriptions.coding': '用于编写代码、排查错误与改进程序。',
        'settings.providers.anthropic.title': 'Anthropic',
        'settings.providers.openai.title': 'OpenAI',
        'settings.providers.xd.title': 'Cindy AI',
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.noResults': '无匹配模型',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.unified.favoritesGroup': '收藏',
        'newChat.modelSelector.unified.recommended': '推荐',
        'newChat.modelSelector.unified.addFavorite': '存为收藏',
        'newChat.modelSelector.unified.customize': '自定义',
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
            description:
              'A very long English description that must stay on one line and never blow up the panel layout in narrow windows',
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
const remoteProvidersRef = vi.hoisted(() => ({ providers: [] as unknown[] }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: () => ({
    providers: remoteProvidersRef.providers,
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
  updateModelFavorite,
} from '@/state/modelFavorites';
import { setModelEngineOverride } from '@/state/modelEnginePrefs';

const onProviderChange = vi.fn();

// ── Fallback picking: the real UI path ──────────────────────────────────────
import {
  fallbackChainKey,
  getFallbackChain,
  __resetForTest as resetFallbackChains,
} from '@/state/fallbackChains';

function renderFallbackPanel(
  props: Partial<React.ComponentProps<typeof ModelSelectorContent>> = {},
): ReturnType<typeof render> {
  return render(
    React.createElement(ModelSelectorContent, {
      modelId: 'gpt-5.5',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'xd',
      onProviderChange: vi.fn(),
      onFastModeChange: vi.fn(),
      onNavigateToProviders: vi.fn(),
      ...props,
    }),
  );
}

describe('fallback mode: clicking a row must reach the chain store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetEnginePrefs();
    resetFavorites();
    // The store caches in module scope, so clearing storage alone leaks state
    // between tests — which is exactly how a stale set can delete a fresh add.
    resetFallbackChains();
  });

  it('adds the clicked model to the chain instead of switching the main model', async () => {
    renderFallbackPanel();

    // Enter fallback mode via the real footer entry.
    const entry = document.querySelector('[data-fallback-entry]') as HTMLElement | null;
    expect(entry, 'fallback entry button should render in the footer').not.toBeNull();
    await act(async () => {
      fireEvent.click(entry as HTMLElement);
    });

    // The mode header must be visible, not clipped away.
    expect(document.querySelector('[data-fallback-header]')).not.toBeNull();

    // Click a DIFFERENT model row; it must land in the chain.
    const list = screen.getByRole('listbox');
    const row = within(list).getByText('Opus 5').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });

    // The fixture's gpt-5.5 resolves to the claude-code engine, so that is the
    // main model's identity. Read the key the app actually keyed the chain by.
    const key = fallbackChainKey({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'claude-code',
      effort: 'high',
    });
    const chain = getFallbackChain(key);
    expect(chain, 'clicking a row in fallback mode must write a chain').not.toBeNull();
    expect(chain?.entries.length).toBeGreaterThan(1);
    expect(chain?.entries[1]?.modelId).toBe('claude-opus-5');
  });

  /**
   * The reported failure: an existing session pins the engine, and selectRow
   * reroutes every cross-engine row into the switch transaction. That path must
   * still land in the chain rather than silently doing nothing.
   */
  it('adds a cross-engine row inside a live session instead of no-oping', async () => {
    const onCrossEngineSelect = vi.fn(async () => true);
    renderFallbackPanel({
      sessionEngineFilter: {
        currentAgent: 'codex',
        runtimeAgent: 'codex',
        onCrossEngineSelect,
      } as never,
    });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-fallback-entry]') as HTMLElement);
    });

    const list = screen.getByRole('listbox');
    const row = within(list).getByText('Opus 5').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });

    // The session's engine-switch transaction must NOT be used for fallback picking.
    expect(onCrossEngineSelect).not.toHaveBeenCalled();

    const key = fallbackChainKey({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      // The main model's engine comes from the picker's own resolution, which the
      // fixture leaves at claude-code; assert against that, not an assumed codex.
      agent: 'claude-code',
      effort: 'high',
    });
    const chain = getFallbackChain(key);
    expect(chain, 'cross-engine pick in a session must write a chain').not.toBeNull();
    expect(chain?.entries[1]?.modelId).toBe('claude-opus-5');
  });

  /**
   * The reported setup, exactly: a Codex session (GPT-6-Astra) clicking an
   * Anthropic row. The picker resolves the main model on codex, so every Claude
   * row is cross-engine and takes the reroute branch.
   */
  it('adds a Claude row from a Codex session', async () => {
    const onCrossEngineSelect = vi.fn(async () => true);
    renderFallbackPanel({
      modelId: 'gpt-5.6',
      currentProviderId: 'openai',
      agentKind: 'codex',
      sessionEngineFilter: {
        currentAgent: 'codex',
        runtimeAgent: 'codex',
        onCrossEngineSelect,
      } as never,
    } as never);

    await act(async () => {
      fireEvent.click(document.querySelector('[data-fallback-entry]') as HTMLElement);
    });

    const list = screen.getByRole('listbox');
    const row = within(list).getByText('Opus 5').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });

    // Picking a fallback must never open the session's engine-switch transaction.
    expect(onCrossEngineSelect).not.toHaveBeenCalled();

    const key = fallbackChainKey({
      providerId: 'openai',
      modelId: 'gpt-5.6',
      agent: 'codex',
      effort: 'high',
    });
    const chain = getFallbackChain(key);
    expect(chain, 'a Claude row clicked from a Codex session must be added').not.toBeNull();
    expect(chain?.entries[1]?.modelId).toBe('claude-opus-5');
  });
  /**
   * The real composer passes onUnifiedSelect (draft/session direct-write path).
   * If the fallback branch sits behind it, or if that handler swallows the click,
   * every row goes dead — which is what the app actually shows.
   */
  it('adds a row even when the host supplies onUnifiedSelect', async () => {
    const onUnifiedSelect = vi.fn(async () => true);
    renderFallbackPanel({ onUnifiedSelect: onUnifiedSelect as never });

    await act(async () => {
      fireEvent.click(document.querySelector('[data-fallback-entry]') as HTMLElement);
    });

    const list = screen.getByRole('listbox');
    const row = within(list).getByText('Opus 5').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });

    // Picking a fallback must not change the session's model.
    expect(onUnifiedSelect).not.toHaveBeenCalled();

    const key = fallbackChainKey({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'claude-code',
      effort: 'high',
    });
    expect(getFallbackChain(key), 'row click must write a chain').not.toBeNull();
  });

  /**
   * The live composer can briefly disable its normal model picker while a
   * request is switching. That state must not disable the already-open
   * fallback editor: the fallback choice is a local chain write, not another
   * live-session switch.
   */
  it('keeps fallback rows clickable while the live picker is disabled', async () => {
    const view = renderFallbackPanel();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-fallback-entry]') as HTMLElement);
    });

    view.rerender(
      React.createElement(ModelSelectorContent, {
        modelId: 'gpt-5.5',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'xd',
        onProviderChange: vi.fn(),
        onFastModeChange: vi.fn(),
        onNavigateToProviders: vi.fn(),
        interactionDisabled: true,
      }),
    );

    const list = screen.getByRole('listbox');
    const row = within(list).getByText('Opus 5').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });

    const key = fallbackChainKey({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'claude-code',
      effort: 'high',
    });
    const chain = getFallbackChain(key);
    expect(chain, 'a disabled live picker must not disable fallback writes').not.toBeNull();
    expect(chain?.entries.length).toBeGreaterThan(1);
  });

  /**
   * The screenshot's list is the Favorites group (starred rows). A favourite row
   * carries a `fav::` anchor and takes a different branch of selectRow than a
   * plain model row, so it needs its own lock.
   */
  it('adds a favourite row to the chain', async () => {
    addModelFavorite({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      agent: 'cc',
    } as never);

    renderFallbackPanel();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-fallback-entry]') as HTMLElement);
    });

    const favRow = document.querySelector('[data-unified-anchor^="fav::"]') as HTMLElement | null;
    expect(favRow, 'a favourite row should render').not.toBeNull();
    await act(async () => {
      fireEvent.click(favRow as HTMLElement);
    });

    const key = fallbackChainKey({
      providerId: 'xd',
      modelId: 'gpt-5.5',
      agent: 'claude-code',
      effort: 'high',
    });
    expect(getFallbackChain(key), 'clicking a favourite must write a chain').not.toBeNull();
  });

  /**
   * ★ The bug every other test in this file missed: they all assert the *store*.
   * The store write was landing fine. What stayed frozen was the **UI** — the
   * component subscribed to the chain version but discarded it, so the memo that
   * reads the chain kept returning its mount-time value. Nothing on screen moved
   * after a click, which is indistinguishable from a dead button.
   *
   * So assert pixels: the chip strip must grow, and clicking again must shrink it.
   */
  it('shows the picked model in the chain strip and removes it on a second click', async () => {
    renderFallbackPanel();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-fallback-entry]') as HTMLElement);
    });

    const chipCount = (): number => document.querySelectorAll('[data-fallback-chip]').length;
    // Only the main model is in the chain at this point.
    expect(chipCount()).toBe(1);

    const list = screen.getByRole('listbox');
    const row = within(list).getByText('Opus 5').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });

    await waitFor(() => {
      expect(chipCount(), 'the picked model must appear in the chain strip').toBe(2);
    });
    expect(
      document.querySelector('[data-fallback-chip]')?.parentElement?.parentElement?.textContent,
    ).toContain('Opus 5');

    // Clicking the same row again toggles it back out, and that must show too.
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => {
      expect(chipCount(), 'clicking again must remove the chip').toBe(1);
    });
  });

  /**
   * Same frozen-read bug, second surface: the footer badge counts the chain.
   * It must reflect a pick made in the editor after coming back out.
   */
  /**
   * Chips used to scroll horizontally, so entries past the third slid out of the
   * panel's right edge: the user could not see what they had just added and could
   * not reach its remove button. They must wrap instead.
   */
  it('wraps the chain chips instead of scrolling them out of view', async () => {
    renderFallbackPanel();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-fallback-entry]') as HTMLElement);
    });

    const strip = document.querySelector('[data-fallback-chip]')?.parentElement?.parentElement;
    expect(strip, 'the chain strip should render').toBeTruthy();
    const cls = (strip as HTMLElement).className;
    expect(cls, 'chips must wrap onto a second row').toContain('flex-wrap');
    expect(cls, 'horizontal scrolling hides entries off the right edge').not.toContain('overflow-x-auto');
  });

  it('updates the footer fallback count after a pick', async () => {
    renderFallbackPanel();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-fallback-entry]') as HTMLElement);
    });

    const list = screen.getByRole('listbox');
    const row = within(list).getByText('Opus 5').closest('[data-unified-anchor]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });

    // Leave the editor via the real back button and read the footer badge.
    const back = document.querySelector('[data-fallback-header] button') as HTMLElement;
    await act(async () => {
      fireEvent.click(back);
    });

    await waitFor(() => {
      const entry = document.querySelector('[data-fallback-entry]') as HTMLElement;
      expect(entry.textContent, 'footer badge must count the new fallback').toContain('1');
    });
  });
});
