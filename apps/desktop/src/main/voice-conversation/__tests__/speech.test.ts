import { describe, expect, it, vi } from 'vitest';
import { SpeechSynthesisSession } from '../speech.js';
import { MAX_ENCODED_SPEECH_BYTES } from '../../../shared/voiceConversation.js';

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

// Unit regression: OpenRouter MiniMax rejects PCM (HTTP 400). Existing native
// MiniMax/PCM cases cannot catch this route-specific format or prefetch contract.
it('prefetches a complete OpenRouter MiniMax MP3 without treating compressed bytes as PCM', async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { body = controller; },
  }), { headers: { 'Content-Type': 'audio/mpeg' } }));
  const speech = new SpeechSynthesisSession({
    connection: () => ({ baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', headers: {} }),
    assertCurrent: () => {},
    fetch: fetcher,
  });
  let ready = false;
  const starting = speech.start({ ...input, modelId: 'minimax/speech-2.8-turbo' })
    .then(result => { ready = true; return result; });
  void starting.catch(() => {});
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
    model: 'minimax/speech-2.8-turbo', response_format: 'mp3',
  });
  body.enqueue(new Uint8Array([0xff, 0xfb]));
  await Promise.resolve();
  expect(ready).toBe(false);
  body.enqueue(new Uint8Array([1]));
  body.close();
  expect(await starting).toEqual({ format: 'mp3', data: new Uint8Array([0xff, 0xfb, 1]).buffer });
  await expect(speech.read(input.requestId)).rejects.toThrow('cancelled');
});

function openRouterSession(fetcher: typeof fetch, baseUrl = 'https://openrouter.ai/api/v1') {
  const assertCurrent = vi.fn();
  const speech = new SpeechSynthesisSession({
    connection: () => ({ baseUrl, protocol: 'openai', headers: {} }),
    assertCurrent, fetch: fetcher,
  });
  return { speech, assertCurrent };
}
const miniInput = { ...input, modelId: 'minimax/speech-2.8-turbo' };

it.each([
  ['https://gateway.test/v1', 'minimax/speech-2.8-turbo'],
  ['https://openrouter.ai/custom', 'minimax/speech-2.8-turbo'],
  ['https://openrouter.ai.evil.test/api/v1', 'minimax/speech-2.8-turbo'],
  ['https://openrouter.ai/api/v1', 'elevenlabs/eleven-v3'],
])('retains streaming PCM on %s for %s', async (baseUrl, modelId) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2]), {
    headers: { 'Content-Type': 'audio/pcm' },
  }));
  const { speech } = openRouterSession(fetcher, baseUrl);
  expect(await speech.start({ ...input, modelId })).toEqual({ sampleRate: 24000 });
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).response_format).toBe('pcm');
  expect((await speech.read(input.requestId)).pcm.byteLength).toBe(2);
  speech.cancel();
});

it.each(['empty', 'oversize', 'wrong-format'] as const)(
  'rejects %s MP3 responses before returning audio to the player', async kind => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(body) {
        if (kind === 'empty') body.close();
        else if (kind === 'oversize') body.enqueue(new Uint8Array(MAX_ENCODED_SPEECH_BYTES + 1));
        else body.enqueue(new TextEncoder().encode('private upstream error'));
      }, cancel,
    }), { headers: { 'Content-Type': kind === 'wrong-format' ? 'application/json' : 'audio/mpeg' } });
    const { speech } = openRouterSession(vi.fn(async () => response));
    await expect(speech.start(miniInput)).rejects.toThrow('format');
    if (kind !== 'empty') expect(cancel).toHaveBeenCalled();
  },
);

it.each(['interrupt', 'owner-change', 'timeout'] as const)(
  'revokes an MP3 prefetch on %s without returning late encoded audio', async reason => {
    vi.useFakeTimers();
    try {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const { speech, assertCurrent } = openRouterSession(vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({ start(controller) { body = controller; }, cancel }),
        { headers: { 'Content-Type': 'audio/mpeg' } },
      )));
      const pending = speech.start(miniInput);
      const rejected = expect(pending).rejects.toThrow(reason === 'timeout' ? 'timeout' : reason === 'interrupt' ? 'cancelled' : 'request');
      body.enqueue(new Uint8Array([0xff, 0xfb]));
      await vi.advanceTimersByTimeAsync(0);
      if (reason === 'interrupt') speech.cancel();
      else if (reason === 'owner-change') {
        assertCurrent.mockImplementation(() => { throw new Error('owner changed'); });
        body.enqueue(new Uint8Array([1]));
      } else await vi.advanceTimersByTimeAsync(15_001);
      await rejected;
      expect(cancel).toHaveBeenCalled();
      await expect(speech.read(input.requestId)).rejects.toThrow();
    } finally { vi.useRealTimers(); }
  },
);

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

function nativeSession(
  protocol: import('../../../shared/voiceConversation.js').SpeechProtocol,
  response: Response,
) {
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

// Unit tier: real transport serialization at the network seam. A selection's
// optional speed must use the provider's field, with no PCM/sample-rate changes.
it.each([
  ['openai', 4, { speed: 4 }],
  ['elevenlabs', 0.7, { voice_settings: { speed: 0.7 } }],
  ['minimax', 2, { voice_setting: { voice_id: 'alloy', speed: 2 } }],
] as const)(
  'serializes native %s speed while retaining the streaming audio format',
  async (protocol, speed, body) => {
    const { speech, fetcher } = nativeSession(
      protocol,
      protocol === 'minimax'
        ? sse([{ data: { status: 1, audio: '0102' } }, { data: { status: 2 } }])
        : new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }),
    );
    expect(await speech.start({ ...input, modelId: 'eleven_flash_v2_5', speed })).toEqual({
      sampleRate: 24000,
    });
    const request = vi.mocked(fetcher as typeof fetch).mock.calls[0][1];
    expect(JSON.parse(String(request?.body))).toMatchObject(body);
    expect([...new Uint8Array((await speech.read(input.requestId)).pcm)]).toEqual([1, 2]);
    speech.cancel();
  },
);

it.each([
  ['openai', 'tts', 4.1],
  // Live Gateway rejects these speeds; transport must guard direct callers too.
  ['openai', 'qwen/qwen-audio-3.1-tts-plus', 0.25],
  ['openai', 'qwen/qwen-audio-3.1-tts-plus', 4],
  ['elevenlabs', 'eleven_flash_v2_5', 1.25],
  ['elevenlabs', 'eleven_v3', 1],
  ['minimax', 'speech-02-hd', 0.4],
] as const)(
  'refuses unsupported speed for %s %s before sending a request',
  async (protocol, modelId, speed) => {
    const { speech, fetcher } = nativeSession(protocol, new Response());
    await expect(speech.start({ ...input, modelId, speed })).rejects.toThrow('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
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

it.each(['minimax', 'qwen-tts', 'dashscope-tts'] as const)(
  'cancels a pending %s SSE frame at its reader',
  async (protocol) => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {'));
      },
      cancel: cancelled,
    });
    const { speech } = nativeSession(
      protocol,
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    await speech.start(input);
    const reading = speech.read('one');
    speech.cancel();
    await expect(reading).rejects.toThrow('cancelled');
    expect(cancelled).toHaveBeenCalledOnce();
  },
);

// Unit tier, real SpeechSynthesisSession entry: native SSE is not raw PCM and
// long Qwen replies need multiple requests. Existing MiniMax hex cases cannot
// catch Base64 corruption, URL aggregate replay, or cancellation between segments.
const dashscopeEvents = (bytes = [1, 2]) => [
  { output: { finish_reason: null, audio: { data: Buffer.from(bytes).toString('base64') } } },
  { output: { finish_reason: 'stop', audio: { data: '', url: 'https://audio.test/aggregate' } } },
];
it.each(['qwen-tts', 'dashscope-tts'] as const)(
  'decodes %s Base64 SSE and ignores the complete-file URL',
  async (protocol) => {
    const { speech, fetcher } = nativeSession(protocol, sse(dashscopeEvents()));
    await speech.start({
      ...input,
      modelId: 'qwen3-tts-flash',
      voice: 'Cherry',
      ...(protocol === 'dashscope-tts' ? { speed: 1.5 } : {}),
    });
    const [url, request] = vi.mocked(fetcher as typeof fetch).mock.calls[0];
    expect(String(url)).toBe(
      'https://provider.test/proxy/v1/services/' +
        (protocol === 'qwen-tts'
          ? 'aigc/multimodal-generation/generation'
          : 'audio/tts/SpeechSynthesizer'),
    );
    expect(request?.headers).toMatchObject({
      authorization: 'Bearer test-mini-key',
      'x-dashscope-sse': 'enable',
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      model: 'qwen3-tts-flash',
      input: {
        text: 'hello',
        voice: 'Cherry',
        ...(protocol === 'dashscope-tts' ? { format: 'pcm', sample_rate: 24000, rate: 1.5 } : {}),
      },
    });
    expect([...new Uint8Array((await speech.read('one')).pcm)]).toEqual([1, 2]);
    expect((await speech.read('one')).done).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
// Unit tier via SpeechSynthesisSession: live Qwen/CosyVoice streams use the string
// "null" while audio is arriving. The JSON-null fixture above missed this case;
// retain the final stop requirement even after sentence-end events.
it.each(['qwen-tts', 'dashscope-tts'] as const)(
  'decodes %s string-null audio and sentence events until stop',
  async (protocol) => {
    const { speech, fetcher } = nativeSession(
      protocol,
      sse([
        { output: { type: 'sentence-begin', finish_reason: 'null', audio: { data: '' } } },
        { output: { type: 'sentence-synthesis', finish_reason: 'null', audio: { data: 'AQI=' } } },
        { output: { type: 'sentence-end', finish_reason: 'null', audio: { data: '' } } },
        dashscopeEvents()[1],
      ]),
    );
    await speech.start(input);
    expect([...new Uint8Array((await speech.read('one')).pcm)]).toEqual([1, 2]);
    expect((await speech.read('one')).done).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('joins multi-line data and fragmented UTF-8 before decoding Qwen PCM', async () => {
  const data =
    ': keepalive\r\ndata: {"output": {"original_text": "你好",\r\ndata: "audio":{"data":"AQI="},"finish_reason":null}}\r\n\r\n' +
    'data: {"output":{"finish_reason":"stop"}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const { speech } = nativeSession(
    'qwen-tts',
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of new TextEncoder().encode(data))
            controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  );
  await speech.start(input);
  expect([...new Uint8Array((await speech.read('one')).pcm)]).toEqual([1, 2]);
  expect((await speech.read('one')).done).toBe(true);
});
it.each([
  [{ code: 'QuotaExceeded', message: 'private upstream text' }],
  [{ output: { audio: { data: 'AQI?' }, finish_reason: 'stop' } }],
  [{ output: { audio: { data: 'AQJ=' }, finish_reason: 'stop' } }],
  [{ output: { audio: { data: 'AQ==' }, finish_reason: 'stop' } }],
  [{ output: { finish_reason: 'stop', audio: { url: 'https://audio.test/aggregate' } } }],
  [{ output: { finish_reason: 'length' } }],
  [dashscopeEvents()[0]],
  [{ output: { finish_reason: 'null', audio: { data: 'AQI=' } } }],
])(
  'refuses incomplete, invalid or failed native SSE %# without replaying a URL',
  async (...events) => {
    const { speech, fetcher } = nativeSession('dashscope-tts', sse(events));
    await speech.start(input);
    await expect(
      (async () => {
        while (!(await speech.read('one')).done) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/^(format|request)$/);
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it.each([
  ['qwen-tts', 1],
  ['dashscope-tts', 0.4],
  ['dashscope-tts', 2.1],
] as const)('rejects unsupported %s speed %s before fetching', async (protocol, speed) => {
  const { speech, fetcher } = nativeSession(protocol, sse(dashscopeEvents()));
  await expect(speech.start({ ...input, speed })).rejects.toThrow('unavailable');
  expect(fetcher).not.toHaveBeenCalled();
});
function segmentedSession(fetcher = vi.fn<typeof fetch>(async () => sse(dashscopeEvents()))) {
  const assertCurrent = vi.fn();
  const diagnostic = vi.fn();
  const speech = new SpeechSynthesisSession({
    connection: () => ({
      baseUrl: 'https://dashscope-intl.aliyuncs.com/api/v1',
      protocol: 'qwen-tts',
      headers: {},
    }),
    assertCurrent,
    fetch: fetcher,
    diagnostic,
  });
  return { speech, fetcher, assertCurrent, diagnostic };
}
it('pulls long Qwen text sequentially without lost text, broken Unicode or replayed audio', async () => {
  const { speech, fetcher } = segmentedSession();
  const text = 'a'.repeat(599) + '😀' + '中文。'.repeat(210);
  await speech.start({ ...input, text });
  expect(fetcher).toHaveBeenCalledOnce();
  const pcm: number[] = [];
  while (true) {
    const chunk = await speech.read('one');
    pcm.push(...new Uint8Array(chunk.pcm));
    if (chunk.done) break;
  }
  const texts = fetcher.mock.calls.map(
    ([, request]) => JSON.parse(String(request?.body)).input.text as string,
  );
  expect(texts.length).toBeGreaterThan(2);
  expect(texts.join('')).toBe(text);
  expect(
    texts.every(
      (part) =>
        part.length <= 600 && !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part),
    ),
  ).toBe(true);
  expect(pcm).toEqual(texts.flatMap(() => [1, 2]));
});
// PR #6660 / discussion_r4345622743: real SpeechSynthesisSession, unit tier with
// fake time and fetch only. Existing tests separate immediate multi-segment
// success from first-request timeouts, missing a later request with slow headers.
// A 1201-character reply must give segment two 30s for headers, then a fresh 15s
// for PCM; failure must abort the request and never fetch segment three.
it.each(['completed', 'headers_timeout', 'read_timeout'] as const)(
  'keeps later Qwen headers and PCM deadlines separate (%s)',
  async (outcome) => {
    vi.useFakeTimers();
    let resolveHeaders!: (response: Response) => void;
    let headersStarted!: () => void;
    let signal: AbortSignal | null | undefined;
    const headersPending = new Promise<void>((resolve) => {
      headersStarted = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sse(dashscopeEvents()))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((resolve, reject) => {
            resolveHeaders = resolve;
            signal = init?.signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            headersStarted();
          }),
      )
      .mockImplementation(async () => sse(dashscopeEvents([5, 6])));
    const { speech, diagnostic } = segmentedSession(fetcher);
    const cancelled = vi.fn();
    try {
      await speech.start({ ...input, text: 'a'.repeat(1201) });
      expect([...new Uint8Array((await speech.read('one')).pcm)]).toEqual([1, 2]);
      let settled = false;
      const reading = speech.read('one').then(
        (chunk) => {
          settled = true;
          return { chunk, error: null };
        },
        (error: unknown) => {
          settled = true;
          return { chunk: null, error };
        },
      );
      await headersPending;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      expect(signal?.aborted).toBe(false);
      if (outcome === 'headers_timeout') {
        await vi.advanceTimersByTimeAsync(9_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      } else {
        let body!: ReadableStreamDefaultController<Uint8Array>;
        resolveHeaders(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
              },
              cancel: cancelled,
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        );
        await vi.advanceTimersByTimeAsync(14_999);
        expect(settled).toBe(false);
        if (outcome === 'read_timeout') await vi.advanceTimersByTimeAsync(1);
        else {
          body.enqueue(
            new TextEncoder().encode(
              dashscopeEvents([3, 4])
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(''),
            ),
          );
          body.close();
        }
      }
      const result = await reading;
      if (outcome === 'completed') {
        expect(result.error).toBeNull();
        expect([...new Uint8Array(result.chunk!.pcm)]).toEqual([3, 4]);
        expect([...new Uint8Array((await speech.read('one')).pcm)]).toEqual([5, 6]);
        expect((await speech.read('one')).done).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(diagnostic.mock.calls.filter(([event]) => event.stage === 'error')).toEqual([]);
      } else {
        expect(result.error).toMatchObject({ code: 'timeout' });
        expect(signal?.aborted).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(
          diagnostic.mock.calls.map(([event]) => event).filter((event) => event.stage === 'error'),
        ).toEqual([expect.objectContaining({ code: outcome })]);
        if (outcome === 'read_timeout') expect(cancelled).toHaveBeenCalledOnce();
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      speech.cancel();
      vi.useRealTimers();
    }
  },
);
it.each(['cancel', 'owner-change'] as const)(
  'prevents the next paid Qwen segment after %s',
  async (action) => {
    const { speech, fetcher, assertCurrent } = segmentedSession();
    await speech.start({ ...input, text: 'a'.repeat(1201) });
    await speech.read('one');
    if (action === 'cancel') speech.cancel();
    else
      assertCurrent.mockImplementation(() => {
        throw new Error('owner changed');
      });
    await expect(speech.read('one')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it('cancels late segment headers and keeps the replacement speech reader', async () => {
  let release!: (response: Response) => void;
  const cancelled = vi.fn();
  let started!: () => void;
  const headersPending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(sse(dashscopeEvents()))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          started();
        }),
    )
    .mockResolvedValueOnce(sse(dashscopeEvents([3, 4])));
  const { speech } = segmentedSession(fetcher);
  await speech.start({ ...input, text: 'a'.repeat(1201) });
  await speech.read('one');
  const oldRead = speech.read('one');
  const rejected = expect(oldRead).rejects.toThrow('cancelled');
  await headersPending;
  expect(fetcher).toHaveBeenCalledTimes(2);
  await speech.start({ ...input, requestId: 'two' });
  release(
    new Response(new ReadableStream({ cancel: cancelled }), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );
  await rejected;
  expect(cancelled).toHaveBeenCalledOnce();
  expect([...new Uint8Array((await speech.read('two')).pcm)]).toEqual([3, 4]);
  expect((await speech.read('two')).done).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

// Oct 21 read-aloud failure: timeout diagnostics previously became generic IPC
// failures. Unit: native synthesis with fake time; assert the safe public cause.
it('keeps the safe headers-timeout cause and aborts native synthesis', async () => {
  vi.useFakeTimers();
  try {
    const diagnostic = vi.fn();
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private network detail')),
            { once: true },
          );
        }),
    );
    const speech = new SpeechSynthesisSession({
      connection: () => ({
        baseUrl: 'https://provider.test/api/v1',
        protocol: 'qwen-tts',
        headers: {},
      }),
      assertCurrent: () => {},
      fetch: fetcher,
      diagnostic,
    });
    const result = expect(speech.start(input)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(
      diagnostic.mock.calls.map(([event]) => event).filter((event) => event.stage === 'error'),
    ).toEqual([expect.objectContaining({ code: 'headers_timeout' })]);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private network detail');
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('preserves a stalled native audio read as timeout after cancelling its stream', async () => {
  vi.useFakeTimers();
  try {
    const cancelled = vi.fn();
    const diagnostic = vi.fn();
    const speech = new SpeechSynthesisSession({
      connection: () => ({
        baseUrl: 'https://provider.test/api/v1',
        protocol: 'dashscope-tts',
        headers: {},
      }),
      assertCurrent: () => {},
      diagnostic,
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('data: {"output":{"audio":{"data":"AQI="}}}\n\n'),
                );
              },
              cancel: cancelled,
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    });
    await speech.start(input);
    expect(new Uint8Array((await speech.read('one')).pcm)).toEqual(new Uint8Array([1, 2]));
    const result = expect(speech.read('one')).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'error',
        code: 'read_timeout',
        bytes: 2,
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});
