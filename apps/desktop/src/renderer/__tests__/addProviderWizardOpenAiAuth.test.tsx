// @vitest-environment jsdom

/**
 * OpenAI 向导必须以本次显式授权结果为完成边界。
 *
 * 系统 ~/.codex/auth.json 可能已登录，但当前 Cindy 账号尚未绑定该凭证。仅观察到
 * useCodexAuth 的 authenticated 快照时不能自动关闭向导；否则从 CLI 检测建议进入
 * OpenAI 会出现弹窗一闪即逝，且 provider 仍保持未连接。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const { createAccount, deleteAccount, triggerLogin, cancelLogin, codexAuthMock } = vi.hoisted(() => ({
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  triggerLogin: vi.fn(),
  cancelLogin: vi.fn(),
  // 可变快照:各用例自行设定初始态;登录成功用例只有 triggerLogin 翻转
  // 到 authenticated 后才算连接,防止「既有快照」冒充「本次登录成功」。
  codexAuthMock: {
    state: { kind: 'authenticated', authSource: 'oauth' } as {
      kind: string;
      authSource?: string;
      mode?: 'browser' | 'device-code';
      deviceCode?: { verificationUrl: string; userCode: string };
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  // 与真实实现同签名同判定(loading 沿用 providerConnected,其余仅
  // authenticated + oauth 视为已连接;#268 起向导直接消费此 helper,
  // mock 必须同步导出)。
  isChatGptConnectionConnected: (
    state: { kind: string; authSource?: string },
    providerConnected: boolean,
  ) =>
    state.kind === 'loading'
      ? providerConnected
      : state.kind === 'authenticated' && state.authSource === 'oauth',
  useCodexAuth: () => ({
    state: codexAuthMock.state,
    triggerLogin,
    cancelLogin,
    logout: vi.fn(),
  }),
}));

vi.mock('@/lib/customProviders', () => ({ createCustomProvider: createAccount, deleteCustomProvider: deleteAccount }));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'O',
}));

vi.mock('@/components/icons/ProviderLogoMark', () => ({
  hasProviderLogo: () => false,
  ProviderLogoMark: () => null,
}));

import { AddProviderWizard } from '@/components/settings/AddProviderWizard';
import { invalidatePendingCodexLogin } from '@/hooks/codexAuthLogin';

const OPENAI_PROVIDER = {
  id: 'openai',
  name: 'OpenAI',
  source: 'builtin',
  agents: ['codex'],
  auth: { method: 'oauth' },
  routing: {},
  models: { codex: [] },
  connected: false,
} satisfies ProviderView;
const DEVICE_PROVIDER = {
  id: 'device-provider',
  name: 'Device Provider',
  source: 'builtin',
  agents: ['codex'],
  auth: {
    method: 'oauth',
    oauth: {
      flow: 'device-code',
      deviceAuthorizationUrl: 'https://auth.example.test/device',
      tokenUrl: 'https://auth.example.test/token',
      clientId: 'device-client',
      scopes: 'openid',
    },
  },
  routing: {
    codex: {
      upstream: 'https://api.example.test/v1',
      authStrategy: 'oauth-token',
    },
  },
  models: { codex: [] },
  connected: false,
} satisfies ProviderView;
const AUTH_CODE_PROVIDER = {
  id: 'auth-code-provider',
  name: 'Authorization Code Provider',
  source: 'builtin',
  agents: ['codex'],
  auth: {
    method: 'oauth',
    oauth: {
      authorizeUrl: 'https://auth.example.test/authorize',
      tokenUrl: 'https://auth.example.test/token',
      clientId: 'auth-code-client',
      scopes: 'openid',
    },
  },
  routing: {
    codex: {
      upstream: 'https://api.example.test/v1',
      authStrategy: 'oauth-token',
    },
  },
  models: { codex: [] },
  connected: false,
} satisfies ProviderView;

const providerOAuthLogin = vi.fn();
const providerOAuthCancel = vi.fn();
type ProviderOAuthProgress = {
  providerId: string;
  phase: 'device-code';
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
} | {
  providerId: string;
  ownerId: string;
  phase: 'browser-url';
  url: string | null;
};
let providerOAuthProgressListener: ((progress: ProviderOAuthProgress) => void) | null = null;

beforeEach(() => {
  invalidatePendingCodexLogin();
  triggerLogin.mockReset();
  cancelLogin.mockReset();
  createAccount.mockReset().mockResolvedValue(undefined);
  deleteAccount.mockReset().mockResolvedValue(undefined);
  providerOAuthLogin.mockReset().mockResolvedValue({ ok: true });
  providerOAuthCancel.mockReset();
  providerOAuthProgressListener = null;
  codexAuthMock.state = { kind: 'authenticated', authSource: 'oauth' };
  // 登录成功 = 快照翻转到 authenticated;完成边界必须由这次翻转驱动。
  triggerLogin.mockImplementation(async () => {
    codexAuthMock.state = { kind: 'authenticated', authSource: 'oauth' };
    return 'authenticated';
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      auth: { triggerLogin, cancelLogin },
      claudeOAuthLogin: triggerLogin,
      claudeOAuthCancel: cancelLogin,
      listProviderPresets: vi.fn(async () => ({ presets: [] })),
      localModelList: vi.fn(async () => ({
        status: { runtime: 'ollama', kind: 'absent', appInstalled: false },
        models: [],
        memoryGb: 0,
      })),
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
      providerOAuthLogin,
      providerOAuthCancel,
      onProviderOAuthProgress: vi.fn((listener: (progress: ProviderOAuthProgress) => void) => {
        providerOAuthProgressListener = listener;
        return () => {
          if (providerOAuthProgressListener === listener) providerOAuthProgressListener = null;
        };
      }),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddProviderWizard — OpenAI 授权边界', () => {
  it.each(['openai', 'anthropic'].flatMap(id => ['cancel', 'unmount'].map(exit => ({ id, exit }))))('discards local $id completion after $exit', async ({ id, exit }) => {
    let finish!: (value: unknown) => void;
    triggerLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    cancelLogin.mockResolvedValue({});
    const onDone = vi.fn();
    const { unmount } = render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id }]}
      entry={{ kind: 'builtin', providerId: id }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByText(id === 'openai' ? 'settings.providers.openai.useLocalAccount' : 'settings.providers.localAccount.useClaude'));
    await waitFor(() => expect(triggerLogin).toHaveBeenCalledTimes(1));
    if (exit === 'unmount') unmount();
    else fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    expect(cancelLogin).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, authenticated: true, authSource: 'oauth', credentialScope: 'system-shared' }); });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('completes a successful local OpenAI login even if CLI scanning fails', async () => {
    triggerLogin.mockResolvedValue({ authenticated: true, authSource: 'oauth', credentialScope: 'system-shared' });
    vi.mocked(window.electronAPI.maker.scanLocalCli).mockRejectedValue(new Error('EACCES'));
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[OPENAI_PROVIDER]} entry={{ kind: 'builtin', providerId: 'openai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByText('settings.providers.openai.useLocalAccount'));
    await waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith('openai'));
  });
  it.each(['openai', 'anthropic', 'xai'].flatMap(id =>
    ['cancel', 'unmount'].map(exit => ({ id, exit })),
  ))('removes $id when login succeeds after $exit', async ({ id, exit }) => {
    let finish!: (value: { ok: boolean }) => void;
    providerOAuthLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onDone = vi.fn();
    const { unmount } = render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id, name: id }]}
      entry={{ kind: 'builtin', providerId: id }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(1));
    const [accountId, options] = providerOAuthLogin.mock.calls[0];
    if (exit === 'unmount') unmount();
    else fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    expect(providerOAuthCancel).toHaveBeenCalledWith(accountId, { ownerId: options.ownerId, releaseOwner: true });
    await act(async () => { finish({ ok: true }); });
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith(accountId);
    expect(onDone).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'finish'])('reopens the pending independent account only on click and clears on %s', async (end) => {
    let finish!: (value: { ok: boolean }) => void;
    providerOAuthLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const openExternal = vi.fn(async () => ({ success: true }));
    window.electronAPI.openExternal = openExternal;
    render(<AddProviderWizard providers={[OPENAI_PROVIDER]}
      entry={{ kind: 'builtin', providerId: 'openai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledOnce());
    const [providerId, { ownerId }] = providerOAuthLogin.mock.calls[0];
    const url = 'https://auth.openai.com/oauth/authorize?state=fake';
    act(() => providerOAuthProgressListener?.({ providerId, ownerId, phase: 'browser-url', url }));
    const reopen = screen.getByRole('button', { name: 'settings.providers.genericOAuth.reopenLoginPage' });
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(reopen);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
    if (end === 'cancel') fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    await act(async () => finish({ ok: true }));
    act(() => providerOAuthProgressListener?.({ providerId, ownerId, phase: 'browser-url', url }));
    expect(screen.queryByRole('button', { name: 'settings.providers.genericOAuth.reopenLoginPage' })).toBeNull();
  });
  it('keeps the retry account when the cancelled login succeeds later', async () => {
    let finishOld!: (value: { ok: boolean }) => void;
    let finishNew!: (value: { ok: boolean }) => void;
    providerOAuthLogin.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    providerOAuthLogin.mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[OPENAI_PROVIDER]}
      entry={{ kind: 'builtin', providerId: 'openai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(1));
    const oldId = providerOAuthLogin.mock.calls[0][0];
    fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(2));
    const [newId, { ownerId }] = providerOAuthLogin.mock.calls[1];
    expect(newId).not.toBe(oldId);
    act(() => providerOAuthProgressListener?.({ providerId: newId, ownerId, phase: 'browser-url', url: 'https://auth.openai.com/authorize?retry=1' }));
    await act(async () => { finishOld({ ok: true }); });
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith(oldId);
    expect(screen.getByRole('button', { name: 'settings.providers.genericOAuth.reopenLoginPage' })).toBeTruthy();
    expect(screen.getByText('settings.providers.wizard.cancel')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => { finishNew({ ok: true }); });
    expect(onDone).toHaveBeenCalledWith(newId);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it.each(['anthropic', 'xai'])('cancels only the pending independent %s authorization', async id => {
    let finish!: (value: { ok: boolean; reason: string }) => void;
    providerOAuthLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id, name: id, connected: true }]}
      entry={{ kind: 'builtin', providerId: id }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(1));
    const [accountId, options] = providerOAuthLogin.mock.calls[0];
    fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    expect(providerOAuthCancel).toHaveBeenCalledWith(accountId, { ownerId: options.ownerId, releaseOwner: true });
    await act(async () => { finish({ ok: false, reason: 'login_cancelled' }); });
    expect(deleteAccount).toHaveBeenCalledWith(accountId);
    expect(onDone).not.toHaveBeenCalled();
  });
  it.each([['anthropic', 'claude'], ['xai', 'xai']] as const)('adds another %s account even when its builtin provider is connected', async (id, native) => {
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id, name: id, connected: true }]}
      onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByText(id));
    fireEvent.click(await screen.findByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(1));
    const accountId = providerOAuthLogin.mock.calls[0][0];
    expect(accountId).toMatch(new RegExp(`^${id}-`));
    expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({ id: accountId, auth: { method: 'oauth', native } }), {});
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(accountId));
  });
  it('已有系统 Codex OAuth 快照时仍停留在授权页，不自动完成当前 Cindy 绑定', async () => {
    const onDone = vi.fn();
    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        entry={{ kind: 'builtin', providerId: 'openai' }}
        onOpenCustomForm={vi.fn()}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );

    expect(screen.getByText('settings.providers.openai.addIndependentAccount')).not.toBeNull();
    await waitFor(() => expect(onDone).not.toHaveBeenCalled());
  });

  it('仅在用户点击授权且本次登录成功后完成绑定流程', async () => {
    // 从未认证起步:完成只能由本次 triggerLogin 成功后的状态翻转驱动,
    // 既有 authenticated 快照(上一用例的场景)不能冒充登录成功。
    codexAuthMock.state = { kind: 'unauthenticated' };
    const onDone = vi.fn();
    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        entry={{ kind: 'builtin', providerId: 'openai' }}
        onOpenCustomForm={vi.fn()}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );

    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));

    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(1));
    const accountId = providerOAuthLogin.mock.calls[0][0];
    expect(accountId).toMatch(/^openai-/);
    expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({ id: accountId, auth: { method: 'oauth', native: 'codex' } }), {});
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(accountId));
    expect(triggerLogin).not.toHaveBeenCalled();
  });

  it('点击授权但本次登录被取消时不完成绑定', async () => {
    // 负向边界:点击本身不算完成——登录取消、状态未翻转,不得收口。
    codexAuthMock.state = { kind: 'unauthenticated' };
    providerOAuthLogin.mockResolvedValue({ ok: false, reason: 'login_cancelled' });
    const onDone = vi.fn();
    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        entry={{ kind: 'builtin', providerId: 'openai' }}
        onOpenCustomForm={vi.fn()}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );

    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));

    await waitFor(() => expect(deleteAccount).toHaveBeenCalledTimes(1));
    // 先等授权流程 settle(按钮从「取消」回到「授权」= loggingIn 已复位),
    // 再做负向断言——避免「负向 waitFor」首查即过、断言早于异步流程收尾。
    await waitFor(() =>
      expect(screen.getByText('settings.providers.openai.addIndependentAccount')).not.toBeNull(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('关闭向导后才完成供应商创建时，不启动登录并清理空供应商', async () => {
    let finishCreate!: () => void;
    createAccount.mockImplementation(() => new Promise<void>((resolve) => { finishCreate = resolve; }));
    const { unmount } = render(<AddProviderWizard providers={[OPENAI_PROVIDER]}
      entry={{ kind: 'builtin', providerId: 'openai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(createAccount).toHaveBeenCalledTimes(1));
    const id = createAccount.mock.calls[0][0].id;
    unmount();
    await act(async () => { finishCreate(); });
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith(id));
    expect(providerOAuthLogin).not.toHaveBeenCalled();
  });

  it('目录声明 Device Grant 时，添加流程直接展示供应商设备码', async () => {
    providerOAuthLogin.mockImplementation(() => new Promise(() => undefined));
    const { unmount } = render(
      <AddProviderWizard
        providers={[DEVICE_PROVIDER]}
        entry={{ kind: 'builtin', providerId: DEVICE_PROVIDER.id }}
        onOpenCustomForm={vi.fn()}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() => expect(providerOAuthProgressListener).not.toBeNull());

    fireEvent.click(screen.getByText('settings.providers.wizard.authorizeWithDeviceCode'));
    await waitFor(() =>
      expect(providerOAuthLogin).toHaveBeenCalledWith(
        DEVICE_PROVIDER.id,
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    const ownerId = providerOAuthLogin.mock.calls[0]?.[1]?.ownerId;
    act(() => {
      providerOAuthProgressListener?.({
        providerId: DEVICE_PROVIDER.id,
        phase: 'device-code',
        verificationUrl: 'https://auth.example.test/device',
        userCode: 'TEST-CODE',
        expiresAt: Date.now() + 300_000,
      });
    });

    expect(await screen.findByText('TEST-CODE')).not.toBeNull();
    expect(screen.getByText(/auth\.example\.test/)).not.toBeNull();

    unmount();
    expect(providerOAuthCancel).toHaveBeenCalledOnce();
    expect(providerOAuthCancel).toHaveBeenCalledWith(DEVICE_PROVIDER.id, {
      releaseOwner: true,
      ownerId,
    });
  });

  it('authorization-code 登录期间被父级卸载时取消仍在等待的回环授权', async () => {
    providerOAuthLogin.mockImplementation(() => new Promise(() => undefined));
    const { unmount } = render(
      <AddProviderWizard
        providers={[AUTH_CODE_PROVIDER]}
        entry={{ kind: 'builtin', providerId: AUTH_CODE_PROVIDER.id }}
        onOpenCustomForm={vi.fn()}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('settings.providers.button.authorize'));
    await waitFor(() =>
      expect(providerOAuthLogin).toHaveBeenCalledWith(
        AUTH_CODE_PROVIDER.id,
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    const ownerId = providerOAuthLogin.mock.calls[0]?.[1]?.ownerId;
    expect(providerOAuthProgressListener).toBeNull();

    unmount();
    expect(providerOAuthCancel).toHaveBeenCalledOnce();
    expect(providerOAuthCancel).toHaveBeenCalledWith(AUTH_CODE_PROVIDER.id, {
      releaseOwner: true,
      ownerId,
    });
  });
});

describe('AddProviderWizard — 关闭途径(DESIGN.md §4:取消 / Esc / 遮罩)', () => {
  it('按 Esc 关闭向导', () => {
    const onClose = vi.fn();
    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        onOpenCustomForm={vi.fn()}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('输入法组合期间按 Esc 不关闭向导(取消候选词,不是关闭命令)', () => {
    const onClose = vi.fn();
    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        onOpenCustomForm={vi.fn()}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击遮罩关闭向导;点击弹窗内部不关闭', () => {
    const onClose = vi.fn();
    const { container } = render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        onOpenCustomForm={vi.fn()}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );
    // 点弹窗内部(标题):target ≠ 遮罩本身,不得关闭。
    fireEvent.click(screen.getByText('settings.providers.wizard.title'));
    expect(onClose).not.toHaveBeenCalled();
    const overlay = container.firstElementChild as HTMLElement;
    // 从弹窗内部按下、拖出到遮罩松开:合成 click 落在遮罩,但按下不始于遮罩,
    // 不得误关(防丢表单)。
    fireEvent.mouseDown(screen.getByText('settings.providers.wizard.title'));
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    // 按下与松开都在遮罩上:关闭。
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
