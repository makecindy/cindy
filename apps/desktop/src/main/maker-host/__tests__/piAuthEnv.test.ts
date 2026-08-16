/**
 * DesktopPiAuthAdapter.getAuthEnv —— 会话级网关 key(CINDY_PI_API_KEY)注入规则。
 * 关键不变量:只有共用 cindy provider 的订阅 OAuth 路由(anthropic/openai)写占位符;
 * xAI/BYOM 原生 provider 使用独立 env，CINDY_PI_API_KEY 保留真网关 key，否则
 * 会话中途切回网关模型会 401。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ gatewayKey: 'REAL-GATEWAY-KEY' as string | null }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp/cindy-pi-auth-test',
  },
}));

vi.mock('../auth-adapters.js', () => ({
  readClaudeApiKey: () => h.gatewayKey,
  desktopCodexAuthAdapter: { getState: async () => ({ authenticated: false }) },
}));
vi.mock('../custom-provider-header-secrets.js', () => ({
  listCustomProvidersWithSecureHeaders: async () => [
    {
      id: 'ollama-local',
      name: 'Local Ollama',
      auth: { method: 'none' },
      runtimes: { pi: { baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen' }] } },
    },
    {
      id: 'my-vllm',
      name: 'My vLLM',
      auth: { method: 'apiKey' },
      runtimes: { pi: { baseUrl: 'https://vllm.example/v1', models: [{ id: 'model' }] } },
    },
  ],
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomProviderKey: (id: string) => (id === 'my-vllm' ? 'BYOM-KEY' : null),
}));

import { desktopPiAuthAdapter } from '../pi-host.js';

const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PLACEHOLDER = 'cindy-pi-provider-auth-placeholder';

describe('DesktopPiAuthAdapter.getAuthEnv', () => {
  beforeEach(() => {
    h.gatewayKey = 'REAL-GATEWAY-KEY';
  });

  it('writes the gateway placeholder only for shared cindy OAuth routes', async () => {
    for (const providerId of ['anthropic', 'openai']) {
      const env = await desktopPiAuthAdapter.getAuthEnv({ providerId });
      expect(env[PI_API_KEY_ENV]).toBe(PLACEHOLDER);
    }
  });

  it('preserves the gateway key for xAI sessions and falls back when no gateway exists', async () => {
    expect((await desktopPiAuthAdapter.getAuthEnv({ providerId: 'xai' }))[PI_API_KEY_ENV])
      .toBe('REAL-GATEWAY-KEY');
    h.gatewayKey = null;
    expect((await desktopPiAuthAdapter.getAuthEnv({ providerId: 'xai' }))[PI_API_KEY_ENV])
      .toBe(PLACEHOLDER);
  });

  it('gives BYOM / custom provider ids the real gateway key (no gateway-block poisoning)', async () => {
    for (const providerId of ['my-vllm', 'ollama-local', 'some_custom']) {
      const env = await desktopPiAuthAdapter.getAuthEnv({ providerId });
      expect(env[PI_API_KEY_ENV]).toBe('REAL-GATEWAY-KEY');
    }
  });

  it('gives the gateway key when no providerId / xd', async () => {
    expect((await desktopPiAuthAdapter.getAuthEnv())[PI_API_KEY_ENV]).toBe('REAL-GATEWAY-KEY');
    expect((await desktopPiAuthAdapter.getAuthEnv({ providerId: 'xd' }))[PI_API_KEY_ENV]).toBe('REAL-GATEWAY-KEY');
  });

  it('authenticates keyless and keyed native providers independently of Cindy auth', async () => {
    expect(await desktopPiAuthAdapter.getState({ providerId: 'ollama-local' })).toMatchObject({
      authenticated: true,
      identity: 'Local Ollama',
    });
    expect(await desktopPiAuthAdapter.getState({ providerId: 'my-vllm' })).toMatchObject({
      authenticated: true,
      identity: 'My vLLM',
    });
  });
});
