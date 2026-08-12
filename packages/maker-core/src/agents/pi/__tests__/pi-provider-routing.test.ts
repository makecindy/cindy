import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  args: [] as string[],
  env: {} as Record<string, string | undefined>,
  requests: [] as Array<Record<string, unknown>>,
  closes: 0,
  requestHandler: undefined as undefined | ((command: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string }>),
}));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(opts: { args: string[]; env?: Record<string, string | undefined> }) {
      captured.args = [...opts.args];
      captured.env = { ...(opts.env ?? {}) };
    }
    async request(command: Record<string, unknown>) {
      captured.requests.push(command);
      if (captured.requestHandler) return captured.requestHandler(command);
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      return { success: true, data: {} };
    }
    send(): void {}
    async close(): Promise<void> { this.isClosed = true; captured.closes += 1; }
  },
}));

import { PiAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { ModelDescriptor } from '../../../types/capabilities.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

describe('Pi provider-aware model routing', () => {
  let agentHome = '';

  /**
   * runtime 文件名带每运行时 nonce(dev + 打包版 / passive 共用 userData 时的跨实例隔离),
   * 所以按「前缀 + sessionId」找,不能再拼死名字。前缀含 sessionId → 不会串到别的用例。
   */
  const runtimeFileOf = (prefix: string, sessionId: string): string => {
    const dir = path.join(agentHome, 'runtime');
    const name = readdirSync(dir).find((f) => f.startsWith(prefix + '-' + sessionId + '-'));
    if (!name) throw new Error('runtime file not found: ' + prefix + '-' + sessionId + '-*');
    return path.join(dir, name);
  };
  let cwd = '';

  beforeEach(() => {
    captured.args = [];
    captured.requests = [];
    captured.closes = 0;
    captured.requestHandler = undefined;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-provider-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-provider-cwd-'));
  });

  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('uses providerId as the primary key when duplicate model ids exist', async () => {
    const authProviderIds: Array<string | null | undefined> = [];
    const deps: AgentDeps = {
      auth: {
        getState: async (options) => {
          authProviderIds.push(options?.providerId);
          return { authenticated: true, identity: 'test', authSource: 'api-key' as const };
        },
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'shared-model', displayName: 'Shared', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => ({
        providers: [
          { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'shared-model' }] },
          { id: 'native-b', name: 'Native B', baseUrl: 'http://b.test', api: 'openai-completions', models: [{ id: 'shared-model' }] },
        ],
        env: {},
      }),
    };
    const agent = new PiAgent(deps);

    // 同名模型显式选 OpenAI 订阅时必须走 compat gateway，而不是被任一 BYOM 抢走。
    const handle = await agent.startSession({
      sessionId: 'provider-routing',
      workingDir: cwd,
      model: 'shared-model',
      providerId: 'openai',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'cindy']);
    expect(authProviderIds).toEqual(['openai']);

    // models.json 现落在每会话隔离的 configHome(PI_CODING_AGENT_DIR),不再在共享 agentHome 根。
    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as {
      providers: Record<string, { models: Array<{ id: string }> }>;
    };
    expect(models.providers.cindy?.models.some((model) => model.id === 'shared-model')).toBe(true);
    expect(models.providers['native-a']?.models.some((model) => model.id === 'shared-model')).toBe(true);
    expect(models.providers['native-b']?.models.some((model) => model.id === 'shared-model')).toBe(true);

    await handle.setModel!('shared-model', { providerId: 'native-b' });
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'native-b',
      modelId: 'shared-model',
    });
    await handle.close();

    const nativeHandle = await agent.startSession({
      sessionId: 'provider-routing-native',
      workingDir: cwd,
      model: 'shared-model',
      providerId: 'native-a',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'native-a']);
    expect(authProviderIds).toEqual(['openai', 'native-a']);
    await nativeHandle.close();
  });

  it('keeps built-in gateway reasoning when a same-id non-reasoning BYOM empties the flat effort intersection', async () => {
    const resolver = vi.fn((modelId: string) => {
      if (modelId !== 'shared-model') return null;
      return {
        id: modelId,
        displayName: 'Shared through Cindy',
        contextWindow: 200_000,
        efforts: ['minimal', 'low', 'high'] as const,
        defaultEffort: 'high' as const,
      };
    });
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        // 模拟 flat availableModels 已因 non-reasoning BYOM 同 id 冲突收敛为空。
        availableModels: [
          { id: 'shared-model', displayName: 'Shared', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => ({
        providers: [
          {
            id: 'native-a',
            name: 'Native A',
            baseUrl: 'http://a.test',
            api: 'openai-responses',
            models: [{ id: 'shared-model', reasoning: false }],
          },
        ],
        env: {},
      }),
      resolvePiGatewayModelDescriptor: resolver,
    };
    const agent = new PiAgent(deps);

    const handle = await agent.startSession({
      sessionId: 'gateway-reasoning-collision',
      workingDir: cwd,
      model: 'shared-model',
      providerId: 'openai',
      effort: 'high',
    });

    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as {
      providers: Record<string, { models: Array<{ id: string; reasoning: boolean }> }>;
    };
    expect(resolver).toHaveBeenCalledWith('shared-model');
    expect(models.providers.cindy?.models.find((model) => model.id === 'shared-model')).toMatchObject({
      reasoning: true,
    });
    expect(models.providers['native-a']?.models.find((model) => model.id === 'shared-model')).toMatchObject({
      reasoning: false,
    });
    expect(captured.requests).toContainEqual({ type: 'set_thinking_level', level: 'high' });
    await handle.close();
  });

  it('reconciles a stale persisted effort to the selected BYOM model default before startup', async () => {
    const resolver = vi.fn((providerId: string | null | undefined, modelId: string) => {
      if (providerId !== 'native-a' || modelId !== 'shared-model') return null;
      return {
        id: modelId,
        displayName: 'Shared through BYOM',
        contextWindow: 200_000,
        efforts: ['low', 'xhigh'] as const,
        defaultEffort: 'xhigh' as const,
      };
    });
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          {
            id: 'shared-model',
            displayName: 'Shared',
            contextWindow: 200_000,
            efforts: ['low'],
            defaultEffort: 'low',
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => ({
        providers: [
          {
            id: 'native-a',
            name: 'Native A',
            baseUrl: 'http://a.test',
            api: 'openai-responses',
            models: [
              {
                id: 'shared-model',
                reasoning: true,
                thinkingLevelMap: {
                  minimal: null,
                  low: 'low',
                  medium: null,
                  high: null,
                  xhigh: 'xhigh',
                  max: null,
                },
              },
            ],
          },
        ],
        env: {},
      }),
      resolvePiRuntimeModelDescriptor: resolver,
    };
    const agent = new PiAgent(deps);

    const handle = await agent.startSession({
      sessionId: 'stale-effort',
      workingDir: cwd,
      model: 'shared-model',
      providerId: 'native-a',
      // 旧任务保存的 high 已在用户收窄能力后失效；必须走当前路由默认 xhigh，不能发 high→null。
      effort: 'high',
    });

    expect(resolver).toHaveBeenCalledWith('native-a', 'shared-model');
    expect(captured.requests).toContainEqual({ type: 'set_thinking_level', level: 'xhigh' });
    expect(captured.requests).not.toContainEqual({ type: 'set_thinking_level', level: 'high' });
    await handle.close();
  });

  it('freezes active BYOM effort selection to the startup models.json snapshot', async () => {
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        {
          id: 'native-a',
          name: 'Native A',
          baseUrl: 'http://a.test',
          api: 'openai-responses',
          models: [{
            id: 'local-model',
            reasoning: true,
            thinkingLevelMap: {
              minimal: null,
              low: 'low',
              medium: null,
              high: null,
              xhigh: null,
              max: null,
            },
          }],
        },
      ],
      env: {},
    })));

    const handle = await agent.startSession({
      sessionId: 'frozen-effort-snapshot',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
      effort: 'low',
    });
    const startupRequests = captured.requests.filter((request) => request.type === 'set_thinking_level');
    expect(startupRequests).toContainEqual({ type: 'set_thinking_level', level: 'low' });

    // provider 保存后 renderer 目录可能已出现 xhigh，但这个活动 Pi 进程仍读旧 models.json。
    await expect(handle.setEffort!('xhigh')).rejects.toThrow(/startup model snapshot.*restart the Pi session/);
    expect(captured.requests.filter((request) => request.type === 'set_thinking_level')).toHaveLength(
      startupRequests.length,
    );

    await handle.setEffort!('low');
    expect(captured.requests.filter((request) => request.type === 'set_thinking_level')).toHaveLength(
      startupRequests.length + 1,
    );
    await handle.close();
  });

  it('rejects an atomic model switch before set_model when its effort is outside the startup snapshot', async () => {
    const lowOnly = {
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: 'low',
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    } as const;
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [{
        id: 'native-a',
        name: 'Native A',
        baseUrl: 'http://a.test',
        api: 'openai-responses',
        models: [
          { id: 'local-model', ...lowOnly },
          { id: 'target-model', ...lowOnly },
        ],
      }],
      env: {},
    }), [
      { id: 'local-model', displayName: 'Local', contextWindow: 200_000, efforts: ['low'], defaultEffort: 'low' },
      { id: 'target-model', displayName: 'Target', contextWindow: 200_000, efforts: ['low'], defaultEffort: 'low' },
    ]));
    const handle = await agent.startSession({
      sessionId: 'atomic-effort-preflight',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
      effort: 'low',
    });
    const beforeSwitch = captured.requests.length;

    // renderer catalog 热更新后把目标模型显示成 high；活动 Pi 的 models.json 仍只允许 low。
    await expect(handle.setModel!('target-model', { providerId: 'native-a', effort: 'high' }))
      .rejects.toThrow(/startup model snapshot/);
    expect(captured.requests.slice(beforeSwitch)).not.toContainEqual({
      type: 'set_model',
      provider: 'native-a',
      modelId: 'target-model',
    });
    expect(handle.model).toBe('local-model');
    await handle.close();
  });

  it('freezes omitted BYOM reasoning to an empty startup capability snapshot', async () => {
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [{
        id: 'native-a',
        name: 'Native A',
        baseUrl: 'http://a.test',
        api: 'openai-responses',
        // buildPiNativeProvidersFromConfigs omits reasoning for this model; models.json writes false.
        models: [{ id: 'local-model' }],
      }],
      env: {},
    })));
    const handle = await agent.startSession({
      sessionId: 'frozen-non-reasoning-snapshot',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });

    await expect(handle.setEffort!('xhigh')).rejects.toThrow(/startup model snapshot/);
    expect(captured.requests.some((request) => request.type === 'set_thinking_level')).toBe(false);
    await handle.close();
  });

  it('accepts the low placeholder after switching to a non-reasoning gateway model', async () => {
    const availableModels: readonly ModelDescriptor[] = [
      { id: 'local-model', displayName: 'Local', contextWindow: 200_000, efforts: ['low'], defaultEffort: 'low' },
      { id: 'gateway-model', displayName: 'Gateway', contextWindow: 200_000, efforts: [], defaultEffort: null },
    ];
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [{
        id: 'native-a',
        name: 'Native A',
        baseUrl: 'http://a.test',
        api: 'openai-responses',
        models: [{
          id: 'local-model',
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            low: 'low',
            medium: null,
            high: null,
            xhigh: null,
            max: null,
          },
        }],
      }],
      env: {},
    }), availableModels));
    const handle = await agent.startSession({
      sessionId: 'switch-to-non-reasoning-gateway',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
      effort: 'low',
    });
    const beforePlaceholder = captured.requests.filter((request) => request.type === 'set_thinking_level').length;

    await handle.setModel!('gateway-model', { providerId: null });
    await expect(handle.setEffort!('low')).resolves.toBeUndefined();
    expect(captured.requests.filter((request) => request.type === 'set_thinking_level')).toHaveLength(
      beforePlaceholder,
    );
    await handle.close();
  });

  const byomDeps = (
    resolvePiNativeProviders: AgentDeps['resolvePiNativeProviders'],
    availableModels: readonly ModelDescriptor[] = [
      { id: 'local-model', displayName: 'Local', contextWindow: 200_000, efforts: [], defaultEffort: null },
    ],
  ): AgentDeps => ({
    auth: {
      getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
      triggerLogin: async () => ({ authenticated: true }),
      logout: async () => {},
      getAuthEnv: async () => ({}),
    },
    runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
    binaryPath: path.join(agentHome, 'pi'),
    logger: noopLogger,
    capabilityAdditions: {
      availableModels,
    },
    resolvePiAgentHome: () => agentHome,
    resolvePiNativeProviders,
  });

  function installPlanModeExtension(): void {
    const extension = path.join(path.dirname(path.join(agentHome, 'pi')), 'examples', 'extensions', 'plan-mode', 'index.ts');
    mkdirSync(path.dirname(extension), { recursive: true });
    writeFileSync(extension, '// mocked plan-mode extension');
  }

  it('fails closed for an explicit BYOM route when native provider resolution throws (no silent gateway fallback)', async () => {
    // 显式选自定义 provider 但配置/safeStorage 暂时读不到:必须抛,不能静默改发 Cindy 网关。
    const agent = new PiAgent(byomDeps(async () => {
      throw new Error('safeStorage temporarily unavailable');
    }));
    await expect(agent.startSession({
      sessionId: 'byom-resolve-fail',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'my-local',
    })).rejects.toThrow(/BYOM provider 'my-local' cannot serve model 'local-model'/);
    // 未走到 spawn(--provider 参数从未拼装)。
    expect(captured.args).toEqual([]);
  });

  it('fails closed when an explicit BYOM provider exists but no longer offers the model', async () => {
    // 用户编辑配置后从现有 provider 删/改了当前 model:provider 仍在,但不含该 model。
    // resolveProviderForModel 会静默回落 cindy(local-model 网关目录里也有 → 会“成功”);
    // 显式 BYOM 必须 fail closed,不能悄悄把请求发往网关(codex review P1)。
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'my-local', name: 'My Local', baseUrl: 'http://l.test', api: 'openai-completions', models: [{ id: 'other-model' }] },
      ],
      env: {},
    })));
    await expect(agent.startSession({
      sessionId: 'byom-model-removed',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'my-local',
    })).rejects.toThrow(/cannot serve model 'local-model'.*refusing to fall back/s);
    expect(captured.args).toEqual([]);
  });

  it('fails closed for an explicit BYOM route absent from the resolved provider set', async () => {
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'local-model' }] },
      ],
      env: {},
    })));
    await expect(agent.startSession({
      sessionId: 'byom-absent',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'my-local',
    })).rejects.toThrow(/refusing to fall back to the Cindy gateway/);
    expect(captured.args).toEqual([]);
  });

  it('fails closed when setModel selects a BYOM provider added after the session started', async () => {
    // 启动快照只含 native-a;会话中途选一个启动后才新增的自定义 provider 必须抛(提示重启),
    // 不能静默回落 cindy 网关(codex review P1)。
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'local-model' }] },
      ],
      env: {},
    })));
    const handle = await agent.startSession({
      sessionId: 'byom-setmodel',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    await expect(handle.setModel!('local-model', { providerId: 'added-later' }))
      .rejects.toThrow(/cannot serve model 'local-model'|restart the session/);
    // 已在快照里的 provider 仍可正常切换。
    await expect(handle.setModel!('local-model', { providerId: 'native-a' })).resolves.toBeUndefined();
    await handle.close();
  });

  it('fails closed when setModel picks a model the pinned BYOM provider does not offer', async () => {
    // provider 在启动快照里,但用户切到一个该 provider 不提供的 model:同样不得静默回落网关。
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'local-model' }] },
      ],
      env: {},
    })));
    const handle = await agent.startSession({
      sessionId: 'byom-setmodel-modelgone',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    await expect(handle.setModel!('ghost-model', { providerId: 'native-a' }))
      .rejects.toThrow(/cannot serve model 'ghost-model'/);
    await handle.close();
  });

  it('guards image prompts by the startup provider-model capability and follows model switches', async () => {
    const gatewayModels: ModelDescriptor[] = [
      {
        id: 'gateway-text',
        displayName: 'Gateway Text',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        supportsImageInput: false,
      },
      {
        id: 'gateway-vision',
        displayName: 'Gateway Vision',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
        supportsImageInput: true,
      },
      {
        id: 'gateway-unknown',
        displayName: 'Gateway Unknown',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
      {
        id: 'local-model',
        displayName: 'Local',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ];
    const resolveGatewayModel = vi.fn((modelId: string) =>
      gatewayModels.find((candidate) => candidate.id === modelId) ?? null,
    );
    const agent = new PiAgent({
      ...byomDeps(async () => ({
        providers: [
          {
            id: 'native-text',
            name: 'Native Text',
            baseUrl: 'http://text.test',
            api: 'openai-completions',
            models: [{ id: 'local-model', input: ['text'] }],
          },
          {
            id: 'native-vision',
            name: 'Native Vision',
            baseUrl: 'http://vision.test',
            api: 'openai-completions',
            models: [{ id: 'local-model', input: ['text', 'image'] }],
          },
        ],
        env: {},
      }), gatewayModels),
      resolvePiGatewayModelDescriptor: resolveGatewayModel,
    });
    const handle = await agent.startSession({
      sessionId: 'image-capability',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-text',
    });
    const imagePath = path.join(cwd, 'screenshot.png');
    writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const imageMessage = {
      type: 'user' as const,
      content: [{ type: 'image' as const, path: imagePath }],
    };
    const mixedMessage = {
      type: 'user' as const,
      content: [
        { type: 'text' as const, text: 'describe this image' },
        { type: 'image' as const, path: imagePath },
      ],
    };
    const instructedMessage = {
      type: 'user' as const,
      content: [
        { type: 'text' as const, text: '$识图 请读取附件' },
        { type: 'image' as const, path: imagePath },
      ],
    };
    const multiImageMessage = {
      type: 'user' as const,
      content: [
        { type: 'image' as const, path: imagePath },
        { type: 'image' as const, path: imagePath },
      ],
    };
    const modelsJson = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as {
      providers: Record<string, { models: Array<{ id: string; input: string[] }> }>;
    };
    expect(modelsJson.providers.cindy?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gateway-text', input: ['text'] }),
      expect.objectContaining({ id: 'gateway-vision', input: ['text', 'image'] }),
      expect.objectContaining({ id: 'gateway-unknown', input: ['text'] }),
    ]));

    captured.requests.length = 0;
    await expect(handle.send(imageMessage)).rejects.toMatchObject({
      code: 'PI_IMAGE_INPUT_UNSUPPORTED',
    });
    await expect(handle.steer!(imageMessage)).rejects.toMatchObject({
      code: 'PI_IMAGE_INPUT_UNSUPPORTED',
    });
    expect(captured.requests.some((request) => request.type === 'prompt' || request.type === 'steer'))
      .toBe(false);

    await handle.setModel!('local-model', { providerId: 'native-vision' });
    captured.requests.length = 0;
    await handle.send(imageMessage);
    expect(captured.requests).toContainEqual(expect.objectContaining({
      type: 'prompt',
      images: [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
    }));

    // 网关纯文本模型在 Pi/provider 调用前拒绝所有带图形态；文本指令不能绕过能力门。
    await handle.setModel!('gateway-text', { providerId: null });
    captured.requests.length = 0;
    for (const message of [imageMessage, mixedMessage, instructedMessage, multiImageMessage]) {
      await expect(handle.send(message)).rejects.toMatchObject({
        code: 'PI_IMAGE_INPUT_UNSUPPORTED',
      });
    }
    await expect(handle.steer!(mixedMessage)).rejects.toMatchObject({
      code: 'PI_IMAGE_INPUT_UNSUPPORTED',
    });
    expect(captured.requests.some((request) => request.type === 'prompt' || request.type === 'steer'))
      .toBe(false);

    // 能力未知同样 fail closed；活动会话只认启动时写入 models.json 的能力快照。
    await handle.setModel!('gateway-unknown', { providerId: null });
    await expect(handle.send(imageMessage)).rejects.toMatchObject({
      code: 'PI_IMAGE_INPUT_UNSUPPORTED',
    });
    gatewayModels[0]!.supportsImageInput = true;
    await handle.setModel!('gateway-text', { providerId: null });
    await expect(handle.send(imageMessage)).rejects.toMatchObject({
      code: 'PI_IMAGE_INPUT_UNSUPPORTED',
    });

    // 明确支持图片的网关模型保留全部图片块，多图不被剥离或改写。
    await handle.setModel!('gateway-vision', { providerId: null });
    captured.requests.length = 0;
    await handle.send(multiImageMessage);
    expect(captured.requests).toContainEqual(expect.objectContaining({
      type: 'prompt',
      images: [
        expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
        expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
      ],
    }));

    // 文件读失败不会生成 image block，仍保留既有的“图片不可读”文本语义。
    await handle.setModel!('local-model', { providerId: 'native-text' });
    captured.requests.length = 0;
    await handle.send({
      type: 'user',
      content: [{ type: 'image', path: path.join(cwd, 'missing.png') }],
    });
    expect(captured.requests).toContainEqual(expect.objectContaining({
      type: 'prompt',
      message: expect.stringContaining('(image unavailable:'),
    }));
    await handle.close();
  });

  it('keeps a leading /skill: command at the prompt start even when Extra Dirs are configured', async () => {
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'skill-extradir',
      workingDir: cwd,
      model: 'local-model',
      extraDirs: ['/refs/project-docs'],
    });
    captured.requests.length = 0;
    await handle.send({ type: 'user', content: '/skill:code-review please' });
    const prompt = captured.requests.find((r) => r.type === 'prompt');
    // /skill: 必须仍在 prompt 起始(未被 Extra Dir 引用段挤走),否则 Pi 不加载技能。
    expect(String(prompt?.message).startsWith('/skill:code-review')).toBe(true);

    // 对照:普通消息仍前置 Extra Dir 引用段。
    captured.requests.length = 0;
    await handle.send({ type: 'user', content: 'just a normal message' });
    const normal = captured.requests.find((r) => r.type === 'prompt');
    expect(String(normal?.message).startsWith('/skill:')).toBe(false);
    expect(String(normal?.message)).toContain('project-docs');
    await handle.close();
  });

  it('routes a null providerId to the gateway even when a BYOM offers the same model', async () => {
    // null = 显式清除来源(session-provider-store 语义);Main 在恢复/setModel 时传它。绝不能
    // 按模型自动挑同名 BYOM,否则默认路由的会话把提示词发往用户未选的 BYOM 端点(codex review P1)。
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        { id: 'native-a', name: 'Native A', baseUrl: 'http://a.test', api: 'openai-completions', models: [{ id: 'local-model' }] },
      ],
      env: {},
    })));
    const handle = await agent.startSession({
      sessionId: 'null-provider',
      workingDir: cwd,
      model: 'local-model',
      providerId: null,
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'cindy']);
    // setModel 传 null 同样固定走网关(不落到 native-a)。
    captured.requests.length = 0;
    await handle.setModel!('local-model', { providerId: null });
    expect(captured.requests).toContainEqual({ type: 'set_model', provider: 'cindy', modelId: 'local-model' });
    await handle.close();
  });

  it('serializes rapid permission-mode switches so the file converges to the latest intent', async () => {
    // 并发/连续切档:串行化 + 代际跳过保证权限档最终 = 最后一次意图(ask),较早的 bypass 写
    // 不得在其后 stale 覆盖(否则 bridge 现读到 bypassPermissions,而 host/UI 已是 Ask)。
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({ sessionId: 'perm-race', workingDir: cwd, model: 'local-model' });
    const permFile = runtimeFileOf('perm', 'perm-race');
    const a = handle.setPermissionMode!('bypassPermissions');
    const b = handle.setPermissionMode!('ask');
    await Promise.all([a, b]);
    expect(JSON.parse(readFileSync(permFile, 'utf8')).mode).toBe('ask');
    await handle.close();
  });

  it('recovers the permission-write chain after a failed write (no permanent poisoning)', async () => {
    // 瞬时 fs 故障不得永久污染串行链:否则文件系统恢复后的重写也追加不进去,bridge 一直卡在旧档。
    const fsp = await import('node:fs');
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'perm-recover',
      workingDir: cwd,
      model: 'local-model',
      permissionMode: 'ask',
    });
    const permFile = runtimeFileOf('perm', 'perm-recover');
    // 下一次写(尝试放宽到 Full)失败一次；旧文件仍是安全的 ask，此后恢复真实写。
    const spy = vi.spyOn(fsp.promises, 'writeFile').mockRejectedValueOnce(new Error('transient EIO'));
    await handle.setPermissionMode!('bypassPermissions').catch(() => {});
    spy.mockRestore();
    // 若链被污染,这次 auto 写的 .then 永不执行,文件会停在 ask;恢复后应写成 auto。
    await handle.setPermissionMode!('auto');
    expect(JSON.parse(readFileSync(permFile, 'utf8')).mode).toBe('auto');
    await handle.close();
  });

  it('does not replay a failed Full-access intent when Extra Dirs are updated later', async () => {
    const fsp = await import('node:fs');
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'perm-failed-intent',
      workingDir: cwd,
      model: 'local-model',
      permissionMode: 'ask',
    });
    const permFile = runtimeFileOf('perm', 'perm-failed-intent');
    const spy = vi.spyOn(fsp.promises, 'writeFile').mockRejectedValueOnce(new Error('transient EIO'));
    await expect(handle.setPermissionMode!('bypassPermissions')).rejects.toThrow('transient EIO');
    spy.mockRestore();

    await handle.setExtraDirs!(['/reference-only']);
    expect(JSON.parse(readFileSync(permFile, 'utf8'))).toEqual({
      mode: 'ask',
      readOnlyRoots: ['/reference-only'],
    });
    await handle.close();
  });

  it('reports the stable Pi user entry id after prompt acceptance', async () => {
    let promptAccepted = false;
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'prompt') {
        promptAccepted = true;
        return { success: true, data: {} };
      }
      if (command.type === 'get_entries') {
        return {
          success: true,
          data: {
            entries: [
              { id: 'old-user', type: 'message', message: { role: 'user', content: 'old' } },
              ...(promptAccepted
                ? [{ id: 'new-user', type: 'message', message: { role: 'user', content: 'new' } }]
                : []),
            ],
          },
        };
      }
      return { success: true, data: {} };
    };
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'entry-link',
      workingDir: cwd,
      model: 'local-model',
    });
    const onTranscriptUserEntry = vi.fn();
    await handle.send(
      { type: 'user', content: 'new' },
      { onTranscriptUserEntry },
    );
    expect(onTranscriptUserEntry).toHaveBeenCalledOnce();
    expect(onTranscriptUserEntry).toHaveBeenCalledWith('new-user');
    await handle.close();
  });

  it('closes the Pi process if tightening a persisted Full-access file fails', async () => {
    const fsp = await import('node:fs');
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'perm-tighten-fail',
      workingDir: cwd,
      model: 'local-model',
      permissionMode: 'bypassPermissions',
    });
    const spy = vi.spyOn(fsp.promises, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(handle.setPermissionMode!('ask')).rejects.toThrow('disk unavailable');
    spy.mockRestore();
    // 子进程 bridge 仍会从旧文件读到 Full access；必须终止会话，不能只收紧 host 镜像。
    expect(captured.closes).toBe(1);
    await handle.close();
  });

  it('serializes concurrent plan-mode requests so same-target toggles only once', async () => {
    installPlanModeExtension();
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({ sessionId: 'plan-race', workingDir: cwd, model: 'local-model' });
    expect(handle.getPlanMode!()).toBe(false);

    await Promise.all([handle.setPlanMode!(true), handle.setPlanMode!(true)]);
    expect(captured.requests.filter((request) => request.type === 'prompt' && request.message === '/plan')).toHaveLength(1);
    expect(handle.getPlanMode!()).toBe(true);
    await handle.close();
  });

  it('keeps plan mode unknown after sync failure and refuses a blind toggle until it can resync', async () => {
    installPlanModeExtension();
    let entriesAvailable = false;
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'get_entries') {
        return entriesAvailable
          ? { success: true, data: { entries: [{ customType: 'plan-mode', data: { enabled: true } }] } }
          : { success: false, error: 'temporary rpc failure' };
      }
      return { success: true, data: {} };
    };
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({ sessionId: 'plan-unknown', workingDir: cwd, model: 'local-model' });
    expect(handle.getPlanMode!()).toBeNull();
    await expect(handle.setPlanMode!(false)).rejects.toThrow(/state is unavailable/);
    expect(captured.requests.some((request) => request.type === 'prompt' && request.message === '/plan')).toBe(false);

    entriesAvailable = true;
    await handle.setPlanMode!(false);
    expect(captured.requests.filter((request) => request.type === 'prompt' && request.message === '/plan')).toHaveLength(1);
    expect(handle.getPlanMode!()).toBe(false);
    await handle.close();
  });

  it('marks plan mode unknown when a toggle transport failure may have happened after execution', async () => {
    installPlanModeExtension();
    let persistedEnabled = false;
    let failNextToggle = true;
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'get_entries') {
        return {
          success: true,
          data: { entries: [{ customType: 'plan-mode', data: { enabled: persistedEnabled } }] },
        };
      }
      if (command.type === 'prompt' && command.message === '/plan') {
        persistedEnabled = !persistedEnabled; // Pi 已执行，但本地 transport 随后超时。
        if (failNextToggle) {
          failNextToggle = false;
          throw new Error('rpc timeout');
        }
      }
      return { success: true, data: {} };
    };
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({ sessionId: 'plan-timeout', workingDir: cwd, model: 'local-model' });

    await expect(handle.setPlanMode!(true)).rejects.toThrow('rpc timeout');
    expect(handle.getPlanMode!()).toBeNull();
    // 下一次同目标先读回 persisted=true，不能再 toggle 一次把 Pi 反向关掉。
    await handle.setPlanMode!(true);
    expect(captured.requests.filter((request) => request.type === 'prompt' && request.message === '/plan')).toHaveLength(1);
    expect(handle.getPlanMode!()).toBe(true);
    await handle.close();
  });

  it('does not fail closed for a gateway/subscription route when native resolution throws', async () => {
    // openai(订阅直连)在 nativeProviders 缺席是正常的,应照常走网关块,不触发 BYOM 拦截。
    const agent = new PiAgent(byomDeps(async () => {
      throw new Error('resolve failed');
    }));
    const handle = await agent.startSession({
      sessionId: 'subscription-ok',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'openai',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'cindy']);
    await handle.close();
  });
});
