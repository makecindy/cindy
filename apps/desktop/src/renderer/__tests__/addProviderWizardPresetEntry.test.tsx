// @vitest-environment jsdom

/**
 * AddProviderWizard — preset 直达入口(引导卡「其他供应商」行)关键不变量:
 *   1. entry={kind:'preset',presetId}:presets 异步载入后直达表单步(step 2,
 *      名称预填预设名),一次性消费。
 *   2. presetId 在目录里不存在 → 回落目录第一步,不假装直达。
 *   3. API Key 输入默认遮罩,但必须能显形核对——粘错 key / 多余空格 / 前缀不对
 *      在遮罩下查不出来。向导曾漏掉这个切换,只有编辑弹窗有(见 SettingsTextInput)。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildUserProvider, BUNDLED_CATALOG, parseModelsListResponse, modelProtocolComparison, type ProviderView } from '@cindy/model-providers';

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
  updateCustomProvider: vi.fn(),
  deleteCustomProvider: vi.fn(async () => undefined),
  providerViewToCustomProviderConfig: (p: ProviderView) => ({ id: p.id, name: p.name, auth: p.auth, runtimes: Object.fromEntries(p.agents.map(a => [a, { baseUrl: p.routing[a]!.upstream, wireProtocol: p.routing[a]!.wireProtocol, models: p.models[a] }])) }),
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
import { createCustomProvider, updateCustomProvider, deleteCustomProvider } from '@/lib/customProviders';

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

it.each(['openrouter', 'minimax-cn', 'minimax-global', 'moonshot-kimi-code', 'github-copilot', 'nous'])(
  'shows the same sign-in/API choice in the supplier list and connection page for %s', async id => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === id)!;
    expect(preset).toBeDefined();
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValue({ presets: [preset, deepseekPreset] });
    render(<AddProviderWizard providers={[]} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
    const hint = await screen.findByText('settings.providers.wizard.metaLoginOrApi');
    const row = hint.closest('button')!;
    expect(row).not.toBeNull();
    expect(within(row).queryByText('settings.providers.wizard.metaApiKey')).toBeNull();
    expect(screen.getByText('settings.providers.wizard.metaApiKey')).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByRole('button', { name: id === 'openrouter' ? 'settings.providers.button.authorize' : 'settings.providers.wizard.authorizeWithDeviceCode' })).toBeTruthy();
    expect(screen.getByText('settings.providers.wizard.useApiKey')).toBeTruthy();
    expect(screen.queryByPlaceholderText('sk-…')).toBeNull();
  },
);

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      onProviderOAuthProgress: vi.fn(() => () => undefined),
      localModelList: vi.fn(async () => ({
        status: { runtime: 'ollama', kind: 'absent', appInstalled: false },
        models: [],
        memoryGb: 0,
      })),
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
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
    expect(screen.queryByText(/api\.anthropic\.com/)).toBeNull();
    expect(screen.getByRole('link', { name: 'settings.providers.wizard.setupLink.apiKey' }).getAttribute('href')).toBe('https://console.anthropic.com/settings/keys');
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
    expect(screen.getAllByText('Claude Haiku 4.5').length).toBeGreaterThan(0);
    expect(
      (screen.getByText('settings.providers.wizard.finish').closest('button') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('官方 API 预设保存引用，解析后继承目录窗口', async () => {
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

    // 默认资料保持继承；保存引用后仍解析出目录窗口。
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    const models = config.runtimes['claude-code']?.models ?? [];
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'claude-opus-5', discoveredMetadata: {} }),
        expect.objectContaining({ id: 'claude-sonnet-5', discoveredMetadata: {} }),
        expect.objectContaining({ id: 'claude-haiku-4-5', discoveredMetadata: {} }),
      ]),
    );
    const codex = config.runtimes.codex;
    expect(codex?.wireProtocol).toBe('anthropic-messages');
    expect(codex?.baseUrl).toBe('https://api.anthropic.com');
    expect(codex?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'claude-opus-5', discoveredMetadata: {} }),
        expect.objectContaining({ id: 'claude-sonnet-5', discoveredMetadata: {} }),
        expect.objectContaining({ id: 'claude-haiku-4-5', discoveredMetadata: {} }),
      ]),
    );
    const keys = vi.mocked(createCustomProvider).mock.calls[0][1];
    expect(keys).toMatchObject({ 'claude-code': 'sk-test', codex: 'sk-test' });
    expect(config.runtimes.pi).toEqual({
      catalogPresetId: 'anthropic-api',
      baseUrl: 'https://api.anthropic.com',
      wireProtocol: 'anthropic-messages',
      models: expect.arrayContaining([
        expect.objectContaining({ id: 'claude-opus-5', discoveredMetadata: {} }),
        expect.objectContaining({ id: 'claude-sonnet-5', discoveredMetadata: {} }),
        expect.objectContaining({ id: 'claude-haiku-4-5', discoveredMetadata: {} }),
      ]),
    });
    expect(keys.pi).toBe('sk-test');
    const { presets } = await window.electronAPI.maker.listProviderPresets();
    const projected = buildUserProvider(config, {
      presets,
      modelRegistry: BUNDLED_CATALOG.modelRegistry,
    });
    expect(projected.models['claude-code']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'claude-opus-5', contextWindow: 1_000_000 }),
        expect.objectContaining({ id: 'claude-haiku-4-5', contextWindow: 200_000 }),
      ]),
    );
    expect(
      config.runtimes['claude-code']?.models.every((model) => model.contextWindow === undefined),
    ).toBe(true);
  });

  it('Pi 预设通过引用继承 reasoning 能力与支持档位', async () => {
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
        discoveredMetadata: {},
      }),
    ]);
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    const { presets } = await window.electronAPI.maker.listProviderPresets();
    expect(config.runtimes.pi?.catalogPresetId).toBe('pi-reasoning');
    expect(buildUserProvider(config, { presets }).models.pi?.[0]).toMatchObject({
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    });
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
      catalogPresetId: 'explicit-pi',
      baseUrl: 'https://explicit.example/pi',
      wireProtocol: 'openai-chat',
      models: [{ id: 'pi-model', name: 'Pi Model', discoveredMetadata: {} }],
    });
    expect(keys.pi).toBe('sk-test');
  });

  it('取消 Pi 模型保留目录但不开启，也不从 Claude 复制模型', async () => {
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
      catalogPresetId: 'explicit-pi',
      baseUrl: 'https://explicit.example/anthropic',
      models: [{ id: 'claude-model', name: 'Claude Model', discoveredMetadata: {} }],
    });
    expect(config.runtimes.pi?.models).toEqual([{ id: 'pi-model', name: 'Pi Model', discoveredMetadata: {}, defaultEnabled: false }]);
    expect(keys.pi).toBe('sk-test');
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
      { id: 'claude-only-model', name: 'Claude Only Model', discoveredMetadata: {} },
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
            models: [{ id: 'local-model', name: 'local-model', discoveredMetadata: {} }],
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
        { id: 'glm-5.2', name: 'GLM-5.2', discoveredMetadata: {} },
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
    expect(config.runtimes['claude-code']?.models.filter(m => m.defaultEnabled !== false).map((model) => model.id)).toEqual(['minimax-m3']);
    expect(config.runtimes.codex?.models.filter(m => m.defaultEnabled !== false).map((model) => model.id)).toEqual(['glm-5.2']);
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
      expect.objectContaining({
        id: 'deepseek-v4',
        discoveredMetadata: expect.objectContaining({ contextWindow: 262_144 }),
      }),
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
      expect.objectContaining({
        id: 'shared-model',
        discoveredMetadata: expect.objectContaining({ contextWindow: 1_000_000 }),
      }),
    ]);
    expect(config.runtimes.codex?.models).toEqual([
      expect.objectContaining({
        id: 'shared-model',
        discoveredMetadata: expect.objectContaining({ contextWindow: 272_000 }),
      }),
    ]);
  });

  it('智谱绑定合并 V4 与 V1 目录，并给 glm-5.3 保存 Responses 路由', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockImplementation(
      async ({ baseUrl }: { baseUrl: string }) =>
        baseUrl === 'https://open.bigmodel.cn/api/v1'
          ? { ok: true, models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] }
          : { ok: true, models: [{ id: 'glm-5.2', name: 'GLM-5.2', discoveredMetadata: {} }] },
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
    expect({ ...config.runtimes.codex, models: config.runtimes.codex?.models.filter(m => m.defaultEnabled !== false) }).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      wireProtocol: 'openai-chat',
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', discoveredMetadata: {} },
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
                { id: 'glm-5.2', name: 'GLM-5.2', discoveredMetadata: {} },
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
    expect(runtime?.models.filter(m => m.defaultEnabled !== false)).toEqual([{ id: 'glm-5.2', name: 'GLM-5.2', discoveredMetadata: {} }]);
  });

  it('可编辑预设改为同源 endpoint 后继续合并 Responses 目录', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockImplementation(
      async ({ baseUrl }: { baseUrl: string }) =>
        baseUrl === 'https://editable.example/api/v1'
          ? { ok: true, models: [{ id: 'responses-model', name: 'Responses Model' }] }
          : {
              ok: true,
              models: [{ id: 'chat-model', name: 'Chat Model', discoveredMetadata: {} }],
            },
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
      { id: 'chat-model', name: 'Chat Model', discoveredMetadata: {} },
      {
        discoveredMetadata: { name: 'Responses Model' },
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
        { id: 'chat-model', name: 'Chat Model', discoveredMetadata: {} },
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

it.each(['apiKey', 'oauth'] as const)('keeps retained single-instance %s connections out of the add list across disconnect and delete', async (method) => {
  const provider = {
    ...anthropicProvider, id: 'gemini', name: 'Single Connection', agents: [], models: {},
    auth: { method, oauth: { kind: 'native' } },
    audioModels: [{ id: 'media', name: 'Media' }],
  } as unknown as ProviderView;
  const props = { onOpenCustomForm: vi.fn(), onClose: vi.fn(), onDone: vi.fn() };
  const view = render(<AddProviderWizard {...props} providers={[provider]} />);
  expect(await screen.findByText('Single Connection')).toBeTruthy();
  for (const state of [
    { connected: true, removed: false },
    { connected: false, removed: false },
    { connected: false, removed: true },
    { connected: true, removed: false },
  ]) {
    view.rerender(<AddProviderWizard {...props} providers={[{ ...provider, ...state }]} />);
    expect(screen.queryByText('Single Connection') !== null).toBe(state.removed);
  }
});

it.each(['audioModels', 'embeddingModels'] as const)('opens key setup for a disconnected media-only builtin with %s', async (field) => {
  const mediaProvider = {
    ...anthropicProvider, id: 'gemini', name: 'Media Only', agents: [], models: {},
    auth: { method: 'apiKey' as const }, [field]: [{ id: 'media', name: 'Media' }],
  } as ProviderView;
  const store = vi.fn(async () => undefined);
  window.electronAPI.builtinApiKeyStore = store;
  const onDone = vi.fn();
  const view = render(<AddProviderWizard providers={[mediaProvider]} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
  fireEvent.click(await screen.findByText('Media Only'));
  expect(await screen.findByText('settings.providers.wizard.builtinApiKey.subtitle')).toBeTruthy();
  const keyInput = view.container.querySelector('input[type="password"]');
  expect(keyInput).not.toBeNull();
  fireEvent.change(keyInput!, { target: { value: 'test-media-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.finish' }));
  await waitFor(() => expect(store).toHaveBeenCalledWith('gemini', 'test-media-key'));
  expect(onDone).toHaveBeenCalledWith('gemini');
});


it('preserves each runtime preset media type when discovery is unavailable', async () => {
  const image = { id: 'shared-media', name: 'Media', mode: 'image_generation' as const,
    modalities: { input: ['text'], output: ['image'] }, officialDocs: 'https://example.test/image' };
  const video = { ...image, mode: 'video_generation' as const,
    modalities: { input: ['image'], output: ['video'] }, officialDocs: 'https://example.test/video' };
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [{
    id: 'media-preset', name: 'Media Preset', runtimes: {
      'claude-code': { baseUrl: 'https://example.test/anthropic', models: [image] },
      codex: { baseUrl: 'https://example.test/v1', wireProtocol: 'openai-chat' as const, models: [video] },
    },
  }] }));
  renderWizard('media-preset');
  await screen.findByDisplayValue('Media Preset');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  await screen.findByText('Media');
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const config = vi.mocked(createCustomProvider).mock.calls[0][0];
  expect(config.runtimes['claude-code']?.models[0]).toMatchObject(image);
  expect(config.runtimes.codex?.models[0]).toMatchObject(video);
});

it('imports the same discovered OpenRouter identity, capabilities and prices into all three engines', async () => {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'openrouter')!);
  for (const runtime of Object.values(preset.runtimes)) {
    runtime!.models = [{ id: 'stale/model', name: 'Stale preset' }];
  }
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [preset] }));
  const models = parseModelsListResponse({ data: [{
    id: 'deepseek/deepseek-v4-pro', name: 'Discovered DeepSeek', context_length: 1048576,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.00000075864', completion: '0.00000151728' },
  }] }, 'https://openrouter.ai/api/v1/models')!;
  window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true, models }));
  renderWizard('openrouter');
  expect(await screen.findByText('settings.providers.wizard.useApiKey')).toBeTruthy();
  expect(screen.queryByPlaceholderText('sk-…')).toBeNull();
  fireEvent.click(screen.getByText('settings.providers.wizard.useApiKey'));
  fireEvent.click(screen.getByText('settings.providers.wizard.back'));
  expect(screen.queryByPlaceholderText('sk-…')).toBeNull();
  fireEvent.click(screen.getByText('settings.providers.wizard.useApiKey'));
  expect(screen.queryByText('settings.providers.button.authorize')).toBeNull();
  await screen.findByDisplayValue('OpenRouter');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  await screen.findByText('Discovered DeepSeek');
  expect(screen.queryByText('Stale preset')).toBeNull();
  expect(screen.queryByText('settings.providers.wizard.recommended')).toBeNull();
  fireEvent.click(screen.getByText('Discovered DeepSeek'));
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved = vi.mocked(createCustomProvider).mock.calls[0][0];
  const provider = buildUserProvider(saved, { presets: [preset], modelRegistry: BUNDLED_CATALOG.modelRegistry });
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    expect(saved.runtimes[agent]?.models.map(m => m.id)).toEqual(['deepseek/deepseek-v4-pro']);
    const model = provider.models[agent]![0];
    expect(model).toMatchObject({ contextWindow: 1048576, nativeApi: 'openai-completions',
      cost: { input: 0.75864, output: 1.51728 } });
    expect(modelProtocolComparison(provider, { [agent]: model }).forAgent(agent)?.mode)
      .toBe(agent === 'pi' ? 'matching' : 'compatibility');
    expect(model.defaultEnabled).toBe(agent === 'pi');
  }
});

it('imports an OpenCode Go Responses model into all three engines', async () => {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'opencode-go')!);
  for (const runtime of Object.values(preset.runtimes)) {
    for (const model of runtime!.models) model.defaultEnabled = false;
  }
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [preset] }));
  // Go's shared discovery only returns IDs. Its protocol/capabilities come from the catalog.
  window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true,
    models: [{ id: 'gpt-5.6-luna', name: 'Go Luna' }] }));
  renderWizard('opencode-go');
  await screen.findByDisplayValue('OpenCode Go');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  fireEvent.click(await screen.findByText('Go Luna'));
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved = vi.mocked(createCustomProvider).mock.calls[0][0];
  expect(saved.runtimes.pi?.models.filter(m => m.defaultEnabled !== false).map(m => m.id)).toEqual(['gpt-5.6-luna']);
  expect(saved.runtimes['claude-code']?.models.find(m => m.id === 'gpt-5.6-luna')).toMatchObject({ id: 'gpt-5.6-luna', api: 'openai-responses' });
  expect(saved.runtimes.codex?.models.find(m => m.id === 'gpt-5.6-luna')).toMatchObject({ id: 'gpt-5.6-luna', api: 'openai-responses' });
  const model = buildUserProvider(saved, { presets: [preset] }).models.pi?.find(m => m.id === 'gpt-5.6-luna');
  expect(model).toMatchObject({ piApi: 'openai-responses', supportsImageInput: true });
  const projected = buildUserProvider(saved, { presets: [preset] });
  for (const agent of projected.agents) expect(projected.models[agent]?.find(m => m.id === 'gpt-5.6-luna')?.defaultEnabled).toBe(agent !== 'claude-code');
});


it.each(['finish', 'back', 'close'] as const)('logs in without a key and handles %s with the owned account', async action => {
  const preset = { id: 'openrouter', name: 'OpenRouter', runtimes: {
    pi: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat' as const,
      models: [{ id: 'test/model', name: 'Test model', defaultEnabled: true, api: 'openai-completions' as const }] },
  } };
  const maker = window.electronAPI.maker;
  vi.mocked(maker.listProviderPresets).mockResolvedValue({ presets: [preset] });
  let created!: Parameters<typeof createCustomProvider>[0];
  vi.mocked(createCustomProvider).mockImplementation(async config => { created = config; return { ok: true }; });
  Object.assign(maker, {
    providerOAuthLogin: vi.fn(async () => ({ ok: true })),
    providerOAuthCancel: vi.fn(async () => ({ ok: true })),
    onProviderOAuthProgress: vi.fn(() => () => undefined),
    listProviders: vi.fn(async () => ({ providers: [{ ...buildUserProvider(created), connected: true }] })),
  });
  const view = renderWizard('openrouter');
  fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.button.authorize' }));
  await screen.findByText('Test model');
  expect(created.auth).toMatchObject({ method: 'oauth', oauth: { tokenUrl: 'https://openrouter.ai/api/v1/auth/keys' } });
  if (action !== 'finish') {
    if (action === 'back') fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    else view.unmount();
    await waitFor(() => expect(deleteCustomProvider).toHaveBeenCalledWith(created.id));
    expect(updateCustomProvider).not.toHaveBeenCalled();
    return;
  }
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.finish' }));
  await waitFor(() => expect(updateCustomProvider).toHaveBeenCalledWith(expect.objectContaining({ id: created.id, auth: created.auth }), {}));
  const deletedBefore = vi.mocked(deleteCustomProvider).mock.calls.length;
  view.unmount();
  expect(vi.mocked(deleteCustomProvider).mock.calls.length).toBe(deletedBefore);
});

it('preserves OAuth-discovered prices for every engine when finishing model selection', async () => {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'openrouter')!);
  const id = 'new-vendor/oauth-discovered-model';
  const maker = window.electronAPI.maker;
  vi.mocked(maker.listProviderPresets).mockResolvedValue({ presets: [preset] });
  let created!: Parameters<typeof createCustomProvider>[0];
  vi.mocked(createCustomProvider).mockImplementation(async config => { created = config; return { ok: true }; });
  const prices = {
    'claude-code': { input: 0.12, output: 0.34, cacheRead: 0 },
    codex: { input: 0.23, output: 0.45, cacheWrite: 0.56 },
    pi: { input: 0.34, output: 0.56 },
  };
  Object.assign(maker, {
    providerOAuthLogin: vi.fn(async () => ({ ok: true })),
    providerOAuthCancel: vi.fn(async () => ({ ok: true })),
    onProviderOAuthProgress: vi.fn(() => () => undefined),
    listProviders: vi.fn(async () => {
      for (const agent of ['claude-code', 'codex', 'pi'] as const) {
        created.runtimes[agent]!.models = [{ id, name: 'OAuth discovered model',
          discoveredMetadata: { contextWindow: 123456 }, discoveredCost: prices[agent] }];
      }
      const provider = buildUserProvider(created, { presets: [preset] });
      for (const agent of provider.agents) expect(provider.models[agent]![0].discoveredCost).toBeUndefined();
      return { providers: [{ ...provider, connected: true }] };
    }),
  });
  renderWizard('openrouter');
  fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.button.authorize' }));
  fireEvent.click(await screen.findByText('OAuth discovered model'));
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.finish' }));
  await waitFor(() => expect(updateCustomProvider).toHaveBeenCalledOnce());
  const saved = vi.mocked(updateCustomProvider).mock.calls[0][0];
  const projected = buildUserProvider(saved, { presets: [preset] });
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    expect(saved.runtimes[agent]!.models[0].discoveredCost).toEqual(prices[agent]);
    expect(projected.models[agent]![0].cost).toEqual(prices[agent]);
  }
});


it('imports the full Hermes inventory immediately, enables selected Pi models and retains both optional harnesses', async () => {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'nous')!);
  vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValue({ presets: [preset] });
  vi.mocked(window.electronAPI.maker.fetchProviderModels).mockImplementation(async spec => spec.agent === 'claude-code'
    ? { ok: false }
    : { ok: true, models: [{ id: 'google/gemini-test', name: 'Hermes Gemini' }, { id: 'other', name: 'Other Hermes Model' }] });
  renderWizard('nous');
  fireEvent.click(await screen.findByText('settings.providers.wizard.useApiKey'));
  await screen.findByDisplayValue('Nous Research (Hermes)');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'test-key' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  fireEvent.click(await screen.findByText('Hermes Gemini'));
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved = vi.mocked(createCustomProvider).mock.calls[0][0];
  const provider = buildUserProvider(saved, { presets: [preset] });
  expect(provider.agents).toEqual(['claude-code', 'codex', 'pi']);
  for (const agent of provider.agents) {
    expect(provider.models[agent]?.map(m => m.id)).toEqual(['google/gemini-test', 'other']);
    expect(provider.models[agent]?.find(m => m.id === 'google/gemini-test')?.defaultEnabled).toBe(agent === 'pi');
    expect(provider.models[agent]?.find(m => m.id === 'other')?.defaultEnabled).toBe(false);
  }
});
