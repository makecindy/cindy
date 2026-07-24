// @vitest-environment jsdom

/**
 * AddProviderWizard —— OpenAI 检测建议直达的关键不变量:
 *
 *   1. 本机已有 ChatGPT 凭证(codexAuth 已是 oauth connected)但当前账号未绑定时,
 *      向导**不得**挂载即自关:codexAuth 是整机凭证态,不含按账号的 native binding,
 *      自关会既不弹 UI 也不补绑定,「去授权」从此点不出任何效果(回归:换账号死循环)。
 *   2. 本向导内点「授权」发起登录并成功 → 正常收口 onDone('openai')。
 *   3. anthropic entry 直达 → 授权步正常渲染(对照组,证明弹窗结构本身可用)。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const { codexState, triggerLoginMock } = vi.hoisted(() => ({
  codexState: { kind: 'unauthenticated' } as { kind: string; authSource?: string },
  triggerLoginMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  // 与真实实现同判定:仅 authenticated + oauth 视为 ChatGPT 已连接。
  isChatGptConnectionConnected: (state: { kind: string; authSource?: string }) =>
    state.kind === 'authenticated' && state.authSource === 'oauth',
  useCodexAuth: () => ({
    state: codexState,
    triggerLogin: triggerLoginMock,
    cancelLogin: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/customProviders', () => ({
  createCustomProvider: vi.fn(),
}));

vi.mock('@/lib/customProviderId', () => ({
  uniqueCustomProviderId: (name: string) => name,
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/components/icons/ProviderLogoMark', () => ({
  hasProviderLogo: () => false,
  ProviderLogoMark: () => null,
}));

import { AddProviderWizard } from '@/components/settings/AddProviderWizard';

const anthropicProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'builtin',
  agents: ['claude-code'],
  auth: { method: 'oauth' },
  routing: {},
  models: { 'claude-code': [] },
  connected: false,
} as unknown as ProviderView;

const openaiProvider = {
  ...anthropicProvider,
  id: 'openai',
  name: 'OpenAI',
  agents: ['claude-code', 'codex'],
} as unknown as ProviderView;

function renderWizard(providerId: string, onDone: (id?: string) => void) {
  return render(
    React.createElement(AddProviderWizard, {
      providers: [anthropicProvider, openaiProvider],
      entry: { kind: 'builtin' as const, providerId },
      onOpenCustomForm: vi.fn(),
      onClose: vi.fn(),
      onDone,
    }),
  );
}

beforeEach(() => {
  codexState.kind = 'unauthenticated';
  delete codexState.authSource;
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

describe('AddProviderWizard — OpenAI 检测建议直达', () => {
  it('本机已有 ChatGPT 凭证但账号未绑定 → 向导保持打开,不静默自关', () => {
    codexState.kind = 'authenticated';
    codexState.authSource = 'oauth';
    const onDone = vi.fn();
    renderWizard('openai', onDone);

    // 授权步可见、可交互;onDone 不得被立即触发。
    expect(screen.getByText('settings.providers.button.authorize')).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('本向导内点「授权」登录成功 → onDone(openai) 收口', async () => {
    triggerLoginMock.mockResolvedValue('authenticated');
    const onDone = vi.fn();
    renderWizard('openai', onDone);

    fireEvent.click(screen.getByText('settings.providers.button.authorize'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('openai'));
    expect(triggerLoginMock).toHaveBeenCalledTimes(1);
  });

  it('anthropic entry 直达 → 授权步正常渲染(对照组)', () => {
    const onDone = vi.fn();
    renderWizard('anthropic', onDone);

    expect(screen.getByText('settings.providers.wizard.titleWith')).not.toBeNull();
    expect(screen.getByText('settings.providers.button.authorize')).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });
});
