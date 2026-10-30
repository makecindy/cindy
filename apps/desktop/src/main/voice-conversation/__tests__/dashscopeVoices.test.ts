import { expect, it, vi } from 'vitest';
import { loadSpeechVoices } from '../voices.js';
import type { SpeechConnection } from '../speech.js';

const model = 'cosyvoice-v3-flash';
const connection: SpeechConnection = {
  protocol: 'dashscope-tts',
  baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1',
  headers: { authorization: 'Bearer test-key' },
};
const json = (output: unknown) => new Response(JSON.stringify({ output }));
const list = (voice_list: unknown[]) => json({ voice_list });
const ready = (voice_id: string, target_model = model) => ({
  voice_id,
  target_model,
  status: 'OK',
});
const load = (fetcher: typeof fetch, modelId = model, baseUrl = connection.baseUrl) =>
  loadSpeechVoices({ ...connection, baseUrl }, modelId, fetcher, () => {});

// Unit tier: exercise the production catalog entry with the documented provider
// response shapes. Prevent cross-model/private voice leakage, lost public fallbacks,
// and unbounded catalog requests without requiring a paid account or audio output.
it('loads the complete Qwen3 system catalog without an account discovery request', async () => {
  const fetcher = vi.fn();
  const result = await loadSpeechVoices(
    { ...connection, protocol: 'qwen-tts' },
    'qwen3-tts-flash',
    fetcher,
    () => {},
  );
  expect(result.source).toBe('reference');
  expect(result.voices).toHaveLength(48);
  expect(result.voices).toContainEqual({ id: 'Cherry', name: '芊悦' });
  expect(result.voices).toContainEqual({ id: 'Eldric Sage', name: '沧明子' });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([
  ['cosyvoice-v3-flash', 88, 32],
  ['cosyvoice-v3-plus', 2, 2],
  ['cosyvoice-v2', 106, 0],
  ['qwen-audio-3.1-tts-flash', 68, 19],
  ['qwen-audio-3.0-tts-plus', 2, 2],
  ['qwen-audio-3.0-tts-flash', 12, 12],
  ['cosyvoice-v3.5-plus', 0, 0],
] as const)('keeps %s system voices specific to the exact model and region', async (id, bj, sg) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => list([]));
  expect((await load(fetcher, id)).voices).toHaveLength(bj);
  const result = await load(
    fetcher,
    id,
    'https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1',
  );
  expect(result.voices).toHaveLength(sg);
  expect(new Set(result.voices.map((voice) => voice.id)).size).toBe(sg);
});

it('merges only ready custom voices bound to the exact model, querying missing metadata', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      list([
        { ...ready('named'), voice_name: 'My Voice', preview_url: 'https://untrusted.test' },
        { voice_id: 'opaque-id', status: 'OK' },
        ready('other', 'cosyvoice-v3-plus'),
        { ...ready('pending'), status: 'DEPLOYING' },
        { ...ready('retired'), status: 'UNDEPLOYED' },
        ready('bad/path'),
        ready('longanyang'),
      ]),
    )
    .mockResolvedValueOnce(
      json({ target_model: model, status: 'OK', resource_link: 'https://untrusted.test' }),
    );
  const result = await load(fetcher);
  expect(result.source).toBe('mixed');
  expect(result.voices).toHaveLength(90);
  expect(result.voices.slice(-2)).toEqual([
    { id: 'named', name: 'My Voice' },
    { id: 'opaque-id', name: 'opaque-id' },
  ]);
  expect(result.voices[0]).toEqual({ id: 'longanyang', name: '龙安洋' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'voice-enrollment',
        input: { action: 'query_voice', voice_id: 'opaque-id' },
      }),
    }),
  );
});

it('paginates in the selected proxy and keeps clone-only model catalogs independent', async () => {
  const customModel = 'cosyvoice-v3.5-plus';
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      list(Array.from({ length: 100 }, (_, i) => ready(`voice-${i}`, customModel))),
    )
    .mockResolvedValueOnce(list([ready('voice-100', customModel), ready('voice-0', customModel)]));
  const result = await load(fetcher, customModel, 'https://proxy.test/prefix/api/v1/');
  expect(result.source).toBe('provider');
  expect(result.voices).toHaveLength(101);
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    'https://proxy.test/prefix/api/v1/services/audio/tts/customization',
    expect.objectContaining({
      body: JSON.stringify({
        model: 'voice-enrollment',
        input: { action: 'list_voice', page_index: 1, page_size: 100 },
      }),
    }),
  );
});

it('never infers a custom voice binding from its ID or copies unknown metadata', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      list([{ voice_id: `${model}-clone`, status: 'OK' }, { voice_id: 'unknown' }]),
    )
    .mockResolvedValueOnce(json({ target_model: 'qwen-audio-3.1-tts-flash', status: 'OK' }))
    .mockResolvedValueOnce(json({ status: 'OK', voice_prompt: 'private prompt' }));
  const result = await load(fetcher);
  expect(result.voices).toHaveLength(88);
  expect(JSON.stringify(result)).not.toContain('private');
});

it.each([
  () => new Response('private error', { status: 403 }),
  () => new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'private error' })),
  () => json({ voice_list: 'invalid' }),
  () => new Response(' '.repeat(2 * 1024 * 1024 + 1)),
])('keeps public voices and a controlled warning when custom discovery fails', async (response) => {
  const result = await load(vi.fn<typeof fetch>().mockResolvedValue(response()));
  expect(result.source).toBe('reference');
  expect(result.voices).toHaveLength(88);
  expect(result).toHaveProperty('customVoicesUnavailable', true);
  expect(JSON.stringify(result)).not.toMatch(/private|InvalidApiKey/);
});

it('does not swallow connection changes in the public-list fallback', async () => {
  let current = true;
  const fetcher = vi.fn(async () => {
    current = false;
    return list([ready('private')]);
  });
  await expect(
    loadSpeechVoices(connection, model, fetcher, () => {
      if (!current) throw new Error('connection_changed');
    }),
  ).rejects.toThrow('connection_changed');
});

it('bounds details and list pages while keeping already verified voices', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body)).input;
    return input.action === 'query_voice'
      ? json({ target_model: model, status: 'OK' })
      : list(
          Array.from({ length: 100 }, (_, i) => ({
            voice_id: `opaque-${input.page_index}-${i}`,
            status: 'OK',
          })),
        );
  });
  const result = await load(fetcher);
  expect(result.truncated).toBe(true);
  expect(result.voices).toHaveLength(188);
  expect(
    fetcher.mock.calls.filter(
      ([, init]) => JSON.parse(String(init?.body)).input.action === 'query_voice',
    ),
  ).toHaveLength(100);
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(110);
});

it('cancels stalled custom discovery at the shared deadline and returns public voices', async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  try {
    const pending = load(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled }))),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(result.voices).toHaveLength(88);
    expect(result).toHaveProperty('customVoicesUnavailable', true);
  } finally {
    vi.useRealTimers();
  }
});
