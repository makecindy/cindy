import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  listProviders: vi.fn(),
  readImDefaultSettings: vi.fn(),
  readRemoteRoute: vi.fn(),
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('../../maker-host', () => ({
  getMaker: () => ({ getCapabilities: mocks.getCapabilities }),
}));
vi.mock('../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('../defaultSettingsStore', () => ({
  readImDefaultSettings: mocks.readImDefaultSettings,
}));
vi.mock('../remoteProviderRoute', () => ({ readImRemoteProviderRoute: mocks.readRemoteRoute }));

import { projectImDefaultSettings, resolveImSessionDefaults } from '../defaultSessionSettings';
import { IM_DEFAULT_SETTINGS } from '../../../shared/imDefaultSettings';
import type { ImOrchestratorConfig } from '../shared/types';
import { setModelVisibilityMirror } from '../../maker-host/model-visibility-mirror';

const config: ImOrchestratorConfig = {
  agentKind: 'claude-code',
  defaultModel: 'claude-opus-4-8',
  defaultPermissionMode: 'auto',
  effortOverrides: { 'claude-opus-4-8': 'xhigh' },
};

const claudeModels = [
  {
    id: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    contextWindow: 200_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

const codexModels = [
  {
    id: 'codex/gpt-5.5',
    displayName: 'GPT 5.5',
    contextWindow: 256_000,
    efforts: ['minimal', 'low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

const openAiCodexModels = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT 5.5',
    contextWindow: 256_000,
    efforts: ['minimal', 'low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

const providers = [
  {
    id: 'xd',
    name: 'XD',
    auth: { method: 'managed' },
    source: 'builtin',
    connected: true,
    agents: ['claude-code', 'codex'],
    models: {
      'claude-code': claudeModels,
      codex: codexModels,
    },
    routing: {
      'claude-code': { upstream: 'https://xd.example', authStrategy: 'gateway-key' },
      codex: { upstream: 'https://xd.example', authStrategy: 'gateway-key' },
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    auth: { method: 'managed' },
    source: 'builtin',
    connected: true,
    agents: ['codex'],
    models: {
      'claude-code': [],
      codex: openAiCodexModels,
    },
    routing: {
      codex: { upstream: 'https://api.openai.com', authStrategy: 'oauth-passthrough' },
    },
  },
];

const customCodexModel = {
  id: 'custom-gpt',
  displayName: 'Custom GPT',
  contextWindow: 128_000,
  efforts: ['low', 'high'],
  defaultEffort: 'low',
};

describe('resolveImSessionDefaults', () => {
  // PR #7291 unit: automatic selection must honor per-source visibility in both
  // factory recommendations and custom-provider fallback; previous tests had no overrides.
  it.each([false, true])('excludes hidden automatic models, including fallback (custom=%s)', async (custom) => {
    mocks.readImDefaultSettings.mockReturnValue(IM_DEFAULT_SETTINGS);
    const provider = { ...providers[1], id: custom ? 'custom' : 'openai',
      source: custom ? 'user' : 'builtin', access: { kind: 'subscription' },
      models: { codex: [
        { ...openAiCodexModels[0], id: 'gpt-6.1-sol', sortOrder: 1 },
        { ...openAiCodexModels[0], id: 'shown-model', sortOrder: 2 },
      ] },
    };
    setModelVisibilityMirror({ [`codex:${provider.id}:gpt-6.1-sol`]: false }, { fallback: true });
    mocks.listProviders.mockResolvedValue([provider]);
    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({ model: 'shown-model' });
    setModelVisibilityMirror({ [`codex:${provider.id}:gpt-6.1-sol`]: false,
      [`codex:${provider.id}:shown-model`]: false }, { fallback: true });
    await expect(resolveImSessionDefaults(config)).rejects.toThrow('no available chat model');
  });
  // Unit: old fixed IM defaults ignored catalog updates; exercise the real creation resolver.
  it('resolves automatic defaults from the live catalog without persisting a model snapshot', async () => {
    mocks.readImDefaultSettings.mockReturnValue(IM_DEFAULT_SETTINGS);
    const subscription = {
      ...providers[1], access: { kind: 'subscription' },
      models: { codex: [
        { ...openAiCodexModels[0], sortOrder: 20 },
        { ...openAiCodexModels[0], id: 'current-recommendation', sortOrder: 1 },
      ] },
    };
    mocks.listProviders.mockResolvedValue([providers[0], subscription]);
    const first = await resolveImSessionDefaults(config);
    expect(first).toMatchObject({ agentKind: 'codex', model: 'current-recommendation', providerId: 'openai', effort: 'medium' });
    subscription.models.codex[1].id = 'next-recommendation';
    const next = await resolveImSessionDefaults(config);
    expect(next.model).toBe('next-recommendation');
    expect(next.fingerprint).not.toBe(first.fingerprint);
    expect(IM_DEFAULT_SETTINGS.agents.codex.model).toBe('');
  });

  it('does not invent a model when automatic selection has no usable source', async () => {
    mocks.readImDefaultSettings.mockReturnValue(IM_DEFAULT_SETTINGS);
    mocks.listProviders.mockResolvedValue([]);
    await expect(resolveImSessionDefaults(config)).rejects.toThrow('no available chat model');
    mocks.listProviders.mockRejectedValue(new Error('catalog offline'));
    await expect(resolveImSessionDefaults(config)).rejects.toThrow('no available chat model');
  });

  it('projects automatic engine slots for official workspace overrides without changing saved choices', async () => {
    const saved = { ...IM_DEFAULT_SETTINGS, agents: { ...IM_DEFAULT_SETTINGS.agents,
      'claude-code': { providerId: 'xd', model: 'explicit-old-model', effort: 'high' as const },
    } };
    const view = await projectImDefaultSettings(saved);
    expect(view.agents['claude-code']).toEqual(saved.agents['claude-code']);
    expect(view.agents.codex.model).toBeTruthy();
    expect(view.agents.codex.providerId).toBeTruthy();
    expect(saved.agents.codex.model).toBe('');
    expect(mocks.listProviders).toHaveBeenCalledTimes(1);
  });

  it('filters automatic engines by the channel approval capability', async () => {
    mocks.readImDefaultSettings.mockReturnValue(IM_DEFAULT_SETTINGS);
    mocks.getCapabilities.mockImplementation((agent: string) => ({
      availableModels: [], turnPermissionPolicy: { supported: { supported: agent === 'codex' } },
    }));
    await expect(resolveImSessionDefaults(config, undefined, 'wechat')).resolves.toMatchObject({ agentKind: 'codex' });
  });
  it.each(['claude-code', 'codex', 'pi'] as const)('resolves a shared %s model only against its own catalog', async (agentKind) => {
    mocks.readImDefaultSettings.mockReturnValue({ agentKind, permissionMode: 'auto', agents: {
      [agentKind]: { agentDeviceId: 'share:owner', providerId: 'owner-only', model: 'remote-model', effort: 'high' },
    } });
    mocks.readRemoteRoute.mockResolvedValue({ model: { efforts: ['low'], defaultEffort: 'low' } });
    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind, agentDeviceId: 'share:owner', providerId: 'owner-only', model: 'remote-model', effort: 'low',
    });
    expect(mocks.listProviders).not.toHaveBeenCalled();
    mocks.readRemoteRoute.mockRejectedValue(new Error('[REMOTE_AGENT_SHARE_PAUSED] paused'));
    await expect(resolveImSessionDefaults(config)).rejects.toThrow('REMOTE_AGENT_SHARE_PAUSED');
    expect(mocks.listProviders).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    setModelVisibilityMirror({}, { fallback: true });
    mocks.getCapabilities.mockImplementation((agentKind: string) => ({
      availableModels: agentKind === 'codex' ? codexModels : claudeModels,
    }));
    mocks.listProviders.mockResolvedValue(providers);
  });

  it('preserves an explicitly saved older model and effort', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'codex/gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'claude-code',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      providerId: null,
      permissionMode: 'auto',
      fastMode: false,
    });
  });

  it('reads defaults from the requested channel scope', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'codex/gpt-5.5',
          effort: 'high',
        },
      },
    });

    await resolveImSessionDefaults(config, null, 'discord');

    expect(mocks.readImDefaultSettings).toHaveBeenCalledWith('discord');
  });

  it('keeps a valid Codex default with its selected provider', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: 'openai',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      providerId: 'openai',
      permissionMode: 'auto',
    });
  });

  it('reroutes a stale provider override to an enabled source instead of routing to it', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: 'xd',
          model: 'gpt-5.5',
          effort: 'high',
        },
      },
    });

    // 失效的显式来源(xd 不提供 gpt-5.5)不再仅回落 null 走隐式默认,而是经启用
    // rail 显式解析替代来源(openai)—— turnRunner 直建会话不过路由守卫,隐式
    // 默认落点可能是被停用的拷贝(PR #744 review 第十轮)。
    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      providerId: 'openai',
    });
  });

  it.each([
    ['号池 → Cindy AI（显式来源）', 'org-pool', 'xd', ['auto', 'auto/group-1'], ['pool-model']],
    [
      'Cindy AI → 号池（Pi 默认来源 null 即 Cindy AI）',
      null,
      'org-pool',
      ['auto'],
      ['pool-model', 'auto/group-1'],
    ],
  ] as const)(
    '保存的 Auto 默认在使用时跟随服务端挪动：%s',
    async (_name, saved, expected, xdModels, poolModels) => {
      const piModel = (id: string) => ({
        id,
        name: id,
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      });
      const piProvider = (id: string, source: string, models: readonly string[]) => ({
        id,
        name: id,
        source,
        connected: true,
        agents: ['pi'],
        auth: { method: 'managed' },
        access: { kind: 'managed' },
        models: { pi: models.map(piModel) },
        routing: { pi: { upstream: 'https://example.invalid', authStrategy: 'api-key-header' } },
      });
      mocks.listProviders.mockResolvedValue([
        piProvider('xd', 'builtin', xdModels),
        piProvider('org-pool', 'organization', poolModels),
      ]);
      mocks.readImDefaultSettings.mockReturnValue({
        agentKind: 'pi',
        agents: { pi: { providerId: saved, model: 'auto/group-1', effort: 'high' } },
      });

      await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
        agentKind: 'pi',
        model: 'auto/group-1',
        providerId: expected,
      });
    },
  );

  it('reroutes an implicit default whose native-default copy is disabled', async () => {
    // providerId 留空(隐式路由):原生默认落点(codex → openai)的拷贝被停用而 xd
    // 有启用拷贝时必须显式改道 —— turnRunner 直建不过路由守卫(第十六轮)。
    mocks.listProviders.mockResolvedValue([
      {
        ...providers[0],
        models: {
          'claude-code': claudeModels,
          codex: [{ ...openAiCodexModels[0] }],
        },
      },
      {
        ...providers[1],
        models: {
          'claude-code': [],
          codex: [{ ...openAiCodexModels[0], disabled: true }],
        },
      },
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
        codex: { providerId: null, model: 'gpt-5.5', effort: 'high' },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'xd',
    });
  });

  it('drops a saved provider whose model copy is disabled and reroutes to the enabled copy', async () => {
    mocks.listProviders.mockResolvedValue([
      {
        ...providers[0],
        models: {
          'claude-code': claudeModels,
          // xd 家的 gpt-5.5 拷贝被停用(buildRegistry 烘焙形态);openai 家启用。
          codex: [{ ...openAiCodexModels[0], disabled: true }],
        },
      },
      providers[1],
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
        codex: { providerId: 'xd', model: 'gpt-5.5', effort: 'high' },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
    });
  });

  it('R25:改道后 effort 按落地来源的拷贝 reconcile,不沿用停用拷贝的档位', async () => {
    // 保存来源 xd 的拷贝(支持 high,已停用)→ 改道 openai 拷贝(只到 medium):
    // effort 必须按落地拷贝重算(high → medium),否则直建会话被上游拒。
    mocks.listProviders.mockResolvedValue([
      {
        ...providers[0],
        models: {
          'claude-code': claudeModels,
          codex: [{ ...openAiCodexModels[0], disabled: true }],
        },
      },
      {
        ...providers[1],
        models: {
          'claude-code': [],
          codex: [
            {
              ...openAiCodexModels[0],
              efforts: ['minimal', 'low', 'medium'],
              defaultEffort: 'medium',
            },
          ],
        },
      },
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
        codex: { providerId: 'xd', model: 'gpt-5.5', effort: 'high' },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'medium',
    });
  });

  it('falls back to the first model for the selected agent when the saved model is unavailable', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'missing-model',
          effort: 'xhigh',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      providerId: null,
    });
  });

  it('uses the selected agent model slot without overwriting the other agent default', async () => {
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'codex/gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'codex/gpt-5.5',
      effort: 'high',
      providerId: null,
    });
  });

  it('uses the live provider catalog for models added after Maker was constructed', async () => {
    mocks.listProviders.mockResolvedValue([
      ...providers,
      {
        id: 'custom',
        name: 'Custom',
        source: 'user',
        connected: true,
        agents: ['codex'],
        models: {
          'claude-code': [],
          codex: [customCodexModel],
        },
        routing: {
          codex: { upstream: 'https://custom.example/v1', authStrategy: 'api-key-header' },
        },
      },
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: 'custom',
          model: 'custom-gpt',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'custom-gpt',
      effort: 'high',
      providerId: 'custom',
    });
  });

  it('falls back from Codex budget default when the XD gateway source is disconnected', async () => {
    mocks.listProviders.mockResolvedValue([{ ...providers[0], connected: false }, providers[1]]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'claude-opus-4-8',
          effort: 'xhigh',
        },
        codex: {
          providerId: null,
          model: 'codex/gpt-5.5',
          effort: 'high',
        },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      providerId: null,
    });
  });

  // issue #882 第 3 点(2026-07 review):live provider 快照路径原来不做 chat 准入判定,
  // 一个非聊天模型 id 若恰好被保存为默认值,或排序靠前成为兜底,会被当成 IM 新会话的
  // 有效默认模型——发消息必失败。下面两条锁住 hasModel / firstModel 都必须过 isChatEligible。
  it('rejects a saved default that points at a non-chat gateway model even though a provider offers that id', async () => {
    mocks.listProviders.mockResolvedValue([
      {
        ...providers[0],
        models: {
          ...providers[0].models,
          'claude-code': [
            { ...claudeModels[0], mode: 'chat' },
            { id: 'gpt-image-2', displayName: 'GPT Image 2', contextWindow: 0, efforts: [], defaultEffort: null, mode: 'image_generation' },
          ],
        },
      },
      providers[1],
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': {
          providerId: null,
          model: 'gpt-image-2', // saved default is a non-chat model — must not be accepted as-is
          effort: 'high',
        },
        codex: { providerId: null, model: 'codex/gpt-5.5', effort: 'high' },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'claude-code',
      model: 'claude-opus-4-8', // falls back to the system default model, not the non-chat id
    });
  });

  it('skips a non-chat model that sorts first when falling back to "first model for the agent"', async () => {
    mocks.listProviders.mockResolvedValue([
      {
        ...providers[0],
        models: {
          ...providers[0].models,
          codex: [
            { id: 'gpt-image-2', displayName: 'GPT Image 2', contextWindow: 0, efforts: [], defaultEffort: null, mode: 'image_generation' },
            ...codexModels,
          ],
        },
      },
      providers[1],
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'codex',
      agents: {
        'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
        codex: { providerId: null, model: 'missing-model', effort: 'high' }, // forces the firstModel() fallback path
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5', // the image model must be skipped; use the connected source fallback
    });
  });

  it('reroutes the session to the chat-eligible provider when the saved provider copy of the model is non-chat (2026-07 review: fresh evidence + 第 25 轮)', async () => {
    // Same model id 'shared-id' exists on both providers with DIFFERENT modes:
    // 'xd' (the saved providerId) marks it non-chat; 'openai' marks it chat.
    // hasModel() passes because *some* source is eligible, but resolveProviderId
    // must independently reject binding the session to the specific non-chat source.
    // Returning null is NOT enough: null means implicit default routing, which lands
    // back on the native default source — and 'xd' IS the native default for
    // claude-code, so null would send the request right back to the non-chat copy.
    // The eligible fallback source must be resolved and persisted explicitly.
    mocks.listProviders.mockResolvedValue([
      {
        ...providers[0],
        models: {
          ...providers[0].models,
          'claude-code': [
            ...claudeModels,
            { id: 'shared-id', displayName: 'Shared', contextWindow: 0, efforts: [], defaultEffort: null, mode: 'image_generation' },
          ],
        },
      },
      {
        ...providers[1],
        agents: ['claude-code'],
        routing: {
          ...providers[1].routing,
          'claude-code': { upstream: 'https://api.openai.com', authStrategy: 'oauth-passthrough' },
        },
        models: {
          ...providers[1].models,
          'claude-code': [
            { id: 'shared-id', displayName: 'Shared', contextWindow: 200_000, efforts: [], defaultEffort: null, mode: 'chat' },
          ],
        },
      },
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': { providerId: 'xd', model: 'shared-id', effort: 'high' },
        codex: { providerId: null, model: 'codex/gpt-5.5', effort: 'high' },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'claude-code',
      model: 'shared-id',
      // must not stay pinned to 'xd' (its copy is not chat-eligible), and must not
      // fall back to null either (implicit routing lands back on 'xd', the native
      // default) — the chat-eligible source must be selected explicitly.
      providerId: 'openai',
    });
  });

  it('resolves effort from the chat-eligible copy of the model, not an earlier non-chat copy with different effort metadata (2026-07 review: fresh evidence)', async () => {
    // 'xd' (checked first) has a non-chat copy with empty efforts; 'openai' (checked
    // second) has the real chat copy with efforts=[low,medium,high]. A requested effort
    // that only the chat copy can validate ('xhigh', unsupported) must be clamped using
    // the chat copy's metadata, not silently accepted via the non-chat copy's empty efforts.
    mocks.listProviders.mockResolvedValue([
      {
        ...providers[0],
        models: {
          ...providers[0].models,
          'claude-code': [
            { id: 'shared-id', displayName: 'Shared', contextWindow: 0, efforts: [], defaultEffort: null, mode: 'image_generation' },
          ],
        },
      },
      {
        ...providers[1],
        agents: ['claude-code'],
        routing: {
          ...providers[1].routing,
          'claude-code': { upstream: 'https://api.openai.com', authStrategy: 'oauth-passthrough' },
        },
        models: {
          ...providers[1].models,
          'claude-code': [
            { id: 'shared-id', displayName: 'Shared', contextWindow: 200_000, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', mode: 'chat' },
          ],
        },
      },
    ]);
    mocks.readImDefaultSettings.mockReturnValue({
      agentKind: 'claude-code',
      agents: {
        'claude-code': { providerId: null, model: 'shared-id', effort: 'xhigh' }, // unsupported by the chat copy
        codex: { providerId: null, model: 'codex/gpt-5.5', effort: 'high' },
      },
    });

    await expect(resolveImSessionDefaults(config)).resolves.toMatchObject({
      agentKind: 'claude-code',
      model: 'shared-id',
      effort: 'medium', // clamped using the chat copy's defaultEffort, not silently passed through
    });
  });
});
