// @vitest-environment jsdom

/**
 * OpenAI 向导必须以本次显式授权结果为完成边界。
 *
 * 系统 ~/.codex/auth.json 可能已登录，但当前 Cindy 账号尚未绑定该凭证。仅观察到
 * useCodexAuth 的 authenticated 快照时不能自动关闭向导；否则从 CLI 检测建议进入
 * OpenAI 会出现弹窗一闪即逝，且 provider 仍保持未连接。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

beforeEach(() => {
  triggerLogin.mockReset();
  cancelLogin.mockReset();
  codexAuthMock.state = { kind: 'authenticated', authSource: 'oauth' };
  // 登录成功 = 快照翻转到 authenticated;完成边界必须由这次翻转驱动。
  triggerLogin.mockImplementation(async () => {
    codexAuthMock.state = { kind: 'authenticated', authSource: 'oauth' };
    return 'authenticated';
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      listProviderPresets: vi.fn(async () => ({ presets: [] })),
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

    expect(screen.getByText('settings.providers.button.authorize')).not.toBeNull();
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

    fireEvent.click(screen.getByText('settings.providers.button.authorize'));

    await waitFor(() => expect(triggerLogin).toHaveBeenCalledTimes(1));
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

    fireEvent.click(screen.getByText('settings.providers.button.authorize'));

    await waitFor(() => expect(triggerLogin).toHaveBeenCalledTimes(1));
    // 先等授权流程 settle(按钮从「取消」回到「授权」= loggingIn 已复位),
    // 再做负向断言——避免「负向 waitFor」首查即过、断言早于异步流程收尾。
    await waitFor(() =>
      expect(screen.getByText('settings.providers.button.authorize')).not.toBeNull(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });
});
