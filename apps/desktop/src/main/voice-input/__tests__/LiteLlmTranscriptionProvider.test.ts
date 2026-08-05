import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LiteLlmTranscriptionProvider,
  transcribeLiteLlmAudioFile,
} from '../LiteLlmTranscriptionProvider.js';
import type { AsrEvent } from '@cindy/voice-input-core';

describe('LiteLlmTranscriptionProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts captured audio to LiteLLM using ElevenLabs Scribe v2', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ text: 'hello world' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: AsrEvent[] = [];
    const provider = new LiteLlmTranscriptionProvider({
      proxyApiKey: 'sk-test',
      baseUrl: 'https://gateway.example/v1-compatible/',
      sourceLanguage: 'zh-CN',
    });
    provider.onEvent((event) => events.push(event));

    await provider.start();
    provider.appendAudio(new ArrayBuffer(3200));
    await provider.flushAudio();

    const form = requestInit?.body as FormData;
    expect(requestUrl).toBe('https://gateway.example/v1-compatible/v1/audio/transcriptions');
    expect(requestInit?.headers).toEqual({ Authorization: 'Bearer sk-test' });
    expect(form.get('model')).toBe('elevenlabs/scribe_v2');
    expect(form.get('language')).toBe('zho');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(events).toContainEqual(expect.objectContaining({ type: 'stable', text: 'hello world' }));
  });

  it('posts an existing audio file to LiteLLM and returns trimmed text', async () => {
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ text: '  mobile voice  ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const text = await transcribeLiteLlmAudioFile({
      proxyApiKey: 'sk-test',
      baseUrl: 'https://gateway.example',
      model: 'elevenlabs/scribe_v2',
      sourceLanguage: 'en',
      bytes: Buffer.from('m4a-bytes'),
      mimeType: 'audio/mp4',
      fileName: 'mobile-voice.m4a',
    });

    const form = requestInit?.body as FormData;
    expect(text).toBe('mobile voice');
    expect(form.get('model')).toBe('elevenlabs/scribe_v2');
    expect(form.get('language')).toBe('en');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });
});
