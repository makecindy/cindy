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

const { triggerLogin, cancelLogin } = vi.hoisted(() => ({
  triggerLogin: vi.fn(),
  cancelLogin: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  useCodexAuth: () => ({
    state: { kind: 'authenticated', authSource: 'oauth' },
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
  triggerLogin.mockResolvedValue('authenticated');
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
});
