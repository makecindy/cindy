// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：真实 `ModelGroupsSection` 详情页（含 `SourceRouteDetail` 与 `RouteTypeSection`），验证顶部单选卡片顺序、
 *   精简文案、模型路由 ↔ 供应商路由切换（空直接切／已有来源弹窗确认／保留名字选法例外／去掉隐藏推理强度／上限保护）、键盘方向键切换，
 *   以及自动合成供应商路由保持只读与原说明。
 * - Bug／规则依据：docs/product-rules/model-groups.md 与路由类型二选一改版（F 方案置顶版）；原界面空来源时同时露出「添加整个供应商」
 *   与「添加来源」导致误点且顺序反置，切换后若残留 effort 会覆盖 resolver.ts 的模型选择器推理强度。
 * - 现有覆盖缺口：ModelGroupsOverview.test.tsx 与 ModelGroupsAutoRoutes.test.tsx 均未覆盖路由类型单选卡片与双向类型转换。
 * - 最小失败输入：1 条空模型路由、1 条带候选与 effort 的模型路由、1 条带成员的用户供应商路由、1 条自动供应商路由，以及已满 32 条模型路由的边界配置。
 * - 回归：首个来源保存未返回时切换不得静默删除来源，其他路由的时段例外删除前必须提示。
 * - tier：unit（jsdom，内存模拟 modelGroupsClient 持久化与 useProviders 目录）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_GROUP_LIMITS, normalizeModelGroupsConfig, type ModelGroupsConfig } from '../../../../shared/modelGroups';

const h = vi.hoisted(() => ({
  config: { routes: [] } as ModelGroupsConfig,
  listeners: new Set<() => void>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  toastError: vi.fn(),
  saveCalls: 0,
  useRealSaveQueue: false,
}));

const i18nValue = { t: (key: string) => key, i18n: { language: 'zh-CN' } };
vi.mock('react-i18next', () => ({ useTranslation: () => i18nValue }));
vi.mock('react-router-dom', () => ({ useInRouterContext: () => false }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: (...args: unknown[]) => h.toastError(...args), success: vi.fn() } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: (...args: unknown[]) => h.confirm(...(args as [])) }),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ProviderMark: () => null,
  ModelSelector: () => null,
  // Route-type tests exercise the surrounding form with the candidate picker closed.
  ModelSelectorPopover: ({ trigger }: { trigger: React.ReactElement }) => trigger,
}));
vi.mock('@/hooks/useModelRouteDevices', () => ({ useModelRouteDevices: () => ({ devices: [] }) }));
vi.mock('@/hooks/useDevicesProviders', () => ({ useDevicesProviders: () => new Map() }));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: [
      { id: 'openai', name: 'OpenAI', connected: true, agents: [], routing: {}, models: {} },
      { id: 'anthropic', name: 'Anthropic', connected: true, agents: [], routing: {}, models: {} },
    ],
  }),
}));
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({ useLocalProviderGroups: () => ({}) }));
vi.mock('@/features/provider-group/useProviderGroup', () => ({ useProviderGroup: () => ({ view: null, save: vi.fn() }) }));

const namesOf = (candidate: { model: string; providerId: string }) => ({
  provider: undefined,
  modelName: candidate.model,
  sourceName: candidate.providerId,
  sourceLabel: candidate.providerId,
  known: true,
  connected: true,
});

vi.mock('@/features/model-groups/modelGroupsClient', async () => {
  const react = await import('react');
  const real = await vi.importActual<typeof import('@/features/model-groups/modelGroupsClient')>('@/features/model-groups/modelGroupsClient');
  return {
    refreshModelGroups: real.refreshModelGroups,
    modelGroupWhyText: () => '',
    useModelGroupCandidateNames: () => namesOf,
    saveModelGroups: async (change: (latest: ModelGroupsConfig) => ModelGroupsConfig) => {
      if (h.useRealSaveQueue) return real.saveModelGroups(change);
      const next = change(h.config);
      if (next === h.config) return h.config;
      h.saveCalls += 1;
      h.config = next;
      for (const listener of h.listeners) listener();
      return h.config;
    },
    useModelGroups: () => {
      const config = react.useSyncExternalStore(
        (listener) => {
          h.listeners.add(listener);
          return () => { h.listeners.delete(listener); };
        },
        () => h.config,
      );
      return { config, loaded: true };
    },
  };
});

import { refreshModelGroups, saveModelGroups } from '@/features/model-groups/modelGroupsClient';
import { ModelGroupsSection } from '../ModelGroupsSection';

beforeEach(() => {
  h.config = { routes: [] };
  h.listeners.clear();
  h.confirm.mockReset().mockResolvedValue(true);
  h.toastError.mockReset();
  h.saveCalls = 0;
  h.useRealSaveQueue = false;
  Object.assign(window, {
    electronAPI: {
      modelGroups: {
        get: async () => h.config,
        set: vi.fn(async (next: ModelGroupsConfig) => {
          h.config = normalizeModelGroupsConfig(next);
          for (const listener of h.listeners) listener();
          return h.config;
        }),
        decisions: vi.fn().mockResolvedValue([]),
        resolve: vi.fn().mockResolvedValue({ outcome: 'unavailable', groupName: '', trace: [] }),
      },
      subscriptionAccounts: {
        command: vi.fn().mockResolvedValue(null),
        onChanged: () => () => undefined,
      },
    },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => cleanup());

function openUserRoute(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-model-group-route="${id}"]`);
  expect(row).toBeTruthy();
  fireEvent.click(row!);
}

function openSourceRoute(id: string) {
  const row = document.querySelector<HTMLElement>(`[data-source-route="${id}"]`);
  expect(row).toBeTruthy();
  fireEvent.click(row!);
}

describe('ModelGroupsSection route type selector', () => {
  it('places the route type radio cards at the top of a model route and removes redundant copy', async () => {
    h.config = {
      routes: [{ id: 'r-empty', name: 'New route', strategy: 'expiring', candidates: [] }],
    };
    render(<ModelGroupsSection />);
    openUserRoute('r-empty');

    const detail = await screen.findByTestId('model-group-route-detail');
    const radioGroup = within(detail).getByRole('radiogroup', { name: 'modelGroups.settings.routeType' });
    const nameInput = within(detail).getByRole('textbox', { name: 'modelGroups.settings.name' });
    // 路由类型必须位于基本设置（名字）之前。
    expect(Boolean(radioGroup.compareDocumentPosition(nameInput) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    const modelRadio = within(radioGroup).getByRole('radio', { name: /modelGroups\.settings\.routeTypeModel/ });
    const providerRadio = within(radioGroup).getByRole('radio', { name: /modelGroups\.settings\.routeTypeProvider/ });
    expect(modelRadio.getAttribute('aria-checked')).toBe('true');
    expect(providerRadio.getAttribute('aria-checked')).toBe('false');

    // 精简后的文案：无页头副文案、无来源副文案、无内嵌添加整个供应商行、空状态显示合并说明。
    expect(within(detail).queryByText('modelGroups.settings.routeShownAs')).toBeNull();
    expect(within(detail).queryByText('modelGroups.settings.sourcesHint')).toBeNull();
    expect(within(detail).queryByText('modelGroups.sources.addWhole')).toBeNull();
    expect(within(detail).getByText('modelGroups.settings.sourcesEmpty')).toBeTruthy();
    expect(within(detail).getByText('modelGroups.settings.addSource')).toBeTruthy();
    // addModelHint 只出现在「模型路由」单选卡片内，不再在添加行重复。
    expect(within(detail).getAllByText('modelGroups.sources.addModelHint')).toHaveLength(1);
  });

  it('switches an empty model route to a provider route immediately without confirmation and strips effort', async () => {
    h.config = {
      routes: [{
        id: 'r-1',
        name: 'My Route',
        strategy: 'order',
        effort: 'high',
        autoSwitch: false,
        exceptions: [{ when: { type: 'image' }, use: 'vision' }],
        candidates: [],
      }],
    };
    render(<ModelGroupsSection />);
    openUserRoute('r-1');

    const detail = await screen.findByTestId('model-group-route-detail');
    const providerRadio = within(detail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeProvider/ });
    fireEvent.click(providerRadio);

    const sourceDetail = await screen.findByTestId('model-groups-source-route');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.config.routes).toEqual([]);
    expect(h.config.sourceRoutes).toEqual([{
      id: 'r-1',
      name: 'My Route',
      strategy: 'order',
      autoSwitch: false,
      exceptions: [{ when: { type: 'image' }, use: 'vision' }],
      sources: [],
    }]);
    // 供应商路由页：无页头 detailHint，无推理强度行，添加供应商行不重复 addWholeHint。
    expect(within(sourceDetail).queryByText('modelGroups.sources.detailHint')).toBeNull();
    expect(within(sourceDetail).queryByText('modelGroups.settings.effort')).toBeNull();
    expect(within(sourceDetail).getByText('modelGroups.sources.addWhole')).toBeTruthy();
    expect(within(sourceDetail).getAllByText('modelGroups.sources.addWholeHint')).toHaveLength(1);
    const checkedProviderRadio = within(sourceDetail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeProvider/ });
    expect(checkedProviderRadio.getAttribute('aria-checked')).toBe('true');
  });

  it('asks for confirmation before switching a model route that already has sources', async () => {
    h.config = {
      routes: [{
        id: 'r-filled',
        name: 'Filled',
        strategy: 'weighted',
        effort: 'medium',
        candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-5' }],
      }],
    };
    render(<ModelGroupsSection />);
    openUserRoute('r-filled');

    const detail = await screen.findByTestId('model-group-route-detail');
    // 按权重时仍保留权重说明。
    expect(within(detail).getByText('modelGroups.settings.weightHint')).toBeTruthy();

    // 取消切换：不保存，候选保留。
    h.confirm.mockResolvedValueOnce(false);
    fireEvent.click(within(detail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeProvider/ }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(h.saveCalls).toBe(0);
    expect(h.config.routes[0]!.candidates).toHaveLength(1);

    // 确认切换：清空候选、保留名字与选法、不带 effort，并切换到供应商路由详情页。
    h.confirm.mockResolvedValueOnce(true);
    fireEvent.click(within(detail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeProvider/ }));
    await screen.findByTestId('model-groups-source-route');
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.config.routes).toEqual([]);
    expect(h.config.sourceRoutes).toEqual([{
      id: 'r-filled',
      name: 'Filled',
      strategy: 'weighted',
      sources: [],
    }]);
  });

  it('switches a user provider route back to a model route via keyboard arrow and confirmation', async () => {
    h.config = {
      routes: [],
      sourceRoutes: [{
        id: 'sr-1',
        name: 'Providers',
        strategy: 'rotate',
        sources: [{ providerId: 'openai' }],
      }],
    };
    render(<ModelGroupsSection />);
    openSourceRoute('sr-1');

    const sourceDetail = await screen.findByTestId('model-groups-source-route');
    const providerRadio = within(sourceDetail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeProvider/ });
    providerRadio.focus();
    fireEvent.keyDown(providerRadio, { key: 'ArrowLeft' });

    const modelDetail = await screen.findByTestId('model-group-route-detail');
    const modelRadio = within(modelDetail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeModel/ });
    expect(document.activeElement).toBe(modelRadio);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.config.sourceRoutes).toEqual([]);
    expect(h.config.routes).toEqual([{
      id: 'sr-1',
      name: 'Providers',
      strategy: 'rotate',
      candidates: [],
    }]);
  });

  it('asks before removing a source whose save completes after clicking switch', async () => {
    h.useRealSaveQueue = true;
    h.config = {
      routes: [],
      sourceRoutes: [{ id: 'sr-pending', name: 'Pending', strategy: 'order', sources: [] }],
    };
    await refreshModelGroups();
    const set = vi.mocked(window.electronAPI.modelGroups.set);
    let finishSave!: () => void;
    set.mockImplementationOnce((next) => new Promise((resolve) => {
      finishSave = () => {
        h.config = normalizeModelGroupsConfig(next);
        for (const listener of h.listeners) listener();
        resolve(h.config);
      };
    }));
    render(<ModelGroupsSection />);
    openSourceRoute('sr-pending');
    const firstSave = saveModelGroups((latest) => ({
      ...latest,
      sourceRoutes: latest.sourceRoutes!.map((route) => ({ ...route, sources: [{ providerId: 'openai' }] })),
    }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));

    h.confirm.mockResolvedValueOnce(false);
    const detail = screen.getByTestId('model-groups-source-route');
    fireEvent.click(within(detail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeModel/ }));
    await act(async () => {
      finishSave();
      await firstSave;
    });

    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledTimes(1);
    expect(h.config.sourceRoutes?.[0]?.sources).toEqual([{ providerId: 'openai' }]);
    expect(screen.getByTestId('model-groups-source-route')).toBeTruthy();
  });

  it('warns before switching an empty model route that another route uses as a timed exception', async () => {
    h.useRealSaveQueue = true;
    const redirect = { when: { type: 'hours' as const, from: 8, to: 9 }, use: { type: 'route' as const, routeId: 'target' } };
    h.config = normalizeModelGroupsConfig({
      routes: [
        { id: 'target', name: 'Target', strategy: 'order', candidates: [] },
        { id: 'caller', name: 'Caller', strategy: 'order', candidates: [], exceptions: [redirect] },
      ],
    });
    expect(h.config.routes[1]?.exceptions).toEqual([redirect]);
    await refreshModelGroups();
    render(<ModelGroupsSection />);
    openUserRoute('target');
    h.confirm.mockResolvedValueOnce(false);
    const detail = screen.getByTestId('model-group-route-detail');
    const providerRadio = within(detail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeProvider/ });
    fireEvent.click(providerRadio);

    await waitFor(() => expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('modelGroups.settings.switchTypeConfirmTargetWarning'),
    })));
    expect(window.electronAPI.modelGroups.set).not.toHaveBeenCalled();
    expect(h.config.routes[1]?.exceptions).toEqual([redirect]);
    await waitFor(() => expect((providerRadio as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(providerRadio);
    await screen.findByTestId('model-groups-source-route');
    expect(h.config.routes[0]).toMatchObject({ id: 'caller' });
    expect(h.config.routes[0]?.exceptions).toBeUndefined();
  });

  it('hides route type cards and preserves the auto-route note on auto-merged provider routes', async () => {
    h.config = {
      routes: [],
      sourceRoutes: [{
        id: 'auto:openai',
        name: 'OpenAI',
        strategy: 'expiring',
        sources: [{ providerId: 'openai' }],
        auto: true,
      }],
    };
    render(<ModelGroupsSection />);
    openSourceRoute('auto:openai');

    const sourceDetail = await screen.findByTestId('model-groups-source-route');
    expect(within(sourceDetail).queryByRole('radiogroup')).toBeNull();
    expect(within(sourceDetail).getByText('modelGroups.sources.note')).toBeTruthy();
  });

  it('keeps the converted route when automatic routes fill the visible provider list', async () => {
    // The IPC normalizer truncates before persistence strips generated routes.
    // 63 custom rows plus one automatic row must still leave a custom slot.
    h.useRealSaveQueue = true;
    h.config = {
      routes: [{ id: 'convert-me', name: 'Keep me', strategy: 'expiring', candidates: [] }],
      sourceRoutes: [
        ...Array.from({ length: MODEL_GROUP_LIMITS.routes * 2 - 1 }, (_, index) => ({
          id: `sr-${index}`, name: `Provider route ${index}`, strategy: 'expiring' as const, sources: [],
        })),
        { id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', auto: true, sources: [{ providerId: 'openai' }] },
      ],
    };
    await refreshModelGroups();
    render(<ModelGroupsSection />);
    openUserRoute('convert-me');
    const detail = screen.getByTestId('model-group-route-detail');
    fireEvent.click(within(detail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeProvider/ }));

    await waitFor(() => {
      expect(h.config.sourceRoutes?.map((route) => route.id)).toContain('convert-me');
    });
    expect(h.config.sourceRoutes).toHaveLength(MODEL_GROUP_LIMITS.routes * 2);
    expect(h.config.routes).toEqual([]);
    expect(await screen.findByTestId('model-groups-source-route')).toBeTruthy();
  });

  it('refuses to convert a provider route when model routes are already at the limit', async () => {
    h.config = {
      routes: Array.from({ length: MODEL_GROUP_LIMITS.routes }, (_, index) => ({
        id: `r-${index}`,
        name: `Route ${index}`,
        strategy: 'expiring' as const,
        candidates: [],
      })),
      sourceRoutes: [{
        id: 'sr-keep',
        name: 'Keep Me',
        strategy: 'expiring',
        sources: [],
      }],
    };
    render(<ModelGroupsSection />);
    openSourceRoute('sr-keep');

    const sourceDetail = await screen.findByTestId('model-groups-source-route');
    fireEvent.click(within(sourceDetail).getByRole('radio', { name: /modelGroups\.settings\.routeTypeModel/ }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('modelGroups.settings.saveFailed'));
    expect(h.config.sourceRoutes).toHaveLength(1);
    expect(h.config.sourceRoutes![0]!.id).toBe('sr-keep');
    expect(screen.getByTestId('model-groups-source-route')).toBeTruthy();
  });
});
