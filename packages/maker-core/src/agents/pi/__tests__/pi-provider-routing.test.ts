import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import { CINDY_BRIDGE_EXTENSION_SOURCE } from '../cindy-bridge-source.js';
import { CINDY_SUBAGENT_EXTENSION_SOURCE } from '../cindy-subagent-source.js';

const captured = vi.hoisted(() => ({
  args: [] as string[],
  env: {} as Record<string, string | undefined>,
  requests: [] as Array<Record<string, unknown>>,
  requestOptions: [] as Array<{
    timeoutMs?: number;
    refreshTimeoutOnEvent?: (event: { type: string }) => boolean;
  } | undefined>,
  closes: 0,
  requestHandler: undefined as undefined | ((command: Record<string, unknown>) => Promise<{
    success: boolean;
    command?: unknown;
    data?: unknown;
    error?: string;
  }>),
}));

vi.mock('../transport.js', () => ({
  createPiStdioTransport: (opts: {
    args: string[];
    env: Record<string, string | undefined>;
    onProcessSpawned?: (pid: number) => void | (() => void);
  }) => {
    // spawn 参数断言移到 transport 工厂(spawn 行为在 stdio transport)。
    captured.args = [...opts.args];
    captured.env = { ...(opts.env ?? {}) };
    opts.onProcessSpawned?.(1234);
    return {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 1234,
      isClosed: () => false,
    };
  },
  attachJsonlReader: () => {},
}));

vi.mock('../rpc-client.js', () => {
  class PiRpcRequestTimeoutError extends Error {
    readonly code = 'PI_RPC_TIMEOUT';
    constructor(
      readonly commandType: string,
      readonly timeoutMs: number,
    ) {
      super(`pi rpc timeout after ${timeoutMs}ms: ${commandType}`);
      this.name = 'PiRpcRequestTimeoutError';
    }
  }
  return {
    PiRpcRequestTimeoutError,
    PiRpcProcess: class {
      isClosed = false;
      async request(
        command: Record<string, unknown>,
        options?: {
          timeoutMs?: number;
          refreshTimeoutOnEvent?: (event: { type: string }) => boolean;
        },
      ) {
        captured.requests.push(command);
        captured.requestOptions.push(options);
        if (captured.requestHandler) return captured.requestHandler(command);
        if (command.type === 'get_state') {
          return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
        }
        return { success: true, data: {} };
      }
      send(): void {}
      async close(): Promise<void> { this.isClosed = true; captured.closes += 1; }
    },
  };
});

import { PiAgent } from '../index.js';
import { PiRpcRequestTimeoutError } from '../rpc-client.js';
import { PiNativeProviderProxyNotReadyError, type AgentDeps } from '../../base-agent.js';
import type { ModelDescriptor } from '../../../types/capabilities.js';
import type { Logger } from '../../../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function testSubagentRunnerHost() {
  const handle = {
    pid: 4321,
    killed: false,
    once(event: 'spawn' | 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void) {
      if (event === 'spawn') queueMicrotask(listener);
      return handle;
    },
    kill: () => true,
  };
  return handle as never;
}

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
    captured.requestOptions = [];
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
    const apiResolver = vi.fn((providerId: string | null | undefined) =>
      providerId === 'openai' ? 'anthropic-messages' as const : 'openai-responses' as const,
    );
    const descriptorResolver = vi.fn((providerId: string | null | undefined, modelId: string) => ({
      id: modelId,
      displayName: providerId === 'openai' ? 'Subscription Shared' : 'XD Shared',
      contextWindow: providerId === 'openai' ? 128_000 : 200_000,
      maxOutputTokens: providerId === 'openai' ? 16_000 : 32_000,
      cost: providerId === 'openai'
        ? { input: 1, output: 2 }
        : { input: 9, output: 10 },
      efforts: [],
      defaultEffort: null,
    }));
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
      resolvePiGatewayModelDescriptor: descriptorResolver,
      resolvePiGatewayModelApi: apiResolver,
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
      providers: Record<string, {
        models: Array<{
          id: string;
          name?: string;
          api?: string;
          contextWindow?: number;
          maxTokens?: number;
          cost?: Record<string, number>;
        }>;
      }>;
    };
    expect(apiResolver).toHaveBeenCalledWith('openai', 'shared-model', { remote: false });
    expect(descriptorResolver).toHaveBeenCalledWith('openai', 'shared-model');
    expect(models.providers.cindy?.models.find((model) => model.id === 'shared-model')).toMatchObject({
      name: 'Subscription Shared',
      api: 'anthropic-messages',
      contextWindow: 128_000,
      maxTokens: 16_000,
      cost: { input: 1, output: 2 },
    });
    expect(models.providers['native-a']?.models.some((model) => model.id === 'shared-model')).toBe(true);
    expect(models.providers['native-b']?.models.some((model) => model.id === 'shared-model')).toBe(true);

    await expect(handle.setModel!('shared-model', { providerId: 'xd' })).rejects.toThrow(
      /restart the Pi session to change provider API/,
    );
    expect(captured.requests).not.toContainEqual({
      type: 'set_model',
      provider: 'cindy',
      modelId: 'shared-model',
    });

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

  it('uses explicit output caps and a context-bounded fallback for gateway and native models', async () => {
    const availableModels: ModelDescriptor[] = [
      {
        id: 'gateway-fallback-model', displayName: 'Gateway fallback', contextWindow: 128_000,
        efforts: [], defaultEffort: null,
      },
      {
        id: 'gateway-explicit-model', displayName: 'Gateway explicit', contextWindow: 200_000,
        maxOutputTokens: 90_000, efforts: [], defaultEffort: null,
      },
      {
        id: 'gateway-small-context-model', displayName: 'Gateway small context', contextWindow: 32_000,
        efforts: [], defaultEffort: null,
      },
      {
        id: 'native-fallback-model', displayName: 'Native fallback', contextWindow: 200_000,
        efforts: [], defaultEffort: null,
      },
      {
        id: 'native-explicit-model', displayName: 'Native explicit', contextWindow: 200_000,
        efforts: [], defaultEffort: null,
      },
      {
        id: 'native-small-context-model', displayName: 'Native small context', contextWindow: 32_000,
        efforts: [], defaultEffort: null,
      },
    ];
    const descriptorResolver = (_providerId: string | null | undefined, modelId: string) =>
      availableModels.find((candidate) => candidate.id === modelId)!;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9988' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: { availableModels },
      resolvePiAgentHome: () => agentHome,
      resolvePiGatewayModelDescriptor: descriptorResolver,
      resolvePiGatewayModelApi: () => 'anthropic-messages',
      resolvePiNativeProviders: async () => ({
        providers: [{
          id: 'native', name: 'Native', baseUrl: 'http://native.test', api: 'openai-completions',
          models: [
            { id: 'native-fallback-model', contextWindow: 200_000 },
            { id: 'native-explicit-model', contextWindow: 200_000, maxTokens: 90_000 },
            { id: 'native-small-context-model', contextWindow: 32_000 },
          ],
        }],
        env: {},
      }),
    });

    const gatewayHandle = await agent.startSession({
      sessionId: 'max-tokens-gateway', workingDir: cwd, model: 'gateway-fallback-model', providerId: 'openai',
    });
    const gatewayModels = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: Record<string, { models?: Array<Record<string, unknown>> }> };
    expect(gatewayModels.providers.cindy?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gateway-fallback-model', maxTokens: 65_536 }),
      expect.objectContaining({ id: 'gateway-explicit-model', maxTokens: 90_000 }),
      expect.objectContaining({ id: 'gateway-small-context-model', maxTokens: 32_000 }),
    ]));
    await gatewayHandle.close();

    const nativeHandle = await agent.startSession({
      sessionId: 'max-tokens-native', workingDir: cwd, model: 'native-fallback-model', providerId: 'native',
    });
    const nativeModels = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: Record<string, { models?: Array<Record<string, unknown>> }> };
    expect(nativeModels.providers.native?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'native-fallback-model', maxTokens: 65_536 }),
      expect.objectContaining({ id: 'native-explicit-model', maxTokens: 90_000 }),
      expect.objectContaining({ id: 'native-small-context-model', maxTokens: 32_000 }),
    ]));
    await nativeHandle.close();
  });

  it('routes host subscriptions through PI native providers and wire model ids', async () => {
    const authProviderIds: Array<string | null | undefined> = [];
    let resolveProxyProviderId: (() => string | null) | undefined;
    const proxyRegistrations: Array<{
      token: string;
      providerId: string | null;
      scope?: 'session' | 'subagent-route';
    }> = [];
    const availableModels: ModelDescriptor[] = [
      {
        id: 'chatgpt/gpt-cindy-daily-test', displayName: 'GPT Daily', contextWindow: 272_000,
        efforts: ['low', 'high'], defaultEffort: 'high',
      },
      {
        id: 'chatgpt/gpt-5.6-luna', displayName: 'GPT 5.6 Luna', contextWindow: 272_000,
        efforts: ['medium'], defaultEffort: 'medium',
      },
      {
        id: 'xai/grok-4.5', displayName: 'Grok 4.5', contextWindow: 1_000_000,
        efforts: ['high'], defaultEffort: 'high',
      },
      {
        id: 'xai/grok-4.20', displayName: 'Grok 4.20', contextWindow: 1_000_000,
        efforts: ['high'], defaultEffort: 'high',
      },
      {
        id: 'xai/grok-4.6', displayName: 'Grok 4.6', contextWindow: 1_000_000,
        efforts: ['medium'], defaultEffort: 'medium',
      },
      {
        id: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000,
        efforts: ['high'], defaultEffort: 'high',
      },
    ];
    const deps: AgentDeps = {
      auth: {
        getState: async (options) => {
          authProviderIds.push(options?.providerId);
          return { authenticated: true, identity: 'test', authSource: 'oauth' as const };
        },
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9988' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: { availableModels },
      resolvePiAgentHome: () => agentHome,
      spawnPiSubagentRunner: testSubagentRunnerHost,
      resolvePiGatewayModelApi: () => 'openai-responses',
      registerPiProxySession: (_sessionId, token, resolveProviderId, options) => {
        if (options?.scope !== 'subagent-route') resolveProxyProviderId = resolveProviderId;
        proxyRegistrations.push({
          token,
          providerId: resolveProviderId(),
          scope: options?.scope,
        });
      },
      resolvePiNativeProviders: async () => ({
        providers: [
          {
            id: 'anthropic', sourceProviderId: 'anthropic', name: 'Anthropic',
            baseUrl: 'http://127.0.0.1:9988', inheritModels: true,
            headers: {
              'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
              'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
              'x-cindy-pi-provider-id': 'anthropic',
            },
            models: [{ id: 'claude-opus-5', wireId: 'claude-opus-5' }],
          },
          {
            id: 'openai-codex', sourceProviderId: 'openai', name: 'OpenAI',
            baseUrl: 'http://127.0.0.1:9988', inheritModels: true,
            apiKeyEnvVar: 'CINDY_PI_OPENAI_PROXY_KEY',
            headers: {
              'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
              'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
              'x-cindy-pi-provider-id': 'openai',
            },
            models: [
              {
                id: 'chatgpt/gpt-5.6-sol',
                wireId: 'gpt-5.6-sol',
                api: 'openai-codex-responses',
                contextWindow: 1_000_000,
                maxTokens: 128_000,
              },
              {
                id: 'chatgpt/gpt-cindy-daily-test',
                wireId: 'gpt-cindy-daily-test',
                catalogAddition: true,
                contextWindow: 272_000,
                maxTokens: 32_000,
              },
              {
                id: 'gpt-5.6-luna',
                wireId: 'gpt-5.6-luna',
                contextWindow: 272_000,
                maxTokens: 32_000,
              },
            ],
          },
          {
            id: 'xai', sourceProviderId: 'xai', name: 'xAI',
            baseUrl: 'http://127.0.0.1:9988/v1', inheritModels: true,
            headers: {
              'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
              'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
              'x-cindy-pi-provider-id': 'xai',
            },
            models: [
              { id: 'xai/grok-4.5', wireId: 'grok-4.5' },
              { id: 'grok-4.6', wireId: 'grok-4.6' },
              {
                id: 'grok-4.6', wireId: 'grok-4.6', catalogAddition: true,
                contextWindow: 500_000, maxTokens: 500_000,
              },
              {
                id: 'xai/grok-4.20', wireId: 'grok-4.20', api: 'openai-responses',
                contextWindow: 1_000_000, maxTokens: 64_000,
                cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
                compat: { supportsStrictTools: true },
              },
            ],
          },
        ],
        env: { CINDY_PI_OPENAI_PROXY_KEY: 'placeholder-jwt' },
      }),
    };

    const handle = await new PiAgent(deps).startSession({
      sessionId: 'native-subscription-routing',
      workingDir: cwd,
      model: 'chatgpt/gpt-cindy-daily-test',
      effort: 'high',
    });

    expect(authProviderIds).toEqual(['openai']);
    expect(resolveProxyProviderId?.()).toBe('openai');
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 4))
      .toEqual(['--provider', 'openai-codex', '--model', 'gpt-cindy-daily-test']);
    const configHome = captured.env.PI_CODING_AGENT_DIR as string;
    const models = JSON.parse(readFileSync(path.join(configHome, 'models.json'), 'utf8')) as {
      providers: Record<string, { api?: string; models?: Array<{ id: string; api?: string }> }>;
    };
    expect(models.providers.anthropic).not.toHaveProperty('api');
    expect(models.providers.anthropic?.models).toBeUndefined();
    expect(models.providers['openai-codex']).not.toHaveProperty('api');
    expect(models.providers['openai-codex']?.models).toEqual([
      expect.objectContaining({
        id: 'gpt-5.6-sol',
        api: 'openai-codex-responses',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      }),
      expect.objectContaining({ id: 'gpt-cindy-daily-test' }),
    ]);
    expect(models.providers['openai-codex']?.models?.[1]).not.toHaveProperty('api');
    expect(models.providers.xai).not.toHaveProperty('api');
    expect(models.providers.xai?.models).toEqual([
      expect.objectContaining({
        id: 'grok-4.6',
        contextWindow: 500_000,
        maxTokens: 500_000,
      }),
      expect.objectContaining({
        id: 'grok-4.20',
        api: 'openai-responses',
        cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
        compat: { supportsStrictTools: true },
      }),
    ]);
    expect(models.providers.xai?.models?.[0]).not.toHaveProperty('api');
    expect(JSON.parse(readFileSync(path.join(configHome, 'settings.json'), 'utf8')))
      .toEqual({
        transport: 'sse',
        retry: {
          enabled: true,
          maxRetries: 6,
          baseDelayMs: 2000,
          provider: { maxRetries: 0 },
        },
      });
    const runtimeText = readFileSync(runtimeFileOf('subagent', 'native-subscription-routing'), 'utf8');
    expect(runtimeText).not.toContain('proxySessionToken');
    expect(proxyRegistrations.filter((registration) => registration.scope === 'subagent-route'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ providerId: 'anthropic', scope: 'subagent-route' }),
        expect.objectContaining({ providerId: 'openai', scope: 'subagent-route' }),
        expect.objectContaining({ providerId: 'xai', scope: 'subagent-route' }),
      ]));
    expect(new Set(proxyRegistrations.map((registration) => registration.token)).size)
      .toBe(proxyRegistrations.length);
    expect(JSON.parse(runtimeText)).toMatchObject({
        model: 'gpt-cindy-daily-test',
        provider: 'openai-codex',
        modelRoutes: {
          'chatgpt/gpt-cindy-daily-test': [
            { provider: 'openai-codex', model: 'gpt-cindy-daily-test' },
            { provider: 'cindy', model: 'chatgpt/gpt-cindy-daily-test' },
          ],
          'chatgpt/gpt-5.6-luna': [
            {
              provider: 'openai-codex', model: 'gpt-5.6-luna', sourceProviderId: 'openai',
              proxySessionAuth: true,
            },
            { provider: 'cindy', model: 'chatgpt/gpt-5.6-luna' },
          ],
          'claude-opus-5': [
            {
              provider: 'anthropic', model: 'claude-opus-5', sourceProviderId: 'anthropic',
              proxySessionAuth: true,
            },
            { provider: 'cindy', model: 'claude-opus-5' },
          ],
          'xai/grok-4.6': [
            { provider: 'xai', model: 'grok-4.6', sourceProviderId: 'xai', proxySessionAuth: true },
            { provider: 'cindy', model: 'xai/grok-4.6' },
          ],
          'xai/grok-4.20': [
            { provider: 'xai', model: 'grok-4.20', sourceProviderId: 'xai', proxySessionAuth: true },
            { provider: 'cindy', model: 'xai/grok-4.20' },
          ],
        },
      });

    await handle.setModel!('xai/grok-4.5', { providerId: 'xai' });
    expect(captured.requests).toContainEqual({
      type: 'set_model', provider: 'xai', modelId: 'grok-4.5',
    });
    expect(resolveProxyProviderId?.()).toBe('xai');
    expect(JSON.parse(readFileSync(runtimeFileOf('subagent', 'native-subscription-routing'), 'utf8')))
      .toMatchObject({ model: 'grok-4.5', provider: 'xai' });

    await handle.setModel!('claude-opus-5', { providerId: 'anthropic' });
    expect(captured.requests).toContainEqual({
      type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-5',
    });
    expect(resolveProxyProviderId?.()).toBe('anthropic');
    await handle.close();
  }, 30_000);

  it('serializes inheritModels Grok 4.6 capability corrections into models.json', async () => {
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'SuperGrok', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9988' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          contextWindow: 500_000,
          efforts: ['low', 'medium', 'high', 'xhigh'],
          defaultEffort: 'high',
        }],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => ({
        providers: [{
          id: 'xai',
          sourceProviderId: 'xai',
          name: 'xAI',
          baseUrl: 'http://127.0.0.1:9988/v1',
          inheritModels: true,
          models: [{
            id: 'grok-4.6',
            wireId: 'grok-4.6',
            api: 'openai-completions',
            reasoning: true,
            thinkingLevelMap: {
              minimal: null,
              low: 'low',
              medium: 'medium',
              high: 'high',
              xhigh: 'xhigh',
              max: null,
            },
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
            },
          }],
        }],
        env: {},
      }),
    });
    const handle = await agent.startSession({
      sessionId: 'grok-46-capability-correction',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
      effort: 'xhigh',
    });
    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: Record<string, { models?: Array<Record<string, unknown>> }> };
    expect(models.providers.xai?.models).toEqual([
      expect.objectContaining({
        id: 'grok-4.6',
        api: 'openai-completions',
        reasoning: true,
        thinkingLevelMap: expect.objectContaining({ xhigh: 'xhigh' }),
        compat: expect.objectContaining({ supportsReasoningEffort: true }),
      }),
    ]);
    expect(captured.requests).toContainEqual({ type: 'set_thinking_level', level: 'xhigh' });
    await handle.close();
  });

  it('routes a persisted BYOM id through its namespaced PI runtime provider', async () => {
    const authProviderIds: Array<string | null | undefined> = [];
    const deps: AgentDeps = {
      auth: {
        getState: async (options) => {
          authProviderIds.push(options?.providerId);
          return { authenticated: true, identity: 'custom', authSource: 'api-key' as const };
        },
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9988' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{
          id: 'chatgpt/gpt-5.6-sol',
          displayName: 'Same-name Custom Model',
          contextWindow: 128_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      resolvePiAgentHome: () => agentHome,
      spawnPiSubagentRunner: testSubagentRunnerHost,
      resolvePiNativeProviders: async () => ({
        providers: [
          {
            id: 'openai-codex',
            sourceProviderId: 'openai',
            name: 'OpenAI (ChatGPT)',
            baseUrl: 'http://127.0.0.1:9988',
            inheritModels: true,
            models: [{ id: 'chatgpt/gpt-5.6-sol', wireId: 'gpt-5.6-sol' }],
          },
          {
            id: 'cindy-byom-openai-codex',
            sourceProviderId: 'openai-codex',
            name: 'User endpoint',
            baseUrl: 'https://user.example/v1',
            api: 'openai-completions',
            models: [{ id: 'chatgpt/gpt-5.6-sol' }],
          },
        ],
        env: {},
      }),
    };

    const handle = await new PiAgent(deps).startSession({
      sessionId: 'namespaced-byom-routing',
      workingDir: cwd,
      model: 'chatgpt/gpt-5.6-sol',
      providerId: 'openai-codex',
    });

    expect(authProviderIds).toEqual(['openai-codex']);
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 4))
      .toEqual(['--provider', 'cindy-byom-openai-codex', '--model', 'chatgpt/gpt-5.6-sol']);
    const configHome = captured.env.PI_CODING_AGENT_DIR as string;
    const models = JSON.parse(readFileSync(path.join(configHome, 'models.json'), 'utf8')) as {
      providers: Record<string, { baseUrl?: string }>;
    };
    expect(models.providers['openai-codex']?.baseUrl).toBe('http://127.0.0.1:9988');
    expect(models.providers['cindy-byom-openai-codex']?.baseUrl).toBe('https://user.example/v1');
    expect(JSON.parse(readFileSync(runtimeFileOf('subagent', 'namespaced-byom-routing'), 'utf8')))
      .toMatchObject({ model: 'chatgpt/gpt-5.6-sol', provider: 'cindy-byom-openai-codex' });
    await handle.close();
  });

  it('keeps xAI and custom providers in one snapshot and switches both directions', async () => {
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'SuperGrok', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          {
            id: 'xai/grok-4.6',
            displayName: 'Grok 4.6',
            contextWindow: 500_000,
            efforts: ['minimal', 'low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
          {
            id: 'local-model',
            displayName: 'Local Model',
            contextWindow: 128_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      spawnPiSubagentRunner: testSubagentRunnerHost,
      resolvePiNativeProviders: async () => ({
        providers: [
          {
            id: 'xai',
            name: 'xAI',
            baseUrl: 'http://127.0.0.1:9',
            api: 'anthropic-messages',
            apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
            headers: {
              'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
              'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
            },
            modelIdAliases: {
              'grok-4.6': 'xai/grok-4.6',
              'xai/grok-4.6': 'xai/grok-4.6',
            },
            models: [{
              id: 'xai/grok-4.6',
              api: 'anthropic-messages',
              contextWindow: 500_000,
              maxTokens: 500_000,
              input: ['text', 'image'],
              reasoning: true,
              compat: {
                supportsStore: false,
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
              },
            }],
          },
          {
            id: 'native-a',
            name: 'Native A',
            baseUrl: 'http://a.test',
            api: 'openai-completions',
            models: [{ id: 'local-model' }],
          },
        ],
        env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
      }),
    });

    const handle = await agent.startSession({
      sessionId: 'grok-46-native',
      workingDir: cwd,
      model: 'xai/grok-4.6',
      providerId: 'xai',
      effort: 'medium',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'xai']);
    expect(captured.args.slice(captured.args.indexOf('--model'), captured.args.indexOf('--model') + 2))
      .toEqual(['--model', 'xai/grok-4.6']);
    expect(captured.env.CINDY_PI_API_KEY).toBe('gateway-key');
    expect(captured.env.CINDY_PI_XAI_PROXY_API_KEY).toBe('xai-proxy-placeholder');

    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: Record<string, { apiKey: string; models: Array<Record<string, unknown>> }> };
    expect(models.providers.cindy?.apiKey).toBe('$CINDY_PI_API_KEY');
    expect(models.providers.xai?.apiKey).toBe('$CINDY_PI_XAI_PROXY_API_KEY');
    expect(models.providers.xai?.models.find((model) => model.id === 'xai/grok-4.6')).toMatchObject({
      api: 'anthropic-messages',
      contextWindow: 500_000,
      maxTokens: 500_000,
      input: ['text', 'image'],
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    });
    expect(JSON.parse(readFileSync(runtimeFileOf('subagent', 'grok-46-native'), 'utf8'))).toEqual({
      model: 'xai/grok-4.6',
      provider: 'xai',
      modelRoutes: expect.any(Object),
    });
    await handle.setModel!('local-model', { providerId: 'native-a' });
    await handle.setModel!('xai/grok-4.6', { providerId: 'xai' });
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'native-a',
      modelId: 'local-model',
    });
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'xai',
      modelId: 'xai/grok-4.6',
    });
    await handle.close();
  });

  it('does not reissue set_model when the live session is already on the requested SuperGrok route', async () => {
    captured.requestHandler = async (command) => {
      if (command.type === 'set_model') {
        return { success: false, error: 'Model "grok-4.6" not found for provider "xai"' };
      }
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      return { success: true, data: {} };
    };
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'SuperGrok', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          contextWindow: 500_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => ({
        providers: [{
          id: 'xai',
          name: 'xAI',
          baseUrl: 'http://127.0.0.1:9',
          api: 'anthropic-messages',
          models: [{ id: 'grok-4.6' }],
        }],
        env: {},
      }),
    });
    const handle = await agent.startSession({
      sessionId: 'grok-46-same-route',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
    });
    captured.requests.length = 0;
    await expect(handle.setModel!('grok-4.6', { providerId: 'xai' })).resolves.toBeUndefined();
    expect(captured.requests.filter((request) => request.type === 'set_model')).toEqual([]);
    await handle.close();
  });

  it('rebuilds a missing subagent snapshot on same-route SuperGrok setModel without RPC', async () => {
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'SuperGrok', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          contextWindow: 500_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      resolvePiAgentHome: () => agentHome,
      spawnPiSubagentRunner: testSubagentRunnerHost,
      resolvePiNativeProviders: async () => ({
        providers: [{
          id: 'xai',
          name: 'xAI',
          baseUrl: 'http://127.0.0.1:9',
          api: 'anthropic-messages',
          models: [{ id: 'grok-4.6' }],
        }],
        env: {},
      }),
    });
    const handle = await agent.startSession({
      sessionId: 'grok-46-snapshot-retry',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
    });
    const snapshotPath = runtimeFileOf('subagent', 'grok-46-snapshot-retry');
    rmSync(snapshotPath, { force: true });
    captured.requests.length = 0;
    await expect(handle.setModel!('grok-4.6', { providerId: 'xai' })).resolves.toBeUndefined();
    expect(captured.requests.filter((request) => request.type === 'set_model')).toEqual([]);
    // The snapshot also persists the alias route table for Subagent model
    // normalization, so assert the rebuilt identity rather than exact shape.
    expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toMatchObject({
      model: 'grok-4.6',
      provider: 'xai',
    });
    await handle.close();
  });

  it('clears a stuck pending subagent snapshot on same-route SuperGrok setModel', async () => {
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'SuperGrok', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          contextWindow: 500_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      resolvePiAgentHome: () => agentHome,
      spawnPiSubagentRunner: testSubagentRunnerHost,
      resolvePiNativeProviders: async () => ({
        providers: [{
          id: 'xai',
          name: 'xAI',
          baseUrl: 'http://127.0.0.1:9',
          api: 'anthropic-messages',
          models: [{ id: 'grok-4.6' }],
        }],
        env: {},
      }),
    });
    const handle = await agent.startSession({
      sessionId: 'grok-46-pending-clear',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
    });
    const snapshotPath = runtimeFileOf('subagent', 'grok-46-pending-clear');
    writeFileSync(snapshotPath, JSON.stringify({
      model: 'grok-4.6',
      provider: 'xai',
      pending: true,
    }) + '\n');
    captured.requests.length = 0;
    await expect(handle.setModel!('grok-4.6', { providerId: 'xai' })).resolves.toBeUndefined();
    expect(captured.requests.filter((request) => request.type === 'set_model')).toEqual([]);
    const cleared = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    expect(cleared).toMatchObject({ model: 'grok-4.6', provider: 'xai' });
    // The point of this test: the stuck pending flag must be gone.
    expect(cleared.pending).toBeUndefined();
    await handle.close();
  });

  it('rejects a same-route gateway heartbeat when the live session wire protocol is stale', async () => {
    let gatewayApi: 'anthropic-messages' | 'openai-responses' = 'anthropic-messages';
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{
          id: 'shared-model',
          displayName: 'Shared',
          contextWindow: 128_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiGatewayModelApi: () => gatewayApi,
    });
    const handle = await agent.startSession({
      sessionId: 'gateway-same-route-stale',
      workingDir: cwd,
      model: 'shared-model',
      providerId: 'xd',
    });
    gatewayApi = 'openai-responses';
    captured.requests.length = 0;
    await expect(handle.setModel!('shared-model', { providerId: 'xd' })).rejects.toThrow(
      /restart the Pi session to change provider API/,
    );
    expect(captured.requests.filter((request) => request.type === 'set_model')).toEqual([]);
    await handle.close();
  });

  it('reloads models.json via switch_session when SuperGrok appears after session start', async () => {
    const xaiProvider = {
      id: 'xai',
      sourceProviderId: 'xai' as const,
      name: 'xAI',
      baseUrl: 'http://127.0.0.1:9/v1',
      inheritModels: true,
      apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
      modelIdAliases: {
        'grok-4.6': 'grok-4.6',
        'xai/grok-4.6': 'grok-4.6',
      },
      models: [{
        id: 'grok-4.6',
        wireId: 'grok-4.6',
        name: 'Grok 4.6',
        api: 'openai-responses' as const,
        catalogAddition: true,
        contextWindow: 500_000,
      }],
    };
    let includeXai = false;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'local-model', displayName: 'Local', contextWindow: 128_000, efforts: [], defaultEffort: null },
          {
            id: 'xai/grok-4.6',
            displayName: 'Grok 4.6',
            contextWindow: 500_000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => (includeXai
        ? { providers: [xaiProvider], env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' } }
        : {
            providers: [{
              id: 'native-a',
              name: 'Native A',
              baseUrl: 'http://a.test',
              api: 'openai-completions',
              models: [{ id: 'local-model' }],
            }],
            env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
          }),
    });
    const handle = await agent.startSession({
      sessionId: 'late-xai',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    includeXai = true;
    await handle.setModel!('xai/grok-4.6', { providerId: 'xai' });
    expect(captured.requests).toContainEqual({
      type: 'switch_session',
      sessionPath: '/mock/s.jsonl',
    });
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'xai',
      modelId: 'grok-4.6',
    });
    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: Record<string, { models: Array<{ id: string; api?: string }> }> };
    expect(models.providers.xai?.models).toEqual([
      expect.objectContaining({ id: 'grok-4.6', api: 'openai-responses' }),
    ]);
    await handle.close();
  });

  it('keeps the live context window when a late catalog reload rewrites settings', async () => {
    const xaiProvider = {
      id: 'xai',
      sourceProviderId: 'xai' as const,
      name: 'xAI',
      baseUrl: 'http://127.0.0.1:9/v1',
      inheritModels: true,
      apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
      modelIdAliases: {
        'grok-4.6': 'grok-4.6',
        'xai/grok-4.6': 'grok-4.6',
      },
      models: [{
        id: 'grok-4.6',
        wireId: 'grok-4.6',
        name: 'Grok 4.6',
        api: 'openai-responses' as const,
        catalogAddition: true,
        contextWindow: 100_000,
      }],
    };
    let includeXai = false;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: {
        endpoint: 'http://127.0.0.1:9',
        piAutoCompactThresholdPct: 75,
      },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'wide-model', displayName: 'Wide', contextWindow: 200_000, efforts: [], defaultEffort: null },
          { id: 'narrow-model', displayName: 'Narrow', contextWindow: 100_000, efforts: [], defaultEffort: null },
          {
            id: 'xai/grok-4.6',
            displayName: 'Grok 4.6',
            contextWindow: 100_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => (includeXai
        ? { providers: [xaiProvider], env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' } }
        : {
            providers: [{
              id: 'native-a',
              name: 'Native A',
              baseUrl: 'http://a.test',
              api: 'openai-completions',
              models: [{ id: 'wide-model' }, { id: 'narrow-model' }],
            }],
            env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
          }),
    });
    const handle = await agent.startSession({
      sessionId: 'catalog-keeps-live-window',
      workingDir: cwd,
      model: 'wide-model',
      providerId: 'native-a',
    });
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'set_model') {
        return { success: true, data: { contextWindow: 100_000 } };
      }
      return { success: true, data: {} };
    };
    await handle.setModel!('narrow-model', { providerId: 'native-a' });
    includeXai = true;
    await handle.setModel!('xai/grok-4.6', { providerId: 'xai' });
    const settings = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'settings.json'), 'utf8'),
    ) as { compaction?: { reserveTokens?: number } };
    expect(settings.compaction?.reserveTokens).toBe(25_000);
    await handle.close();
  });

  it('rolls models.json back when switch_session fails after an xAI catalog refresh', async () => {
    const xaiProvider = {
      id: 'xai',
      sourceProviderId: 'xai' as const,
      name: 'xAI',
      baseUrl: 'http://127.0.0.1:9/v1',
      inheritModels: true,
      apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
      modelIdAliases: { 'xai/grok-4.6': 'grok-4.6', 'grok-4.6': 'grok-4.6' },
      models: [{
        id: 'grok-4.6',
        wireId: 'grok-4.6',
        api: 'openai-responses' as const,
        catalogAddition: true,
      }],
    };
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'switch_session') {
        return { success: false, error: 'reload failed' };
      }
      return { success: true, data: {} };
    };
    let includeXai = false;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'local-model', displayName: 'Local', contextWindow: 128_000, efforts: [], defaultEffort: null },
          { id: 'xai/grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => (includeXai
        ? { providers: [xaiProvider], env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' } }
        : {
            providers: [{
              id: 'native-a',
              name: 'Native A',
              baseUrl: 'http://a.test',
              api: 'openai-completions',
              models: [{ id: 'local-model' }],
            }],
            env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
          }),
    });
    const handle = await agent.startSession({
      sessionId: 'xai-reload-rollback',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    includeXai = true;
    await expect(handle.setModel!('xai/grok-4.6', { providerId: 'xai' })).rejects.toThrow(/reload models/);
    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: Record<string, unknown> };
    expect(models.providers.xai).toBeUndefined();
    await handle.close();
  });

  it('terminates the session when catalog rollback cannot be written after switch_session fails', async () => {
    const xaiProvider = {
      id: 'xai',
      sourceProviderId: 'xai' as const,
      name: 'xAI',
      baseUrl: 'http://127.0.0.1:9/v1',
      inheritModels: true,
      apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
      modelIdAliases: { 'xai/grok-4.6': 'grok-4.6', 'grok-4.6': 'grok-4.6' },
      models: [{
        id: 'grok-4.6',
        wireId: 'grok-4.6',
        api: 'openai-responses' as const,
        catalogAddition: true,
      }],
    };
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'switch_session') {
        const modelsPath = path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json');
        unlinkSync(modelsPath);
        mkdirSync(modelsPath);
        return { success: false, error: 'reload failed' };
      }
      return { success: true, data: {} };
    };
    let includeXai = false;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'local-model', displayName: 'Local', contextWindow: 128_000, efforts: [], defaultEffort: null },
          { id: 'xai/grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => (includeXai
        ? { providers: [xaiProvider], env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' } }
        : {
            providers: [{
              id: 'native-a',
              name: 'Native A',
              baseUrl: 'http://a.test',
              api: 'openai-completions',
              models: [{ id: 'local-model' }],
            }],
            env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
          }),
    });
    const handle = await agent.startSession({
      sessionId: 'xai-reload-rollback-unwritable',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    includeXai = true;
    await expect(handle.setModel!('xai/grok-4.6', { providerId: 'xai' })).rejects.toThrow(/PI_CATALOG_RELOAD_UNCONFIRMED/);
    expect(captured.closes).toBeGreaterThan(0);
  });

  it('terminates the session when switch_session neither confirms nor rejects after an xAI catalog refresh', async () => {
    const xaiProvider = {
      id: 'xai',
      sourceProviderId: 'xai' as const,
      name: 'xAI',
      baseUrl: 'http://127.0.0.1:9/v1',
      inheritModels: true,
      apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
      modelIdAliases: { 'xai/grok-4.6': 'grok-4.6', 'grok-4.6': 'grok-4.6' },
      models: [{
        id: 'grok-4.6',
        wireId: 'grok-4.6',
        api: 'openai-responses' as const,
        catalogAddition: true,
      }],
    };
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'switch_session') {
        throw new Error('pi rpc timeout after 30000ms: switch_session');
      }
      return { success: true, data: {} };
    };
    let includeXai = false;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'local-model', displayName: 'Local', contextWindow: 128_000, efforts: [], defaultEffort: null },
          { id: 'xai/grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => (includeXai
        ? { providers: [xaiProvider], env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' } }
        : {
            providers: [{
              id: 'native-a',
              name: 'Native A',
              baseUrl: 'http://a.test',
              api: 'openai-completions',
              models: [{ id: 'local-model' }],
            }],
            env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
          }),
    });
    const handle = await agent.startSession({
      sessionId: 'xai-reload-unconfirmed',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    includeXai = true;
    await expect(handle.setModel!('xai/grok-4.6', { providerId: 'xai' })).rejects.toThrow(/PI_CATALOG_RELOAD_UNCONFIRMED/);
    expect(captured.closes).toBeGreaterThan(0);
  });

  it('refuses a live xAI refresh when the provider endpoint would change', async () => {
    let call = 0;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'xai/grok-4.5', displayName: 'Grok 4.5', contextWindow: 500_000, efforts: [], defaultEffort: null },
          { id: 'xai/grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => {
        call += 1;
        return {
          providers: [{
            id: 'xai',
            sourceProviderId: 'xai' as const,
            name: 'xAI',
            baseUrl: call === 1 ? 'http://127.0.0.1:9/v1' : 'http://evil.test/v1',
            inheritModels: true,
            apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
            modelIdAliases: {
              'xai/grok-4.5': 'grok-4.5',
              'grok-4.5': 'grok-4.5',
              'xai/grok-4.6': 'grok-4.6',
              'grok-4.6': 'grok-4.6',
            },
            models: call === 1
              ? [{
                  id: 'grok-4.5',
                  wireId: 'grok-4.5',
                  api: 'openai-responses' as const,
                  catalogAddition: true,
                }]
              : [{
                  id: 'grok-4.6',
                  wireId: 'grok-4.6',
                  api: 'openai-responses' as const,
                  catalogAddition: true,
                }],
          }],
          env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
        };
      },
    });
    const handle = await agent.startSession({
      sessionId: 'xai-endpoint-guard',
      workingDir: cwd,
      model: 'xai/grok-4.5',
      providerId: 'xai',
    });
    await expect(handle.setModel!('xai/grok-4.6', { providerId: 'xai' })).rejects.toThrow(
      /cannot serve model/,
    );
    expect(captured.requests).not.toContainEqual(expect.objectContaining({ type: 'switch_session' }));
    await handle.close();
  });

  it('does not refresh when switching to a bundled inheritModels xAI model', async () => {
    let resolves = 0;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'local-model', displayName: 'Local', contextWindow: 128_000, efforts: [], defaultEffort: null },
          { id: 'xai/grok-4.5', displayName: 'Grok 4.5', contextWindow: 500_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => {
        resolves += 1;
        return {
          providers: [
            {
              id: 'native-a',
              name: 'Native A',
              baseUrl: 'http://a.test',
              api: 'openai-completions',
              models: [{ id: 'local-model' }],
            },
            {
              id: 'xai',
              sourceProviderId: 'xai' as const,
              name: 'xAI',
              baseUrl: 'http://127.0.0.1:9/v1',
              inheritModels: true,
              apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
              modelIdAliases: { 'xai/grok-4.5': 'grok-4.5', 'grok-4.5': 'grok-4.5' },
              models: [{ id: 'grok-4.5', wireId: 'grok-4.5' }],
            },
          ],
          env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
        };
      },
    });
    const handle = await agent.startSession({
      sessionId: 'bundled-xai-switch',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    expect(resolves).toBe(1);
    captured.requests.length = 0;
    await handle.setModel!('xai/grok-4.5', { providerId: 'xai' });
    expect(resolves).toBe(1);
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'xai',
      modelId: 'grok-4.5',
    });
    expect(captured.requests.filter((request) => request.type === 'switch_session')).toHaveLength(1);
    await handle.close();
  });

  it('does not live-refresh xAI when the caller pins the gateway with providerId null', async () => {
    let resolves = 0;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'local-model', displayName: 'Local', contextWindow: 128_000, efforts: [], defaultEffort: null },
          { id: 'xai/grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => {
        resolves += 1;
        return {
          providers: [{
            id: 'native-a',
            name: 'Native A',
            baseUrl: 'http://a.test',
            api: 'openai-completions',
            models: [{ id: 'local-model' }],
          }],
          env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
        };
      },
    });
    const handle = await agent.startSession({
      sessionId: 'gateway-pin-skips-xai-reload',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'native-a',
    });
    expect(resolves).toBe(1);
    captured.requests.length = 0;
    await handle.setModel!('xai/grok-4.6', { providerId: null });
    expect(resolves).toBe(1);
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'cindy',
      modelId: 'xai/grok-4.6',
    });
    expect(captured.requests.filter((request) => request.type === 'switch_session')).toHaveLength(1);
    await handle.close();
  });

  it('refuses to add a remote xAI proxy that was not provisioned at startup', async () => {
    let resolves = 0;
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'user', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9', remoteEndpoint: 'https://gateway.example.test' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          { id: 'gateway-model', displayName: 'Gateway model', contextWindow: 200_000, efforts: [], defaultEffort: null },
          { id: 'xai/grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiGatewayModelApi: () => 'anthropic-messages',
      resolveRemotePiBinaryPath: async () => '/remote/pi',
      getRemotePiFileOps: () => ({
        mkdirp: async () => {},
        writeFile: async () => {},
        stat: async () => ({ isFile: true }),
        rm: async () => {},
        listDir: async () => [],
      }),
      getRemotePiTransport: async () => ({
        writeLine: async () => {},
        onLine: () => () => {},
        onStderr: () => () => {},
        onClose: () => () => {},
        close: async () => {},
        pid: 4321,
        isClosed: () => false,
        remoteBinaryPath: '/remote/pi',
        ensureHostProxyForward: async () => {},
      }),
      resolvePiNativeProviders: async () => {
        resolves += 1;
        if (resolves === 1) {
          return { providers: [], env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' } };
        }
        return {
          providers: [{
            id: 'xai',
            sourceProviderId: 'xai' as const,
            name: 'xAI',
            baseUrl: 'http://127.0.0.1:47989',
            inheritModels: true,
            apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
            modelIdAliases: { 'xai/grok-4.6': 'grok-4.6', 'grok-4.6': 'grok-4.6' },
            models: [{
              id: 'grok-4.6',
              wireId: 'grok-4.6',
              api: 'openai-responses' as const,
              catalogAddition: true,
            }],
            hostProxyForward: {
              localUrl: 'http://127.0.0.1:18765',
              remotePort: 47989,
            },
          }],
          env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
        };
      },
    });
    const handle = await agent.startSession({
      sessionId: 'remote-xai-after-login',
      workingDir: cwd,
      model: 'gateway-model',
      providerId: 'xd',
      remoteHostId: 'remote-host',
    });
    await expect(handle.setModel!('xai/grok-4.6', { providerId: 'xai' })).rejects.toThrow(
      /cannot serve model/,
    );
    expect(captured.requests).not.toContainEqual(expect.objectContaining({ type: 'switch_session' }));
    await handle.close();
  });

  it('applies each native provider alias during provider-less compatibility routing', async () => {
    const provider = (id: string, aliases?: Record<string, string>) => ({
      id,
      name: id,
      baseUrl: `http://${id}.test`,
      api: 'anthropic-messages' as const,
      ...(aliases ? { modelIdAliases: aliases } : {}),
      models: [{ id: id === 'xai' ? 'xai/grok-4.6' : 'other-model' }],
    });
    const agent = new PiAgent({
      auth: {
        getState: async (options) => ({
          authenticated: true,
          identity: options?.providerId === 'xai' ? 'SuperGrok' : 'test',
          authSource: 'oauth' as const,
        }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          contextWindow: 500_000,
          efforts: [],
          defaultEffort: null,
        }],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => ({
        providers: [
          provider('other'),
          provider('xai', {
            'grok-4.6': 'xai/grok-4.6',
            'xai/grok-4.6': 'xai/grok-4.6',
          }),
        ],
        env: {},
      }),
    });

    const bare = await agent.startSession({
      sessionId: 'providerless-grok-bare',
      workingDir: cwd,
      model: 'grok-4.6',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'xai']);
    expect(captured.args.slice(captured.args.indexOf('--model'), captured.args.indexOf('--model') + 2))
      .toEqual(['--model', 'xai/grok-4.6']);
    await bare.close();

    const namespaced = await agent.startSession({
      sessionId: 'providerless-grok-namespaced',
      workingDir: cwd,
      model: 'xai/grok-4.6',
    });
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'xai']);
    await namespaced.close();
  });

  it('normalizes Subagent aliases to the catalog wire id without a guessed gateway fallback', async () => {
    const deps = byomDeps(async () => ({
      providers: [{
        id: 'xai',
        sourceProviderId: 'xai',
        name: 'xAI',
        baseUrl: 'http://xai.test',
        api: 'anthropic-messages',
        modelIdAliases: {
          'grok-4.6': 'xai/grok-4.6',
          'xai/grok-4.6': 'xai/grok-4.6',
        },
        models: [{ id: 'xai/grok-4.6', wireId: 'x-ai/grok-4.6' }],
      }],
      env: {},
    }), [
      { id: 'gateway-model', displayName: 'Gateway', contextWindow: 200_000, efforts: [], defaultEffort: null },
      { id: 'grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
    ]);
    deps.resolvePiGatewayModelApi = (_providerId, modelId) =>
      modelId === 'gateway-model' ? 'openai-responses' : undefined;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'subagent-wire-normalization',
      workingDir: cwd,
      model: 'gateway-model',
      providerId: 'xd',
    });
    const runtime = JSON.parse(
      readFileSync(runtimeFileOf('subagent', 'subagent-wire-normalization'), 'utf8'),
    ) as { modelRoutes: Record<string, Array<{ provider: string; model: string; sourceProviderId?: string }>> };
    expect(runtime.modelRoutes['grok-4.6']).toEqual([
      { provider: 'xai', model: 'x-ai/grok-4.6', sourceProviderId: 'xai' },
    ]);
    expect(runtime.modelRoutes['xai/grok-4.6']).toEqual([
      { provider: 'xai', model: 'x-ai/grok-4.6', sourceProviderId: 'xai' },
    ]);
    expect(runtime.modelRoutes['gateway-model']).toEqual([
      {
        provider: 'cindy',
        model: 'gateway-model',
        sourceProviderId: 'cindy-gateway',
        proxySessionAuth: true,
      },
    ]);
    await handle.close();
  });

  it('fails closed when provider-less aliases are ambiguous', async () => {
    const agent = new PiAgent(byomDeps(async () => ({
      providers: [
        {
          id: 'native-a',
          name: 'Native A',
          baseUrl: 'http://a.test',
          api: 'openai-completions',
          modelIdAliases: { legacy: 'native-a-model' },
          models: [{ id: 'native-a-model' }],
        },
        {
          id: 'native-b',
          name: 'Native B',
          baseUrl: 'http://b.test',
          api: 'openai-completions',
          modelIdAliases: { legacy: 'native-b-model' },
          models: [{ id: 'native-b-model' }],
        },
      ],
      env: {},
    })));
    await expect(agent.startSession({
      sessionId: 'providerless-alias-conflict',
      workingDir: cwd,
      model: 'legacy',
    })).rejects.toThrow(/matches multiple native providers.*refusing to guess an endpoint/);
    expect(captured.args).toEqual([]);
  });

  it('surfaces a first-party Pi proxy-not-ready failure for provider-less and legacy Grok sessions', async () => {
    const proxyNotReady = new PiNativeProviderProxyNotReadyError();
    const agent = new PiAgent(byomDeps(async () => {
      throw proxyNotReady;
    }, [
      { id: 'grok-4.6', displayName: 'Grok 4.6', contextWindow: 500_000, efforts: [], defaultEffort: null },
    ]));

    for (const [index, model] of ['grok-4.6', 'xai/grok-4.6'].entries()) {
      await expect(agent.startSession({
        sessionId: `providerless-grok-proxy-not-ready-${index}`,
        workingDir: cwd,
        model,
      })).rejects.toBe(proxyNotReady);
    }
    expect(captured.args).toEqual([]);
  });

  it('fails closed when an explicit xAI selection cannot build the Pi native provider', async () => {
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'SuperGrok', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          contextWindow: 500_000,
          efforts: ['minimal', 'low', 'medium', 'high'],
          defaultEffort: 'medium',
        }],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: async () => {
        throw new Error('xAI token unavailable');
      },
    };
    await expect(new PiAgent(deps).startSession({
      sessionId: 'grok-46-native-failed',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
    })).rejects.toThrow(/BYOM provider 'xai' cannot serve model 'grok-4.6'.*refusing to fall back/);
    expect(captured.args).toEqual([]);
  });

  it('passes resume identity so a historical xAI model can stay private to the restored session', async () => {
    const resolver = vi.fn(async (ctx) => ({
      providers: [{
        id: 'xai',
        name: 'xAI',
        baseUrl: 'http://127.0.0.1:9',
        api: 'anthropic-messages' as const,
        modelIdAliases: { 'grok-retired': 'xai/grok-retired' },
        models: [{ id: 'xai/grok-retired', api: 'anthropic-messages' as const }],
      }],
      env: {},
    }));
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'SuperGrok', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'provider-auth-placeholder' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: { availableModels: [] },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: resolver,
    });

    const handle = await agent.startSession({
      sessionId: 'historical-xai-resume',
      resumeSessionId: 'pi-sdk-session-old',
      workingDir: cwd,
      model: 'grok-retired',
      providerId: 'xai',
    });
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'xai',
      model: 'grok-retired',
      resumeSessionId: 'pi-sdk-session-old',
    }));
    expect(captured.args.slice(captured.args.indexOf('--model'), captured.args.indexOf('--model') + 2))
      .toEqual(['--model', 'xai/grok-retired']);
    await handle.close();
  });

  it('restores a retired OpenAI context profile through its native subscription provider', async () => {
    const resolver = vi.fn(async () => ({
      providers: [{
        id: 'openai-codex',
        sourceProviderId: 'openai',
        name: 'OpenAI (ChatGPT)',
        baseUrl: 'http://127.0.0.1:9',
        inheritModels: true,
        models: [{
          id: 'chatgpt/gpt-5.6-sol[1m]',
          wireId: 'gpt-5.6-sol[1m]',
          catalogAddition: true,
        }],
      }],
      env: {},
    }));
    const agent = new PiAgent({
      auth: {
        getState: async () => ({ authenticated: true, identity: 'ChatGPT', authSource: 'oauth' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: { availableModels: [] },
      resolvePiAgentHome: () => agentHome,
      resolvePiNativeProviders: resolver,
      resolvePiRuntimeModelDescriptor: () => ({
        id: 'chatgpt/gpt-5.6-sol[1m]',
        displayName: 'GPT-5.6-Sol (1M · Higher usage)',
        contextWindow: 1_000_000,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
      }),
    });

    const handle = await agent.startSession({
      sessionId: 'historical-openai-profile-resume',
      resumeSessionId: 'pi-sdk-session-openai-profile',
      workingDir: cwd,
      model: 'chatgpt/gpt-5.6-sol[1m]',
      providerId: 'openai',
    });

    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'openai',
      model: 'chatgpt/gpt-5.6-sol[1m]',
      resumeSessionId: 'pi-sdk-session-openai-profile',
    }));
    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'openai-codex']);
    expect(captured.args.slice(captured.args.indexOf('--model'), captured.args.indexOf('--model') + 2))
      .toEqual(['--model', 'gpt-5.6-sol[1m]']);
    await handle.close();
  });

  it('keeps built-in gateway reasoning when a same-id non-reasoning BYOM empties the flat effort intersection', async () => {
    const resolver = vi.fn((_providerId: string | null | undefined, modelId: string) => {
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
      resolvePiGatewayModelApi: () => 'anthropic-messages',
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
    expect(resolver).toHaveBeenCalledWith('openai', 'shared-model');
    expect(models.providers.cindy?.models.find((model) => model.id === 'shared-model')).toMatchObject({
      reasoning: true,
    });
    expect(models.providers['native-a']?.models.find((model) => model.id === 'shared-model')).toMatchObject({
      reasoning: false,
    });
    expect(captured.requests).toContainEqual({ type: 'set_thinking_level', level: 'high' });
    await handle.close();
  });

  it.each([
    ['anthropic-messages', 'messages-model', undefined],
    ['openai-responses', 'responses-model', 'http://127.0.0.1:9988/v1'],
    ['openai-completions', 'moonshotai/kimi-k3', 'http://127.0.0.1:9988/v1'],
    ['google-generative-ai', 'google/gemini-3.6-flash', 'http://127.0.0.1:9988/v1beta'],
  ] as const)(
    'keeps provider cindy while emitting Gateway API %s',
    async (api, modelId, baseUrl) => {
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9988/' },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          {
            id: modelId,
            displayName: modelId,
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiGatewayModelApi: () => api,
      resolvePiGatewayModelSpec: () => ({
        api,
        ...(api === 'openai-completions'
          ? {
              compat: {
                maxTokensField: 'max_tokens',
                thinkingFormat: 'openai',
                requiresReasoningContentOnAssistantMessages: true,
                deferredToolsMode: 'kimi',
              },
            }
          : {}),
      }),
    };

    const handle = await new PiAgent(deps).startSession({
      sessionId: `gateway-${api}`,
      workingDir: cwd,
      model: modelId,
      providerId: 'xd',
    });

    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'cindy']);
    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as {
      providers: Record<string, {
        api: string;
        models: Array<{
          id: string;
          api?: string;
          baseUrl?: string;
          headers?: Record<string, string>;
          compat?: Record<string, unknown>;
        }>;
      }>;
    };
    expect(models.providers.cindy?.api).toBe('anthropic-messages');
    const model = models.providers.cindy?.models.find((candidate) => candidate.id === modelId);
    expect(model).toMatchObject({ api });
    expect(model?.baseUrl).toBe(baseUrl);
    if (api === 'openai-completions') {
      expect(model?.compat).toMatchObject({
        maxTokensField: 'max_tokens',
        thinkingFormat: 'openai',
        requiresReasoningContentOnAssistantMessages: true,
        deferredToolsMode: 'kimi',
      });
    }
    if (api === 'google-generative-ai') {
      expect(model?.headers).toEqual({
        authorization: 'Bearer $CINDY_PI_API_KEY',
        'x-goog-api-key': '$CINDY_PI_API_KEY',
      });
    }
    await handle.close();
  });

  it('keeps BYOM startup when the model is outside the XD v3 Pi catalog', async () => {
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
            id: 'byom-only-model',
            displayName: 'BYOM Only Model',
            contextWindow: 128_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      // undefined = 该模型不受 XD v3 管理；不是 XD 协议缺失。
      resolvePiGatewayModelApi: () => undefined,
      resolvePiNativeProviders: async () => ({
        providers: [
          {
            id: 'my-local',
            name: 'My Local',
            baseUrl: 'http://127.0.0.1:11434/v1',
            api: 'openai-completions',
            models: [{ id: 'byom-only-model' }],
          },
        ],
        env: {},
      }),
    };

    const handle = await new PiAgent(deps).startSession({
      sessionId: 'byom-outside-xd-v3',
      workingDir: cwd,
      model: 'byom-only-model',
      providerId: 'my-local',
    });

    expect(captured.args.slice(captured.args.indexOf('--provider'), captured.args.indexOf('--provider') + 2))
      .toEqual(['--provider', 'my-local']);
    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as {
      providers: Record<string, {
        models: Array<{ id: string; api?: string }>;
      }>;
    };
    expect(models.providers.cindy?.models.find((model) => model.id === 'byom-only-model'))
      .toBeUndefined();
    expect(models.providers['my-local']?.models.find((model) => model.id === 'byom-only-model'))
      .toMatchObject({ id: 'byom-only-model' });
    await handle.close();
  });

  it('omits an unsupported Gateway route without aborting a same-id BYOM session', async () => {
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
            id: 'shared-future-model',
            displayName: 'Shared Future Model',
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiGatewayModelApi: () => null,
      resolvePiNativeProviders: async () => ({
        providers: [
          {
            id: 'my-local',
            name: 'My Local',
            baseUrl: 'http://127.0.0.1:11434/v1',
            api: 'openai-completions',
            models: [{ id: 'shared-future-model' }],
          },
        ],
        env: {},
      }),
    };

    const handle = await new PiAgent(deps).startSession({
      sessionId: 'unsupported-xd-same-id-byom',
      workingDir: cwd,
      model: 'shared-future-model',
      providerId: 'my-local',
    });
    const models = JSON.parse(
      readFileSync(path.join(captured.env.PI_CODING_AGENT_DIR as string, 'models.json'), 'utf8'),
    ) as { providers: Record<string, { models: Array<{ id: string }> }> };
    expect(models.providers.cindy?.models.find((model) => model.id === 'shared-future-model'))
      .toBeUndefined();
    expect(models.providers['my-local']?.models.find((model) => model.id === 'shared-future-model'))
      .toMatchObject({ id: 'shared-future-model' });
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
      resolvePiGatewayModelApi: () => 'anthropic-messages',
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
    spawnPiSubagentRunner: testSubagentRunnerHost,
    resolvePiGatewayModelApi: () => 'anthropic-messages',
    resolvePiNativeProviders,
  });

  it('omits remote Google Gateway routes that cannot sanitize x-goog-api-key', async () => {
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
    };
    const written = new Map<string, string>();
    const modelId = 'google/gemini-3.6-flash';
    const base = byomDeps(async () => ({ providers: [], env: {} }), [
      {
        id: modelId,
        displayName: 'Gemini 3.6 Flash',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
    ]);
    const agent = new PiAgent({
      ...base,
      runtimeConfig: { ...base.runtimeConfig, remoteEndpoint: 'https://gateway.example.test' },
      resolvePiGatewayModelApi: () => 'google-generative-ai',
      resolvePiGatewayModelSpec: () => ({ api: 'google-generative-ai' }),
      resolveRemotePiBinaryPath: async () => '/remote/pi',
      getRemotePiTransport: async () => remoteStub,
      getRemotePiFileOps: () => ({
        mkdirp: async () => {},
        writeFile: async (filePath, content) => {
          written.set(filePath, content);
        },
        stat: async () => ({ isFile: true }),
        rm: async () => {},
        listDir: async () => [],
      }),
    });

    await expect(agent.startSession({
      sessionId: 'remote-google-header-sanitizer',
      workingDir: cwd,
      model: modelId,
      providerId: 'xd',
      remoteHostId: 'remote-host',
    })).rejects.toThrow(/\[PI_GATEWAY_PROTOCOL_UNAVAILABLE\]/);
    const modelsJson = [...written.entries()].find(([filePath]) => filePath.endsWith('models.json'))?.[1];
    expect(modelsJson).toBeTruthy();
    expect(modelsJson).not.toContain('x-goog-api-key');
    const models = JSON.parse(modelsJson!) as {
      providers: Record<string, { models: Array<{ id: string }> }>;
    };
    expect(models.providers.cindy?.models).toEqual([]);
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
    const resolveGatewayModel = vi.fn((_providerId: string | null | undefined, modelId: string) =>
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
      content: [{
        type: 'image' as const,
        path: imagePath,
        managedUrl: 'xdt-image://pi-managed/screenshot.png',
      }],
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
      message: expect.stringContaining(JSON.stringify({
        image: 1,
        uri: 'xdt-image://pi-managed/screenshot.png',
      })),
      images: [expect.objectContaining({ type: 'image', mimeType: 'image/png' })],
    }));
    captured.requests.length = 0;
    await handle.steer!(imageMessage);
    expect(captured.requests).toContainEqual(expect.objectContaining({
      type: 'steer',
      message: expect.stringContaining(JSON.stringify({
        image: 1,
        uri: 'xdt-image://pi-managed/screenshot.png',
      })),
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

    // 轮 40-w4-t6 CRITICAL:用户显式图片读取失败 → fail-before-dispatch(抛错),
    // 不再静默降级文本占位(否则 DB/UI 与 Pi 实际输入分叉)。
    await handle.setModel!('local-model', { providerId: 'native-text' });
    captured.requests.length = 0;
    await expect(
      handle.send({
        type: 'user',
        content: [{ type: 'image', path: path.join(cwd, 'missing.png') }],
      }),
    ).rejects.toThrow(/failed to read image attachment/);
    // 未发送任何 prompt(失败在 dispatch 前)
    expect(captured.requests).toHaveLength(0);
    await handle.close();
  });

  it('waits through Pi preflight compaction when accepting a prompt', async () => {
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'prompt-acceptance-budget',
      workingDir: cwd,
      model: 'local-model',
    });

    await handle.send({ type: 'user', content: 'continue the goal' });

    const promptIndex = captured.requests.findIndex((request) => request.type === 'prompt');
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(captured.requestOptions[promptIndex]).toMatchObject({ timeoutMs: 600_000 });
    const refresh = captured.requestOptions[promptIndex]?.refreshTimeoutOnEvent;
    expect(refresh?.({ type: 'compaction_start' })).toBe(true);
    expect(refresh?.({ type: 'summarization_retry_scheduled' })).toBe(true);
    expect(refresh?.({ type: 'agent_start' })).toBe(false);
    await handle.close();
  });

  it('marks a true prompt acceptance timeout as an unconfirmed dispatch', async () => {
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'prompt') {
        throw new PiRpcRequestTimeoutError('prompt', 600_000);
      }
      return { success: true, data: {} };
    };
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'prompt-acceptance-timeout',
      workingDir: cwd,
      model: 'local-model',
    });

    await expect(handle.send({ type: 'user', content: 'continue the goal' })).rejects.toMatchObject({
      name: 'TurnDispatchUnconfirmedError',
      code: 'TURN_DISPATCH_UNCONFIRMED',
    });
    await handle.close();
  });

  it.each([
    ['transport close before response', new Error('pi process exited (code=null, signal=null)')],
    ['unknown write result', new Error('write EPIPE')],
    ['malformed response envelope', new Error('pi rpc: response for prompt missing boolean success')],
  ])('marks %s after prompt request starts as an unconfirmed dispatch', async (_label, failure) => {
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'prompt') throw failure;
      return { success: true, data: {} };
    };
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: `prompt-unknown-${String(_label).replaceAll(' ', '-')}`,
      workingDir: cwd,
      model: 'local-model',
    });

    await expect(handle.send({ type: 'user', content: 'continue the goal' })).rejects.toMatchObject({
      name: 'TurnDispatchUnconfirmedError',
      code: 'TURN_DISPATCH_UNCONFIRMED',
      cause: failure,
    });
    expect(captured.requests.filter((request) => request.type === 'prompt')).toHaveLength(1);
    await handle.close();
  });

  it('keeps an explicit prompt rejection as a confirmed undispatched error', async () => {
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'prompt') {
        return {
          command: 'prompt',
          success: false,
          error: 'prompt rejected before acceptance',
        };
      }
      return { success: true, data: {} };
    };
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'prompt-explicit-rejection',
      workingDir: cwd,
      model: 'local-model',
    });

    await expect(handle.send({ type: 'user', content: 'continue the goal' })).rejects.toMatchObject({
      name: 'TurnDispatchRejectedError',
      code: 'TURN_DISPATCH_REJECTED',
      message: 'pi prompt rejected before acceptance: prompt rejected before acceptance',
    });
    await handle.close();
  });

  it.each([
    ['missing command', { success: false, error: 'prompt rejected before acceptance' }],
    [
      'non-string command',
      { command: { type: 'prompt' }, success: false, error: 'prompt rejected before acceptance' },
    ],
    [
      'mismatched command',
      { command: 'steer', success: false, error: 'prompt rejected before acceptance' },
    ],
  ])('treats a rejected prompt response with %s as an unconfirmed dispatch', async (
    label,
    rejectionResponse,
  ) => {
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return {
          success: true,
          data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } },
        };
      }
      if (command.type === 'prompt') return rejectionResponse;
      return { success: true, data: {} };
    };
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: `prompt-rejection-${label.replaceAll(' ', '-')}`,
      workingDir: cwd,
      model: 'local-model',
    });

    await expect(handle.send({ type: 'user', content: 'continue the goal' })).rejects.toMatchObject({
      name: 'TurnDispatchUnconfirmedError',
      code: 'TURN_DISPATCH_UNCONFIRMED',
      cause: expect.objectContaining({
        message: 'pi prompt rejection response missing matching command',
      }),
    });
    expect(captured.requests.filter((request) => request.type === 'prompt')).toHaveLength(1);
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

  it('executes only runtime-confirmed commands from enabled Cindy-managed Pi packages', async () => {
    const packageRoot = path.join(agentHome, 'managed-package');
    const extensionPath = path.join(packageRoot, 'extensions', 'index.ts');
    mkdirSync(path.dirname(extensionPath), { recursive: true });
    writeFileSync(extensionPath, '// managed extension');
    let releaseCommandCatalog!: () => void;
    const commandCatalogGate = new Promise<void>((resolve) => {
      releaseCommandCatalog = resolve;
    });
    captured.requestHandler = async (command) => {
      if (command.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } };
      }
      if (command.type === 'get_commands') {
        await commandCatalogGate;
        return {
          type: 'response',
          command: 'get_commands',
          success: true,
          data: {
            commands: [
              {
                name: 'managed-run',
                description: 'Managed package command',
                source: 'extension',
                sourceInfo: { path: extensionPath, source: 'extension' },
              },
              {
                name: 'user-run',
                description: 'Unmanaged user command',
                source: 'extension',
                sourceInfo: { path: '/private/user/.pi/extensions/index.ts', source: 'extension' },
              },
            ],
          },
        };
      }
      return { success: true, data: {} };
    };
    const deps = byomDeps(async () => ({ providers: [], env: {} }));
    deps.resolvePiManagedPackageResources = async () => ({
      extensions: [extensionPath],
      skills: [],
      promptTemplates: [],
      packageRoots: [packageRoot],
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'managed-command',
      workingDir: cwd,
      model: 'local-model',
      extraDirs: ['/refs/project-docs'],
    });
    captured.requests.length = 0;
    const firstSend = handle.send({ type: 'user', content: '/managed-run now' });
    await Promise.resolve();
    expect(captured.requests.some((request) => request.type === 'prompt')).toBe(false);
    releaseCommandCatalog();
    await firstSend;
    const manifest = await new Promise<ReturnType<NonNullable<typeof handle.getRuntimeCapabilities>>>((resolve) => {
      const current = handle.getRuntimeCapabilities?.();
      if (current?.status === 'loaded') {
        resolve(current);
        return;
      }
      let unsubscribe: (() => void) | undefined;
      unsubscribe = handle.onRuntimeCapabilitiesChange?.((next) => {
        if (next?.status !== 'loaded') return;
        unsubscribe?.();
        resolve(next);
      });
    });
    expect(manifest?.managedPackageCommandNames).toEqual(['managed-run']);
    const managed = captured.requests.find((request) => request.type === 'prompt');
    expect(managed?.message).toBe('/managed-run now');

    captured.requests.length = 0;
    await handle.send({ type: 'user', content: '/user-run now' });
    const unmanaged = captured.requests.find((request) => request.type === 'prompt');
    expect(String(unmanaged?.message)).not.toMatch(/^\/user-run/);
    expect(String(unmanaged?.message)).toContain('/user-run now');
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
      writableRoots: [],
    });
    await handle.close();
  });

  it('persists writable directory grants separately from read-only references', async () => {
    const agent = new PiAgent(byomDeps(async () => ({ providers: [], env: {} })));
    const handle = await agent.startSession({
      sessionId: 'perm-writable-dirs',
      workingDir: cwd,
      model: 'local-model',
      permissionMode: 'auto',
      extraDirs: ['/reference-only'],
      writableDirs: ['/shared-output'],
    });
    const permFile = runtimeFileOf('perm', 'perm-writable-dirs');
    expect(JSON.parse(readFileSync(permFile, 'utf8'))).toMatchObject({
      mode: 'auto',
      readOnlyRoots: ['/reference-only'],
      writableRoots: ['/shared-output'],
    });
    await handle.setWritableDirs?.(['/replacement-output']);
    expect(JSON.parse(readFileSync(permFile, 'utf8'))).toMatchObject({
      readOnlyRoots: ['/reference-only'],
      writableRoots: ['/replacement-output'],
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

  it('rejects a loopback-only BYOM provider for remote Pi sessions (fail-fast)', async () => {
    // 轮 42 P2(codex-connector):远端 Pi + baseUrl 指向本机 loopback 的 BYOM
    // (Ollama @ localhost 等)在创建时拒绝 —— 远端进程在 SSH 主机上连 localhost
    // 是远端自己, 用户本机服务不可达, 首回合必然失败/错配。
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
    };
    const deps: AgentDeps = {
      ...byomDeps(async () => ({
        providers: [
          {
            id: 'ollama',
            name: 'Ollama',
            baseUrl: 'http://localhost:11434',
            api: 'openai-completions' as const,
            models: [{ id: 'local-model' }],
          },
        ],
        env: {},
      })),
      getRemotePiTransport: async () => remoteStub,
      getRemotePiFileOps: () => ({
        mkdirp: async () => {},
        writeFile: async () => {},
        stat: async () => ({ isFile: true }),
        rm: async () => {},
        listDir: async () => [],
      }),
    };
    const agent = new PiAgent(deps);
    await expect(agent.startSession({
      sessionId: 'remote-loopback-byom',
      workingDir: cwd,
      model: 'local-model',
      providerId: 'ollama',
      remoteHostId: 'remote-host',
    })).rejects.toThrow(/\[REMOTE_LOCAL_ONLY_PROVIDER\]/);
    // 未走到 spawn(transport 从未创建)。
    expect(captured.args).toEqual([]);
  });

  it('rejects a local-only OpenAI context profile before resolving or spawning remote Pi', async () => {
    const resolver = vi.fn(async () => ({ providers: [], env: {} }));
    const transport = vi.fn(async () => {
      throw new Error('remote transport must not be created');
    });
    const agent = new PiAgent({
      ...byomDeps(resolver, [
        {
          id: 'chatgpt/gpt-5.6-sol[1m]',
          displayName: 'GPT-5.6-Sol 1M',
          contextWindow: 1_000_000,
          efforts: [],
          defaultEffort: null,
        },
      ]),
      getRemotePiTransport: transport,
    });

    await expect(agent.startSession({
      sessionId: 'remote-openai-context-profile',
      workingDir: cwd,
      model: 'chatgpt/gpt-5.6-sol[1m]',
      providerId: 'openai',
      remoteHostId: 'remote-host',
    })).rejects.toThrow(/\[REMOTE_PI_CONTEXT_PROFILE_UNAVAILABLE\]/);
    expect(resolver).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(captured.args).toEqual([]);
  });

  it('rejects switching a running remote Pi session to a local-only OpenAI context profile', async () => {
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
    };
    const base = byomDeps(async () => ({ providers: [], env: {} }), [
      {
        id: 'gateway-model',
        displayName: 'Gateway model',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      },
      {
        id: 'chatgpt/gpt-5.6-sol[1m]',
        displayName: 'GPT-5.6-Sol 1M',
        contextWindow: 1_000_000,
        efforts: [],
        defaultEffort: null,
      },
    ]);
    const agent = new PiAgent({
      ...base,
      runtimeConfig: { ...base.runtimeConfig, remoteEndpoint: 'https://gateway.example.test' },
      resolveRemotePiBinaryPath: async () => '/remote/pi',
      getRemotePiTransport: async () => remoteStub,
      getRemotePiFileOps: () => ({
        mkdirp: async () => {},
        writeFile: async () => {},
        stat: async () => ({ isFile: true }),
        rm: async () => {},
        listDir: async () => [],
      }),
    });
    const handle = await agent.startSession({
      sessionId: 'remote-gateway-context-profile-switch',
      workingDir: cwd,
      model: 'gateway-model',
      providerId: 'xd',
      remoteHostId: 'remote-host',
    });

    captured.requests.length = 0;
    await expect(handle.setModel!('chatgpt/gpt-5.6-sol[1m]', { providerId: 'openai' }))
      .rejects.toThrow(/\[REMOTE_PI_CONTEXT_PROFILE_UNAVAILABLE\]/);
    expect(handle.model).toBe('gateway-model');
    expect(captured.requests).not.toContainEqual(expect.objectContaining({ type: 'set_model' }));
    await handle.close();
  });

  it('allows an explicitly forwarded remote xAI provider and keeps proxy auth in the remote env', async () => {
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
      ensureHostProxyForward: async () => {},
    };
    let transportOptions:
      Parameters<NonNullable<AgentDeps['getRemotePiTransport']>>[1] | undefined;
    const remoteWrittenFiles: string[] = [];
    let registeredToken: string | undefined;
    let disposed = 0;
    const base = byomDeps(
      async () => ({
        providers: [
          {
            id: 'xai',
            name: 'xAI',
            baseUrl: 'http://127.0.0.1:47989',
            api: 'anthropic-messages',
            apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
            headers: {
              'x-cindy-pi-session-id': '$CINDY_PI_SESSION_ID',
              'x-cindy-pi-session-token': '$CINDY_PI_SESSION_TOKEN',
            },
            models: [{ id: 'xai/grok-4.6' }],
            modelIdAliases: {
              'grok-4.6': 'xai/grok-4.6',
              'xai/grok-4.6': 'xai/grok-4.6',
            },
            hostProxyForward: {
              localUrl: 'http://127.0.0.1:18765',
              remotePort: 47989,
            },
          },
        ],
        env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
      }),
      [
        {
          id: 'gateway-model',
          displayName: 'Gateway model',
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        },
        {
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          contextWindow: 500_000,
          efforts: [],
          defaultEffort: null,
        },
      ],
    );
    const stableTokens = new Map([
      ['remote-xai-forward', 'a'.repeat(43)],
      ['remote-xai-other', 'b'.repeat(43)],
    ]);
    const derivePiProxySessionToken = vi.fn((sessionId: string) => stableTokens.get(sessionId)!);
    const agentDeps: AgentDeps = {
      ...base,
      auth: {
        ...base.auth,
        getState: async () => ({
          authenticated: true,
          identity: 'SuperGrok',
          authSource: 'oauth',
        }),
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: {
        ...base.runtimeConfig,
        remoteEndpoint: 'https://gateway.example.test',
      },
      registerPiProxySession: (_sessionId, token) => {
        registeredToken = token;
        return () => {
          disposed += 1;
        };
      },
      derivePiProxySessionToken,
      mutatePiManagedPackage: vi.fn(async () => ({ changed: true })),
      resolveRemotePiBinaryPath: async () => '/remote/pi',
      getRemotePiFileOps: () => ({
        mkdirp: async () => {},
        writeFile: async (file) => { remoteWrittenFiles.push(file); },
        stat: async () => ({ isFile: true }),
        rm: async () => {},
        listDir: async () => [],
      }),
      getRemotePiTransport: async (_hostId, opts) => {
        transportOptions = opts;
        return remoteStub;
      },
    };
    const agent = new PiAgent(agentDeps);
    const handle = await agent.startSession({
      sessionId: 'remote-xai-forward',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
      remoteHostId: 'remote-host',
    });
    expect(transportOptions?.hostProxyForwards).toEqual([
      { localUrl: 'http://127.0.0.1:18765', remotePort: 47989 },
    ]);
    expect(registeredToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(transportOptions?.env.CINDY_PI_API_KEY).toBe('gateway-key');
    expect(transportOptions?.env.CINDY_PI_XAI_PROXY_API_KEY).toBe('xai-proxy-placeholder');
    expect(JSON.parse(transportOptions?.env.CINDY_PI_SECRET_ENV_NAMES ?? '[]')).toEqual(
      expect.arrayContaining(['CINDY_PI_API_KEY', 'CINDY_PI_XAI_PROXY_API_KEY']),
    );
    expect(transportOptions?.env.CINDY_PI_SESSION_TOKEN).toBe(registeredToken);
    expect(transportOptions?.args).not.toContain('/remote/cindy-subagent.ts');
    expect(transportOptions?.args.some((arg) => arg.endsWith('/cindy-subagent.ts'))).toBe(false);
    expect(transportOptions?.env.CINDY_PI_SUBAGENT_BINARY).toBeUndefined();
    expect(transportOptions?.env.CINDY_PI_SUBAGENT_RUNTIME_FILE).toBeUndefined();
    expect(transportOptions?.env.CINDY_PI_SUBAGENT_RUN_ROOT).toBeUndefined();
    expect(transportOptions?.env.CINDY_PI_SUBAGENT_RUNNER_FILE).toBeUndefined();
    expect(transportOptions?.env.CINDY_PI_SUBAGENT_NODE).toBeUndefined();
    expect(remoteWrittenFiles.some((file) => file.endsWith('/cindy-subagent.ts'))).toBe(false);
    expect(remoteWrittenFiles.some((file) => file.endsWith('/cindy-subagent-runner.cjs'))).toBe(false);
    expect(transportOptions?.env.CINDY_PI_PACKAGE_MANAGEMENT).toBeUndefined();
    const firstToken = registeredToken;
    const firstSpawnEnv = { ...transportOptions?.env };

    captured.requests.length = 0;
    await handle.setModel!('gateway-model', { providerId: 'xd' });
    await handle.setModel!('grok-4.6', { providerId: 'xai' });
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'cindy',
      modelId: 'gateway-model',
    });
    expect(captured.requests).toContainEqual({
      type: 'set_model',
      provider: 'xai',
      modelId: 'xai/grok-4.6',
    });
    expect(remoteWrittenFiles.some((file) => file.includes('/subagent-'))).toBe(false);
    await handle.close();
    expect(disposed).toBe(1);

    // Reconstruct the agent to model a Desktop restart. The host-owned
    // derivation survives while maker-core process-local state does not.
    const reattached = await new PiAgent(agentDeps).startSession({
      sessionId: 'remote-xai-forward',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
      remoteHostId: 'remote-host',
    });
    expect(registeredToken).toBe(firstToken);
    expect(transportOptions?.env).toEqual(firstSpawnEnv);
    expect(transportOptions?.env.CINDY_PI_SESSION_TOKEN).toBe(firstToken);
    await reattached.close();
    expect(disposed).toBe(2);

    const otherSession = await new PiAgent(agentDeps).startSession({
      sessionId: 'remote-xai-other',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
      remoteHostId: 'remote-host',
    });
    expect(registeredToken).not.toBe(firstToken);
    expect(transportOptions?.env.CINDY_PI_SESSION_TOKEN).toBe(registeredToken);
    expect(derivePiProxySessionToken).toHaveBeenCalledWith('remote-xai-forward');
    expect(derivePiProxySessionToken).toHaveBeenCalledWith('remote-xai-other');
    await otherSession.close();
    expect(disposed).toBe(3);

    const legacyDeps: AgentDeps = {
      ...agentDeps,
      derivePiProxySessionToken: undefined,
    };
    const legacy = await new PiAgent(legacyDeps).startSession({
      sessionId: 'remote-xai-legacy',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
      remoteHostId: 'remote-host',
    });
    const legacyToken = registeredToken;
    await legacy.close();
    const legacyReattached = await new PiAgent(legacyDeps).startSession({
      sessionId: 'remote-xai-legacy',
      workingDir: cwd,
      model: 'grok-4.6',
      providerId: 'xai',
      remoteHostId: 'remote-host',
    });
    expect(registeredToken).toBe(legacyToken);
    await legacyReattached.close();
    expect(disposed).toBe(5);
  });

  it('defers the remote xAI forward until a running gateway session actually switches to xAI', async () => {
    const forwardEvents: string[] = [];
    let rejectForward = true;
    let remoteWrites = 0;
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
      ensureHostProxyForward: async (spec) => {
        forwardEvents.push(`forward:${spec.localUrl}:${spec.remotePort}`);
        if (rejectForward) throw new Error('remote port already in use');
      },
    };
    let transportOptions:
      Parameters<NonNullable<AgentDeps['getRemotePiTransport']>>[1] | undefined;
    const base = byomDeps(
      async () => ({
        providers: [
          {
            id: 'xai',
            name: 'xAI',
            baseUrl: 'http://127.0.0.1:47989',
            api: 'anthropic-messages',
            apiKeyEnvVar: 'CINDY_PI_XAI_PROXY_API_KEY',
            models: [{ id: 'xai/grok-4.6' }],
            modelIdAliases: {
              'grok-4.6': 'xai/grok-4.6',
              'xai/grok-4.6': 'xai/grok-4.6',
            },
            hostProxyForward: {
              localUrl: 'http://127.0.0.1:18765',
              remotePort: 47989,
            },
          },
        ],
        env: { CINDY_PI_XAI_PROXY_API_KEY: 'xai-proxy-placeholder' },
      }),
      [
        {
          id: 'gateway-model',
          displayName: 'Gateway model',
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        },
        {
          id: 'grok-4.6',
          displayName: 'Grok 4.6',
          contextWindow: 500_000,
          efforts: [],
          defaultEffort: null,
        },
      ],
    );
    captured.requestHandler = async (command) => {
      if (command.type === 'set_model') forwardEvents.push('set_model');
      return command.type === 'get_state'
        ? { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200_000 } } }
        : { success: true, data: {} };
    };
    const agent = new PiAgent({
      ...base,
      auth: {
        ...base.auth,
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'gateway-key' }),
      },
      runtimeConfig: {
        ...base.runtimeConfig,
        remoteEndpoint: 'https://gateway.example.test',
      },
      resolveRemotePiBinaryPath: async () => '/remote/pi',
      getRemotePiFileOps: () => ({
        mkdirp: async () => {},
        writeFile: async () => {
          remoteWrites += 1;
        },
        stat: async () => ({ isFile: true }),
        rm: async () => {},
        listDir: async () => [],
      }),
      getRemotePiTransport: async (_hostId, opts) => {
        transportOptions = opts;
        return remoteStub;
      },
    });
    const handle = await agent.startSession({
      sessionId: 'remote-gateway-then-xai',
      workingDir: cwd,
      model: 'gateway-model',
      providerId: 'xd',
      remoteHostId: 'remote-host',
    });

    expect(transportOptions?.hostProxyForwards).toEqual([]);
    expect(forwardEvents).toEqual([]);

    captured.requests.length = 0;
    remoteWrites = 0;
    await expect(handle.setModel!('grok-4.6', { providerId: 'xai' })).rejects.toThrow(
      /remote port already in use/,
    );
    expect(remoteWrites).toBe(0);
    expect(captured.requests).not.toContainEqual({
      type: 'set_model',
      provider: 'xai',
      modelId: 'xai/grok-4.6',
    });

    rejectForward = false;
    forwardEvents.length = 0;
    await handle.setModel!('grok-4.6', { providerId: 'xai' });
    expect(forwardEvents).toEqual([
      'forward:http://127.0.0.1:18765:47989',
      'set_model',
    ]);
    await handle.close();
  });

  it('hashes the remote permission snapshot into spawn env so a later Full-access attach restarts', async () => {
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
    };
    const capturedRemoteEnvs: Array<Record<string, string | undefined>> = [];
    const remoteFileOps = {
      mkdirp: async () => {},
      writeFile: async () => {},
      stat: async () => ({ isFile: true }),
      rm: async () => {},
      listDir: async () => [],
    };
    const startRemote = async (permissionMode: 'ask' | 'bypassPermissions') => {
      const base = byomDeps(async () => ({ providers: [], env: {} }));
      const agent = new PiAgent({
        ...base,
        runtimeConfig: { ...base.runtimeConfig, remoteEndpoint: 'https://gateway.example.test' },
        resolveRemotePiBinaryPath: async () => '/remote/pi',
        getRemotePiTransport: async (_hostId, opts) => {
          capturedRemoteEnvs.push({ ...(opts.env ?? {}) });
          return remoteStub;
        },
        getRemotePiFileOps: () => remoteFileOps,
      });
      const handle = await agent.startSession({
        sessionId: 'remote-perm-hash',
        workingDir: cwd,
        model: 'local-model',
        permissionMode,
        remoteHostId: 'remote-host',
      });
      await handle.close();
    };

    await startRemote('ask');
    await startRemote('bypassPermissions');
    expect(capturedRemoteEnvs).toHaveLength(2);
    expect(capturedRemoteEnvs[0]!.CINDY_PI_PERMISSION_HASH).toMatch(/^[0-9a-f]{16}$/);
    expect(capturedRemoteEnvs[1]!.CINDY_PI_PERMISSION_HASH).toMatch(/^[0-9a-f]{16}$/);
    expect(capturedRemoteEnvs[0]!.CINDY_PI_PERMISSION_HASH)
      .not.toBe(capturedRemoteEnvs[1]!.CINDY_PI_PERMISSION_HASH);
    expect(capturedRemoteEnvs[0]!.CINDY_PI_PERMISSION_FILE)
      .not.toBe(capturedRemoteEnvs[1]!.CINDY_PI_PERMISSION_FILE);
    expect(capturedRemoteEnvs[0]!.CINDY_PI_PERMISSION_FILE)
      .toContain(capturedRemoteEnvs[0]!.CINDY_PI_PERMISSION_HASH);
    expect(capturedRemoteEnvs[1]!.CINDY_PI_PERMISSION_FILE)
      .toContain(capturedRemoteEnvs[1]!.CINDY_PI_PERMISSION_HASH);
  });

  it('puts a deterministic Cindy extension bundle hash into remote spawn env', async () => {
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
    };
    const capturedRemoteEnvs: Array<Record<string, string | undefined>> = [];
    const startRemote = async () => {
      const base = byomDeps(async () => ({ providers: [], env: {} }));
      const agent = new PiAgent({
        ...base,
        runtimeConfig: { ...base.runtimeConfig, remoteEndpoint: 'https://gateway.example.test' },
        resolveRemotePiBinaryPath: async () => '/remote/pi',
        getRemotePiTransport: async (_hostId, opts) => {
          capturedRemoteEnvs.push({ ...(opts.env ?? {}) });
          return remoteStub;
        },
        getRemotePiFileOps: () => ({
          mkdirp: async () => {},
          writeFile: async () => {},
          stat: async () => ({ isFile: true }),
          rm: async () => {},
          listDir: async () => [],
        }),
      });
      const handle = await agent.startSession({
        sessionId: 'remote-extension-hash',
        workingDir: cwd,
        model: 'local-model',
        remoteHostId: 'remote-host',
      });
      await handle.close();
    };

    await startRemote();
    await startRemote();
    const expected = createHash('sha256')
      .update(CINDY_BRIDGE_EXTENSION_SOURCE)
      .update('\n')
      .update(CINDY_SUBAGENT_EXTENSION_SOURCE)
      .digest('hex')
      .slice(0, 16);
    expect(capturedRemoteEnvs).toHaveLength(2);
    expect(capturedRemoteEnvs[0]!.CINDY_PI_EXTENSION_BUNDLE_HASH).toBe(expected);
    expect(capturedRemoteEnvs[1]!.CINDY_PI_EXTENSION_BUNDLE_HASH).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{16}$/);
  });

  it('isolates remote configHome by models.json hash so a later route change does not overwrite the live child', async () => {
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
    };
    const capturedRemoteEnvs: Array<Record<string, string | undefined>> = [];
    const startRemote = async (remoteEndpoint: string) => {
      const base = byomDeps(async () => ({ providers: [], env: {} }));
      const agent = new PiAgent({
        ...base,
        runtimeConfig: { ...base.runtimeConfig, remoteEndpoint },
        resolveRemotePiBinaryPath: async () => '/remote/pi',
        getRemotePiTransport: async (_hostId, opts) => {
          capturedRemoteEnvs.push({ ...(opts.env ?? {}) });
          return remoteStub;
        },
        getRemotePiFileOps: () => ({
          mkdirp: async () => {},
          writeFile: async () => {},
          stat: async () => ({ isFile: true }),
          rm: async () => {},
          listDir: async () => [],
        }),
      });
      const handle = await agent.startSession({
        sessionId: 'remote-config-hash',
        workingDir: cwd,
        model: 'local-model',
        remoteHostId: 'remote-host',
      });
      await handle.close();
    };

    await startRemote('https://gateway-a.example.test');
    await startRemote('https://gateway-b.example.test');
    expect(capturedRemoteEnvs).toHaveLength(2);
    expect(capturedRemoteEnvs[0]!.PI_CODING_AGENT_DIR)
      .not.toBe(capturedRemoteEnvs[1]!.PI_CODING_AGENT_DIR);
    expect(capturedRemoteEnvs[0]!.CINDY_PI_MODELS_JSON_HASH)
      .not.toBe(capturedRemoteEnvs[1]!.CINDY_PI_MODELS_JSON_HASH);
    expect(capturedRemoteEnvs[0]!.PI_CODING_AGENT_DIR)
      .toContain((capturedRemoteEnvs[0]!.CINDY_PI_MODELS_JSON_HASH ?? '').slice(0, 16));
    expect(capturedRemoteEnvs[1]!.PI_CODING_AGENT_DIR)
      .toContain((capturedRemoteEnvs[1]!.CINDY_PI_MODELS_JSON_HASH ?? '').slice(0, 16));
  });

  it('includes settings.json in the remote launch identity so retry config restarts the child', async () => {
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
    };
    const written = new Map<string, string>();
    const capturedRemoteEnvs: Array<Record<string, string | undefined>> = [];
    const base = byomDeps(async () => ({ providers: [], env: {} }));
    const agent = new PiAgent({
      ...base,
      runtimeConfig: { ...base.runtimeConfig, remoteEndpoint: 'https://gateway.example.test' },
      resolveRemotePiBinaryPath: async () => '/remote/pi',
      getRemotePiTransport: async (_hostId, opts) => {
        capturedRemoteEnvs.push({ ...(opts.env ?? {}) });
        return remoteStub;
      },
      getRemotePiFileOps: () => ({
        mkdirp: async () => {},
        writeFile: async (filePath, content) => {
          written.set(filePath, content);
        },
        stat: async () => ({ isFile: true }),
        rm: async () => {},
        listDir: async () => [],
      }),
    });
    const handle = await agent.startSession({
      sessionId: 'remote-settings-hash',
      workingDir: cwd,
      model: 'local-model',
      remoteHostId: 'remote-host',
    });
    await handle.close();

    const modelsJson = [...written.entries()].find(([filePath]) => filePath.endsWith('models.json'))?.[1];
    const settingsJson = [...written.entries()].find(([filePath]) => filePath.endsWith('settings.json'))?.[1];
    expect(modelsJson).toBeTruthy();
    expect(settingsJson).toBeTruthy();
    const modelsOnlyHash = createHash('sha256').update(modelsJson!).digest('hex');
    const launchHash = createHash('sha256')
      .update(modelsJson!)
      .update('\n')
      .update(settingsJson!)
      .digest('hex');
    expect(launchHash).not.toBe(modelsOnlyHash);
    expect(capturedRemoteEnvs).toHaveLength(1);
    expect(capturedRemoteEnvs[0]!.CINDY_PI_MODELS_JSON_HASH).toBe(launchHash);
    expect(capturedRemoteEnvs[0]!.PI_CODING_AGENT_DIR).toContain(launchHash.slice(0, 16));
  });

  it('inlines remote text attachments and rejects local path mentions before dispatch', async () => {
    const remoteStub: import('../transport.js').PiTransport = {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 4321,
      isClosed: () => false,
      remoteBinaryPath: '/remote/pi',
      killRemoteSession: async () => {},
    };
    const attachment = path.join(cwd, 'notes.txt');
    writeFileSync(attachment, 'remote-inline-body');
    const base = byomDeps(async () => ({ providers: [], env: {} }));
    const agent = new PiAgent({
      ...base,
      runtimeConfig: { ...base.runtimeConfig, remoteEndpoint: 'https://gateway.example.test' },
      resolveRemotePiBinaryPath: async () => '/remote/pi',
      getRemotePiTransport: async () => remoteStub,
      getRemotePiFileOps: () => ({
        mkdirp: async () => {},
        writeFile: async () => {},
        stat: async () => ({ isFile: true }),
        rm: async () => {},
        listDir: async () => [],
      }),
    });
    const handle = await agent.startSession({
      sessionId: 'remote-attach',
      workingDir: cwd,
      model: 'local-model',
      remoteHostId: 'remote-host',
    });

    captured.requests.length = 0;
    await handle.send({
      type: 'user',
      content: [
        { type: 'text', text: 'please read this' },
        { type: 'file', path: attachment },
      ],
    });
    const prompt = captured.requests.find((r) => r.type === 'prompt');
    expect(String(prompt?.message)).toContain('remote-inline-body');
    expect(String(prompt?.message)).not.toContain(attachment);

    await expect(handle.send({
      type: 'user',
      content: [{ type: 'mention', name: 'local-dir', path: cwd, kind: 'dir' }],
    })).rejects.toThrow(/cannot use local path mentions/);
    await handle.close();
  });
});
