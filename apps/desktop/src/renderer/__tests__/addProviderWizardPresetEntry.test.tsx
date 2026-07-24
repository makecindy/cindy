// @vitest-environment jsdom

/**
 * AddProviderWizard — preset 直达入口(引导卡「其他供应商」行)关键不变量:
 *   1. entry={kind:'preset',presetId}:presets 异步载入后直达表单步(step 2,
 *      名称预填预设名),一次性消费。
 *   2. presetId 在目录里不存在 → 回落目录第一步,不假装直达。
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
