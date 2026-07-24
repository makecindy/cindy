// @vitest-environment jsdom

/**
 * AddProviderWizard — preset 直达入口(引导卡「其他供应商」行)关键不变量:
 *   1. entry={kind:'preset',presetId}:presets 异步载入后直达表单步(step 2,
 *      名称预填预设名),一次性消费。
 *   2. presetId 在目录里不存在 → 回落目录第一步,不假装直达。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
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

const deepseekPreset = {
  id: 'deepseek',
  name: 'DeepSeek',
  runtimes: { 'claude-code': { baseUrl: 'https://api.deepseek.com/anthropic', models: [] } },
};

function renderWizard(presetId: string) {
  return render(
    React.createElement(AddProviderWizard, {
      providers: [anthropicProvider],
      entry: { kind: 'preset' as const, presetId },
      onOpenCustomForm: vi.fn(),
      onClose: vi.fn(),
      onDone: vi.fn(),
    }),
  );
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      listProviderPresets: vi.fn(async () => ({ presets: [deepseekPreset] })),
      // 列模型失败场景兜底(Greptile P1 回归):官方 API 预设必须靠推荐模型仍可完成。
      fetchProviderModels: vi.fn(async () => ({ ok: false, code: 'NETWORK' })),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddProviderWizard — preset 直达', () => {
  it('presets 载入后直达表单步:名称预填预设名,出现 API Key 输入', async () => {
    renderWizard('deepseek');

    // step 2 预设表单:名称输入预填 DeepSeek(nameLabel 只在表单步渲染)。
    await waitFor(() =>
      expect(screen.getByText('settings.providers.wizard.nameLabel')).not.toBeNull(),
    );
    expect(screen.getByDisplayValue('DeepSeek')).not.toBeNull();
    expect(screen.getByPlaceholderText('sk-…')).not.toBeNull();
    // 不在目录步(搜索框只在 step 1)。
    expect(screen.queryByPlaceholderText('settings.providers.wizard.searchPlaceholder')).toBeNull();
  });

  it('OAuth 授权步提供「改用 API Key 接入」→ 切到官方 API 预设表单', async () => {
    render(
      React.createElement(AddProviderWizard, {
        providers: [anthropicProvider],
        entry: { kind: 'builtin' as const, providerId: 'anthropic' },
        onOpenCustomForm: vi.fn(),
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );

    // 授权步:有「授权」按钮与「改用 API Key」替代路径。
    const useApiKey = await screen.findByText('settings.providers.wizard.useApiKey');
    fireEvent.click(useApiKey);

    // 切到官方 API 预设表单:名称预填 Anthropic API,baseUrl 展示官方端点。
    await waitFor(() =>
      expect(screen.getByText('settings.providers.wizard.nameLabel')).not.toBeNull(),
    );
    expect(screen.getByDisplayValue('Anthropic API')).not.toBeNull();
    expect(screen.getByText(/api\.anthropic\.com/)).not.toBeNull();
  });

  it('官方 API 预设:列模型失败 → 第三步仍有推荐模型预勾,可完成(Greptile P1 回归)', async () => {
    render(
      React.createElement(AddProviderWizard, {
        providers: [anthropicProvider],
        entry: { kind: 'builtin' as const, providerId: 'anthropic' },
        onOpenCustomForm: vi.fn(),
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );

    fireEvent.click(await screen.findByText('settings.providers.wizard.useApiKey'));
    await waitFor(() =>
      expect(screen.getByText('settings.providers.wizard.nameLabel')).not.toBeNull(),
    );
    // 填 key 后进入第三步(拉取被 mock 为失败)。
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() =>
      expect(screen.getByText('settings.providers.wizard.fetchFailed')).not.toBeNull(),
    );
    // 降级:推荐模型仍在清单里,完成按钮可用(不被空列表堵死)。
    expect(screen.getByText('Claude Sonnet 5')).not.toBeNull();
    expect(screen.getByText('Claude Haiku 4.5')).not.toBeNull();
    expect(
      (screen.getByText('settings.providers.wizard.finish').closest('button') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('presetId 不存在 → 回落目录第一步', async () => {
    renderWizard('nonexistent');

    // presets 载入完成后仍停在目录步(搜索框在,表单步标记不在)。
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText('settings.providers.wizard.searchPlaceholder'),
      ).not.toBeNull(),
    );
    expect(screen.queryByText('settings.providers.wizard.nameLabel')).toBeNull();
  });
});
