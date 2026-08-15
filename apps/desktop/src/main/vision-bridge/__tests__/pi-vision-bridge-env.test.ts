/**
 * pi-vision-bridge-env 单元测试。
 *
 * 覆盖：未启用 → null；无主后端 → null；主后端解析失败 → null；正常序列化（含 fallback）；
 * fallback 解析失败时主后端仍可用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPiVisionBridgeEnv, PI_VISION_BRIDGE_ENV } from '../pi-vision-bridge-env.js';
import type { VisionBridgeSettings } from '../vision-bridge-settings-store.js';
import type { VisionChannelDeps } from '../vision-channel.js';

vi.mock('../vision-bridge-settings-store.js', () => ({
  readVisionBridgeSettings: vi.fn(),
}));
vi.mock('../vision-bridge-controller.js', () => ({
  getVisionBridgeController: vi.fn(),
}));

import { readVisionBridgeSettings } from '../vision-bridge-settings-store.js';
import { getVisionBridgeController } from '../vision-bridge-controller.js';

const mockedSettings = vi.mocked(readVisionBridgeSettings);
const mockedController = vi.mocked(getVisionBridgeController);

/** 默认：视觉桥已装配且命中任意模型（shouldBridge true）。 */
function mockController(shouldBridge: (model: string) => boolean = () => true): void {
  mockedController.mockReturnValue({ shouldBridge, describeImage: vi.fn() } as never);
}

function depsWithProvider(provider: { id: string; routingAuth: string }): VisionChannelDeps {
  return {
    getProviderById: (providerId: string) =>
      providerId === provider.id
        ? ({
            id: provider.id,
            name: provider.id,
            source: 'user',
            agents: ['claude-code', 'codex', 'pi'],
            auth: { method: 'apiKey' },
            routing: {
              'claude-code': {
                wireProtocol: 'openai-chat',
                upstream: 'https://api.example.com/v1',
                authStrategy: provider.routingAuth,
              },
            },
            models: { 'claude-code': [{ id: 'vision-x', name: 'Vision X' }] },
          } as never)
        : null,
    readCustomProviderKey: () => 'sk-test',
    readGatewayKey: () => 'gk-test',
  };
}

function settings(overrides: Partial<VisionBridgeSettings> = {}): VisionBridgeSettings {
  return {
    enabled: true,
    targetModels: [],
    primary: { providerId: 'user-x', modelId: 'vision-x' },
    fallback: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // 默认视觉桥已装配且命中（shouldBridge true），各用例可覆盖。
  mockController();
});

describe('buildPiVisionBridgeEnv', () => {
  it('returns null when disabled', () => {
    mockedSettings.mockReturnValue(settings({ enabled: false }));
    expect(buildPiVisionBridgeEnv(depsWithProvider({ id: 'user-x', routingAuth: 'api-key-header' }), 'deepseek-v4')).toBeNull();
  });

  it('returns null when no primary backend', () => {
    mockedSettings.mockReturnValue(settings({ primary: null }));
    expect(buildPiVisionBridgeEnv(depsWithProvider({ id: 'user-x', routingAuth: 'api-key-header' }), 'deepseek-v4')).toBeNull();
  });

  it('returns null when current model is not a vision-bridge target (shouldBridge false)', () => {
    mockedSettings.mockReturnValue(settings());
    // 视觉桥已装配但当前 session 模型未命中目标（如 claude-sonnet 已有视觉、或未勾选）：
    // 不注入 env、pi 不注册 vision 工具（零干扰——不因别的模型配置而改变本模型工具面）。
    mockController((model) => model !== 'claude-sonnet');
    const d = depsWithProvider({ id: 'user-x', routingAuth: 'api-key-header' });
    expect(buildPiVisionBridgeEnv(d, 'claude-sonnet')).toBeNull();
    // 命中模型 → 正常注入。
    expect(buildPiVisionBridgeEnv(d, 'deepseek-v4')).not.toBeNull();
  });

  it('returns null when primary backend cannot be resolved (unsupported auth)', () => {
    mockedSettings.mockReturnValue(settings());
    // provider 用 OAuth 策略 → resolveVisionBackendEndpoint 抛错 → primary null → 整体 null。
    const d = depsWithProvider({ id: 'user-x', routingAuth: 'provider-oauth-header' });
    expect(buildPiVisionBridgeEnv(d, 'deepseek-v4')).toBeNull();
  });

  it('serializes primary + fallback backend spec into env', () => {
    mockedSettings.mockReturnValue(
      settings({
        primary: { providerId: 'user-x', modelId: 'vision-x' },
        fallback: { providerId: 'user-y', modelId: 'vision-y' },
      }),
    );
    const d = depsWithProvider({ id: 'user-x', routingAuth: 'api-key-header' });
    // fallback provider user-y 不在 deps 里 → resolve null，主后端仍可用。
    const env = buildPiVisionBridgeEnv(d, 'deepseek-v4');
    expect(env).not.toBeNull();
    expect(env![PI_VISION_BRIDGE_ENV]).toBeTruthy();
    const parsed = JSON.parse(env![PI_VISION_BRIDGE_ENV]);
    expect(parsed.enabled).toBe(true);
    expect(parsed.primary.baseUrl).toBe('https://api.example.com/v1');
    expect(parsed.primary.model).toBe('vision-x');
    expect(parsed.primary.authorization).toBe('Bearer sk-test');
    // wireProtocol 透传：pi 子进程按此构造请求/解析响应（routing 声明 openai-chat）。
    expect(parsed.primary.wireProtocol).toBe('openai-chat');
    // headers 透传：routing 无 headerOverride 时为空对象，但字段必须存在
    // （pi 子进程合并请求头，缺失会导致 anthropic 风格后端拒视觉请求）。
    expect(parsed.primary.headers).toEqual({});
    // fallback 解析失败 → null（序列化时保留 null，pi bridge 侧再判）。
    expect(parsed.fallback).toBeNull();
  });

  it('keeps fallback when both providers resolve', () => {
    mockedSettings.mockReturnValue(
      settings({
        primary: { providerId: 'user-x', modelId: 'vision-x' },
        fallback: { providerId: 'user-x', modelId: 'vision-y' },
      }),
    );
    const d = depsWithProvider({ id: 'user-x', routingAuth: 'api-key-header' });
    const env = buildPiVisionBridgeEnv(d, 'deepseek-v4');
    expect(env).not.toBeNull();
    const parsed = JSON.parse(env![PI_VISION_BRIDGE_ENV]);
    expect(parsed.fallback).not.toBeNull();
    expect(parsed.fallback.model).toBe('vision-y');
  });
});
