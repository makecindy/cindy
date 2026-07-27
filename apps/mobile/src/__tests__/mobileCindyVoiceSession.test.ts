import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({
  default: {
    nativeAppVersion: '1.2.3',
    expoConfig: { version: '1.2.3' },
  },
}));
vi.mock('@/config/env', () => ({
  AUTH_REGION: 'global',
  VOICE_API_BASE_URL: 'https://voice.example.com/',
}));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async () => null),
  setSecureItem: vi.fn(async () => undefined),
  deleteSecureItem: vi.fn(async () => undefined),
}));

import { ApiError } from '@/api/client';
import { i18n } from '@/i18n';
import {
  CINDY_MANAGED_REFINER_PROVIDER,
  createMobileCindyVoiceCredential,
  MobileCindyVoiceRunContext,
} from '@/session/mobileCindyVoiceSession';
import {
  resolveMobileVoiceAsrLanguage,
  resolveMobileVoiceRefinementSourceLanguage,
} from '@/session/mobileVoiceLanguage';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function sessionResponse(overrides: Partial<{
  sessionId: string;
  ticket: string;
  provider: string;
}> = {}) {
  const provider = overrides.provider ?? 'qwen-asr-flash-realtime';
  return {
    sessionId: overrides.sessionId ?? 'session-1',
    ticket: overrides.ticket ?? 'ticket-1',
    expiresAt: '2026-07-21T14:00:00.000Z',
    asr: {
      provider,
      websocketUrl: `wss://voice.example.com/api/voice/asr?ticket=${overrides.ticket ?? 'ticket-1'}`,
      protocolProfile: 'qwen-asr-server-vad',
      sampleRate: 16_000,
    },
  };
}

function makeContext(apiFetch: unknown, refinerProvider: string | undefined = CINDY_MANAGED_REFINER_PROVIDER) {
  return new MobileCindyVoiceRunContext(
    vi.fn(async () => 'access-token'),
    vi.fn(async () => 'fresh-access-token'),
    apiFetch as ConstructorParameters<typeof MobileCindyVoiceRunContext>[2],
    'zh-CN',
    refinerProvider,
  );
}

describe('MobileCindyVoiceRunContext', () => {
  it('creates managed ASR sessions through the authenticated API wrapper with the auto refiner marker', async () => {
    const apiFetch = vi.fn(async () => sessionResponse());
    const context = makeContext(apiFetch);

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).resolves.toEqual({
      websocketUrl: 'wss://voice.example.com/api/voice/asr?ticket=ticket-1',
      authorizationToken: 'ticket-1',
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/voice/sessions', {
      baseUrl: 'https://voice.example.com',
      method: 'POST',
      body: {
        mode: 'dictation',
        language: 'zh-CN',
        client: 'mobile',
        clientVersion: '1.2.3',
        asrProvider: 'qwen-asr-flash-realtime',
        refinerProvider: 'auto',
      },
      timeoutMs: 10_000,
    });
  });

  it('keeps ASR auto-detection separate from the concrete refinement language', async () => {
    const apiFetch = vi.fn(async (
      _path: string,
      _options: { body?: { language?: string } },
    ) => sessionResponse());
    const context = new MobileCindyVoiceRunContext(
      vi.fn(async () => 'access-token'),
      vi.fn(async () => 'fresh-access-token'),
      apiFetch as ConstructorParameters<typeof MobileCindyVoiceRunContext>[2],
      'auto',
      CINDY_MANAGED_REFINER_PROVIDER,
    );

    await context.createAsrConnection('qwen-asr-flash-realtime');

    expect(apiFetch.mock.calls[0][1].body?.language)
      .toBeUndefined();
    expect(resolveMobileVoiceAsrLanguage(' auto ')).toBeUndefined();
    expect(resolveMobileVoiceRefinementSourceLanguage('auto', 'ja')).toBe('ja');
    expect(resolveMobileVoiceRefinementSourceLanguage('ko', 'en')).toBe('ko');
  });

  it('retries once without the auto marker when a legacy voice-server rejects with 400, then fails refine fast', async () => {
    const apiFetch = vi.fn(async (_path: string, options: { body?: { refinerProvider?: string } }) => {
      if (options.body?.refinerProvider === 'auto') {
        throw new ApiError('INVALID_PARAMS', 400, 'unknown refinerProvider');
      }
      return sessionResponse();
    });
    const context = makeContext(apiFetch);

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).resolves.toMatchObject({
      authorizationToken: 'ticket-1',
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect((apiFetch.mock.calls[1][1] as { body: { refinerProvider?: string } }).body.refinerProvider)
      .toBeUndefined();

    // 降级置位后:refine 目标与 warmup 都快速失败,不再打到服务端。
    await expect(context.createRefinerTarget('auto')).rejects.toThrow('暂不支持托管润色');
    await expect(context.warmRefiner({
      system: 'sys',
      user: {},
      promptCacheKey: 'xdt:dictation_refinement:abc',
    })).rejects.toThrow('暂不支持托管润色');

    // 后续会话分配不再携带 refinerProvider。
    await context.createAsrConnection('qwen-asr-flash-realtime');
    expect((apiFetch.mock.calls[2][1] as { body: { refinerProvider?: string } }).body.refinerProvider)
      .toBeUndefined();
  });

  it('does not downgrade on a 400 whose code is not INVALID_PARAMS', async () => {
    // 只有参数校验类 400(旧服务端拒绝 'auto' 的实际错误码)才触发降级重试;
    // 其它形态的 400 原样抛出,不额外发起无润色重试。
    const apiFetch = vi.fn().mockRejectedValueOnce(new ApiError('RATE_LIMITED_DAILY', 400, 'quota shaped 400'));
    const context = makeContext(apiFetch);

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).rejects.toThrow('quota shaped 400');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('does not mark the server degraded when the no-refiner retry fails too', async () => {
    const apiFetch = vi.fn()
      .mockRejectedValueOnce(new ApiError('INVALID_PARAMS', 400, 'bad asr candidate'))
      .mockRejectedValueOnce(new ApiError('INVALID_PARAMS', 400, 'bad asr candidate'))
      .mockResolvedValueOnce(sessionResponse({ provider: 'volcengine-sauc-asr' }));
    const context = makeContext(apiFetch);

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).rejects.toThrow('bad asr candidate');
    // 同一 run context 上的下一个 ASR 候选仍要尝试托管润色('auto' 继续携带)。
    await context.createAsrConnection('volcengine-sauc-asr');
    expect((apiFetch.mock.calls[2][1] as { body: { refinerProvider?: string } }).body.refinerProvider)
      .toBe('auto');
  });

  it('does not retry non-400 session failures', async () => {
    const apiFetch = vi.fn(async () => {
      throw new ApiError('INTERNAL', 500, 'boom');
    });
    const context = makeContext(apiFetch);

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).rejects.toThrow('boom');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('posts the warmup request to the session refine-warmup endpoint', async () => {
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/api/voice/sessions') return sessionResponse();
      return {};
    });
    const context = makeContext(apiFetch);
    await context.createAsrConnection('qwen-asr-flash-realtime');

    await context.warmRefiner({
      system: 'system prompt',
      user: { schemaName: 'dictation_refinement', input: { promptVersion: 'v9', context: {}, dictationText: '' } },
      promptCacheKey: 'xdt:dictation_refinement:abc',
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/voice/sessions/session-1/refine-warmup', {
      baseUrl: 'https://voice.example.com',
      method: 'POST',
      body: {
        prompt_cache_key: 'xdt:dictation_refinement:abc',
        messages: [
          { role: 'system', content: 'system prompt' },
          {
            role: 'user',
            content: JSON.stringify({
              schemaName: 'dictation_refinement',
              input: { promptVersion: 'v9', context: {}, dictationText: '' },
            }),
          },
        ],
      },
      timeoutMs: 10_000,
    });
  });

  it('requires a connected ASR session before warmup or refine targets', async () => {
    const context = makeContext(vi.fn());

    await expect(context.warmRefiner({
      system: 'sys',
      user: {},
      promptCacheKey: 'key',
    })).rejects.toThrow('语音识别会话尚未连接');
    await expect(context.createRefinerTarget('auto')).rejects.toThrow('语音识别会话尚未连接');
  });
});

describe('createMobileCindyVoiceCredential', () => {
  it('builds a managed provider graph with the auto refiner and no real key', () => {
    const credential = createMobileCindyVoiceCredential('device-1');

    expect(credential.hostDeviceId).toBe('device-1');
    expect(credential.proxyBaseUrl).toBe('https://voice.example.com');
    // 占位串:托管路径不落任何真实推理 key。
    expect(credential.proxyApiKey).toBe('cindy-voice-session-ticket');
    expect(credential.refiner).toMatchObject({
      provider: 'auto',
      model: 'auto',
      transport: 'litellm-chat-completions',
    });
    expect(credential.refinerProviderChain).toHaveLength(1);
    expect(credential.asrProviderChain?.map((item) => item.provider)).toEqual([
      'litellm-volcengine-sauc-asr',
      'litellm-qwen3-asr-flash-realtime',
      'litellm-gpt-realtime-whisper',
    ]);
    expect(credential.asrProviderChain?.every((item) => item.pcmSampleRate === 16_000)).toBe(true);
    expect(credential.settings).toEqual({
      language: 'auto',
      refinementEnabled: true,
      playInteractionSound: true,
    });
  });

  it.each([
    ['cn', 'zh-CN'],
    ['global', 'auto'],
    ['dev', 'auto'],
  ] as const)('uses the %s build voice language default', (region, language) => {
    expect(createMobileCindyVoiceCredential('device-1', region).settings?.language).toBe(language);
  });

  it('rejects an empty host device id', () => {
    expect(() => createMobileCindyVoiceCredential('  ')).toThrow('host device id is required');
  });
});
