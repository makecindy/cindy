import { describe, expect, it, vi } from 'vitest';
import { SpeechSynthesisSession } from '../speech.js';

const make = (
  fetcher: typeof fetch = vi.fn(
    async () => new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }),
  ),
) => {
  const assertCurrent = vi.fn();
  const diagnostic = vi.fn();
  const speech = new SpeechSynthesisSession({
    connection: () => ({
      baseUrl: 'https://gateway.test/prefix/v1/',
      protocol: 'openai' as const,
      headers: { authorization: 'Bearer test-key' },
    }),
    fetch: fetcher,
    assertCurrent,
    diagnostic,
  });
  return { speech, fetcher, assertCurrent, diagnostic };
};
const input = { requestId: 'one', modelId: 'speech-model', voice: 'alloy', text: 'hello' };

describe('speech transport', () => {
  it('preserves the server-provided endpoint prefix, sends the selected model, and pulls binary PCM', async () => {
    const { speech, fetcher, diagnostic } = make();
    expect(await speech.start(input)).toEqual({ sampleRate: 24000 });
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://gateway.test/prefix/v1/audio/speech'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({
          model: 'speech-model',
          voice: 'alloy',
          input: 'hello',
          response_format: 'pcm',
        }),
      }),
    );
    expect(new Uint8Array((await speech.read('one')).pcm)).toEqual(new Uint8Array([1, 2]));
    expect((await speech.read('one')).done).toBe(true);
    speech.cancel();
    expect(diagnostic.mock.calls.map(([event]) => event.stage)).toEqual([
      'request',
      'headers',
      'first_pcm',
      'complete',
    ]);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/hello|test-key|gateway\.test|alloy/);
  });

  it.each(['audio/mpeg', 'application/json'])(
    'rejects an incompatible %s body instead of playing it as PCM',
    async (contentType) => {
      const { speech } = make(
        vi.fn(async () => new Response('not PCM', { headers: { 'Content-Type': contentType } })),
      );
      await expect(speech.start(input)).rejects.toThrow('format');
    },
  );

  it('does not pass upstream error bodies to the renderer', async () => {
    const { speech, diagnostic } = make(
      vi.fn(async () => new Response('upstream-sensitive-error', { status: 401 })),
    );
    await expect(speech.start(input)).rejects.toThrow(/^request$/);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'headers', httpStatus: 401 }),
    );
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'error', code: 'request' }),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /upstream-sensitive-error|hello|test-key/,
    );
  });

  it.each([new Uint8Array(), new Uint8Array([1])])(
    'rejects empty or truncated PCM at EOF',
    async (bytes) => {
      const { speech } = make(
        vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'audio/pcm' } })),
      );
      await speech.start(input);
      if (bytes.length) await speech.read('one');
      await expect(speech.read('one')).rejects.toThrow('format');
    },
  );

  it('cancels pending headers and refuses a late body after interruption', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const { speech } = make(fetcher);
    const starting = speech.start(input);
    speech.cancel();
    resolve(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }));
    await expect(starting).rejects.toThrow('cancelled');
    await expect(speech.read('one')).rejects.toThrow('cancelled');
  });

  it('allows only one read and invalidates a blocked read on interruption', async () => {
    const stream = new ReadableStream<Uint8Array>();
    const { speech } = make(
      vi.fn(async () => new Response(stream, { headers: { 'Content-Type': 'audio/pcm' } })),
    );
    await speech.start(input);
    const reading = speech.read('one');
    await expect(speech.read('one')).rejects.toThrow('cancelled');
    speech.cancel();
    await expect(reading).rejects.toThrow('cancelled');
  });

  it('rechecks the owner/model before each read', async () => {
    const { speech, assertCurrent } = make();
    await speech.start(input);
    assertCurrent.mockImplementation(() => {
      throw new Error('owner changed');
    });
    await expect(speech.read('one')).rejects.toThrow('owner changed');
    speech.cancel();
  });
});

function nativeSession(protocol: 'elevenlabs' | 'minimax', response: Response) {
  const fetcher = vi.fn(async () => response);
  const speech = new SpeechSynthesisSession({
    connection: () => ({
      baseUrl: 'https://provider.test/proxy/v1',
      protocol,
      headers:
        protocol === 'elevenlabs'
          ? ({ 'xi-api-key': 'test-eleven-key' } as Record<string, string>)
          : ({ authorization: 'Bearer test-mini-key' } as Record<string, string>),
    }),
    assertCurrent: () => {},
    fetch: fetcher,
  });
  return { speech, fetcher };
}
function sse(events: unknown[], split = 7) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

it('uses the ElevenLabs stream endpoint, voice ID, model_id and xi-api-key with raw 24 kHz PCM', async () => {
  const { speech, fetcher } = nativeSession(
    'elevenlabs',
    new Response(new Uint8Array([1, 2]), {
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  );
  expect(await speech.start({ ...input, voice: 'a_voice-id' })).toEqual({ sampleRate: 24000 });
  expect(fetcher).toHaveBeenCalledWith(
    new URL(
      'https://provider.test/proxy/v1/text-to-speech/a_voice-id/stream?output_format=pcm_24000',
    ),
    expect.objectContaining({
      redirect: 'error',
      headers: { 'xi-api-key': 'test-eleven-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: input.modelId, text: input.text }),
    }),
  );
  expect([...new Uint8Array((await speech.read('one')).pcm)]).toEqual([1, 2]);
  expect((await speech.read('one')).done).toBe(true);
});

it('decodes fragmented MiniMax SSE/hex without replaying the terminal aggregate', async () => {
  const { speech, fetcher } = nativeSession(
    'minimax',
    sse([
      { data: { status: 1, audio: '0102' }, base_resp: { status_code: 0 } },
      { data: { status: 1, audio: '0304' } },
      {
        data: { status: 2, audio: '01020304' },
        extra_info: { audio_sample_rate: 24000, audio_channel: 1, audio_format: 'pcm' },
        base_resp: { status_code: 0 },
      },
    ]),
  );
  await speech.start(input);
  expect(fetcher).toHaveBeenCalledWith(
    new URL('https://provider.test/proxy/v1/t2a_v2'),
    expect.objectContaining({
      headers: { authorization: 'Bearer test-mini-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.modelId,
        text: input.text,
        stream: true,
        stream_options: { exclude_aggregated_audio: true },
        output_format: 'hex',
        voice_setting: { voice_id: input.voice },
        audio_setting: { format: 'pcm', sample_rate: 24000, channel: 1 },
      }),
    }),
  );
  expect([...new Uint8Array((await speech.read('one')).pcm)]).toEqual([1, 2]);
  expect([...new Uint8Array((await speech.read('one')).pcm)]).toEqual([3, 4]);
  expect(await speech.read('one')).toEqual({ done: true, pcm: new ArrayBuffer(0) });
});

it.each([
  [{ data: { status: 1, audio: 'zz' } }, 'format'],
  [{ data: { status: 1, audio: '0' } }, 'format'],
  [
    { data: { status: 2 }, base_resp: { status_code: 1004, status_msg: 'private token detail' } },
    'request',
  ],
  [{ data: { status: 2 }, extra_info: { audio_format: 'mp3' } }, 'format'],
  [{ data: { status: 2 }, extra_info: { audio_sample_rate: 32000 } }, 'format'],
  [{ data: { status: 2 }, extra_info: { audio_channel: 2 } }, 'format'],
])('rejects invalid MiniMax output with a safe error', async (event, message) => {
  const { speech } = nativeSession('minimax', sse([event]));
  await speech.start(input);
  await expect(speech.read('one')).rejects.toThrow(new RegExp(`^${message}$`));
});

it('rejects a truncated MiniMax stream instead of claiming completion', async () => {
  const { speech } = nativeSession('minimax', sse([{ data: { status: 1, audio: '0102' } }]));
  await speech.start(input);
  await speech.read('one');
  await expect(speech.read('one')).rejects.toThrow('format');
});

it('cancels a MiniMax read waiting for the remainder of an SSE event', async () => {
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {'));
    },
    cancel: cancelled,
  });
  const { speech } = nativeSession(
    'minimax',
    new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  await speech.start(input);
  const reading = speech.read('one');
  speech.cancel();
  await expect(reading).rejects.toThrow('cancelled');
  expect(cancelled).toHaveBeenCalledOnce();
});
