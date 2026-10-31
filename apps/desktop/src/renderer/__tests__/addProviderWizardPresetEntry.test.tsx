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

import { buildUserProvider, BUNDLED_CATALOG, parseModelsListResponse, modelProtocolComparison, type CustomProviderConfig, type ProviderView } from '@cindy/model-providers';

const testI18n = vi.hoisted(() => ({ language: 'zh-CN' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: testI18n }),
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
  readCustomProviderKey: vi.fn(async () => "fake-stored-key"),
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
import { AddSpeechModelsDialog } from '@/components/settings/AddSpeechModelsDialog';
import { UnifiedModelList } from '@/components/settings/UnifiedModelList';
import { speechModels } from '../../main/voice-conversation/models';
import { __resetForTest as resetVisibility, setModelVisibilityOwner } from '@/state/modelVisibilityPrefs';
import { createCustomProvider, updateCustomProvider, deleteCustomProvider, readCustomProviderKey } from '@/lib/customProviders';

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

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

it.each([
  ['zh-CN', '小米'],
  ['zh-TW', '小米'],
  ['en', 'Xiaomi'],
])('finds the displayed MiMo brand in %s', async (language, query) => {
  testI18n.language = language;
  const presets = BUNDLED_CATALOG.presets!.filter(p =>
    ['xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'].includes(p.id),
  );
  expect(presets).toHaveLength(2);
  vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValue({ presets: [...presets, deepseekPreset] });
  render(<AddProviderWizard providers={[]} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
  await screen.findByText('DeepSeek');
  fireEvent.change(screen.getByPlaceholderText('settings.providers.wizard.searchPlaceholder'), { target: { value: query } });
  expect(screen.getAllByText('settings.providers.models.subscriptionProduct')).toHaveLength(2);
  expect(screen.queryByText('DeepSeek')).toBeNull();
});

it.each(['xiaomi-mimo-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'])(
  'presents %s as a subscription with the dedicated key hint', async id => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === id)!;
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValue({ presets: [preset, deepseekPreset] });
    render(<AddProviderWizard providers={[]} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
    const hint = await screen.findByText('settings.providers.models.subscriptionProduct');
    fireEvent.click(hint.closest('button')!);
    expect(await screen.findByPlaceholderText('tp-…')).toBeTruthy();
    expect(screen.getByText('settings.providers.wizard.mimoTokenPlanNote')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'settings.providers.wizard.setupLink.apiKey' }).getAttribute('href')).toBe('https://platform.xiaomimimo.com/token-plan');
    expect(screen.queryByPlaceholderText('sk-…')).toBeNull();
  },
);

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
    expect(within(screen.getByText('DeepSeek').closest('button')!).getByText('settings.providers.wizard.metaApiKey')).toBeTruthy();
    fireEvent.click(row);
    expect(await screen.findByRole('button', { name: id === 'openrouter' ? 'settings.providers.button.authorize' : 'settings.providers.wizard.authorizeWithDeviceCode' })).toBeTruthy();
    expect(screen.getByText('settings.providers.wizard.useApiKey')).toBeTruthy();
    expect(screen.queryByPlaceholderText('sk-…')).toBeNull();
  },
);

beforeEach(() => {
  testI18n.language = 'zh-CN';
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      llamaCppEnsure: vi.fn(async () => undefined),
      llamaCppStatus: vi.fn(async () => ({ installed: false, supported: true, running: false, models: [] })),
      llamaCppInstall: vi.fn(async () => undefined),
      llamaCppStart: vi.fn(async () => undefined),
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
  it('opens custom configuration from the header and leaves only cancel below the list', async () => {
    const onOpenCustomForm = vi.fn();
    const onClose = vi.fn();
    render(<AddProviderWizard providers={[]} onOpenCustomForm={onOpenCustomForm} onClose={onClose} onDone={vi.fn()} />);
    await screen.findByText('DeepSeek');

    const custom = screen.getByRole('button', { name: 'settings.providers.wizard.customAction' });
    const title = screen.getByRole('heading', { name: 'settings.providers.wizard.title' });
    expect(title.parentElement?.contains(custom)).toBe(true);
    expect(screen.queryByText('settings.providers.wizard.customTitle')).toBeNull();
    expect(screen.queryByText('settings.providers.wizard.customMeta')).toBeNull();
    expect(screen.queryByText('settings.providers.wizard.pickHint')).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.providers.wizard.cancel' })).toBeTruthy();

    fireEvent.click(custom);
    await waitFor(() => expect(onOpenCustomForm).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps search, supplier selection, back navigation and cancellation working', async () => {
    const onClose = vi.fn();
    render(<AddProviderWizard providers={[]} onOpenCustomForm={vi.fn()} onClose={onClose} onDone={vi.fn()} />);
    await screen.findByText('DeepSeek');
    const search = screen.getByRole('textbox', { name: 'settings.providers.wizard.searchPlaceholder' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: 'DeepSeek' } });
    expect(screen.queryByText('LiteLLM')).toBeNull();
    fireEvent.click(screen.getByText('DeepSeek').closest('button')!);
    await screen.findByDisplayValue('DeepSeek');
    expect(screen.queryByRole('button', { name: 'settings.providers.wizard.customAction' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /settings.providers.wizard.back/ }));
    await screen.findByRole('textbox', { name: 'settings.providers.wizard.searchPlaceholder' });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.cancel' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('adds llama.cpp immediately without checking, installing or starting the runtime', async () => {
    let finish!: () => void;
    vi.mocked(window.electronAPI.maker.llamaCppEnsure).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[]} onClose={vi.fn()} onDone={onDone} onOpenCustomForm={vi.fn()} />);
    const row = await screen.findByRole('button', { name: /settings.providers.llamacpp.title/ });
    fireEvent.click(row);
    expect(row.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(row);
    expect(window.electronAPI.maker.llamaCppEnsure).toHaveBeenCalledOnce();
    finish();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('cindy-local-llamacpp'));
    expect(window.electronAPI.maker.llamaCppStatus).not.toHaveBeenCalled();
    expect(window.electronAPI.maker.llamaCppInstall).not.toHaveBeenCalled();
    expect(window.electronAPI.maker.llamaCppStart).not.toHaveBeenCalled();
  });
  it('keeps the Codex and Pi addresses of an existing llama.cpp server in sync until one is edited separately', async () => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'llamacpp')!;
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValue({ presets: [preset] });
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({ ok: true, models: [{ id: 'qwen3-8b', name: 'qwen3-8b' }] });
    renderWizard('llamacpp');
    const [first] = await screen.findAllByDisplayValue('http://127.0.0.1:8080/v1');
    fireEvent.change(first!, { target: { value: 'http://127.0.0.1:8081/v1' } });
    expect(screen.getAllByDisplayValue('http://127.0.0.1:8081/v1').length).toBeGreaterThan(1);
    expect(screen.queryAllByDisplayValue('http://127.0.0.1:8080/v1')).toHaveLength(0);
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    fireEvent.click(await screen.findByText('qwen3-8b'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    expect(Object.values(config.runtimes).map(rt => rt?.baseUrl)).toEqual(Object.keys(config.runtimes).map(() => 'http://127.0.0.1:8081/v1'));
    expect(config.runtimes.pi?.baseUrl).toBe('http://127.0.0.1:8081/v1');
  });
  it('connects an existing llama.cpp server from the preset deep link without touching the managed runtime', async () => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'llamacpp')!;
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValue({ presets: [preset] });
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({
      ok: true,
      models: [{ id: 'qwen3-8b', name: 'qwen3-8b' }, { id: 'gemma-4', name: 'gemma-4' }, { id: 'glm-5-air', name: 'glm-5-air' }],
    });
    renderWizard('llamacpp');
    expect(await screen.findAllByDisplayValue('http://127.0.0.1:8080/v1')).not.toHaveLength(0);
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    fireEvent.click(await screen.findByText('qwen3-8b'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    expect(config.id).not.toBe('cindy-local-llamacpp');
    expect(config.runtimes.pi?.baseUrl).toBe('http://127.0.0.1:8080/v1');
    expect(config.runtimes.pi?.models.map(m => m.id)).toContain('qwen3-8b');
    expect(window.electronAPI.maker.llamaCppEnsure).not.toHaveBeenCalled();
  });
  it.each([
    ['detected', ['llamacpp'], 'settings.providers.wizard.groupDetectedLocal'],
    ['not detected', [], 'settings.providers.wizard.moreLocal'],
  ])('lists the existing llama.cpp server entry when %s, even with the managed runtime added', async (_label, detectedLocalPresetIds, group) => {
    const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'llamacpp')!;
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValue({ presets: [preset] });
    vi.mocked(window.electronAPI.maker.localModelList).mockResolvedValue({
      status: { runtime: 'ollama', kind: 'absent', appInstalled: false },
      models: [],
      memoryGb: 0,
      detectedLocalPresetIds,
    } as unknown as Awaited<ReturnType<typeof window.electronAPI.maker.localModelList>>);
    const managed = { ...anthropicProvider, id: 'cindy-local-llamacpp', name: 'llama.cpp', source: 'user' } as ProviderView;
    render(<AddProviderWizard providers={[managed]} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
    const label = await screen.findByText(group);
    const row = await screen.findByRole('button', { name: /llama\.cpp/ });
    expect(label.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('settings.providers.llamacpp.subtitle')).toBeNull();
    fireEvent.click(row);
    expect(await screen.findAllByDisplayValue('http://127.0.0.1:8080/v1')).not.toHaveLength(0);
    expect(window.electronAPI.maker.llamaCppEnsure).not.toHaveBeenCalled();
  });
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

  it('copies a filled account slot across editable engines', async () => {
    const preset = {
      id: 'azure-slots',
      name: 'Azure Slots',
      runtimes: {
        pi: {
          baseUrl: 'https://{resource}.openai.azure.com/openai/v1',
          baseUrlEditable: true,
          wireProtocol: 'openai-chat' as const,
          models: [{ id: 'm', name: 'M' }],
        },
        codex: {
          baseUrl: 'https://{resource}.openai.azure.com/openai/v1',
          baseUrlEditable: true,
          wireProtocol: 'openai-responses' as const,
          models: [{ id: 'm', name: 'M' }],
        },
      },
    };
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValueOnce({ presets: [preset] });
    renderWizard('azure-slots');
    const inputs = await screen.findAllByDisplayValue('https://{resource}.openai.azure.com/openai/v1');
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0], { target: { value: 'https://myres.openai.azure.com/openai/v1' } });
    expect(screen.getAllByDisplayValue('https://myres.openai.azure.com/openai/v1')).toHaveLength(2);
  });

  it('accepts the official Vertex global host and rejects an unrelated host on the Vertex template', async () => {
    const preset = {
      id: 'google-vertex',
      name: 'Google Vertex AI',
      runtimes: {
        pi: {
          baseUrl: 'https://{location}-aiplatform.googleapis.com',
          baseUrlEditable: true,
          wireProtocol: 'google-generative-ai' as const,
          models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
        },
        codex: {
          baseUrl: 'https://{location}-aiplatform.googleapis.com',
          baseUrlEditable: true,
          wireProtocol: 'google-generative-ai' as const,
          models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
        },
      },
    };
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValueOnce({ presets: [preset] });
    renderWizard('google-vertex');
    const inputs = await screen.findAllByDisplayValue('https://{location}-aiplatform.googleapis.com');
    const next = screen.getByText('settings.providers.wizard.next').closest('button') as HTMLButtonElement;
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'vertex-key' } });
    expect(next.disabled).toBe(true);

    fireEvent.change(inputs[0], { target: { value: 'https://attacker.example' } });
    expect(next.disabled).toBe(true);

    fireEvent.change(inputs[0], { target: { value: 'https://aiplatform.googleapis.com' } });
    expect(screen.getAllByDisplayValue('https://aiplatform.googleapis.com')).toHaveLength(2);
    expect(next.disabled).toBe(false);
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
  render(<AddProviderWizard providers={[mediaProvider]} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
  fireEvent.click(await screen.findByText('Media Only'));
  expect(await screen.findByText('settings.providers.wizard.builtinApiKey.subtitle')).toBeTruthy();
  const keyInput = screen.getByRole('dialog').querySelector('input[type="password"]');
  expect(keyInput).not.toBeNull();
  fireEvent.change(keyInput!, { target: { value: 'test-media-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.finish' }));
  await waitFor(() => expect(store).toHaveBeenCalledWith('gemini', 'test-media-key'));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith('gemini'));
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

it('keeps supplemental DeepSeek candidates in every declared engine before discovery and after saving', async () => {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(candidate => candidate.id === 'deepseek')!);
  for (const runtime of Object.values(preset.runtimes)) {
    runtime!.models = runtime!.models.filter(model => ['deepseek-flash', 'deepseek-v4-pro'].includes(model.id));
  }
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({
    presets: [preset], modelRegistry: BUNDLED_CATALOG.modelRegistry,
  }));
  window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: false }));
  renderWizard('deepseek');
  await screen.findByDisplayValue('DeepSeek');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
  const supplemental = await screen.findByText('DeepSeek V4 Flash Vision Exp');
  fireEvent.click(supplemental);
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved: CustomProviderConfig = JSON.parse(JSON.stringify(vi.mocked(createCustomProvider).mock.calls[0][0]));
  const provider = buildUserProvider(saved, { presets: [preset], modelRegistry: BUNDLED_CATALOG.modelRegistry });
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    expect(saved.runtimes[agent]?.models.some(model => model.id === 'deepseek-v4-flash-vision-exp')).toBe(true);
    expect(provider.models[agent]?.some(model => model.id === 'deepseek-v4-flash-vision-exp')).toBe(true);
  }
});

it('keeps an explicit tenant path through online discovery, saving and runtime projection', async () => {
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({
    presets: [liteLlmPreset], modelRegistry: BUNDLED_CATALOG.modelRegistry,
  }));
  window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true,
    models: [{ id: 'tenant-only-model', name: 'Tenant-only model' }] }));
  renderWizard('litellm');
  await screen.findByDisplayValue('LiteLLM Proxy');
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  fireEvent.click(await screen.findByText('Tenant-only model'));
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved: CustomProviderConfig = JSON.parse(JSON.stringify(vi.mocked(createCustomProvider).mock.calls[0][0]));
  const provider = buildUserProvider(saved, { presets: [liteLlmPreset], modelRegistry: BUNDLED_CATALOG.modelRegistry });
  expect(provider.routing.codex).toMatchObject({ upstream: 'http://127.0.0.1:4000/v1', requestPath: '/tenant/acme/infer' });
  expect(provider.models.codex?.find(model => model.id === 'tenant-only-model')).toMatchObject({ id: 'tenant-only-model' });
  expect(provider.models.codex?.find(model => model.id === 'tenant-only-model')?.route).toBeUndefined();
  expect(saved.runtimes.codex?.models[0].interfaceId).toBeUndefined();
});

it.each([[false, false], [true, false], [true, true]])('preserves discovery route priority, offline=%s mainHit=%s', async (offline, mainHit) => {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(candidate => candidate.id === 'deepseek')!);
  const registry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
  const model = { id: offline ? 'deepseek-v4-flash-vision-exp' : 'discovery-tenant-chat-only', name: 'Discovery tenant Chat-only' };
  preset.runtimes['claude-code']!.models = [];
  delete preset.runtimes.codex;
  delete preset.runtimes.pi;
  const source = { baseUrl: 'https://api.deepseek.com', wireProtocol: 'openai-chat' as const,
    modelsUrl: 'https://api.deepseek.com/tenant/acme/models', requestPath: '/tenant/acme/infer' };
  preset.runtimes['claude-code']!.modelDiscovery = [source];
  registry.models.push({ id: 'review/discovery-chat-only', name: model.name, routes: [{ providerId: preset.id,
    modelId: model.id, agents: ['claude-code'], interfaces: [{ profileId: 'deepseek-openai-completions' }] }] });
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [preset], modelRegistry: registry }));
  window.electronAPI.maker.fetchProviderModels = vi.fn(async (input: { modelsUrl?: string | null }) => ({ ok: true,
    models: input.modelsUrl === source.modelsUrl || mainHit ? [model] : [] }));
  renderWizard('deepseek');
  await screen.findByDisplayValue('DeepSeek');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
  fireEvent.click(await screen.findByText(model.name));
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved: CustomProviderConfig = JSON.parse(JSON.stringify(vi.mocked(createCustomProvider).mock.calls[0][0]));
  const route = { baseUrl: source.baseUrl, wireProtocol: source.wireProtocol, ...(!mainHit ? { requestPath: source.requestPath } : {}) };
  expect(saved.runtimes['claude-code']?.models.find(candidate => candidate.id === model.id)).toMatchObject({ route });
  expect(saved.runtimes['claude-code']?.models.find(candidate => candidate.id === model.id)?.interfaceId).toBe(mainHit ? 'deepseek-openai-completions' : undefined);
  const provider = buildUserProvider(saved, { presets: [preset], modelRegistry: registry });
  expect(provider.models['claude-code']?.find(candidate => candidate.id === model.id)).toMatchObject({ id: model.id, route });
});

it.each([false, true])('follows an exact preferred interface through discovery and saving, additional=%s', async additional => {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(candidate => candidate.id === 'deepseek')!);
  const registry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
  const model = { id: 'discovery-dual-preferred-chat', name: 'Discovery preferred Chat' };
  delete preset.runtimes.codex;
  delete preset.runtimes.pi;
  const source = { baseUrl: 'https://api.deepseek.com/anthropic', wireProtocol: 'anthropic-messages' as const,
    modelsUrl: 'https://api.deepseek.com/anthropic/extra/models' };
  if (additional) preset.runtimes['claude-code']!.modelDiscovery = [source];
  registry.models.push({ id: 'review/dual-preferred', name: model.name, routes: [{ providerId: preset.id,
    modelId: model.id, agents: ['claude-code'], interfaces: [
      { profileId: 'deepseek-anthropic-messages' }, { profileId: 'deepseek-openai-completions' },
    ], preferredInterfaces: { 'claude-code': ['deepseek-openai-completions'] } }] });
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [preset], modelRegistry: registry }));
  window.electronAPI.maker.fetchProviderModels = vi.fn(async (input: { modelsUrl?: string | null }) => ({
    ok: true, models: !additional || input.modelsUrl === source.modelsUrl ? [model] : [],
  }));
  renderWizard('deepseek');
  await screen.findByDisplayValue('DeepSeek');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
  fireEvent.click(await screen.findByText(model.name));
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved: CustomProviderConfig = JSON.parse(JSON.stringify(vi.mocked(createCustomProvider).mock.calls[0][0]));
  expect(saved.runtimes['claude-code']?.models.find(candidate => candidate.id === model.id)?.interfaceId).toBeUndefined();
  const provider = buildUserProvider(saved, { presets: [preset], modelRegistry: registry });
  expect(provider.models['claude-code']?.find(candidate => candidate.id === model.id)).toMatchObject({
    api: 'openai-completions', selectedInterface: { profileId: 'deepseek-openai-completions' },
  });
});

it.each([false, true])('honors exact online declarations with different preset memberships, existing row=%s', async existingRow => {
  const preset = structuredClone(BUNDLED_CATALOG.presets!.find(candidate => candidate.id === 'deepseek')!);
  const registry = structuredClone(BUNDLED_CATALOG.modelRegistry!);
  const model = { id: 'account-new-chat-only', name: 'Account new Chat-only' };
  preset.runtimes['claude-code']!.models = [{ id: 'cc-known', name: 'CC known' }];
  preset.runtimes.codex!.models = [existingRow ? model : { id: 'codex-known', name: 'Codex known' }];
  delete preset.runtimes.pi;
  registry.models.push({ id: 'review/online-chat-only', name: model.name, routes: [{ providerId: preset.id,
    modelId: model.id, agents: ['claude-code'], interfaces: [{ profileId: 'deepseek-openai-completions' }] }] });
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [preset], modelRegistry: registry }));
  window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true, models: [model] }));
  renderWizard('deepseek');
  await screen.findByDisplayValue('DeepSeek');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
  const row = await screen.findByText(model.name);
  if (!existingRow) fireEvent.click(row);
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved: CustomProviderConfig = JSON.parse(JSON.stringify(vi.mocked(createCustomProvider).mock.calls[0][0]));
  expect(saved.runtimes['claude-code']?.models.find(candidate => candidate.id === model.id)).toMatchObject({ interfaceId: 'deepseek-openai-completions' });
  const provider = buildUserProvider(saved, { presets: [preset], modelRegistry: registry });
  expect(provider.models['claude-code']?.find(candidate => candidate.id === model.id)).toMatchObject({ api: 'openai-completions',
    route: { baseUrl: 'https://api.deepseek.com', wireProtocol: 'openai-chat' } });
});

it('does not infer a second protocol from identical preset membership at a shared models URL', async () => {
  const preset = structuredClone(openCodePreset);
  for (const runtime of Object.values(preset.runtimes)) runtime.models = [{ id: 'known', name: 'Known model' }];
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [preset] }));
  window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true,
    models: [{ id: 'known', name: 'Known model' }, { id: 'unknown', name: 'Unknown protocol model' }] }));
  renderWizard('opencode-go');
  await screen.findByDisplayValue('OpenCode Go');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
  expect(screen.queryByText('Unknown protocol model')).toBeNull();
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const saved = vi.mocked(createCustomProvider).mock.calls[0][0];
  for (const agent of ['claude-code', 'codex'] as const) {
    expect(saved.runtimes[agent]?.models.some(model => model.id === 'known')).toBe(true);
    expect(saved.runtimes[agent]?.models.some(model => model.id === 'unknown')).toBe(false);
  }
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
    // OpenRouter serves Messages, Responses and Chat for every model: no local conversion.
    expect(modelProtocolComparison(provider, { [agent]: model }).forAgent(agent)?.mode).toBe('matching');
    expect(model.defaultEnabled).toBe(true);
  }
});

describe.each([true, false])('native defaults with discovery available=%s', discoveryAvailable => {
  it.each([
    ['openai/gpt-6-astra', 'openai-responses'],
    ['anthropic/claude-fable-5', 'anthropic-messages'],
    ['deepseek/deepseek-v4-pro', 'openai-completions'],
    ['google/gemini-3.8-flash', 'google-generative-ai'],
  ] as const)('enables every engine OpenRouter serves when selecting %s', async (id, nativeApi) => {
    const agents = ['claude-code', 'codex', 'pi'] as const;
    const preset = structuredClone(BUNDLED_CATALOG.presets!.find(p => p.id === 'openrouter')!);
    for (const agent of agents) {
      const model = preset.runtimes[agent]!.models.find(m => m.id === id)!;
      expect(model).toBeDefined();
      preset.runtimes[agent]!.models = [{ ...model, name: 'Selected model', defaultEnabled: false }];
    }
    vi.mocked(window.electronAPI.maker.listProviderPresets).mockResolvedValue({ presets: [preset] });
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue(discoveryAvailable
      ? { ok: true, models: [{ id, name: 'Selected model' }] }
      : { ok: false });
    renderWizard('openrouter');
    fireEvent.click(await screen.findByText('settings.providers.wizard.useApiKey'));
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
    fireEvent.click(await screen.findByText('Selected model'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    const saved = vi.mocked(createCustomProvider).mock.calls[0][0];
    const provider = buildUserProvider(saved, { presets: [preset], modelRegistry: BUNDLED_CATALOG.modelRegistry });
    agents.forEach(agent => {
      // Model selection must not be persisted as a per-engine visibility override.
      expect(saved.runtimes[agent]!.models.find(m => m.id === id)).not.toHaveProperty('defaultEnabled');
      const model = provider.models[agent]!.find(m => m.id === id)!;
      expect(model).toMatchObject({ nativeApi, defaultEnabled: true });
      expect(modelProtocolComparison(provider, { [agent]: model }).forAgent(agent)?.mode).toBe('matching');
    });
  });
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
  expect(saved.runtimes['claude-code']?.models.find(m => m.id === 'gpt-5.6-luna')).not.toHaveProperty('api');
  expect(saved.runtimes.codex?.models.find(m => m.id === 'gpt-5.6-luna')).not.toHaveProperty('api');
  const model = buildUserProvider(saved, { presets: [preset] }).models.pi?.find(m => m.id === 'gpt-5.6-luna');
  expect(model).toMatchObject({ piApi: 'openai-responses', supportsImageInput: true });
  const projected = buildUserProvider(saved, { presets: [preset] });
  for (const agent of projected.agents) {
    expect(projected.models[agent]?.find(m => m.id === 'gpt-5.6-luna')).toMatchObject({ api: 'openai-responses', defaultEnabled: agent !== 'claude-code' });
    expect(saved.runtimes[agent]?.models.find(m => m.id === 'gpt-5.6-luna')).not.toHaveProperty('route');
  }
});


it.each(['finish', 'back', 'close'] as const)('logs in without a key and handles %s with the owned account', async action => {
  const preset = { id: 'openrouter', name: 'OpenRouter', runtimes: {
    pi: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat' as const,
      models: [{ id: 'test/model', name: 'Test model', api: 'openai-completions' as const }] },
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
  expect(screen.getByText('settings.providers.wizard.recommended')).toBeTruthy();
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

it('does not discard the OAuth connection if the wizard closes while finish is saving', async () => {
  const preset = { id: 'openrouter', name: 'OpenRouter', runtimes: {
    pi: { baseUrl: 'https://openrouter.ai/api/v1', wireProtocol: 'openai-chat' as const,
      models: [{ id: 'test/model', name: 'Test model', defaultEnabled: true, api: 'openai-completions' as const }] },
  } };
  const maker = window.electronAPI.maker;
  vi.mocked(maker.listProviderPresets).mockResolvedValue({ presets: [preset] });
  let created!: Parameters<typeof createCustomProvider>[0];
  vi.mocked(createCustomProvider).mockImplementation(async config => { created = config; return { ok: true }; });
  let finishSaving!: (value: { ok: true }) => void;
  vi.mocked(updateCustomProvider).mockImplementation(() => new Promise(resolve => { finishSaving = resolve; }));
  Object.assign(maker, {
    providerOAuthLogin: vi.fn(async () => ({ ok: true })),
    providerOAuthCancel: vi.fn(async () => ({ ok: true })),
    onProviderOAuthProgress: vi.fn(() => () => undefined),
    listProviders: vi.fn(async () => ({ providers: [{ ...buildUserProvider(created), connected: true }] })),
  });
  const onClose = vi.fn();
  const onDone = vi.fn();
  const view = render(
    React.createElement(AddProviderWizard, {
      providers: [anthropicProvider],
      entry: { kind: 'preset' as const, presetId: 'openrouter' },
      onOpenCustomForm: vi.fn(),
      onClose,
      onDone,
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.button.authorize' }));
  await screen.findByText('Test model');
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.finish' }));
  await waitFor(() => expect(updateCustomProvider).toHaveBeenCalledOnce());
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.cancel' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(deleteCustomProvider).not.toHaveBeenCalled();
  view.unmount();
  expect(deleteCustomProvider).not.toHaveBeenCalled();
  finishSaving({ ok: true });
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(created.id));
  expect(deleteCustomProvider).not.toHaveBeenCalled();
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
  fireEvent.click(await screen.findByRole(
    'button',
    { name: 'settings.providers.button.authorize' },
    { timeout: 5000 },
  ));
  fireEvent.click(await screen.findByText('OAuth discovered model'));
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.finish' }));
  await waitFor(() => expect(updateCustomProvider).toHaveBeenCalledOnce());
  const saved = vi.mocked(updateCustomProvider).mock.calls[0][0];
  const projected = buildUserProvider(saved, { presets: [preset] });
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    expect(saved.runtimes[agent]!.models[0].discoveredCost).toEqual(prices[agent]);
    expect(projected.models[agent]![0].cost).toEqual(prices[agent]);
    expect(projected.models[agent]![0].defaultEnabled).toBe(true);
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


it('keeps legacy curated recommendations selected and newly discovered models unchecked', async () => {
  const preset = { id: 'selection-fixture', name: 'Selection Fixture', runtimes: {
    pi: { baseUrl: 'https://selection.example/v1', wireProtocol: 'openai-chat' as const, models: [
      { id: 'recommended', name: 'Recommended' },
      { id: 'disabled', name: 'Disabled', defaultEnabled: false },
    ] },
  } };
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [preset] }));
  window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true, models: [
    { id: 'recommended', name: 'Recommended' }, { id: 'unspecified', name: 'Unspecified' },
  ] }));
  renderWizard(preset.id);
  await screen.findByDisplayValue('Selection Fixture');
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'fixture-key' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  await screen.findByText('Unspecified');
  expect(screen.getAllByText('settings.providers.wizard.recommended')).toHaveLength(1);
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const models = vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.pi!.models;
  expect(models.filter(model => model.defaultEnabled !== false).map(model => model.id)).toEqual(['recommended']);
});

it('sets up Sub2API from one site address and retains discovered capabilities in all engines', async () => {
  const preset = BUNDLED_CATALOG.presets!.find(p => p.id === 'sub2api')!;
  window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [preset] }));
  const models = parseModelsListResponse({ models: [{ slug: 'private-sol', display_name: 'Private Sol',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'high',
    context_window: 272000, max_context_window: 1050000,
    input_modalities: ['text', 'image'], service_tiers: [{ id: 'priority' }],
  }] })!;
  window.electronAPI.maker.fetchProviderModels = vi.fn(async () => ({ ok: true, models }));
  vi.mocked(createCustomProvider).mockResolvedValue({ ok: true });
  renderWizard('sub2api');
  await screen.findByDisplayValue('Sub2API');
  fireEvent.change(screen.getAllByDisplayValue('https://{endpoint}/v1')[0], { target: { value: 'https://relay.example/team' } });
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test' } });
  fireEvent.click(screen.getByText('settings.providers.wizard.next'));
  fireEvent.click(await screen.findByText('Private Sol'));
  fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
  await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
  const config = vi.mocked(createCustomProvider).mock.calls[0][0];
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    const rt = config.runtimes[agent]!;
    expect(rt.baseUrl).toBe('https://relay.example/team/v1');
    expect(rt.modelsUrl).toBe('https://relay.example/team/v1/models?client_version=0.147.0');
    expect(rt.catalogPresetId).toBe('sub2api');
    expect(rt.models[0].discoveredMetadata).toMatchObject({ efforts: ['low', 'high'],
      contextWindow: 272000, contextWindowMax: 1050000, supportsFastMode: true, supportsImageInput: true });
  }
});

// Scheme-2 handoff must keep connection ownership and user choices; the managed-local
// entry tests above do not cover an independently addressed LM Studio deployment.
describe('identified provider handoff', () => {
  const model = { id: 'private-alias', name: 'My model', contextWindow: 4096, route: { baseUrl: 'https://relay.example/team/v1', wireProtocol: 'openai-chat' as const } };
  const detected = {
    agent: 'pi' as const, apiKey: 'fake-key', keys: { pi: 'fake-key' },
    preset: { id: 'lmstudio', name: 'LM Studio', runtimes: { pi: {
      baseUrl: 'https://relay.example/team/v1', baseUrlEditable: true, wireProtocol: 'openai-chat' as const,
      headers: { 'X-Project': 'test' }, models: [],
    } } },
    config: { id: 'draft', name: 'My remote server', runtimes: { pi: { baseUrl: 'https://relay.example/team/v1', models: [model] } } },
    catalog: { ok: true, models: [{ id: 'private-alias', name: 'Upstream name' }, { id: 'unselected', name: 'Another' }] },
  };
  it.each([false, true])('saves an independent connection and retains overrides on its edited endpoint: %s', async edited => {
    const managed = { ...anthropicProvider, id: 'cindy-local-lmstudio', name: 'LM Studio', source: 'user' } as ProviderView;
    render(<AddProviderWizard providers={[managed]} detected={detected} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    const baseUrl = edited ? 'https://new-relay.example/team/v1' : detected.config.runtimes.pi.baseUrl;
    if (edited) vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue(detected.catalog);
    if (edited) fireEvent.change(await screen.findByDisplayValue(detected.config.runtimes.pi.baseUrl), { target: { value: baseUrl } });
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.wizard.next' }));
    const finish = await screen.findByRole('button', { name: 'settings.providers.wizard.finish' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    if (!edited) expect(window.electronAPI.maker.fetchProviderModels).not.toHaveBeenCalled();
    fireEvent.click(finish);
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    const [config, keys] = vi.mocked(createCustomProvider).mock.calls[0];
    expect(config.id).not.toBe('cindy-local-lmstudio');
    expect(config.runtimes.pi).toMatchObject({ baseUrl, wireProtocol: 'openai-chat', headers: { 'X-Project': 'test' } });
    expect(config.runtimes.pi!.models.find(m => m.id === 'private-alias')).toMatchObject({ ...model, route: { ...model.route, baseUrl } });
    expect(config.runtimes.pi!.models.find(m => m.id === 'unselected')?.defaultEnabled).toBe(false);
    expect(keys).toEqual({ pi: 'fake-key' });
  });
  it.each([true, false])('current checkbox overrides an old disabled draft: checked=%s', async checked => {
    const handoff = { ...detected, config: { ...detected.config, runtimes: { pi: {
      ...detected.config.runtimes.pi, models: [{ ...model, defaultEnabled: false }, { id: 'keep', name: 'Keep' }],
    } } } };
    render(<AddProviderWizard providers={[]} detected={handoff} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.wizard.next' }));
    const finish = await screen.findByRole('button', { name: 'settings.providers.wizard.finish' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    if (!checked) fireEvent.click(screen.getByText('Upstream name'));
    fireEvent.click(finish);
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    const saved = vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.pi!.models.find(m => m.id === model.id)!;
    expect(saved.defaultEnabled).toBe(checked ? undefined : false);
    expect(saved).toMatchObject({ contextWindow: model.contextWindow, route: model.route });
  });
  it.each([true, false])('returns the current selection without reviving disabled flags: %s', async checked => {
    const handoff = { ...detected, config: { ...detected.config, runtimes: { pi: {
      ...detected.config.runtimes.pi, models: [{ ...model, defaultEnabled: false }, { id: 'keep', name: 'Keep' }],
    } } } };
    const onReturnCustom = vi.fn();
    render(<AddProviderWizard providers={[]} detected={handoff} onReturnCustom={onReturnCustom} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.wizard.next' }));
    const finish = await screen.findByRole('button', { name: 'settings.providers.wizard.finish' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    if (!checked) fireEvent.click(screen.getByText('Upstream name'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    const models = onReturnCustom.mock.calls[0][0].config.runtimes.pi.models;
    const returned = models.find((m: { id: string }) => m.id === model.id);
    if (checked) {
      expect(returned.defaultEnabled).toBeUndefined();
      expect(returned).toMatchObject({ contextWindow: model.contextWindow, route: model.route });
    } else expect(returned).toBeUndefined();
    expect(models.some((m: { id: string }) => m.id === 'keep')).toBe(true);
    expect(createCustomProvider).not.toHaveBeenCalled();
  });
  it('saves the explicit native image option carried by a Codex handoff', async () => {
    const runtime = { ...detected.preset.runtimes.pi, wireProtocol: 'openai-responses' as const, supportsImageGeneration: true };
    const handoff = { ...detected, agent: 'codex' as const, keys: { codex: 'fake-key' },
      preset: { ...detected.preset, runtimes: { codex: runtime } },
      config: { ...detected.config, runtimes: { codex: { ...runtime, models: [{ id: 'private-alias', name: 'Model' }] } } },
    };
    render(<AddProviderWizard providers={[]} detected={handoff} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.wizard.next' }));
    const finish = await screen.findByRole('button', { name: 'settings.providers.wizard.finish' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    fireEvent.click(finish);
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex).toMatchObject({ supportsImageGeneration: true, wireProtocol: 'openai-responses' });
  });
  it('retains a hand-entered model when OpenRouter returns a complete public catalog', async () => {
    const baseUrl = 'https://openrouter.ai/api/v1';
    const handoff = { ...detected,
      preset: { ...detected.preset, id: 'openrouter', name: 'OpenRouter', runtimes: { pi: { ...detected.preset.runtimes.pi, baseUrl } } },
      config: { ...detected.config, runtimes: { pi: { baseUrl, models: [{ ...model, route: { ...model.route, baseUrl } }] } } },
      catalog: { ok: true, models: [{ id: 'public-only', name: 'Public' }] },
    };
    render(<AddProviderWizard providers={[]} detected={handoff} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.wizard.next' }));
    const finish = await screen.findByRole('button', { name: 'settings.providers.wizard.finish' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('My model')).toBeTruthy();
    fireEvent.click(finish);
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.pi!.models.find(m => m.id === model.id)).toMatchObject({ id: model.id, contextWindow: 4096 });
  });
  it('preserves hand-entered models for every inherited engine and never fetches an independent draft', async () => {
    const runtime = detected.preset.runtimes.pi;
    const own = { baseUrl: 'https://independent.example/anthropic', models: [{ id: 'own-only', name: 'Own' }] };
    const handoff = { ...detected,
      preset: { ...detected.preset, runtimes: { pi: runtime, codex: { ...runtime } } },
      keys: { pi: 'fake-key', codex: 'fake-key', 'claude-code': 'own-key' },
      config: { ...detected.config, runtimes: { pi: detected.config.runtimes.pi, codex: { ...detected.config.runtimes.pi }, 'claude-code': own } },
    };
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({ ok: true, models: [{ id: 'directory-only', name: 'Directory' }] });
    render(<AddProviderWizard providers={[]} detected={handoff} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.wizard.next' }));
    const finish = await screen.findByRole('button', { name: 'settings.providers.wizard.finish' });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    fireEvent.click(finish);
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
    const [config, keys] = vi.mocked(createCustomProvider).mock.calls[0];
    expect(config.runtimes.codex!.models.some(m => m.id === 'private-alias')).toBe(true);
    expect(config.runtimes['claude-code']).toEqual(own);
    expect(keys['claude-code']).toBe('own-key');
    expect(vi.mocked(window.electronAPI.maker.fetchProviderModels).mock.calls.every(([request]) => request.baseUrl !== own.baseUrl)).toBe(true);
  });
  it('returns selected models only to their own engine with its discovery metadata', async () => {
    const onReturnCustom = vi.fn();
    const runtime = detected.preset.runtimes.pi;
    const handoff = { ...detected, preset: { ...detected.preset, runtimes: { pi: runtime, codex: { ...runtime } } },
      config: { ...detected.config, runtimes: { pi: detected.config.runtimes.pi, codex: { ...detected.config.runtimes.pi } } },
    };
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({ ok: true, models: [
      { id: 'codex-exclusive', name: 'Only Codex', discoveredMetadata: { contextWindow: 50000 } },
    ] });
    render(<AddProviderWizard providers={[]} detected={handoff} onReturnCustom={onReturnCustom} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.wizard.next' }));
    fireEvent.click(await screen.findByText('Only Codex'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    const runtimes = onReturnCustom.mock.calls[0][0].config.runtimes;
    expect(runtimes.pi.models.some((m: { id: string }) => m.id === 'codex-exclusive')).toBe(false);
    expect(runtimes.codex.models.find((m: { id: string }) => m.id === 'codex-exclusive')).toMatchObject({ discoveredMetadata: { contextWindow: 50000 } });
  });
  it('retains a non-active engine URL edited inside the identified wizard when returning', async () => {
    const onReturnCustom = vi.fn();
    const codexUrl = 'https://relay.example/codex/v1';
    const handoff = { ...detected, preset: { ...detected.preset, runtimes: { ...detected.preset.runtimes,
      codex: { ...detected.preset.runtimes.pi, baseUrl: codexUrl },
    } }, config: { ...detected.config, runtimes: { ...detected.config.runtimes, codex: { ...detected.config.runtimes.pi } } } };
    render(<AddProviderWizard providers={[]} detected={handoff} onReturnCustom={onReturnCustom} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.change(await screen.findByDisplayValue(codexUrl), { target: { value: 'https://edited.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    expect(onReturnCustom.mock.calls[0][0].config.runtimes.codex.baseUrl).toBe('https://edited.example/v1');
    expect(onReturnCustom.mock.calls[0][0].config.runtimes.pi.baseUrl).toBe(detected.config.runtimes.pi.baseUrl);
  });
  it('returns shared URL/key edits without replacing an independent engine draft', async () => {
    const onReturnCustom = vi.fn();
    const shared = detected.config.runtimes.pi;
    const handoff = { ...detected, preset: { ...detected.preset, runtimes: { ...detected.preset.runtimes, codex: { ...detected.preset.runtimes.pi, baseUrl: 'https://relay.example/codex/v1' } } }, keys: { pi: 'fake-key', codex: 'fake-key', 'claude-code': 'independent-key' },
      config: { ...detected.config, runtimes: { pi: shared, codex: { ...shared },
        'claude-code': { baseUrl: 'https://independent.example/anthropic', models: [{ id: 'own-model', name: 'Own' }] },
      } },
    };
    render(<AddProviderWizard providers={[]} detected={handoff} onReturnCustom={onReturnCustom} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.change(await screen.findByPlaceholderText('sk-…'), { target: { value: 'edited-fake-key' } });
    fireEvent.change(screen.getByDisplayValue(shared.baseUrl), { target: { value: 'https://new-relay.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    const returned = onReturnCustom.mock.calls[0][0];
    expect(returned.keys).toEqual({ pi: 'edited-fake-key', codex: 'edited-fake-key', 'claude-code': 'independent-key' });
    expect(returned.config.runtimes.codex.baseUrl).toBe('https://new-relay.example/v1');
    expect(returned.config.runtimes['claude-code']).toEqual(handoff.config.runtimes['claude-code']);
    expect(returned.catalog).toBeUndefined();
  });
  it.each([true, false])('keeps an excluded runtime unchanged even when its key and address overlap: %s', async sameAddress => {
    const own = { ...detected.config.runtimes.pi,
      baseUrl: sameAddress ? detected.config.runtimes.pi.baseUrl : 'https://independent.example/v1',
      requestPath: '/independent/messages',
    };
    const handoff = { ...detected, keys: { pi: 'fake-key', 'claude-code': 'fake-key' },
      config: { ...detected.config, runtimes: { ...detected.config.runtimes, 'claude-code': own } } };
    const onReturnCustom = vi.fn();
    render(<AddProviderWizard providers={[]} detected={handoff} onReturnCustom={onReturnCustom} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.change(await screen.findByPlaceholderText('sk-…'), { target: { value: 'new-shared-key' } });
    fireEvent.change(screen.getByDisplayValue(detected.config.runtimes.pi.baseUrl), { target: { value: 'https://new.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    expect(onReturnCustom.mock.calls[0][0].keys['claude-code']).toBe('fake-key');
    expect(onReturnCustom.mock.calls[0][0].config.runtimes['claude-code']).toEqual(own);
  });
  it('returns the draft instead of navigating to the provider gallery, keeping edited credentials', async () => {
    const onReturnCustom = vi.fn();
    render(<AddProviderWizard providers={[]} detected={detected} onReturnCustom={onReturnCustom} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.change(await screen.findByPlaceholderText('sk-…'), { target: { value: 'edited-fake-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.wizard.back' }));
    expect(onReturnCustom).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'edited-fake-key', config: expect.objectContaining({ name: 'My remote server' }) }));
    expect(createCustomProvider).not.toHaveBeenCalled();
  });
});
describe('speech models in the existing provider wizard', () => {
  // PR #6768 unit regression: speech choices must be reached before a long chat
  // catalog. Existing setup tests checked membership/defaults, never reading order.
  it('puts Aliyun speech choices before the discovered general catalog and keeps the recommendation selected', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({ ok: true, models:
      Array.from({ length: 100 }, (_, index) => ({ id: `chat-${index}`, name: `Chat ${index}`, mode: 'chat' })),
    });
    await enter('aliyun-bailian-api-cn');
    const speech = await screen.findByRole('checkbox', { name: /qwen3-tts-flash/ });
    const firstChat = screen.getByText('Chat 0');
    expect(speech.compareDocumentPosition(firstChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(speech.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('checkbox', { name: /cosyvoice/ })).toBeNull();
  });
  it('reuses server API presets instead of duplicating the same speech service entry', async () => {
    window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [{
      id: 'aliyun-model-studio-global', name: 'Server Model Studio', runtimes: {
        codex: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', models: [] },
      },
    }] }));
    render(<AddProviderWizard providers={[]} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    const serverPreset = await screen.findByRole('button', { name: /Server Model Studio/ });
    expect(screen.queryByText('阿里云百炼 API')).toBeNull();
    expect(screen.getByText('阿里云百炼 API（中国大陆）')).toBeTruthy();
    fireEvent.click(serverPreset);
    fireEvent.change(await screen.findByPlaceholderText('sk-…'), { target: { value: 'fake-test-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    expect((await screen.findByRole('checkbox', { name: /qwen3-tts-flash/ })).getAttribute('aria-checked')).toBe('true');
  });
  async function enter(presetId: string, speechOnly = false) {
    render(<AddProviderWizard providers={[]} entry={{ kind: 'preset', presetId, speechOnly }} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.change(await screen.findByPlaceholderText('sk-…'), { target: { value: 'fake-test-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
  }
  it('defaults to one recommended speech model, allows speech-only and does not save unchecked references', async () => {
    await enter('openai-api', true);
    const recommended = await screen.findByRole('checkbox', { name: /gpt-4o-mini-tts/i });
    expect(recommended.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: /tts-1(?!-hd)/i }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalled());
    const config = vi.mocked(createCustomProvider).mock.calls[0][0];
    const enabled = Object.values(config.runtimes).flatMap(rt => rt?.models.filter(model => model.defaultEnabled !== false) ?? []);
    expect(enabled.map(model => model.id)).toEqual(['gpt-4o-mini-tts']);
    expect(config.runtimes.codex?.models.some(model => model.id === 'tts-1')).toBe(false);
    expect(updateCustomProvider).not.toHaveBeenCalled();
  });
  it('supports ElevenLabs discovery and explicit false revokes a recommended offline TTS model', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({ ok: true, models: parseModelsListResponse([
      { model_id: 'eleven_flash_v2_5', can_do_text_to_speech: false },
      { model_id: 'new-voice-model', name: 'New speech model', can_do_text_to_speech: true },
    ])! });
    await enter('elevenlabs-api');
    expect(screen.queryByRole('checkbox', { name: /eleven_flash_v2_5/ })).toBeNull();
    fireEvent.click(screen.getByText('settings.providers.speechSetup.more'));
    const discovered = screen.getByRole('checkbox', { name: /New speech model/ });
    fireEvent.click(discovered);
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalled());
    const models = vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex!.models;
    expect(models.find(model => model.id === 'new-voice-model')?.discoveredMetadata?.mode).toBe('audio_speech');
    expect(models.find(model => model.id === 'eleven_flash_v2_5')?.defaultEnabled).toBe(false);
  });
  it('retains a user deselection and manual speech ID in the saved connection', async () => {
    await enter('elevenlabs-api');
    fireEvent.click(screen.getByRole('checkbox', { name: /eleven_flash_v2_5/i }));
    fireEvent.click(screen.getByText('settings.providers.speechSetup.manual'));
    fireEvent.change(screen.getByRole('textbox', { name: 'settings.providers.speechSetup.modelId' }), { target: { value: 'my-private-speech-model' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.addManualModel'));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalled());
    expect(vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex?.models).toEqual([
      expect.objectContaining({ id: 'my-private-speech-model', mode: 'audio_speech' }),
    ]);
  });
  // #6768 review regression (unit): the actual wizard saves an unchecked discovered
  // TTS model, then the management switch must restore its companion picker entry.
  // Existing tests stopped at defaultEnabled:false or disabled every saved addition.
  it('can show a previously unchecked discovered speech model through model management', async () => {
    const syncVisibility = vi.fn<(owner: string, generation: number, overrides: Record<string, boolean>) => Promise<void>>(async () => undefined);
    Object.assign(window.electronAPI.maker, {
      claimLegacyModelVisibilityOwner: () => ({ dataOwnerId: 'speech-review', ownerGeneration: 1,
        canWriteOwnerScoped: true, claimed: true, claimedByOtherOwner: false,
        canInitialize: true, profileOrigin: 'new' }),
      syncModelVisibility: syncVisibility,
    });
    await setModelVisibilityOwner('speech-review', 1, 'cloud');
    try {
      vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({ ok: true, models: [
        { id: 'my-later-tts', name: 'Later speech', discoveredMetadata: { mode: 'audio_speech' } },
      ] });
      await enter('elevenlabs-api');
      fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
      await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
      const config = vi.mocked(createCustomProvider).mock.calls[0][0];
      expect(config.runtimes.codex?.models.find(model => model.id === 'my-later-tts')?.defaultEnabled).toBe(false);
      const provider = buildUserProvider(config);
      const other = buildUserProvider({ ...config, id: 'another-connection' });
      const deps = {
        catalog: { ...BUNDLED_CATALOG, providers: [provider, other] },
        gatewayAllowed: false, disabled: () => false, readKey: () => 'fake-key',
        gatewayConnection: () => ({ baseUrl: '', apiKey: '' }),
        visibilityOverride: (agent: string, providerId: string, modelId: string) =>
          (syncVisibility.mock.lastCall?.[2] as Record<string, boolean> | undefined)?.[`${agent}:${providerId}:${modelId}`],
      };
      cleanup();
      const view = { ...provider, connected: true,
        availableMediaModelIds: speechModels(deps).filter(model => model.providerId === provider.id).map(model => model.id) };
      render(<UnifiedModelList provider={view} focusModelId="my-later-tts" />);
      const toggle = await screen.findByRole('switch', { name: 'Later speech' });
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      fireEvent.click(toggle);
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Later speech' }).getAttribute('aria-checked')).toBe('true'));
      expect(speechModels(deps).filter(model => model.id === 'my-later-tts' && model.pickerVisible !== false).map(model => model.providerId)).toEqual([provider.id]);
      cleanup();
      render(<UnifiedModelList provider={view} focusModelId="my-later-tts" />);
      expect((await screen.findByRole('switch', { name: 'Later speech' })).getAttribute('aria-checked')).toBe('true');
      expect(config.runtimes.codex?.models.find(model => model.id === 'my-later-tts')?.defaultEnabled).toBe(false);
    } finally {
      cleanup();
      resetVisibility();
    }
  });
});

// PR #6768 / #6660 integration regression (Renderer unit): the real wizard and
// additions dialog must save defaults supported at the configured endpoint.
// Previous tests asserted one brand-wide CosyVoice default; a public DashScope
// URL is the smallest failing input. No live credentials or synthesis required.
describe('Alibaba speech recommendations follow the actual endpoint', () => {
  const endpoints = [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3-tts-flash'],
    ['https://dashscope-intl.aliyuncs.com/api/v1/', 'qwen3-tts-flash'],
    ['https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1', 'cosyvoice-v3-flash'],
    ['https://work-unit.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'cosyvoice-v3-flash'],
    ['https://ws-test.ap-southeast-1.maas.aliyuncs.com/api/v1', 'qwen-audio-3.0-tts-flash'],
    ['https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'qwen-audio-3.0-tts-plus'],
    ['https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', null],
    ['https://dashscope-us.aliyuncs.com/compatible-mode/v1', null],
  ] as const;
  const publicUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  async function openWizard(baseUrl: string) {
    renderWizard('aliyun-bailian-api-global');
    fireEvent.change(await screen.findByDisplayValue(publicUrl), { target: { value: baseUrl } });
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'fake-test-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
  }
  function expectRecommendation(id: string | null) {
    const section = screen.getByRole('region', { name: 'settings.providers.speechSetup.title' });
    const checked = within(section).queryAllByRole('checkbox').filter(row => row.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(id ? 1 : 0);
    if (id) {
      expect(checked[0].textContent).toContain(id);
      expect(within(checked[0]).getByText('settings.providers.wizard.recommended')).toBeTruthy();
    } else {
      expect(within(section).queryByText('settings.providers.wizard.recommended')).toBeNull();
    }
  }
  it.each(endpoints)('new provider uses %s instead of the preset region', async (baseUrl, expected) => {
    await openWizard(baseUrl);
    expectRecommendation(expected);
    if (!expected) return;
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const runtime = vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex!;
    expect(runtime.baseUrl).toBe(baseUrl);
    const speech = runtime.models.filter(model => /tts|cosyvoice/.test(model.id));
    expect(speech.map(model => model.id)).toEqual([expected]);
    expect(speech[0].defaultEnabled).not.toBe(false);
  });
  it.each(endpoints)('existing provider uses the same recommendation for %s', async (baseUrl, expected) => {
    const provider = { ...buildUserProvider({ id: 'my-ali', name: 'Alibaba connection', runtimes: {
      codex: { baseUrl, wireProtocol: 'openai-chat', models: [{ id: 'qwen-plus', name: 'My chat', defaultEnabled: false }] },
    } }), connected: true } as ProviderView;
    vi.mocked(updateCustomProvider).mockResolvedValue({ ok: true });
    render(<AddSpeechModelsDialog provider={provider} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
    expectRecommendation(expected);
    if (!expected) return;
    fireEvent.click(screen.getByText('settings.providers.wizard.addManualModel'));
    await waitFor(() => expect(updateCustomProvider).toHaveBeenCalledTimes(1));
    expect(updateCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
      runtimes: { codex: expect.objectContaining({ baseUrl, models: [expect.objectContaining({ id: expected, defaultEnabled: true })] }) },
    }), {}, { appendSpeechModelsOnly: true });
  });
  it('recomputes recommendations after going back and editing the endpoint', async () => {
    await openWizard(publicUrl);
    expectRecommendation('qwen3-tts-flash');
    fireEvent.click(screen.getByText('settings.providers.wizard.back'));
    const workspace = 'https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1';
    fireEvent.change(await screen.findByDisplayValue(publicUrl), { target: { value: workspace } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
    expectRecommendation('cosyvoice-v3-flash');
    expect(screen.queryByRole('checkbox', { name: /qwen3-tts-flash/ })).toBeNull();
  });
  it('keeps US catalog models unselected and lets the user explicitly add one', async () => {
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({ ok: true, models: [
      { id: 'cosyvoice-v3-flash', name: 'CosyVoice', discoveredMetadata: { mode: 'audio_speech' } },
      { id: 'qwen3-tts-flash', name: 'Qwen3', discoveredMetadata: { mode: 'audio_speech' } },
    ] });
    await openWizard('https://dashscope-us.aliyuncs.com/compatible-mode/v1');
    expectRecommendation(null);
    fireEvent.click(screen.getByRole('checkbox', { name: /cosyvoice-v3-flash/ }));
    fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
    await waitFor(() => expect(createCustomProvider).toHaveBeenCalledTimes(1));
    const models = vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex!.models;
    expect(models.find(model => model.id === 'cosyvoice-v3-flash')).toBeDefined();
    expect(models.find(model => model.id === 'cosyvoice-v3-flash')?.defaultEnabled).not.toBe(false);
    expect(models.find(model => model.id === 'qwen3-tts-flash')?.defaultEnabled).toBe(false);
  });
  it('keeps a previously saved CosyVoice choice when recommending Qwen3 for an existing public connection', async () => {
    const provider = { ...buildUserProvider({ id: 'my-ali', name: 'Alibaba connection', runtimes: {
      codex: { baseUrl: publicUrl, wireProtocol: 'openai-chat', models: [
        { id: 'cosyvoice-v3-flash', name: 'My saved voice', mode: 'audio_speech', defaultEnabled: false },
      ] },
    } }), connected: true } as ProviderView;
    vi.mocked(updateCustomProvider).mockResolvedValue({ ok: true });
    render(<AddSpeechModelsDialog provider={provider} onClose={vi.fn()} onSaved={vi.fn()} />);
    const saved = await screen.findByRole('checkbox', { name: /My saved voice/ });
    expect((saved as HTMLButtonElement).disabled).toBe(true);
    expect(within(saved).getByText('settings.providers.speechSetup.saved')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /qwen3-tts-flash/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('settings.providers.wizard.addManualModel'));
    await waitFor(() => expect(updateCustomProvider).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateCustomProvider).mock.calls[0][0].runtimes.codex?.models).toEqual([
      expect.objectContaining({ id: 'qwen3-tts-flash', defaultEnabled: true }),
    ]);
    expect(provider.models.codex).toEqual([
      expect.objectContaining({ id: 'cosyvoice-v3-flash', name: 'My saved voice', defaultEnabled: false }),
    ]);
  });
});

describe('existing connection speech additions', () => {
  const provider = { ...buildUserProvider({ id: 'my-minimax', name: 'My connection', runtimes: {
    codex: { baseUrl: 'https://api.minimax.io/v1', wireProtocol: 'openai-chat', models: [
      { id: 'MiniMax-M3', name: 'My chat', defaultEnabled: false },
      { id: 'speech-2.8-hd', name: 'My saved voice', mode: 'audio_speech', defaultEnabled: false },
    ] },
  } }), connected: true } as ProviderView;
  it('uses the saved key and submits only selected additions, leaving existing model switches alone', async () => {
    vi.mocked(updateCustomProvider).mockResolvedValue({ ok: true });
    const saved = vi.fn();
    render(<AddSpeechModelsDialog provider={provider} onClose={vi.fn()} onSaved={saved} />);
    const recommended = await screen.findByRole('checkbox', { name: /speech-2.8-turbo/ });
    expect(recommended.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('checkbox', { name: /speech-2.8-hd/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(readCustomProviderKey).toHaveBeenCalledWith('my-minimax', 'codex');
    expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalledWith(expect.objectContaining({ savedProviderId: 'my-minimax', apiKey: 'fake-stored-key' }));
    fireEvent.click(screen.getByText('settings.providers.wizard.addManualModel'));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(updateCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'my-minimax', runtimes: { codex: expect.objectContaining({ models: [expect.objectContaining({ id: 'speech-2.8-turbo', defaultEnabled: true })] }) },
    }), {}, { appendSpeechModelsOnly: true });
    expect(createCustomProvider).not.toHaveBeenCalled();
  });
  it('does not write on cancel and ignores discovery after the dialog unmounts', async () => {
    let resolve!: (value: { ok: true; models: [] }) => void;
    vi.mocked(window.electronAPI.maker.fetchProviderModels).mockReturnValue(new Promise(done => { resolve = done; }));
    const closed = vi.fn();
    const result = render(<AddSpeechModelsDialog provider={provider} onClose={closed} onSaved={vi.fn()} />);
    await waitFor(() => expect(window.electronAPI.maker.fetchProviderModels).toHaveBeenCalled());
    fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    result.unmount();
    resolve({ ok: true, models: [] });
    expect(updateCustomProvider).not.toHaveBeenCalled();
    expect(createCustomProvider).not.toHaveBeenCalled();
  });
});

// Review regression: a mixed provider with no preset models and no directory must
// retain the chat fallback alongside speech suggestions. Prior LiteLLM coverage
// used a URL without speech support (Renderer unit, mock discovery, no requests).
describe('general manual fallback beside speech suggestions', () => {
  it.each([
    ['OpenAI', 'https://api.openai.com/v1'],
    ['MiniMax', 'https://api.minimax.io/v1'],
    ['Bailian', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
  ].flatMap(([name, baseUrl]) => [true, false].map(failed => ({ name, baseUrl, failed }))))(
    'keeps manual chat entry for $name with failed=$failed directory', async ({ name, baseUrl, failed }) => {
      window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [{
        id: 'empty-mixed-api', name, runtimes: { codex: { baseUrl, models: [] } },
      }] }));
      if (!failed) vi.mocked(window.electronAPI.maker.fetchProviderModels).mockResolvedValue({ ok: true, models: [] });
      renderWizard('empty-mixed-api');
      fireEvent.change(await screen.findByPlaceholderText('sk-…'), { target: { value: 'fake-test-key' } });
      fireEvent.click(screen.getByText('settings.providers.wizard.next'));
      const input = await screen.findByPlaceholderText('settings.providers.wizard.manualModelPlaceholder');
      expect(screen.getByText('settings.providers.speechSetup.manual')).toBeTruthy();
      fireEvent.change(input, { target: { value: 'my-new-chat-model' } });
      fireEvent.click(screen.getByText('settings.providers.wizard.addManualModel'));
      fireEvent.click(screen.getByText('settings.providers.wizard.finish'));
      await waitFor(() => expect(createCustomProvider).toHaveBeenCalledOnce());
      const saved = vi.mocked(createCustomProvider).mock.calls[0][0].runtimes.codex!.models;
      expect(saved.find(model => model.id === 'my-new-chat-model')).toMatchObject({ name: 'my-new-chat-model' });
      expect(saved.find(model => model.id === 'my-new-chat-model')?.mode).toBeUndefined();
    },
  );
  it.each(['elevenlabs', 'speech-only'] as const)('does not offer a chat fallback in %s setup', async (kind) => {
    window.electronAPI.maker.listProviderPresets = vi.fn(async () => ({ presets: [{
      id: 'empty-api', name: 'Empty API', runtimes: { codex: {
        baseUrl: kind === 'elevenlabs' ? 'https://api.elevenlabs.io/v1' : 'https://api.openai.com/v1', models: [],
      } },
    }] }));
    render(<AddProviderWizard providers={[]} entry={{ kind: 'preset', presetId: 'empty-api', speechOnly: kind === 'speech-only' }} onClose={vi.fn()} onDone={vi.fn()} onOpenCustomForm={vi.fn()} />);
    fireEvent.change(await screen.findByPlaceholderText('sk-…'), { target: { value: 'fake-test-key' } });
    fireEvent.click(screen.getByText('settings.providers.wizard.next'));
    await screen.findByText('settings.providers.speechSetup.manual');
    await waitFor(() => expect(screen.queryByText('settings.providers.wizard.fetching')).toBeNull());
    expect(screen.queryByPlaceholderText('settings.providers.wizard.manualModelPlaceholder')).toBeNull();
  });
});
