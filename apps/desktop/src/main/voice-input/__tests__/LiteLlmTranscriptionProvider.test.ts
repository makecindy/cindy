import { afterEach, describe, expect, it, vi } from 'vitest';

const outboundFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../maker-host/outbound-fetch.js', () => ({
  outboundFetch: (...args: unknown[]) => outboundFetchMock(...args),
}));

const reportKeyRejectedMock = vi.hoisted(() => vi.fn());
vi.mock('../../model-access/gatewayKeyRejection.js', () => ({
  reportCindyGatewayKeyRejected: reportKeyRejectedMock,
}));

import {
  LiteLlmTranscriptionProvider,
  transcribeLiteLlmAudioFile,
} from '../LiteLlmTranscriptionProvider.js';
import type { AsrEvent } from '@cindy/voice-input-core';

describe('LiteLlmTranscriptionProvider', () => {
  afterEach(() => {
    outboundFetchMock.mockReset();
    reportKeyRejectedMock.mockReset();
  });

  it('reports a 401 even when reading the response body fails', async () => {
    outboundFetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => {
        throw new TypeError('terminated');
      },
    });

    await expect(transcribeLiteLlmAudioFile({
      proxyApiKey: 'sk-sent',
      baseUrl: 'https://gateway.example',
      bytes: Buffer.from([1, 2, 3]),
    })).rejects.toThrow('terminated');
    expect(reportKeyRejectedMock).toHaveBeenCalledTimes(1);
    expect(reportKeyRejectedMock).toHaveBeenCalledWith('sk-sent');
  });

  it.each([
    [401, 1],
    [403, 0],
  ] as const)('reports the sent Cindy AI key on HTTP %s only when unauthorized', async (status, reports) => {
    outboundFetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'rejected' }), { status }));

    await expect(transcribeLiteLlmAudioFile({
      proxyApiKey: 'sk-sent',
      baseUrl: 'https://gateway.example',
      bytes: Buffer.from([1, 2, 3]),
    })).rejects.toThrow('rejected');
    expect(reportKeyRejectedMock).toHaveBeenCalledTimes(reports);
    if (reports > 0) expect(reportKeyRejectedMock).toHaveBeenCalledWith('sk-sent');
  });

  it('posts captured audio to LiteLLM using ElevenLabs Scribe v2', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    outboundFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ text: 'hello world' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

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
    outboundFetchMock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ text: '  mobile voice  ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

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
