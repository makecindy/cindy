// @vitest-environment jsdom

/**
 * AddProviderWizard — preset 直达入口(引导卡「其他供应商」行)关键不变量:
 *   1. entry={kind:'preset',presetId}:presets 异步载入后直达表单步(step 2,
 *      名称预填预设名),一次性消费。
 *   2. presetId 在目录里不存在 → 回落目录第一步,不假装直达。
 *   3. API Key 输入默认遮罩,但必须能显形核对——粘错 key / 多余空格 / 前缀不对
 *      在遮罩下查不出来。向导曾漏掉这个切换,只有编辑弹窗有(见 SettingsTextInput)。
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

import { AddProviderWizard, OFFICIAL_API_PRESETS } from '@/components/settings/AddProviderWizard';
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

const dualDiscoveryPreset = {
  id: 'dual-endpoints',
  name: 'Dual Endpoints',
  runtimes: {
    'claude-code': {
      baseUrl: 'https://dual.example/anthropic',
      modelsUrl: 'https://dual.example/anthropic/v1/models',
      models: [],
    },
    codex: {
      baseUrl: 'https://dual.example/openai/v1',
      modelsUrl: 'https://dual.example/openai/v1/models',
      models: [],
    },
  },
};

const zhipuCodingPreset = {
  id: 'zhipu-coding-plan-cn',
  name: 'Zhipu GLM Coding Plan',
  runtimes: {
    codex: {
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      wireProtocol: 'openai-chat' as const,
      models: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
      modelDiscovery: [
        {
          baseUrl: 'https://open.bigmodel.cn/api/v1',
          modelsUrl: 'https://open.bigmodel.cn/api/v1/models',
          wireProtocol: 'openai-responses' as const,
        },
      ],
    },
  },
};

const editableDiscoveryPreset = {
  id: 'editable-discovery',
  name: 'Editable Discovery',
  runtimes: {
    codex: {
      baseUrl: 'https://editable.example/api/v4',
      baseUrlEditable: true,
      wireProtocol: 'openai-chat' as const,
      models: [{ id: 'chat-model', name: 'Chat Model' }],
      modelDiscovery: [
        {
          baseUrl: 'https://editable.example/api/v1',
          modelsUrl: 'https://editable.example/api/v1/models',
          wireProtocol: 'openai-responses' as const,
        },
      ],
    },
  },
};

const piReasoningPreset = {
  id: 'pi-reasoning',
  name: 'Pi Reasoning',
  runtimes: {
    pi: {
      baseUrl: 'https://pi.example/v1',
      wireProtocol: 'openai-chat' as const,
      models: [
        {
          id: 'reasoning-model',
          name: 'Reasoning Model',
          reasoning: true,
          reasoningEfforts: ['low', 'high'] as const,
          reasoningDefaultEffort: 'high' as const,
        },
      ],
    },
  },
};

const explicitPiPreset = {
  id: 'explicit-pi',
  name: 'Explicit Pi',
  runtimes: {
    'claude-code': {
      baseUrl: 'https://explicit.example/anthropic',
      models: [{ id: 'claude-model', name: 'Claude Model' }],
    },
    pi: {
      baseUrl: 'https://explicit.example/pi',
      wireProtocol: 'openai-chat' as const,
      models: [{ id: 'pi-model', name: 'Pi Model' }],
    },
  },
};

const claudeRequestPathPreset = {
  id: 'claude-request-path',
  name: 'Claude Request Path',
  runtimes: {
    'claude-code': {
      baseUrl: 'https://path.example/anthropic',
      requestPath: '/tenant/acme/messages',
      models: [{ id: 'path-model', name: 'Path Model' }],
    },
  },
};

const claudeOnlyPreset = {
  id: 'claude-only',
  name: 'Claude Only',
  runtimes: {
    'claude-code': {
      baseUrl: 'https://claude-only.example/anthropic',
      models: [{ id: 'claude-only-model', name: 'Claude Only Model' }],
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
          dualDiscoveryPreset,
          zhipuCodingPreset,
          editableDiscoveryPreset,
          piReasoningPreset,
          explicitPiPreset,
          claudeRequestPathPreset,
          claudeOnlyPreset,
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
  it('官方 API 入口逐一显式声明 Pi 协议，不依赖 Claude runtime 派生', () => {
    expect(OFFICIAL_API_PRESETS.anthropic?.runtimes.pi?.wireProtocol).toBe('anthropic-messages');
    expect(OFFICIAL_API_PRESETS.openai?.runtimes.pi?.wireProtocol).toBe('openai-responses');
    expect(OFFICIAL_API_PRESETS.xai?.runtimes.pi?.wireProtocol).toBe('openai-chat');
  });

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

  it('API Key 默认遮罩,eye 能切明文再切回(粘贴后核对)', async () => {
    renderWizard('deepseek');

    const keyInput = await screen.findByPlaceholderText('sk-…');
    expect(keyInput.getAttribute('type')).toBe('password');
    // 密钥框要挡住密码管理器建议与拼写红线(普通文本字段则保留浏览器默认,不禁用)。
    expect(keyInput.getAttribute('autocomplete')).toBe('off');
    expect(keyInput.getAttribute('spellcheck')).toBe('false');

    // 遮罩态按钮语义是「显示密钥」,点击后翻转为「隐藏密钥」。
    fireEvent.click(screen.getByLabelText('settings.apiKey.showKey'));
    expect(keyInput.getAttribute('type')).toBe('text');

    fireEvent.click(screen.getByLabelText('settings.apiKey.hideKey'));
    expect(keyInput.getAttribute('type')).toBe('password');
  });

  it('密钥框底色是 DESIGN.md §4 的 --surface-elevated,不是 settings 的 ivory', async () => {
    renderWizard('deepseek');

    // 共享化时把底色顺手换成 --settings-input-bg 会退化:该 token 解析到
    // --surface-card-ivory,而 ProvidersSection 的卡片本身就是这个值,行内密钥框会与卡片
    // 同色、只剩边框。DESIGN.md §4 input/text 规定 fill = --surface-elevated。
    const cls = (await screen.findByPlaceholderText('sk-…')).className;
    expect(cls).toContain('bg-[var(--surface-elevated)]');
    expect(cls).not.toContain('bg-[var(--settings-input-bg)]');
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
    expect(screen.getAllByText(/api\.anthropic\.com/)).toHaveLength(3);
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
    expect(config.runtimes.pi).toEqual({
      baseUrl: 'https://api.anthropic.com',
      wireProtocol: 'anthropic-messages',
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-opus-5', contextWindow: 1_000_000 }),
        expect.objectContaining({ id: 'claude-sonnet-5', contextWindow: 1_000_000 }),
        expect.objectContaining({ id: 'claude-haiku-4-5', contextWindow: 200_000 }),
      ]),
    });
    expect(keys.pi).toBe('sk-test');
  });

  it('Pi 预设保存时保留显式 reasoning 能力与支持档位', async () => {
    renderWizard('pi-reasoning');

    await waitFor(() => expect(screen.getByDisplayValue('Pi Reasoning')).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.getByText('Reasoning Model')).not.toBeNull());
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.pi?.models).toEqual([
      expect.objectContaining({
        id: 'reasoning-model',
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        reasoningDefaultEffort: 'high',
      }),
    ]);
  });

  it('预设已有显式 Pi runtime 时不被 Claude 自动初始化覆盖', async () => {
    renderWizard('explicit-pi');

    await waitFor(() => expect(screen.getByDisplayValue('Explicit Pi')).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.getByText('Pi Model')).not.toBeNull());
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const [config, keys] = vi.mocked(createCustomProvider).mock.calls[0];
    expect(config.runtimes.pi).toEqual({
      baseUrl: 'https://explicit.example/pi',
      wireProtocol: 'openai-chat',
      models: [{ id: 'pi-model', name: 'Pi Model' }],
    });
    expect(keys.pi).toBe('sk-test');
  });

  it('预设显式 Pi 模型全部取消后不从 Claude 重新生成 Pi runtime', async () => {
    renderWizard('explicit-pi');

    await waitFor(() => expect(screen.getByDisplayValue('Explicit Pi')).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    const piModel = await screen.findByText('Pi Model');
    fireEvent.click(piModel.closest('button') as HTMLButtonElement);
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const [config, keys] = vi.mocked(createCustomProvider).mock.calls[0];
    expect(config.runtimes['claude-code']).toEqual({
      baseUrl: 'https://explicit.example/anthropic',
      models: [{ id: 'claude-model', name: 'Claude Model' }],
    });
    expect(config.runtimes.pi).toBeUndefined();
    expect(keys.pi).toBeUndefined();
  });

  it('Claude runtime 带自定义请求路径时不自动生成 Pi runtime', async () => {
    renderWizard('claude-request-path');

    await waitFor(() => expect(screen.getByDisplayValue('Claude Request Path')).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.getByText('Path Model')).not.toBeNull());
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const [config, keys] = vi.mocked(createCustomProvider).mock.calls[0];
    expect(config.runtimes['claude-code']).toMatchObject({
      requestPath: '/tenant/acme/messages',
    });
    expect(config.runtimes.pi).toBeUndefined();
    expect(keys.pi).toBeUndefined();
  });

  it('缺少显式 Pi runtime 的预设不会从 Claude runtime 静默派生', async () => {
    renderWizard('claude-only');

    await waitFor(() => expect(screen.getByDisplayValue('Claude Only')).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.getByText('Claude Only Model')).not.toBeNull());
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const [config, keys] = vi.mocked(createCustomProvider).mock.calls[0];
    expect(config.runtimes['claude-code']?.models).toEqual([
      { id: 'claude-only-model', name: 'Claude Only Model' },
    ]);
    expect(config.runtimes.pi).toBeUndefined();
    expect(keys.pi).toBeUndefined();
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
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValueOnce({
      presets: [editablePreset],
    });
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
    const next = screen
      .getByText('settings.providers.wizard.next')
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

  it('拉取新增模型带端点上报的 contextWindow 入库(Codex P1 回归)', async () => {
    // 预设未收录的发现模型没有预设窗口可回填:丢弃端点上报值会让它落 200K
    // 默认,显示与压缩阈值双错——完成创建必须把发现值写进配置。
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({
      ok: true,
      models: [{ id: 'deepseek-v4', name: 'DeepSeek V4', contextWindow: 262_144 }],
    });
    renderWizard('deepseek');

    await waitFor(() =>
      expect(screen.getByText('settings.providers.wizard.nameLabel')).not.toBeNull(),
    );
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    // 拉取新增模型默认不勾选,点选后完成。
    fireEvent.click(await screen.findByText('DeepSeek V4'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    expect(config.runtimes['claude-code']?.models).toEqual([
      expect.objectContaining({ id: 'deepseek-v4', contextWindow: 262_144 }),
    ]);
  });

  it('双 runtime 各自端点发现同一模型不同窗口时按 runtime 分别入库(Codex P1 回归)', async () => {
    // 同一 model id 在两端窗口可以不同(如 cc=1M / codex=272K):共享一个发现值
    // 会让其中一端显示与压缩阈值双错,必须按 agent 分槽各取各的端点上报值。
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockImplementation(
      async ({ agent }: { agent: 'claude-code' | 'codex' | 'pi' }) => ({
        ok: true,
        models: [
          {
            id: 'shared-model',
            name: 'Shared Model',
            contextWindow: agent === 'claude-code' ? 1_000_000 : 272_000,
          },
        ],
      }),
    );
    renderWizard('dual-endpoints');

    await waitFor(() =>
      expect(screen.getByText('settings.providers.wizard.nameLabel')).not.toBeNull(),
    );
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    fireEvent.click(await screen.findByText('Shared Model'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    expect(config.runtimes['claude-code']?.models).toEqual([
      expect.objectContaining({ id: 'shared-model', contextWindow: 1_000_000 }),
    ]);
    expect(config.runtimes.codex?.models).toEqual([
      expect.objectContaining({ id: 'shared-model', contextWindow: 272_000 }),
    ]);
  });

  it('智谱绑定合并 V4 与 V1 目录，并给 glm-5.3 保存 Responses 路由', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockImplementation(
      async ({ baseUrl }: { baseUrl: string }) =>
        baseUrl === 'https://open.bigmodel.cn/api/v1'
          ? { ok: true, models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] }
          : { ok: true, models: [{ id: 'glm-5.2', name: 'GLM-5.2' }] },
    );
    renderWizard('zhipu-coding-plan-cn');

    await waitFor(() => expect(screen.getByDisplayValue('Zhipu GLM Coding Plan')).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'glm-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    fireEvent.click(await screen.findByText('GLM-5.3'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        wireProtocol: 'openai-chat',
      }),
    );
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        baseUrl: 'https://open.bigmodel.cn/api/v1',
        modelsUrl: 'https://open.bigmodel.cn/api/v1/models',
        wireProtocol: 'openai-responses',
      }),
    );
    const [config, keys] = vi.mocked(createCustomProvider).mock.calls[0];
    expect(config.runtimes.codex).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      wireProtocol: 'openai-chat',
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2' },
        {
          id: 'glm-5.3',
          name: 'GLM-5.3',
          route: {
            baseUrl: 'https://open.bigmodel.cn/api/v1',
            wireProtocol: 'openai-responses',
          },
        },
      ],
    });
    expect(keys.codex).toBe('glm-key');
  });

  it('智谱主目录失败时附加目录不会改写预设模型的 V4 路由', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockImplementation(
      async ({ baseUrl }: { baseUrl: string }) =>
        baseUrl === 'https://open.bigmodel.cn/api/v1'
          ? {
              ok: true,
              models: [
                { id: 'glm-5.2', name: 'GLM-5.2' },
                { id: 'glm-5.3', name: 'GLM-5.3' },
              ],
            }
          : { ok: false },
    );
    renderWizard('zhipu-coding-plan-cn');

    await waitFor(() => expect(screen.getByDisplayValue('Zhipu GLM Coding Plan')).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'glm-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await screen.findByText('GLM-5.3');
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const runtime = vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex;
    expect(runtime).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      wireProtocol: 'openai-chat',
    });
    expect(runtime?.models).toEqual([{ id: 'glm-5.2', name: 'GLM-5.2' }]);
  });

  it('可编辑预设改为同源 endpoint 后继续合并 Responses 目录', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockImplementation(
      async ({ baseUrl }: { baseUrl: string }) =>
        baseUrl === 'https://editable.example/api/v1'
          ? { ok: true, models: [{ id: 'responses-model', name: 'Responses Model' }] }
          : { ok: true, models: [{ id: 'chat-model', name: 'Chat Model' }] },
    );
    renderWizard('editable-discovery');

    const endpoint = await screen.findByDisplayValue('https://editable.example/api/v4');
    fireEvent.change(endpoint, { target: { value: 'https://editable.example/custom/v4' } });
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'edited-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    fireEvent.click(await screen.findByText('Responses Model'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://editable.example/custom/v4',
        apiKey: 'edited-key',
      }),
    );
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://editable.example/api/v1',
        wireProtocol: 'openai-responses',
        apiKey: 'edited-key',
      }),
    );
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex?.models).toEqual([
      { id: 'chat-model', name: 'Chat Model' },
      {
        id: 'responses-model',
        name: 'Responses Model',
        route: {
          baseUrl: 'https://editable.example/api/v1',
          wireProtocol: 'openai-responses',
        },
      },
    ]);
  });

  it('可编辑预设改为异源 endpoint 后不向旧目录发送 API Key', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({
      ok: true,
      models: [{ id: 'self-hosted-model', name: 'Self-hosted Model' }],
    });
    renderWizard('editable-discovery');

    const endpoint = await screen.findByDisplayValue('https://editable.example/api/v4');
    fireEvent.change(endpoint, { target: { value: 'https://self-hosted.example/v4' } });
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'self-hosted-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    fireEvent.click(await screen.findByText('Self-hosted Model'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));

    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://self-hosted.example/v4',
        apiKey: 'self-hosted-key',
      }),
    );
    expect(window.electronAPI.maker.fetchProviderModels).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://editable.example/api/v1' }),
    );
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex).toMatchObject({
      baseUrl: 'https://self-hosted.example/v4',
      models: [
        { id: 'chat-model', name: 'Chat Model' },
        { id: 'self-hosted-model', name: 'Self-hosted Model' },
      ],
    });
  });

  it('LiteLLM:清空可编辑端点后不回退预设地址，也不能继续', async () => {
    renderWizard('litellm');

    const endpoint = await screen.findByDisplayValue('http://127.0.0.1:4000/v1');
    fireEvent.change(endpoint, { target: { value: '   ' } });

    const next = screen
      .getByText('settings.providers.wizard.next')
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
