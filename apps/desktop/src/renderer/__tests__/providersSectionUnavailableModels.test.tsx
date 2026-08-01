// @vitest-environment jsdom

/**
 * ProvidersSection(双栏重构)关键不变量:
 *   1. Cindy AI(xd)固定置顶且默认选中;实时模型清单为空时仍保留手动刷新入口。
 *   2. 未连接的内置渠道不再常驻占行(入口在向导目录 + 检测建议)。
 *   3. 本机 CLI 检测命中且渠道未连接时,左栏出现建议行,点击直达向导授权步。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const { refreshBuiltinModelsSpy, requestAutoRefreshSpy, wizardSpy } = vi.hoisted(() => ({
  refreshBuiltinModelsSpy: vi.fn(async () => ({ ok: true, providerId: 'xd' as const })),
  requestAutoRefreshSpy: vi.fn(async () => ({ ok: true as const })),
  wizardSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: [
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
    ],
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'cloud', exitLocalMode: vi.fn(async () => undefined) }),
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
  scanResult = { detections: [] };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => scanResult),
      refreshBuiltinProviderModels: refreshBuiltinModelsSpy,
      requestProviderModelsAutoRefresh: requestAutoRefreshSpy,
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — 双栏管理', () => {
  it('Cindy AI 置顶默认选中;未连接内置渠道不占行;零模型仍可手动刷新', async () => {
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
});
