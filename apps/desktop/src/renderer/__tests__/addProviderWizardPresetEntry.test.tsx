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
import { createCustomProvider } from '@/lib/customProviders';

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
const liteLlmPreset = {
  id: 'litellm',
  name: 'LiteLLM Proxy',
  authMethod: 'none' as const,
  runtimes: {
    codex: {
      baseUrl: 'http://127.0.0.1:4000/v1',
      baseUrlEditable: true,
      requestPath: '/tenant/acme/infer',
      models: [],
    },
  },
};
const unsafeNoAuthDiscoveryPreset = {
  id: 'unsafe-no-auth-discovery',
  name: 'Unsafe no-auth discovery',
  authMethod: 'none' as const,
  runtimes: {
    codex: {
      baseUrl: 'http://127.0.0.1:4000/v1',
      modelsUrl: 'https://remote.example/v1/models',
      models: [],
    },
  },
};
const openCodePreset = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  runtimes: {
    'claude-code': {
      baseUrl: 'https://opencode.ai/zen/go',
      modelsUrl: 'https://opencode.ai/zen/go/v1/models',
      models: [{ id: 'minimax-m3', name: 'MiniMax M3' }],
    },
    codex: {
      baseUrl: 'https://opencode.ai/zen/go/v1',
      wireProtocol: 'openai-chat' as const,
      modelsUrl: 'https://opencode.ai/zen/go/v1/models',
      models: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
    },
  },
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
      listProviderPresets: vi.fn(async () => ({
        presets: [
          deepseekPreset,
          liteLlmPreset,
          unsafeNoAuthDiscoveryPreset,
          openCodePreset,
        ],
      })),
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
    expect(screen.getAllByText(/api\.anthropic\.com/)).toHaveLength(2);
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
    expect(screen.getByText('Claude Opus 5')).not.toBeNull();
    expect(screen.getByText('Claude Sonnet 5')).not.toBeNull();
    expect(screen.getByText('Claude Haiku 4.5')).not.toBeNull();
    expect(
      (screen.getByText('settings.providers.wizard.finish').closest('button') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('官方 API 预设:完成保存 → 模型带目录口径 contextWindow(Codex P1 回归)', async () => {
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
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.getByText('Claude Opus 5')).not.toBeNull());
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    // 保存产物必须带预设声明的 contextWindow:它是唯一窗口来源,缺省会落
    // 200k 默认导致 1M 模型丢 [1m] 路由(toSdkModelString 按窗口剥后缀)。
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    const models = config.runtimes['claude-code']?.models ?? [];
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'claude-opus-5', contextWindow: 1_000_000 }),
        expect.objectContaining({ id: 'claude-sonnet-5', contextWindow: 1_000_000 }),
        expect.objectContaining({ id: 'claude-haiku-4-5', contextWindow: 200_000 }),
      ]),
    );
    const codex = config.runtimes.codex;
    expect(codex?.wireProtocol).toBe('anthropic-messages');
    expect(codex?.baseUrl).toBe('https://api.anthropic.com');
    expect(codex?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'claude-opus-5', contextWindow: 1_000_000 }),
        expect.objectContaining({ id: 'claude-sonnet-5', contextWindow: 1_000_000 }),
        expect.objectContaining({ id: 'claude-haiku-4-5', contextWindow: 200_000 }),
      ]),
    );
    const keys = vi.mocked(createCustomProvider).mock.calls[0][1];
    expect(keys).toMatchObject({ 'claude-code': 'sk-test', codex: 'sk-test' });
  });

  it('editable preset saves the edited base URL and exact request path', async () => {
    const editablePreset = {
      id: 'local-gateway',
      name: 'Local Gateway',
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          baseUrlEditable: true,
          requestPath: '/tenant/acme/infer',
          models: [{ id: 'local-model', name: 'Local model' }],
        },
      },
    };
    vi.mocked(window.electronAPI.maker.listProviderPresets)
      .mockResolvedValueOnce({ presets: [editablePreset] });
    renderWizard('local-gateway');

    const baseUrl = await screen.findByDisplayValue('http://127.0.0.1:4000/v1');
    fireEvent.change(baseUrl, { target: { value: 'http://localhost:11434/custom' } });
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'local-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));

    await waitFor(() => expect(screen.getByText('Local model')).not.toBeNull());
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:11434/custom' }),
    );
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex).toMatchObject({
      baseUrl: 'http://localhost:11434/custom',
      requestPath: '/tenant/acme/infer',
    });
  });

  it('LiteLLM:模型发现失败时可手填模型 ID，并以 none 鉴权保存', async () => {
    renderWizard('litellm');

    await waitFor(() => expect(screen.getByDisplayValue('LiteLLM Proxy')).not.toBeNull());
    expect(screen.queryByPlaceholderText('sk-…')).toBeNull();
    expect(screen.getByText('settings.providers.wizard.noAuthNote')).not.toBeNull();

    const endpoint = screen.getByDisplayValue('http://127.0.0.1:4000/v1');
    fireEvent.change(endpoint, { target: { value: 'http://localhost:4100/v1' } });
    const next = screen
      .getByText('settings.providers.wizard.next')
      .closest('button') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);

    const manualModel = await screen.findByPlaceholderText(
      'settings.providers.wizard.manualModelPlaceholder',
    );
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        baseUrl: 'http://localhost:4100/v1',
        authMethod: 'none',
        apiKey: null,
      }),
    );
    fireEvent.change(manualModel, { target: { value: 'local-model' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.addManualModel'));
    expect(screen.getByText('local-model')).not.toBeNull();
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createCustomProvider).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        auth: { method: 'none' },
        runtimes: {
          codex: expect.objectContaining({
            baseUrl: 'http://localhost:4100/v1',
            requestPath: '/tenant/acme/infer',
            models: [{ id: 'local-model', name: 'local-model' }],
          }),
        },
      }),
    );
    expect(vi.mocked(createCustomProvider).mock.calls[0][1]).toEqual({});
  });

  it('none 预设的远端 modelsUrl 会在第二步阻止继续', async () => {
    renderWizard('unsafe-no-auth-discovery');

    await waitFor(() =>
      expect(screen.getByDisplayValue('Unsafe no-auth discovery')).not.toBeNull(),
    );
    const next = screen.getByText('settings.providers.wizard.next')
      .closest('button') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(window.electronAPI.maker.fetchProviderModels).not.toHaveBeenCalled();
  });

  it('共享模型目录不会扩大 OpenCode 的逐协议模型归属', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({
      ok: true,
      models: [
        { id: 'minimax-m3', name: 'MiniMax M3' },
        { id: 'glm-5.2', name: 'GLM-5.2' },
      ],
    });
    renderWizard('opencode-go');

    await waitFor(() => expect(screen.getByDisplayValue('OpenCode Go')).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.getByText('MiniMax M3')).not.toBeNull());
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    expect(config.runtimes['claude-code']?.models.map((model) => model.id)).toEqual(['minimax-m3']);
    expect(config.runtimes.codex?.models.map((model) => model.id)).toEqual(['glm-5.2']);
  });

  it('LiteLLM:清空可编辑端点后不回退预设地址，也不能继续', async () => {
    renderWizard('litellm');

    const endpoint = await screen.findByDisplayValue('http://127.0.0.1:4000/v1');
    fireEvent.change(endpoint, { target: { value: '   ' } });

    const next = screen.getByText('settings.providers.wizard.next')
      .closest('button') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(window.electronAPI.maker.fetchProviderModels).not.toHaveBeenCalled();
    expect(createCustomProvider).not.toHaveBeenCalled();
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
