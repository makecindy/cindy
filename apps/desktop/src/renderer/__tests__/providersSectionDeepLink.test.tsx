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

const {
  wizardSpy,
  providersState,
  codexAuthState,
  codexAuthActions,
  toastError,
  setModelVisibilitiesSpy,
  customDialogSpy,
} = vi.hoisted(() => ({
  wizardSpy: vi.fn(),
  providersState: { providers: [] as unknown[], order: [] as string[] },
  codexAuthState: {
    state: { kind: 'unauthenticated' } as Record<string, unknown>,
    reconnectCredentialScope: undefined as string | undefined,
    recoveryCheck: 'idle' as 'idle' | 'checking' | 'failed',
  },
  codexAuthActions: {
    refresh: vi.fn(async () => undefined),
    triggerLogin: vi.fn(async () => 'authenticated'),
    cancelLogin: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  },
  toastError: vi.fn(),
  setModelVisibilitiesSpy: vi.fn(() => true),
  customDialogSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: providersState.providers,
    providerOrder: providersState.order,
    ownerGeneration: 1,
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'local', exitLocalMode: vi.fn(async () => undefined) }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: (state: { kind?: string; authSource?: string }) =>
    state.kind === 'authenticated' && state.authSource === 'oauth',
  useCodexAuth: () => ({
    ...codexAuthState,
    ...codexAuthActions,
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
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock('@/lib/customProviders', () => ({
  deleteCustomProvider: vi.fn(),
  providerViewToCustomProviderConfig: (provider: ProviderView) => ({
    id: provider.id,
    name: provider.name,
    auth: provider.auth,
    runtimes: {},
  }),
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
  setModelVisibilities: setModelVisibilitiesSpy,
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/CustomProviderDialog', () => ({
  CustomProviderDialog: (props: unknown) => {
    customDialogSpy(props);
    return React.createElement('div', { 'data-testid': 'custom-provider-dialog-stub' });
  },
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
  codexAuthState.state = { kind: 'unauthenticated' };
  codexAuthState.reconnectCredentialScope = undefined;
  codexAuthState.recoveryCheck = 'idle';
  providersState.order = [];
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
      requestProviderModelsAutoRefresh: vi.fn(async () => ({ ok: true })),
      setProviderOrder: vi.fn(async () => ({ ok: true })),
    },
    openChatGPTApp: vi.fn(async () => ({ success: true })),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — 深链定位', () => {
  it('Dev 只读复用 OpenAI 登录态时保持已连接且不能断开', async () => {
    codexAuthState.state = {
      kind: 'authenticated',
      authSource: 'oauth',
      credentialScope: 'system-shared',
      oauthWritesBlocked: true,
    };
    providersState.providers = [
      makeProvider('openai', {
        name: 'OpenAI',
        agents: ['codex', 'claude-code'],
        connected: true,
        models: { codex: [], 'claude-code': [] },
      }),
    ];
    renderAt('?tab=providers&connect=openai');

    const disconnect = await screen.findByRole('button', {
      name: 'settings.providers.button.disconnect',
    });
    expect((disconnect as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(disconnect);
    expect(codexAuthActions.logout).not.toHaveBeenCalled();
  });

  it('ChatGPT 系统共享登录失效时显示来源说明并打开 ChatGPT App', async () => {
    codexAuthState.state = {
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    };
    codexAuthState.reconnectCredentialScope = 'system-shared';
    providersState.providers = [
      makeProvider('openai', {
        name: 'OpenAI',
        agents: ['codex', 'claude-code'],
        connected: false,
        models: { codex: [], 'claude-code': [] },
      }),
    ];
    renderAt('?tab=providers&connect=openai');

    const openAiListRow = await screen.findByRole('button', { name: /OpenAI/ });
    expect(openAiListRow.textContent).toContain('settings.providers.openai.reconnectRequired');
    expect((openAiListRow.lastElementChild as HTMLElement).style.backgroundColor).toBe(
      'var(--remote-status-failed)',
    );
    expect(await screen.findByText('chatgptAuthRecovery.systemSharedInvalidated')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'chatgptAuthRecovery.openApp' }));

    await waitFor(() => expect(window.electronAPI.openChatGPTApp).toHaveBeenCalledOnce());
    expect(codexAuthActions.triggerLogin).not.toHaveBeenCalled();
  });

  it('ChatGPT 系统共享打开 App 后保留恢复入口', async () => {
    codexAuthState.state = {
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    };
    codexAuthState.reconnectCredentialScope = 'system-shared';
    providersState.providers = [
      makeProvider('openai', {
        name: 'OpenAI',
        agents: ['codex', 'claude-code'],
        connected: false,
        models: { codex: [], 'claude-code': [] },
      }),
    ];
    renderAt('?tab=providers&connect=openai');

    fireEvent.click(await screen.findByRole('button', { name: 'chatgptAuthRecovery.openApp' }));

    await waitFor(() => expect(window.electronAPI.openChatGPTApp).toHaveBeenCalledOnce());
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'chatgptAuthRecovery.openApp' })).not.toBeNull();
  });

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

  it('内置供应商深链会选中并定位目标模型行', async () => {
    providersState.providers = [
      makeProvider('openai', {
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        models: {
          codex: [
            {
              id: 'gpt-unknown',
              name: 'GPT Unknown',
              contextWindow: 0,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
      }),
    ];
    const view = renderAt('?tab=providers&connect=openai&model=gpt-unknown&agent=codex');

    await waitFor(() =>
      expect(view.container.querySelector('[data-deep-link-target="true"]')).not.toBeNull(),
    );
    expect(screen.getByText('GPT Unknown')).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  it('自定义供应商深链会打开编辑表单并定位模型上下文窗口', async () => {
    providersState.providers = [
      makeProvider('custom-provider', {
        name: 'Custom Provider',
        source: 'user',
        connected: true,
        agents: ['codex'],
        auth: { method: 'apiKey' },
        models: {
          codex: [
            {
              id: 'custom-model',
              name: 'Custom Model',
              contextWindow: 0,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
      }),
    ];
    renderAt('?tab=providers&connect=custom-provider&model=custom-model&agent=codex');

    expect(await screen.findByTestId('custom-provider-dialog-stub')).not.toBeNull();
    expect(customDialogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        focusModelId: 'custom-model',
        focusAgent: 'codex',
        initial: expect.objectContaining({ id: 'custom-provider' }),
      }),
    );
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

  it('统一模型开关跨 agent 一次提交，失败时提示用户', async () => {
    providersState.providers = [
      makeProvider('dual', {
        name: 'Dual',
        connected: true,
        agents: ['claude-code', 'codex'],
        models: {
          'claude-code': [
            {
              id: 'shared',
              name: 'Shared',
              contextWindow: 200_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
          codex: [
            {
              id: 'shared',
              name: 'Shared',
              contextWindow: 272_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
      }),
    ];
    setModelVisibilitiesSpy.mockReturnValueOnce(false);
    renderAt('?tab=providers');

    fireEvent.click(await screen.findByRole('switch', { name: 'Shared' }));

    expect(setModelVisibilitiesSpy).toHaveBeenCalledOnce();
    expect(setModelVisibilitiesSpy).toHaveBeenCalledWith(
      'dual',
      [
        { agent: 'claude-code', modelId: 'shared' },
        { agent: 'codex', modelId: 'shared' },
      ],
      false,
    );
    expect(toastError).toHaveBeenCalledWith('settings.providers.models.visibilityWriteFailed');
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
        requestProviderModelsAutoRefresh: vi.fn(async () => ({ ok: true })),
        providerOAuthLogin,
        providerOAuthCancel,
        onProviderOAuthProgress,
        setProviderOrder: vi.fn(async () => ({ ok: true })),
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
