// @vitest-environment jsdom

/**
 * ProvidersSection(双栏重构)关键不变量:
 *   1. 首个可见供应商默认选中;Cindy AI 实时模型清单为空时仍保留手动刷新入口。
 *   2. 未连接的内置渠道不再常驻占行(入口在向导目录 + 检测建议)。
 *   3. 本机 CLI 检测命中且渠道未连接时,左栏出现建议行,点击直达向导授权步。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const {
  refreshBuiltinModelsSpy,
  requestAutoRefreshSpy,
  setProviderOrderSpy,
  refetchProvidersSpy,
  authState,
  providerSnapshotState,
  wizardSpy,
} = vi.hoisted(() => ({
  refreshBuiltinModelsSpy: vi.fn(async () => ({ ok: true, providerId: 'xd' as const })),
  requestAutoRefreshSpy: vi.fn(async () => ({ ok: true as const })),
  setProviderOrderSpy: vi.fn(async () => ({ ok: true as const })),
  refetchProvidersSpy: vi.fn(),
  authState: { dataOwnerId: 'owner-1' as string | null },
  providerSnapshotState: {
    dataOwnerId: 'owner-1' as string | null,
    ownerGeneration: 1,
    order: ['anthropic', 'xd', 'custom'],
  },
  wizardSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => {
    const providers = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: {},
        models: {
          'claude-code': [
            {
              id: 'claude-sonnet-5',
              name: 'Sonnet 5',
              contextWindow: 200_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
        connected: false,
      } satisfies ProviderView,
      {
        id: 'xd',
        name: 'XD Gateway',
        source: 'builtin',
        agents: ['claude-code', 'codex'],
        auth: { method: 'managed' },
        routing: {},
        models: { 'claude-code': [], codex: [] },
        connected: false,
      } satisfies ProviderView,
      {
        id: 'custom',
        name: 'Custom',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {},
        models: {
          codex: [
            {
              id: 'custom-model',
              name: 'Custom model',
              contextWindow: 128_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
        connected: true,
      } satisfies ProviderView,
    ];
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    return {
      providers:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId
          ? [...byId.values()]
          : [],
      providerOrder:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId
          ? providerSnapshotState.order
          : [],
      ownerGeneration:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId
          ? providerSnapshotState.ownerGeneration
          : null,
      loading: providerSnapshotState.dataOwnerId !== authState.dataOwnerId,
      refetch: refetchProvidersSpy,
    };
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    mode: 'cloud',
    dataOwnerId: authState.dataOwnerId,
    exitLocalMode: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: () => false,
  useCodexAuth: () => ({
    state: { kind: 'unauthenticated' },
    triggerLogin: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ key: '', hasSavedKey: false, clearKey: vi.fn() }),
}));

vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ state: 'failed', source: null, endpoint: null }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/customProviders', () => ({
  deleteCustomProvider: vi.fn(),
  readCustomProviderKey: vi.fn(async () => null),
  updateCustomProvider: vi.fn(),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/lib/providerSubtitle', () => ({
  customProviderSubtitleForDisplay: () => '',
  providerSubtitleForDisplay: () => 'XD Gateway',
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  setManyVisibility: vi.fn(),
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/CustomProviderDialog', () => ({
  CustomProviderDialog: () => null,
}));

vi.mock('@/components/settings/AddProviderWizard', () => ({
  AddProviderWizard: (props: { entry?: { kind: string; providerId: string } }) => {
    wizardSpy(props.entry);
    return React.createElement('div', { 'data-testid': 'wizard-stub' });
  },
}));

import { ProvidersSection } from '@/components/settings/ProvidersSection';

type ScanResult = { detections: unknown[] };
let scanResult: ScanResult;

beforeEach(() => {
  authState.dataOwnerId = 'owner-1';
  providerSnapshotState.dataOwnerId = 'owner-1';
  providerSnapshotState.ownerGeneration = 1;
  providerSnapshotState.order = ['anthropic', 'xd', 'custom'];
  scanResult = { detections: [] };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => scanResult),
      refreshBuiltinProviderModels: refreshBuiltinModelsSpy,
      requestProviderModelsAutoRefresh: requestAutoRefreshSpy,
      setProviderOrder: setProviderOrderSpy,
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — 双栏管理', () => {
  it('首个可见供应商默认选中;未连接内置渠道不占行;零模型仍可手动刷新', async () => {
    // ProvidersSection 内部消费 useSearchParams(深链定位),测试需要 Router 上下文。
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
    expect(requestAutoRefreshSpy).toHaveBeenCalledWith('providers-open');

    // 详情头 + 左栏行都显示 xd 标题(默认选中第一行 = xd)。
    expect(
      (await screen.findAllByText('settings.providers.xd.title')).length,
    ).toBeGreaterThanOrEqual(2);
    // 未连接的 Anthropic 不出现在左栏(无检测建议时整页不出现)。
    expect(screen.queryByText('Anthropic')).toBeNull();
    // xd 实时模型为空 → 详情仍渲染模型工具行与刷新入口，避免用户无从恢复。
    expect(screen.getByText('settings.providers.detail.emptyModels')).not.toBeNull();
    expect(screen.getByText('settings.providers.models.available')).not.toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' }),
      );
    });
    expect(refreshBuiltinModelsSpy).toHaveBeenCalledWith('xd');
  });

  it('同一事件循环内连续点击刷新只启动一个请求', async () => {
    let resolveRefresh!: (value: { ok: true; providerId: 'xd' }) => void;
    const pendingRefresh = new Promise<{ ok: true; providerId: 'xd' }>((resolve) => {
      resolveRefresh = resolve;
    });
    refreshBuiltinModelsSpy.mockReturnValueOnce(pendingRefresh);
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    const button = await screen.findByRole('button', {
      name: 'settings.providers.models.refreshBuiltinAria',
    });
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(refreshBuiltinModelsSpy).toHaveBeenCalledTimes(1);
    const refreshingButton = screen.getByRole('button', {
      name: 'settings.providers.models.refreshingAria',
    });
    expect(refreshingButton.getAttribute('title'))
      .toBe('settings.providers.models.refreshingAria');

    await act(async () => {
      resolveRefresh({ ok: true, providerId: 'xd' });
      await pendingRefresh;
    });
  });

  it('检测到本机 CLI 且渠道未连接 → 建议行出现,点击直达向导授权步', async () => {
    scanResult = {
      detections: [
        { cli: 'claude-cli', providerId: 'anthropic', installed: true, loggedIn: true },
        { cli: 'codex-cli', providerId: 'openai', installed: false, loggedIn: false },
      ],
    };
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    // 建议组标签 + Anthropic 建议行(codex 未安装不出现)。
    expect(await screen.findByText('settings.providers.detect.groupLabel')).not.toBeNull();
    const action = screen.getByText('settings.providers.detect.action');
    fireEvent.click(action.closest('button')!);

    // 向导以 entry 直达 anthropic。
    expect(screen.getByTestId('wizard-stub')).not.toBeNull();
    expect(wizardSpy).toHaveBeenCalledWith({ kind: 'builtin', providerId: 'anthropic' });
  });

  it('首次记录可见项，并用方向键提交新的可见顺序', async () => {
    providerSnapshotState.order = ['anthropic', 'xd'];
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );

    const handles = await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-1', 1, ['custom']);
    await act(async () => {
      fireEvent.keyDown(handles[0]!, { key: 'ArrowDown' });
      await Promise.resolve();
    });
    // Renderer 只提交左栏顺序；Main 负责保留曾出现但当前隐藏的供应商槽位。
    expect(setProviderOrderSpy).toHaveBeenLastCalledWith('owner-1', 1, ['custom', 'xd']);
    const selectedRows = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'true');
    expect(selectedRows).toHaveLength(1);
    expect(selectedRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(screen.queryByRole('button', { name: 'settings.providers.order.reset' })).toBeNull();

    // Main 对未观察隐藏项的权威结果会把它放到末尾。pending 只比较左栏可见顺序，
    // 收到该快照后应清除；后续 Main 顺序变化不得再被旧乐观状态覆盖。
    await act(async () => {
      providerSnapshotState.order = ['custom', 'xd', 'anthropic'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    await act(async () => {
      providerSnapshotState.order = ['xd', 'custom', 'anthropic'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    const providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(providerRows[1]?.textContent).toContain('Custom');
  });

  it('已有顺序快照挂载时不自动回写，避免旧窗口覆盖显式排序', async () => {
    providerSnapshotState.order = ['anthropic', 'custom', 'xd'];
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    expect(setProviderOrderSpy).not.toHaveBeenCalled();
  });

  it('写入结束后的同目录权威快照会结束乐观排序，以另一窗口的后写结果为准', async () => {
    let resolveOrderWrite!: (value: { ok: true }) => void;
    const orderWrite = new Promise<{ ok: true }>((resolve) => {
      resolveOrderWrite = resolve;
    });
    setProviderOrderSpy.mockReturnValueOnce(orderWrite);
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );

    const handles = await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    fireEvent.keyDown(handles[0]!, { key: 'ArrowDown' });
    let providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('Custom');
    expect(providerRows[1]?.textContent).toContain('settings.providers.xd.title');

    await act(async () => {
      resolveOrderWrite({ ok: true });
      await orderWrite;
      await Promise.resolve();
    });
    expect(refetchProvidersSpy).toHaveBeenCalledOnce();

    // B 窗口后写成为 Main 最终顺序；目录成员没变，但新快照必须结束 A 的 pending。
    await act(async () => {
      providerSnapshotState.order = ['anthropic', 'xd', 'custom'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(providerRows[1]?.textContent).toContain('Custom');
  });

  it('切换数据 owner 后会按新 owner 重新记录可见项', async () => {
    providerSnapshotState.order = ['anthropic', 'xd'];
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );
    await waitFor(() => {
      expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-1', 1, ['custom']);
    });
    setProviderOrderSpy.mockClear();

    await act(async () => {
      authState.dataOwnerId = 'owner-2';
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    expect(setProviderOrderSpy).not.toHaveBeenCalled();

    await act(async () => {
      providerSnapshotState.dataOwnerId = 'owner-2';
      providerSnapshotState.ownerGeneration = 2;
      providerSnapshotState.order = ['xd'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-2', 2, ['custom']);
    });
  });
});
