import { beforeAll, describe, expect, it, vi } from 'vitest';
import { apiFetchRaw } from '@/api/client';
import { DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL, DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { i18n } from '@/i18n';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const GW_PROXY = `${DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL}/proxy`;
import {
  appendVoiceTranscriptDraft,
  appendVoiceTranscriptDraftWithRange,
  buildMobileVoiceRefinementContext,
  canCancelMobileVoiceRecording,
  makeMobileRefinerPromptCacheKey,
  mobileVoiceMicPermissionError,
  mobileVoiceRealtimeAudioUnavailableError,
  MOBILE_MAX_VOICE_AUDIO_BYTES,
  isMobileVoiceMicPermissionError,
  mobileVoiceStateLabel,
  MobileLiteLlmTextModelClient,
  normalizeMobileVoiceTranscriptResult,
  presignMobileVoiceUpload,
  putMobileVoiceUpload,
  replaceVoiceTranscriptDraftRange,
  resolveVoiceRecordingMeta,
  uploadMobileVoiceRecording,
} from '@/session/mobileVoiceInput';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';

function storedCredential(overrides: Partial<StoredMobileVoiceCredential> = {}): StoredMobileVoiceCredential {
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-06-19T00:00:00.000Z',
    proxyBaseUrl: GW_PROXY,
    proxyApiKey: 'sk-mobile-voice',
    hostDeviceId: 'host-a',
    storageVersion: 1,
    syncedAt: '2026-06-19T00:01:00.000Z',
    asr: {
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
      auth: 'api-key',
      mode: 'batch-http',
      endpointPath: '/v1/audio/transcriptions',
    },
    refiner: {
      provider: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    },
    ...overrides,
  };
}

describe('mobileVoiceInput', () => {
  it('appends transcript into composer draft without losing existing text', () => {
    expect(appendVoiceTranscriptDraft('', '  hello  ')).toBe('hello');
    expect(appendVoiceTranscriptDraft('first line', 'second line')).toBe('first line\nsecond line');
    expect(appendVoiceTranscriptDraft('first line ', 'second line')).toBe('first line second line');
    expect(appendVoiceTranscriptDraft('keep', '   ')).toBe('keep');
  });

  it('tracks the inserted raw transcript range so refinement can replace it in place', () => {
    const first = appendVoiceTranscriptDraftWithRange('first line', ' raw words ');
    expect(first).toEqual({
      draft: 'first line\nraw words',
      insertion: { start: 11, end: 20, text: 'raw words' },
    });
    expect(replaceVoiceTranscriptDraftRange(first.draft, first.insertion, 'refined words')).toBe(
      'first line\nrefined words',
    );
    expect(replaceVoiceTranscriptDraftRange('user edited raw words', first.insertion, 'refined words')).toBe(
      'user edited raw words\nrefined words',
    );
  });

  it('uses compact Chinese labels for the voice button state', () => {
    expect(mobileVoiceStateLabel('idle')).toBe('语音');
    expect(mobileVoiceStateLabel('listening')).toBe('正在听');
    expect(mobileVoiceStateLabel('submitting')).toBe('转写中');
    expect(mobileVoiceStateLabel('refining')).toBe('正在润色');
    expect(mobileVoiceStateLabel('done')).toBe('语音');
    expect(mobileVoiceStateLabel('error')).toBe('语音出错');
  });

  it('only exposes cancel while a recording is active', () => {
    expect(canCancelMobileVoiceRecording('listening')).toBe(true);
    expect(canCancelMobileVoiceRecording('idle')).toBe(false);
    expect(canCancelMobileVoiceRecording('submitting')).toBe(false);
    expect(canCancelMobileVoiceRecording('refining')).toBe(false);
    expect(canCancelMobileVoiceRecording('error')).toBe(false);
  });

  it('detects microphone permission errors for the settings shortcut', () => {
    expect(isMobileVoiceMicPermissionError(mobileVoiceMicPermissionError())).toBe(true);
    expect(mobileVoiceRealtimeAudioUnavailableError()).toContain('原生录音模块');
    expect(isMobileVoiceMicPermissionError('麦克风权限未开启')).toBe(false);
    expect(isMobileVoiceMicPermissionError(null)).toBe(false);
  });

  it('builds refinement context from synced desktop and local mobile voice settings plus session context', () => {
    const context = buildMobileVoiceRefinementContext(storedCredential({
      settings: {
        language: 'zh-CN',
        refinementEnabled: true,
        playInteractionSound: true,
        refinementInstructions: '保留产品名。',
        dictionaryEntries: [
          {
            text: 'XDMaker',
            frequency: 3,
            aliases: [{ text: 'xd maker', count: 2 }],
          },
        ],
        voiceInputHistory: ['桌面较新的术语', '桌面较早的术语'],
      },
    }), {
      uiLanguage: 'zh-CN',
      localVoiceInputHistory: ['手机最新术语', '手机较早术语'],
      refinementContext: {
        selectionBefore: '当前输入框前文',
        replyToMessage: '最近的助手回复',
      },
    });

    expect(context).toMatchObject({
      uiLanguage: 'zh-CN',
      sourceLanguage: 'zh-CN',
      userRefinementInstructions: '保留产品名。',
      userDictionary: '- XDMaker',
      dictionaryAliasHints: [
        {
          term: 'XDMaker',
          frequency: 3,
          aliases: [{ text: 'xd maker', count: 2 }],
        },
      ],
      selectionBefore: '当前输入框前文',
      replyToMessage: '最近的助手回复',
    });
    const history = context.voiceInputHistory ?? '';
    expect(history).toContain('语音输入历史');
    expect(history.indexOf('- 桌面较早的术语')).toBeLessThan(history.indexOf('- 桌面较新的术语'));
    expect(history.indexOf('- 桌面较新的术语')).toBeLessThan(history.indexOf('- 手机较早术语'));
    expect(history.indexOf('- 手机较早术语')).toBeLessThan(history.indexOf('- 手机最新术语'));
  });

  it('uses the current UI language for refinement when ASR language is auto', () => {
    const context = buildMobileVoiceRefinementContext(storedCredential({
      settings: {
        language: 'auto',
        refinementEnabled: true,
        playInteractionSound: true,
      },
    }), {
      uiLanguage: 'ja',
    });

    expect(context).toMatchObject({
      uiLanguage: 'ja',
      sourceLanguage: 'ja',
    });
  });

  it('normalizes the desktop transcribe result before inserting into the draft', () => {
    expect(normalizeMobileVoiceTranscriptResult({
      text: '  识别文本  ',
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
    })).toEqual({
      text: '识别文本',
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
    });
    expect(normalizeMobileVoiceTranscriptResult(null)).toEqual({ text: '' });
    expect(normalizeMobileVoiceTranscriptResult({ text: 1 })).toEqual({ text: '' });
  });

  it('infers stable upload metadata from recording uri and mime type', () => {
    expect(resolveVoiceRecordingMeta({
      uri: 'file:///tmp/take.webm?cache=1',
    })).toEqual({
      mimeType: 'audio/webm',
      fileName: 'mobile-voice.webm',
      ext: 'webm',
    });
    expect(resolveVoiceRecordingMeta({
      uri: 'file:///tmp/no-extension',
      mimeType: 'audio/wav',
      fileName: 'clip.wav',
    })).toEqual({
      mimeType: 'audio/wav',
      fileName: 'clip.wav',
      ext: 'wav',
    });
  });

  it('requests a device-link media presign-put for the recorded audio', async () => {
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/voice-put',
      key: 'cindy/device-link/user-1/voice.m4a',
      expiresAt: '2026-06-17T00:00:00.000Z',
    }));

    const result = await presignMobileVoiceUpload({
      uri: 'file:///tmp/mobile-voice.m4a',
      size: 4096,
      mimeType: 'audio/mp4',
      fileName: 'mobile-voice.m4a',
    }, { token: 'token-1', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw } });

    expect(apiFetch).toHaveBeenCalledWith('/api/device-link/media/presign-put', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'POST',
      token: 'token-1',
      body: {
        size: 4096,
        contentType: 'audio/mp4',
        ext: 'm4a',
      },
    });
    expect(result.key).toBe('cindy/device-link/user-1/voice.m4a');
  });

  it('uploads recorded bytes with the signed PUT url', async () => {
    const fetchPut = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response));
    const data = new Blob(['voice'], { type: 'audio/mp4' });

    await putMobileVoiceUpload('https://oss.example/voice-put', data, 'audio/mp4', {
      fetch: fetchPut,
    });

    expect(fetchPut).toHaveBeenCalledWith('https://oss.example/voice-put', {
      method: 'PUT',
      headers: {
        'Content-Type': 'audio/mp4',
        'x-oss-object-acl': 'private',
      },
      body: data,
    });
  });

  it('returns the OSS key and desktop-facing audio metadata after upload', async () => {
    const apiFetch = vi.fn(async () => ({
      putUrl: 'https://oss.example/voice-put',
      key: 'cindy/device-link/user-1/mobile-voice.m4a',
      expiresAt: '2026-06-17T00:00:00.000Z',
    }));
    const fetchPut = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response));
    const body = new Blob(['voice'], { type: 'audio/mp4' });

    const result = await uploadMobileVoiceRecording({
      uri: 'file:///tmp/rec.m4a',
      size: body.size,
      mimeType: 'audio/mp4',
      durationMs: 1200,
    }, body, {
      token: 'token-1',
      deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw, fetch: fetchPut },
    });

    expect(result).toEqual({
      ossKey: 'cindy/device-link/user-1/mobile-voice.m4a',
      mimeType: 'audio/mp4',
      fileName: 'mobile-voice.m4a',
      size: body.size,
    });
  });

  it('rejects empty or oversized recordings before presign', async () => {
    const apiFetch = vi.fn();
    await expect(presignMobileVoiceUpload({
      uri: 'file:///tmp/empty.m4a',
      size: 0,
      mimeType: 'audio/mp4',
    }, { token: 'token-1', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw } })).rejects.toThrow('录音为空');

    await expect(presignMobileVoiceUpload({
      uri: 'file:///tmp/huge.m4a',
      size: MOBILE_MAX_VOICE_AUDIO_BYTES + 1,
      mimeType: 'audio/mp4',
    }, { token: 'token-1', deps: { apiFetch: apiFetch as unknown as typeof apiFetchRaw } })).rejects.toThrow('录音超过上限');

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('fails when OSS PUT rejects the recorded audio', async () => {
    const fetchPut = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    } as Response));

    await expect(putMobileVoiceUpload('https://oss.example/voice-put', new Blob(['x']), 'audio/mp4', {
      fetch: fetchPut,
    })).rejects.toThrow('语音上传失败：HTTP 403 Forbidden');
  });

  it('streams mobile refinement previews from managed refine SSE chunks', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"content":"{\\"text\\":\\"我想"}}]}',
          '',
          'data: {"choices":[{"delta":{"content":"看一下 LiteLLM。\\"}"}}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n')));
        controller.close();
      },
    });
    const fetchCloud = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: stream,
      json: async () => {
        throw new Error('streaming response should not use json()');
      },
    } as unknown as Response));
    const client = new MobileLiteLlmTextModelClient({
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      requestTargetProvider: async () => ({
        url: 'https://voice.example.com/api/voice/sessions/session-1/refine?provider=auto',
        authorization: 'Bearer refine-token',
      }),
    });
    const previews: string[] = [];

    const result = await client.requestJson<{ text: string }>({
      model: 'auto',
      system: 'Return JSON.',
      user: { promptVersion: 'v9', dictationText: '嗯 我想看一下 litellm' },
      schemaName: 'dictation_refinement',
      promptCacheScope: 'mobile-voice:host-a',
      onTextSnapshot: (text) => previews.push(text),
    });

    expect(previews).toEqual(['我想', '我想看一下 LiteLLM。']);
    expect(result).toEqual({ text: '我想看一下 LiteLLM。' });
    // 托管单请求:目标 URL 来自 voice-server refine 票据,不再拼接直连网关地址。
    const [url, init] = fetchCloud.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://voice.example.com/api/voice/sessions/session-1/refine?provider=auto');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('auto');
    // warmup 与真实润色必须共用同一把 prompt_cache_key。
    expect(body.prompt_cache_key).toBe(makeMobileRefinerPromptCacheKey({
      model: 'auto',
      schemaName: 'dictation_refinement',
      promptVersion: 'v9',
      system: 'Return JSON.',
      scope: 'mobile-voice:host-a',
    }));
  });

  it('derives a stable prompt cache key that only changes with its inputs', () => {
    const base = {
      model: 'auto',
      schemaName: 'dictation_refinement',
      promptVersion: 'v9',
      system: 'Return JSON.',
      scope: 'mobile-voice:host-a',
    };
    const key = makeMobileRefinerPromptCacheKey(base);
    expect(key).toMatch(/^xdt:dictation_refinement:[0-9a-f]{16}$/);
    expect(makeMobileRefinerPromptCacheKey(base)).toBe(key);
    expect(makeMobileRefinerPromptCacheKey({ ...base, scope: 'mobile-voice:host-b' })).not.toBe(key);
    expect(makeMobileRefinerPromptCacheKey({ ...base, system: 'Return JSON!' })).not.toBe(key);
    expect(makeMobileRefinerPromptCacheKey({ ...base, promptVersion: 'v10' })).not.toBe(key);
  });

  it('refreshes the managed voice access token once after a 401 refinement response', async () => {
    const fetchCloud = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: undefined,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ text: 'refined' }) } }] }),
      } as unknown as Response);
    const requestTargetProvider = vi.fn()
      .mockResolvedValueOnce({ url: 'https://voice.example.com/refine', authorization: 'Bearer stale-token' })
      .mockResolvedValueOnce({ url: 'https://voice.example.com/refine', authorization: 'Bearer fresh-token' });
    const client = new MobileLiteLlmTextModelClient({
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      requestTargetProvider,
    });

    await expect(client.requestJson<{ text: string }>({
      model: 'gpt-5.4-mini',
      system: 'Return JSON.',
      user: { text: 'raw' },
      schemaName: 'VoiceRefinement',
    })).resolves.toEqual({ text: 'refined' });
    expect(requestTargetProvider).toHaveBeenNthCalledWith(1, { refreshAccessToken: false });
    expect(requestTargetProvider).toHaveBeenNthCalledWith(2, { refreshAccessToken: true });
    expect(fetchCloud).toHaveBeenCalledTimes(2);
  });

  it('parses buffered SSE text when React Native fetch has no readable body', async () => {
    const fetchCloud = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: undefined,
      text: async () => [
        'data: {"choices":[{"delta":{"content":"{\\"text\\":\\"mock refined"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":" voice draft\\"}"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      json: async () => {
        throw new Error('buffered SSE response should not use json()');
      },
    } as unknown as Response));
    const client = new MobileLiteLlmTextModelClient({
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      requestTargetProvider: async () => ({
        url: 'https://voice.example.com/api/voice/sessions/session-1/refine?provider=auto',
        authorization: 'Bearer refine-token',
      }),
    });
    const previews: string[] = [];

    const result = await client.requestJson<{ text: string }>({
      model: 'auto',
      system: 'Return JSON.',
      user: { dictationText: 'mock realtime voice draft' },
      schemaName: 'dictation_refinement',
      onTextSnapshot: (text) => previews.push(text),
    });

    expect(previews).toEqual(['mock refined', 'mock refined voice draft']);
    expect(result).toEqual({ text: 'mock refined voice draft' });
  });

  it('surfaces managed refine HTTP error details', async () => {
    const fetchCloud = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => JSON.stringify({ error: { message: 'managed refiner unavailable' } }),
    } as unknown as Response));
    const client = new MobileLiteLlmTextModelClient({
      deps: { fetch: fetchCloud as unknown as typeof fetch },
      requestTargetProvider: async () => ({
        url: 'https://voice.example.com/api/voice/sessions/session-1/refine?provider=auto',
        authorization: 'Bearer refine-token',
      }),
    });

    await expect(client.requestJson<{ text: string }>({
      model: 'auto',
      system: 'Return JSON.',
      user: { dictationText: 'raw' },
      schemaName: 'dictation_refinement',
    // 冒号来自 cloudVoiceHttpErrorMessage() 的代码拼接（半角），不在 locale 里，
    // 因此不随 zh-CN 全角标点规则变化。
    })).rejects.toThrow('语音润色失败: HTTP 500 Server Error · managed refiner unavailable');
  });
});
