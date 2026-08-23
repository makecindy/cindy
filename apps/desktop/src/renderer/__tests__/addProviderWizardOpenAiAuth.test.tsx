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

const { triggerLogin, cancelLogin, codexAuthMock } = vi.hoisted(() => ({
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
};
let providerOAuthProgressListener: ((progress: ProviderOAuthProgress) => void) | null = null;

beforeEach(() => {
  triggerLogin.mockReset();
  cancelLogin.mockReset();
  providerOAuthLogin.mockReset();
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

    expect(screen.getByText('settings.providers.wizard.authorizeInBrowser')).not.toBeNull();
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

    fireEvent.click(screen.getByText('settings.providers.wizard.authorizeInBrowser'));

    await waitFor(() => expect(triggerLogin).toHaveBeenCalledTimes(1));
    expect(triggerLogin).toHaveBeenCalledWith('browser');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('openai'));
  });

  it('点击授权但本次登录被取消时不完成绑定', async () => {
    // 负向边界:点击本身不算完成——登录取消、状态未翻转,不得收口。
    codexAuthMock.state = { kind: 'unauthenticated' };
    triggerLogin.mockImplementation(async () => 'cancelled');
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

    fireEvent.click(screen.getByText('settings.providers.wizard.authorizeInBrowser'));

    await waitFor(() => expect(triggerLogin).toHaveBeenCalledTimes(1));
    // 先等授权流程 settle(按钮从「取消」回到「授权」= loggingIn 已复位),
    // 再做负向断言——避免「负向 waitFor」首查即过、断言早于异步流程收尾。
    await waitFor(() =>
      expect(screen.getByText('settings.providers.wizard.authorizeInBrowser')).not.toBeNull(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('设备码路径展示代码，并支持复制和打开官方验证页', async () => {
    codexAuthMock.state = { kind: 'unauthenticated' };
    triggerLogin.mockImplementation(() => {
      codexAuthMock.state = {
        kind: 'login-pending',
        mode: 'device-code',
        deviceCode: {
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'RUH2-7E2VH',
        },
      };
      return new Promise<string>(() => undefined);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    (
      window.electronAPI as unknown as {
        openExternal: typeof openExternal;
      }
    ).openExternal = openExternal;

    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        entry={{ kind: 'builtin', providerId: 'openai' }}
        onOpenCustomForm={vi.fn()}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('settings.providers.wizard.authorizeWithDeviceCode'));
    await waitFor(() => expect(screen.getByText('RUH2-7E2VH')).not.toBeNull());
    expect(triggerLogin).toHaveBeenCalledWith('device-code');

    fireEvent.click(screen.getByText('settings.providers.wizard.copyDeviceCode'));
    fireEvent.click(screen.getByText('settings.providers.wizard.openVerificationPage'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('RUH2-7E2VH'));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/codex/device'),
    );
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
