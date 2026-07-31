import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    getAppPath: vi.fn(() => '/tmp/xdt-maker-test/app'),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
  },
}));

vi.mock('../UtilityModelSelection.js', () => ({
  getUtilityModelChainProfiles: vi.fn(),
}));

vi.mock('../../maker-host/auth-adapters.js', () => ({
  readClaudeApiKey: vi.fn(),
}));

vi.mock('../../maker-host/anthropic-responses-bridge-host.js', () => ({
  getChatgptBridgeAuth: vi.fn(),
}));

vi.mock('../../maker-host/claude-oauth-refresh.js', () => ({
  getValidClaudeAiOAuth: vi.fn(),
}));

vi.mock('../../maker-host/grok-oauth-login.js', () => ({
  getGrokAccessToken: vi.fn(),
}));

vi.mock('../../maker-host/generic-oauth.js', () => ({
  readCachedGenericOAuthAccessToken: vi.fn(),
}));

vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: vi.fn(() => ({ providers: [] })),
}));

vi.mock('../../maker-host/provider-route.js', () => ({
  isProviderRouteMutationInProgress: vi.fn(() => false),
}));

vi.mock('../../maker-host/model-disable-store.js', () => ({
  readModelDisableOverrides: vi.fn(() => ({ disabledModels: {}, disabledProviders: {} })),
}));

vi.mock('../../secrets/providerSecretStore.js', () => ({
  readCustomProviderKey: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

// SUT 链(maker-host/runtime-configs → effectiveXdGatewayBaseUrl)运行期读
// model-access 下发的 endpoint;mock 成 fixture 值。
vi.mock('../../model-access/effectiveEndpoint.js', async () => {
  const { TEST_XD_GATEWAY_BASE_URL } = await import('../../../test/vitest/clientEndpointsFixture');
  return { effectiveXdGatewayBaseUrl: () => TEST_XD_GATEWAY_BASE_URL };
});

import type { Maker } from '@cindy/maker-core';
import { fetch as undiciFetch } from 'undici';

import { readClaudeApiKey } from '../../maker-host/auth-adapters.js';
import { getChatgptBridgeAuth } from '../../maker-host/anthropic-responses-bridge-host.js';
import { getValidClaudeAiOAuth } from '../../maker-host/claude-oauth-refresh.js';
import { getGrokAccessToken } from '../../maker-host/grok-oauth-login.js';
import { readCachedGenericOAuthAccessToken } from '../../maker-host/generic-oauth.js';
import { getActiveCatalog } from '../../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../../maker-host/model-disable-store.js';
import { isProviderRouteMutationInProgress } from '../../maker-host/provider-route.js';
import { readCustomProviderKey } from '../../secrets/providerSecretStore.js';
import { getUtilityModelChainProfiles } from '../UtilityModelSelection.js';
import { getUtilityTextCandidates, requestUtilityText } from '../oneShotCandidates.js';

const getProfiles = vi.mocked(getUtilityModelChainProfiles);
const readKey = vi.mocked(readClaudeApiKey);
const readCodexCreds = vi.mocked(getChatgptBridgeAuth);
const readClaudeOAuth = vi.mocked(getValidClaudeAiOAuth);
const readGrokToken = vi.mocked(getGrokAccessToken);
const readGenericOAuthToken = vi.mocked(readCachedGenericOAuthAccessToken);
const fetchMock = vi.mocked(undiciFetch);
const activeCatalog = vi.mocked(getActiveCatalog);
const readDisableOverrides = vi.mocked(readModelDisableOverrides);
const providerRouteMutationInProgress = vi.mocked(isProviderRouteMutationInProgress);
const readCustomKey = vi.mocked(readCustomProviderKey);

function makerMock(authenticated: boolean): Maker {
  return {
    listAvailableAgents: () => ['codex'],
    getAgentAuthState: vi.fn(async () => authenticated ? { authenticated: true } : { authenticated: false, errorReason: 'no_key' }),
    oneShot: vi.fn(async () => 'codex text'),
  } as unknown as Maker;
}

describe('utility one-shot candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readKey.mockReturnValue(null);
    readCodexCreds.mockRejectedValue(new Error('not authenticated'));
    readClaudeOAuth.mockResolvedValue(null);
    readGrokToken.mockRejectedValue(new Error('not authenticated'));
    readGenericOAuthToken.mockReturnValue(null);
    providerRouteMutationInProgress.mockReturnValue(false);
    readCustomKey.mockReturnValue(null);
    readDisableOverrides.mockReturnValue({ disabledModels: {}, disabledProviders: {} });
    activeCatalog.mockReturnValue({ providers: [] } as never);
    getProfiles.mockReturnValue([
      {
        id: 'codex-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        transport: 'codex-responses',
        auth: 'codex',
        settingsTab: 'connections',
        missingCredentialMessage: 'codex missing',
      },
      {
        id: 'litellm-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        transport: 'litellm-chat-completions',
        auth: 'api-key',
        settingsTab: 'api-keys',
        missingCredentialMessage: 'api key missing',
      },
    ]);
  });

  it('skips unauthenticated codex and keeps configured LiteLLM when API key exists', async () => {
    readKey.mockReturnValue('proxy-key');

    const candidates = await getUtilityTextCandidates(makerMock(false));

    expect(candidates.map((candidate) => candidate.providerId)).toEqual(['litellm-gpt-5.4-mini']);
  });

  it('returns credential-safe diagnostics when every configured candidate is unavailable', async () => {
    const result = await requestUtilityText(makerMock(false), 'hello');

    expect(result).toEqual({
      ok: false,
      reason: 'no_candidate',
      attempts: [
        expect.objectContaining({ providerId: 'codex-gpt-5.4-mini', reason: 'not_authenticated' }),
        expect.objectContaining({ providerId: 'litellm-gpt-5.4-mini', reason: 'api_key_missing' }),
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls through failed codex execution and succeeds on LiteLLM', async () => {
    readKey.mockReturnValue('proxy-key');
    const maker = makerMock(true);
    vi.mocked(maker.oneShot).mockRejectedValueOnce(new Error('codex down'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'lite text' } }] }),
    } as never);

    const result = await requestUtilityText(maker, 'hello', {
      maxTokens: 10,
      reasoningEffort: 'low',
    });

    expect(result).toMatchObject({
      ok: true,
      text: 'lite text',
      providerId: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      transport: 'litellm-chat-completions',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      max_tokens: 10,
      reasoning_effort: 'low',
    });
  });

  it('pinnedProfileId 钉住某一档时只用它,绕开默认链', async () => {
    // 默认链(mock)是 codex-mini + litellm-mini;钉 deepseek 应当完全绕开它们,
    // 只解析出 deepseek 这一个候选(取自真实档位表,不受链 mock 影响)。
    readKey.mockReturnValue('proxy-key');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pinned text' } }] }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'hello', {
      maxTokens: 10,
      pinnedProfileId: 'litellm-deepseek-v4-flash',
    });

    expect(result).toMatchObject({
      ok: true,
      text: 'pinned text',
      providerId: 'litellm-deepseek-v4-flash',
      model: 'deepseek/deepseek-v4-flash',
    });
    // 钉住后链上的 mini 一次都不该被下单
    expect(JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'deepseek/deepseek-v4-flash',
    });
  });

  it('不认的 pinnedProfileId 忽略,回落默认链', async () => {
    readKey.mockReturnValue('proxy-key');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'chain text' } }] }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'hello', {
      maxTokens: 10,
      pinnedProfileId: 'no-such-profile',
    });

    // 回落到链上第一个可用候选(codex 无凭证被跳过 → litellm-mini)
    expect(result).toMatchObject({
      ok: true,
      providerId: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
    });
  });

  it('preserves failed candidate and HTTP status diagnostics without response bodies', async () => {
    readKey.mockReturnValue('proxy-key');
    const maker = makerMock(true);
    vi.mocked(maker.oneShot).mockRejectedValueOnce(new Error('upstream included sensitive details'));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      body: { cancel: vi.fn(async () => undefined) },
    } as never);

    const result = await requestUtilityText(maker, 'hello');

    expect(result).toMatchObject({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [
        expect.objectContaining({ providerId: 'codex-gpt-5.4-mini', reason: 'request_failed' }),
        expect.objectContaining({ providerId: 'litellm-gpt-5.4-mini', reason: 'http_error', httpStatus: 403 }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('sensitive details');
  });

  it('distinguishes an empty response from generic request failures', async () => {
    getProfiles.mockReturnValue([{
      id: 'codex-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      transport: 'codex-responses',
      auth: 'codex',
      settingsTab: 'providers',
      missingCredentialMessage: 'codex missing',
    }]);
    const maker = makerMock(true);
    vi.mocked(maker.oneShot).mockResolvedValueOnce('   ');

    const result = await requestUtilityText(maker, 'hello');

    expect(result).toMatchObject({
      ok: false,
      reason: 'empty_response',
      attempts: [expect.objectContaining({ reason: 'empty_response' })],
    });
  });

  it('distinguishes a timeout when every executable candidate times out', async () => {
    const maker = makerMock(true);
    vi.mocked(maker.oneShot).mockRejectedValueOnce(new Error('request timed out'));

    const result = await requestUtilityText(maker, 'hello');

    expect(result).toMatchObject({
      ok: false,
      reason: 'timeout',
      attempts: [
        expect.objectContaining({ providerId: 'litellm-gpt-5.4-mini', status: 'skipped' }),
        expect.objectContaining({ providerId: 'codex-gpt-5.4-mini', reason: 'timeout' }),
      ],
    });
  });

  it('routes an explicitly selected custom provider to its own Codex endpoint', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'tapsvc',
        name: 'Tap Service',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {
          codex: {
            upstream: 'https://custom.example/v1',
            authStrategy: 'api-key-header',
            headerOverride: { 'X-Tenant': 'tenant-a' },
          },
        },
        models: {
          codex: [{ id: 'custom-mini', name: 'Custom Mini', contextWindow: 100_000 }],
        },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'data: {"type":"response.output_text.delta","delta":"```js\\nprocess.exit(0)\\n```"}\ndata: [DONE]\n',
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'tapsvc',
      agentKind: 'codex',
      model: 'custom-mini',
      maxTokens: 100,
    });

    expect(result).toMatchObject({
      ok: true,
      providerId: 'tapsvc',
      model: 'custom-mini',
      transport: 'codex-responses',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom.example/v1/responses',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer custom-secret',
          'X-Tenant': 'tenant-a',
        }),
      }),
    );
    expect(JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'custom-mini',
    });
  });

  it('does not read or send a custom-provider key while its route is mutating', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'tapsvc',
        name: 'Tap Service',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {
          codex: {
            upstream: 'https://old.example/v1',
            authStrategy: 'api-key-header',
          },
        },
        models: {
          codex: [{ id: 'custom-mini', name: 'Custom Mini', contextWindow: 100_000 }],
        },
      }],
    } as never);
    providerRouteMutationInProgress.mockReturnValue(true);
    readCustomKey.mockReturnValue('replacement-secret');

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'tapsvc',
      agentKind: 'codex',
      model: 'custom-mini',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [expect.objectContaining({
        providerId: 'tapsvc',
        status: 'failed',
        reason: 'request_failed',
      })],
    });
    expect(readCustomKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses Chat Completions for an explicitly selected openai-chat provider', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'chat-only',
        name: 'Chat Only',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {
          codex: {
            upstream: 'https://chat.example/v1',
            wireProtocol: 'openai-chat',
            authStrategy: 'api-key-header',
          },
        },
        models: {
          codex: [{ id: 'chat-model', name: 'Chat Model', contextWindow: 100_000 }],
        },
      }],
    } as never);
    readCustomKey.mockReturnValue('chat-secret');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'chat result' } }],
      }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'chat-only',
      agentKind: 'codex',
      model: 'chat-model',
      reasoningEffort: 'low',
    });

    expect(result).toMatchObject({
      ok: true,
      text: 'chat result',
      transport: 'litellm-chat-completions',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chat.example/v1/chat/completions',
      expect.anything(),
    );
    expect(JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'chat-model',
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'generate' }],
    });
  });

  it.each([
    {
      wireProtocol: 'openai-chat' as const,
      endpoint: 'https://custom.example/v1/chat/completions',
      reasoningField: 'reasoning_effort',
      maxTokensField: 'max_tokens',
      successBody: JSON.stringify({ choices: [{ message: { content: 'chat result' } }] }),
    },
    {
      wireProtocol: 'openai-responses' as const,
      endpoint: 'https://custom.example/v1/responses',
      reasoningField: 'reasoning',
      maxTokensField: 'max_output_tokens',
      successBody: 'data: {"type":"response.output_text.delta","delta":"response result"}\ndata: [DONE]\n',
    },
  ])(
    'retries a custom $wireProtocol route with a minimal body after an invalid-parameter response',
    async ({ wireProtocol, endpoint, reasoningField, maxTokensField, successBody }) => {
      activeCatalog.mockReturnValue({
        providers: [{
          id: 'custom-reasoning-unknown',
          name: 'Custom Reasoning Unknown',
          source: 'user',
          agents: ['codex'],
          auth: { method: 'apiKey' },
          routing: {
            codex: {
              upstream: 'https://custom.example/v1',
              wireProtocol,
              authStrategy: 'api-key-header',
            },
          },
          models: {
            codex: [{ id: 'custom-model', name: 'Custom Model', contextWindow: 100_000 }],
          },
        }],
      } as never);
      readCustomKey.mockReturnValue('custom-secret');
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          body: { cancel: vi.fn(async () => undefined) },
        } as never)
        .mockResolvedValueOnce({
          ok: true,
          text: async () => successBody,
        } as never);

      const result = await requestUtilityText(makerMock(false), 'generate', {
        providerId: 'custom-reasoning-unknown',
        agentKind: 'codex',
        model: 'custom-model',
        maxTokens: 384,
        reasoningEffort: 'low',
      });

      expect(result).toMatchObject({ ok: true, providerId: 'custom-reasoning-unknown' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(1, endpoint, expect.anything());
      expect(fetchMock).toHaveBeenNthCalledWith(2, endpoint, expect.anything());
      const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
      const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
      expect(firstBody).toHaveProperty(reasoningField);
      expect(firstBody).toHaveProperty(maxTokensField, 384);
      expect(retryBody).not.toHaveProperty(reasoningField);
      expect(retryBody).not.toHaveProperty(maxTokensField);
      if (wireProtocol === 'openai-responses') {
        expect(retryBody).toEqual({
          model: 'custom-model',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'generate' }] }],
        });
      } else {
        expect(retryBody).toEqual({
          model: 'custom-model',
          messages: [{ role: 'user', content: 'generate' }],
        });
      }
    },
  );

  it('uses an explicitly configured custom-provider request path', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'exact-path',
        name: 'Exact Path',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'none' },
        routing: {
          codex: {
            upstream: 'http://127.0.0.1:4000',
            requestPath: '/tenant/acme/infer?stream=1',
            authStrategy: 'none',
          },
        },
        models: {
          codex: [{ id: 'local-model', name: 'Local Model', contextWindow: 100_000 }],
        },
      }],
    } as never);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'data: {"type":"response.output_text.delta","delta":"ok"}\ndata: [DONE]\n',
    } as never);
    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'exact-path',
      agentKind: 'codex',
      model: 'local-model',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'exact-path' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/tenant/acme/infer?stream=1',
      expect.objectContaining({
        headers: expect.not.objectContaining({
          Authorization: expect.anything(),
          'x-api-key': expect.anything(),
        }),
      }),
    );
  });

  it('fails closed when an explicitly selected no-auth runtime is disabled', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'legacy-remote',
        name: 'Legacy Remote',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'none' },
        routing: {
          codex: {
            upstream: 'https://remote.example/v1',
            authStrategy: 'none',
            disabled: true,
          },
        },
        models: {
          codex: [{ id: 'legacy-model', name: 'Legacy Model', contextWindow: 100_000 }],
        },
      }],
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'legacy-remote',
      agentKind: 'codex',
      model: 'legacy-model',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'no_candidate',
      attempts: [{
        providerId: 'legacy-remote',
        model: 'legacy-model',
        status: 'skipped',
        reason: 'endpoint_missing',
      }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('R22:显式候选执行前按真实来源重查停用,不做 transport 推断', async () => {
    // 显式自定义 codex 供应商 → transport codex-responses。旧的 transport 推断会把
    // 重查错映射到 'openai' 的 override 上;真实来源 'my-custom' 在凭证等待期被停用
    // 时照旧下单。新逻辑按 (candidate.providerId, candidate.model) 重查 → 跳过。
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'my-custom',
        name: 'My Custom',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'none' },
        routing: {
          codex: {
            upstream: 'https://custom.example/v1',
            authStrategy: 'none',
          },
        },
        models: {
          codex: [{ id: 'local-model', name: 'Local Model', contextWindow: 100_000 }],
        },
      }],
    } as never);
    // 第一次读 = 入口裁决(未停用,放行);随后的读 = executeCandidates 派发前重查
    // (此刻 'my-custom' 已被供应商级停用)。
    readDisableOverrides
      .mockReturnValueOnce({ disabledModels: {}, disabledProviders: {} })
      .mockReturnValue({ disabledModels: {}, disabledProviders: { 'my-custom': true } });

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'my-custom',
      agentKind: 'codex',
      model: 'local-model',
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: [{
        providerId: 'my-custom',
        model: 'local-model',
        status: 'skipped',
        reason: 'model_unavailable',
      }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects base URL userinfo when applying an exact provider request path', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'exact-path-query',
        name: 'Exact Path Query',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'none' },
        routing: {
          codex: {
            upstream: 'https://user:pass@custom.example/api?tenant=alpha',
            requestPath: '/infer?stream=1&mode=fast',
            authStrategy: 'none',
          },
        },
        models: {
          codex: [{ id: 'local-model', name: 'Local Model', contextWindow: 100_000 }],
        },
      }],
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'exact-path-query',
      agentKind: 'codex',
      model: 'local-model',
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: [expect.objectContaining({ providerId: 'exact-path-query', reason: 'request_failed' })],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a legacy header-only custom-provider credential when safeStorage is empty', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'legacy-header',
        name: 'Legacy Header',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {
          codex: {
            upstream: 'https://custom.example/v1',
            authStrategy: 'api-key-header',
            headerOverride: {
              Authorization: 'Bearer legacy-secret',
              'X-Tenant': 'tenant-a',
            },
          },
        },
        models: {
          codex: [{ id: 'legacy-mini', name: 'Legacy Mini', contextWindow: 100_000 }],
        },
      }],
    } as never);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        'data: {"type":"response.output_text.delta","delta":"ok"}\ndata: [DONE]\n',
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'legacy-header',
      agentKind: 'codex',
      model: 'legacy-mini',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'legacy-header' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom.example/v1/responses',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer legacy-secret',
          'X-Tenant': 'tenant-a',
        }),
      }),
    );
  });

  it('does not fall back to XD after an explicitly selected custom provider returns 401', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'tapsvc',
        name: 'Tap Service',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: { codex: { upstream: 'https://custom.example/v1', authStrategy: 'api-key-header' } },
        models: { codex: [{ id: 'custom-mini', name: 'Custom Mini', contextWindow: 100_000 }] },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      body: { cancel: vi.fn(async () => undefined) },
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'tapsvc',
      agentKind: 'codex',
      model: 'custom-mini',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [expect.objectContaining({ providerId: 'tapsvc', reason: 'http_error', httpStatus: 401 })],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the required Anthropic version header for a custom Claude provider', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'claude-connect',
        name: 'Claude Connect',
        source: 'user',
        agents: ['claude-code'],
        auth: { method: 'apiKey' },
        routing: {
          'claude-code': {
            upstream: 'https://custom.example/api',
            authStrategy: 'api-key-header',
            headerOverride: {
              authorization: 'Bearer stale-lowercase',
              Authorization: 'Bearer stale-uppercase',
              'X-API-Key': 'stale-key',
              'x-tenant': 'tenant-a',
            },
          },
        },
        models: {
          'claude-code': [{ id: 'claude-connect-4-6', name: 'Claude Connect 4.6', contextWindow: 200_000 }],
        },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'script' }] }),
    } as never);

    await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'claude-connect',
      agentKind: 'claude-code',
      model: 'claude-connect-4-6',
    });

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['x-api-key']).toBe('custom-secret');
    expect(init.headers.Authorization).toBe('Bearer custom-secret');
    expect(init.headers.authorization).toBeUndefined();
    expect(init.headers['X-API-Key']).toBeUndefined();
    expect(init.headers['x-tenant']).toBe('tenant-a');
  });

  it('uses a generic OAuth token for a custom Claude provider without sending x-api-key', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'claude-oauth',
        name: 'Claude OAuth',
        source: 'user',
        agents: ['claude-code'],
        auth: {
          method: 'oauth',
          oauth: {
            authorizeUrl: 'https://auth.example/authorize',
            tokenUrl: 'https://auth.example/token',
            clientId: 'client',
            scopes: 'openid',
          },
        },
        routing: {
          'claude-code': {
            upstream: 'https://custom.example/api',
            authStrategy: 'oauth-token',
            headerOverride: {
              'x-api-key': 'stale-key',
              authorization: 'Bearer stale-lowercase',
              Authorization: 'Bearer stale-uppercase',
              'X-Tenant': 'tenant-a',
            },
          },
        },
        models: {
          'claude-code': [{ id: 'claude-oauth-4-6', name: 'Claude OAuth 4.6', contextWindow: 200_000 }],
        },
      }],
    } as never);
    readGenericOAuthToken.mockReturnValue('oauth-access-token');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'script' }] }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'claude-oauth',
      agentKind: 'claude-code',
      model: 'claude-oauth-4-6',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'claude-oauth' });
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer oauth-access-token');
    expect(init.headers.authorization).toBeUndefined();
    expect(init.headers['x-api-key']).toBeUndefined();
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['X-Tenant']).toBe('tenant-a');
  });

  it('uses a generic OAuth token for a custom Codex provider', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'codex-oauth',
        name: 'Codex OAuth',
        source: 'user',
        agents: ['codex'],
        auth: {
          method: 'oauth',
          oauth: {
            authorizeUrl: 'https://auth.example/authorize',
            tokenUrl: 'https://auth.example/token',
            clientId: 'client',
            scopes: 'openid',
          },
        },
        routing: {
          codex: {
            upstream: 'https://custom.example/v1',
            authStrategy: 'oauth-token',
            headerOverride: { authorization: 'Bearer stale-codex' },
          },
        },
        models: {
          codex: [{ id: 'codex-oauth-5-5', name: 'Codex OAuth 5.5', contextWindow: 100_000 }],
        },
      }],
    } as never);
    readGenericOAuthToken.mockReturnValue('oauth-access-token');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'data: {"type":"response.output_text.delta","delta":"script"}\ndata: [DONE]\n',
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'codex-oauth',
      agentKind: 'codex',
      model: 'codex-oauth-5-5',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'codex-oauth' });
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer oauth-access-token');
    expect(init.headers.authorization).toBeUndefined();
    expect(init.headers['anthropic-version']).toBeUndefined();
  });

  it('routes a descriptor-backed no-auth builtin through the generic utility transport', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'catalog-local',
        name: 'Catalog Local',
        source: 'builtin',
        agents: ['codex'],
        auth: { method: 'none' },
        routing: {
          codex: {
            upstream: 'http://127.0.0.1:4000/v1',
            wireProtocol: 'openai-chat',
            authStrategy: 'none',
          },
        },
        models: {
          codex: [{ id: 'catalog-model', name: 'Catalog Model', contextWindow: 100_000 }],
        },
      }],
    } as never);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'catalog result' } }],
      }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'catalog-local',
      agentKind: 'codex',
      model: 'catalog-model',
    });

    expect(result).toMatchObject({
      ok: true,
      text: 'catalog result',
      providerId: 'catalog-local',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/v1/chat/completions',
      expect.anything(),
    );
    expect(readCustomKey).not.toHaveBeenCalled();
  });

  it('can infer a unique custom provider when an older caller omits providerId', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'tapsvc',
        name: 'Tap Service',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: { codex: { upstream: 'https://custom.example/v1', authStrategy: 'api-key-header' } },
        models: { codex: [{ id: 'unique-mini', name: 'Unique Mini', contextWindow: 100_000 }] },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'data: {"type":"response.output_text.delta","delta":"ok"}\ndata: [DONE]\n',
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      agentKind: 'codex',
      model: 'unique-mini',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'tapsvc', model: 'unique-mini' });
    expect(fetchMock).toHaveBeenCalledWith('https://custom.example/v1/responses', expect.anything());
  });

  it('does not enter the XD fallback chain when an explicit selection has no provider', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'tapsvc',
        name: 'Tap Service',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: { codex: { upstream: 'https://custom.example/v1', authStrategy: 'api-key-header' } },
        models: { codex: [{ id: 'custom-mini', name: 'Custom Mini', contextWindow: 100_000 }] },
      }],
    } as never);

    const result = await requestUtilityText(makerMock(true), 'generate', {
      agentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
    });

    expect(result).toEqual({ ok: false, reason: 'no_candidate', attempts: [] });
    expect(getProfiles).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not borrow another runtime title model when the selected Claude provider has no Claude model', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'tapsvc',
        name: 'Tap Service',
        source: 'user',
        titleModel: 'codex/gpt-5.5',
        agents: ['claude-code', 'codex'],
        auth: { method: 'apiKey' },
        routing: {
          'claude-code': { upstream: 'https://custom.example/anthropic', authStrategy: 'api-key-header' },
          codex: { upstream: 'https://custom.example/v1', authStrategy: 'api-key-header' },
        },
        models: {
          'claude-code': [],
          codex: [{ id: 'codex/gpt-5.5', name: 'Codex GPT 5.5', contextWindow: 100_000 }],
        },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'tapsvc',
      agentKind: 'claude-code',
      model: 'claude-connect-4-6',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'no_candidate',
      attempts: [{
        providerId: 'tapsvc',
        model: 'claude-connect-4-6',
        transport: 'litellm-chat-completions',
        status: 'skipped',
        reason: 'model_unavailable',
      }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not duplicate /v1 when a custom Claude endpoint already includes it', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'claude-connect',
        name: 'Claude Connect',
        source: 'user',
        agents: ['claude-code'],
        auth: { method: 'apiKey' },
        routing: {
          'claude-code': {
            upstream: 'https://custom.example/api/v1',
            authStrategy: 'api-key-header',
          },
        },
        models: {
          'claude-code': [{ id: 'claude-connect-4-6', name: 'Claude Connect 4.6', contextWindow: 200_000 }],
        },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'script' }] }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'claude-connect',
      agentKind: 'claude-code',
      model: 'claude-connect-4-6',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'claude-connect', model: 'claude-connect-4-6' });
    expect(fetchMock).toHaveBeenCalledWith('https://custom.example/api/v1/messages', expect.anything());
  });

  it('keeps query parameters after the Claude Messages path', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'claude-query',
        name: 'Claude Query',
        source: 'user',
        agents: ['claude-code'],
        auth: { method: 'apiKey' },
        routing: {
          'claude-code': {
            upstream: 'https://custom.example/api/v1?tenant=alpha&mode=fast',
            authStrategy: 'api-key-header',
          },
        },
        models: {
          'claude-code': [{ id: 'claude-query-4-6', name: 'Claude Query 4.6', contextWindow: 200_000 }],
        },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'script' }] }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'claude-query',
      agentKind: 'claude-code',
      model: 'claude-query-4-6',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'claude-query', model: 'claude-query-4-6' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom.example/api/v1/messages?tenant=alpha&mode=fast',
      expect.anything(),
    );
  });

  it('does not duplicate the complete Claude Messages resource path', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'claude-resource',
        name: 'Claude Resource',
        source: 'user',
        agents: ['claude-code'],
        auth: { method: 'apiKey' },
        routing: {
          'claude-code': {
            upstream: 'https://custom.example/api/v1/messages?tenant=alpha',
            authStrategy: 'api-key-header',
          },
        },
        models: {
          'claude-code': [{ id: 'claude-resource-4-6', name: 'Claude Resource 4.6', contextWindow: 200_000 }],
        },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'script' }] }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'claude-resource',
      agentKind: 'claude-code',
      model: 'claude-resource-4-6',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'claude-resource', model: 'claude-resource-4-6' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom.example/api/v1/messages?tenant=alpha',
      expect.anything(),
    );
  });

  it('does not duplicate the complete Codex Responses resource path', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'codex-resource',
        name: 'Codex Resource',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {
          codex: {
            upstream: 'https://custom.example/v1/responses?tenant=alpha',
            authStrategy: 'api-key-header',
          },
        },
        models: {
          codex: [{ id: 'codex-resource-5-5', name: 'Codex Resource 5.5', contextWindow: 100_000 }],
        },
      }],
    } as never);
    readCustomKey.mockReturnValue('custom-secret');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'data: {"type":"response.output_text.delta","delta":"script"}\ndata: [DONE]\n',
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'codex-resource',
      agentKind: 'codex',
      model: 'codex-resource-5-5',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'codex-resource', model: 'codex-resource-5-5' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://custom.example/v1/responses?tenant=alpha',
      expect.anything(),
    );
  });

  it('keeps an explicit XD selection on the selected model instead of entering the fallback chain', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'xd',
        name: 'XD Gateway',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'managed' },
        routing: {
          'claude-code': { upstream: 'https://ignored.invalid', authStrategy: 'gateway-key' },
        },
        models: {
          'claude-code': [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000 }],
        },
      }],
    } as never);
    readKey.mockReturnValue('xd-key');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'script' } }] }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'xd',
      agentKind: 'claude-code',
      model: 'gpt-5.5',
      reasoningEffort: 'low',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'xd', model: 'gpt-5.5' });
    expect(getProfiles).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.test.invalid/v1/chat/completions', expect.anything());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gpt-5.5',
      reasoning_effort: 'low',
    });
  });

  it('uses Anthropic OAuth and the selected Anthropic routing for an explicit builtin provider', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: {
          'claude-code': { upstream: 'https://anthropic.example/api/v1', authStrategy: 'oauth-passthrough' },
        },
        models: {
          'claude-code': [{ id: 'claude-sonnet-4-6', name: 'Sonnet', contextWindow: 1_000_000 }],
        },
      }],
    } as never);
    readClaudeOAuth.mockResolvedValue({ accessToken: 'anthropic-token' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'script' }] }),
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'anthropic',
      agentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(fetchMock).toHaveBeenCalledWith('https://anthropic.example/api/v1/messages', expect.anything());
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string>; body: string };
    expect(init.headers.Authorization).toBe('Bearer anthropic-token');
    expect(JSON.parse(init.body).model).toBe('claude-sonnet-4-6[1m]');
  });

  it('uses OpenAI Codex OAuth and strips the bridge model prefix on the selected route', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'openai',
        name: 'OpenAI',
        source: 'builtin',
        agents: ['codex'],
        auth: { method: 'oauth' },
        routing: { codex: { upstream: 'https://chatgpt.example/api/v1', authStrategy: 'oauth-passthrough' } },
        models: { codex: [{ id: 'chatgpt/gpt-5.5', name: 'GPT-5.5', contextWindow: 272_000 }] },
      }],
    } as never);
    readCodexCreds.mockResolvedValue({ accessToken: 'codex-token', accountId: 'account-1' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'data: {"type":"response.output_text.delta","delta":"script"}\ndata: [DONE]\n',
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'openai',
      agentKind: 'codex',
      model: 'chatgpt/gpt-5.5',
      maxTokens: 384,
      reasoningEffort: 'low',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'openai', model: 'chatgpt/gpt-5.5' });
    expect(readCodexCreds).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.example/api/v1/responses', expect.anything());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-5.5',
      reasoning: { effort: 'low' },
    });
    // ChatGPT Codex returns HTTP 400 for this public Responses API field.
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  it('uses xAI OAuth and the selected xAI Responses route', async () => {
    activeCatalog.mockReturnValue({
      providers: [{
        id: 'xai',
        name: 'xAI',
        source: 'builtin',
        agents: ['codex'],
        auth: { method: 'oauth' },
        routing: { codex: { upstream: 'https://xai.example/v1', authStrategy: 'provider-oauth-header' } },
        models: { codex: [{ id: 'xai/grok-4.3', name: 'Grok', contextWindow: 272_000 }] },
      }],
    } as never);
    readGrokToken.mockResolvedValue('xai-token');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => 'data: {"type":"response.output_text.delta","delta":"script"}\ndata: [DONE]\n',
    } as never);

    const result = await requestUtilityText(makerMock(false), 'generate', {
      providerId: 'xai',
      agentKind: 'codex',
      model: 'xai/grok-4.3',
      reasoningEffort: 'low',
    });

    expect(result).toMatchObject({ ok: true, providerId: 'xai', model: 'xai/grok-4.3' });
    expect(fetchMock).toHaveBeenCalledWith('https://xai.example/v1/responses', expect.anything());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'grok-4.3',
      reasoning: { effort: 'low' },
    });
  });

  it.each(['xai/grok-code-fast', 'xai/grok-build-preview'])(
    'omits reasoning for xAI model %s that rejects the field',
    async (model) => {
      activeCatalog.mockReturnValue({
        providers: [{
          id: 'xai',
          name: 'xAI',
          source: 'builtin',
          agents: ['codex'],
          auth: { method: 'oauth' },
          routing: { codex: { upstream: 'https://xai.example/v1', authStrategy: 'provider-oauth-header' } },
          models: { codex: [{ id: model, name: 'Grok Code', contextWindow: 256_000 }] },
        }],
      } as never);
      readGrokToken.mockResolvedValue('xai-token');
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => 'data: {"type":"response.output_text.delta","delta":"script"}\ndata: [DONE]\n',
      } as never);

      const result = await requestUtilityText(makerMock(false), 'generate', {
        providerId: 'xai',
        agentKind: 'codex',
        model,
        reasoningEffort: 'low',
      });

      expect(result).toMatchObject({ ok: true, providerId: 'xai', model });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty('reasoning');
    },
  );
});
