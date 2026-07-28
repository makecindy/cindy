// @vitest-environment jsdom

/**
 * ProvidersSection — 深链定位(?connect / ?wizard)关键不变量:
 *   1. connect=<内置未占行渠道> → 向导以 builtin entry 直达授权步;URL 参数消费后被清除。
 *   2. connect=<左栏占行供应商>(如已连接的 anthropic)→ 直接选中,不开向导。
 *   3. connect=<目录外 id> → 视为 preset id,向导以 preset entry 打开。
 *   4. wizard=1 → 向导目录第一步(entry undefined)。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const { wizardSpy, providersState } = vi.hoisted(() => ({
  wizardSpy: vi.fn(),
  providersState: { providers: [] as unknown[] },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: providersState.providers, loading: false, refetch: vi.fn() }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'local', exitLocalMode: vi.fn(async () => undefined) }),
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
  providerSubtitleForDisplay: () => 'subtitle',
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
  AddProviderWizard: (props: { entry?: unknown }) => {
    wizardSpy(props.entry);
    return React.createElement('div', { 'data-testid': 'wizard-stub' });
  },
}));

import { ProvidersSection } from '@/components/settings/ProvidersSection';

function makeProvider(id: string, over?: Partial<ProviderView>): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'oauth' },
    routing: {},
    models: { 'claude-code': [] },
    connected: false,
    ...over,
  } as unknown as ProviderView;
}

function SearchProbe() {
  const location = useLocation();
  return <div data-testid="search">{location.search}</div>;
}

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <Routes>
        <Route
          path="/settings"
          element={
            <>
              <ProvidersSection />
              <SearchProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  providersState.providers = [
    makeProvider('anthropic', { name: 'Anthropic' }),
    makeProvider('xd', {
      name: 'Cindy AI',
      auth: { method: 'managed' } as ProviderView['auth'],
      agents: ['claude-code', 'codex'],
      models: { 'claude-code': [], codex: [] },
    }),
  ];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — 深链定位', () => {
  it('connect=anthropic(未占行内置渠道)→ 向导 builtin 直达;参数消费后清除', async () => {
    renderAt('?tab=providers&connect=anthropic');

    await waitFor(() => expect(screen.queryByTestId('wizard-stub')).not.toBeNull());
    expect(wizardSpy).toHaveBeenCalledWith({ kind: 'builtin', providerId: 'anthropic' });
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  it('connect=<左栏占行供应商> → 直接选中,不开向导', async () => {
    providersState.providers = [
      makeProvider('anthropic', { name: 'Anthropic', connected: true }),
      makeProvider('xd', {
        name: 'Cindy AI',
        auth: { method: 'managed' } as ProviderView['auth'],
        agents: ['claude-code', 'codex'],
        models: { 'claude-code': [], codex: [] },
      }),
    ];
    renderAt('?tab=providers&connect=anthropic');

    // 详情头切到 anthropic(默认是置顶的 xd;title key 只在详情头出现)。向导不打开。
    await waitFor(() =>
      expect(screen.getByText('settings.providers.anthropic.title')).not.toBeNull(),
    );
    expect(screen.queryByTestId('wizard-stub')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  it('connect=<目录外 id> → 视为 preset id,向导 preset entry 打开', async () => {
    renderAt('?tab=providers&connect=deepseek');

    await waitFor(() => expect(screen.queryByTestId('wizard-stub')).not.toBeNull());
    expect(wizardSpy).toHaveBeenCalledWith({ kind: 'preset', presetId: 'deepseek' });
  });

  it('目录无 xd(无账号会话)→ 左栏置顶 Cindy 登录引导行,connect=xd 落到该行,CTA 跳 /login', async () => {
    const { fireEvent } = await import('@testing-library/react');
    providersState.providers = [makeProvider('anthropic', { name: 'Anthropic' })];
    render(
      <MemoryRouter initialEntries={['/settings?tab=providers&connect=xd']}>
        <Routes>
          <Route path="/settings" element={<ProvidersSection />} />
          <Route path="/login" element={<div data-testid="login-page" />} />
        </Routes>
      </MemoryRouter>,
    );

    // 引导行 + 右栏登录引导(connect=xd 深链选中;列表为空时它也是默认选中)。
    expect(await screen.findByText('settings.providers.xdSignin.badge')).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByText('settings.providers.xdSignin.desc')).not.toBeNull(),
    );
    expect(screen.queryByTestId('wizard-stub')).toBeNull();

    fireEvent.click(screen.getByText('settings.providers.xdSignin.cta'));
    // local 模式:先 exitLocalMode 再进 /login(直跳会被 GuestRoute 弹回)。
    await waitFor(() => expect(screen.getByTestId('login-page')).not.toBeNull());
  });

  it('wizard=1 → 向导目录第一步(无 entry);参数清除', async () => {
    renderAt('?tab=providers&wizard=1');

    await waitFor(() => expect(screen.queryByTestId('wizard-stub')).not.toBeNull());
    expect(wizardSpy).toHaveBeenCalledWith(undefined);
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  it('authorization-code 自定义供应商登录期间卸载时取消本视图拥有的授权', async () => {
    const providerOAuthLogin = vi.fn<
      (providerId: string, options?: { ownerId?: string }) => Promise<{ ok: boolean }>
    >(() => new Promise(() => undefined));
    const providerOAuthCancel = vi.fn(async () => ({ ok: true }));
    const onProviderOAuthProgress = vi.fn(() => () => undefined);
    providersState.providers = [
      makeProvider('custom-oauth', {
        name: 'Custom OAuth',
        source: 'user',
        auth: {
          method: 'oauth',
          oauth: {
            authorizeUrl: 'https://auth.example.test/authorize',
            tokenUrl: 'https://auth.example.test/token',
            clientId: 'custom-client',
            scopes: 'openid',
          },
        },
      }),
    ];
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        scanLocalCli: vi.fn(async () => ({ detections: [] })),
        providerOAuthLogin,
        providerOAuthCancel,
        onProviderOAuthProgress,
      },
    };

    const view = renderAt('?tab=providers');
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.providers.button.authorize' }),
    );
    await waitFor(() =>
      expect(providerOAuthLogin).toHaveBeenCalledWith(
        'custom-oauth',
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    const ownerId = providerOAuthLogin.mock.calls[0]?.[1]?.ownerId;
    expect(onProviderOAuthProgress).not.toHaveBeenCalled();

    view.unmount();
    expect(providerOAuthCancel).toHaveBeenCalledOnce();
    expect(providerOAuthCancel).toHaveBeenCalledWith('custom-oauth', {
      releaseOwner: true,
      ownerId,
    });
  });
});
