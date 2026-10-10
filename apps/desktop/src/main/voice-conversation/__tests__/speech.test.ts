import { describe, expect, it, vi } from 'vitest';
import { SpeechSynthesisSession } from '../speech.js';

const make = (
  fetcher: typeof fetch = vi.fn(
    async () => new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/pcm' } }),
  ),
) => {
  const assertCurrent = vi.fn();
  const speech = new SpeechSynthesisSession({
    connection: () => ({ baseUrl: 'https://gateway.test/prefix/v1/', apiKey: 'test-key' }),
    fetch: fetcher,
    assertCurrent,
  });
  return { speech, fetcher, assertCurrent };
};
const input = { requestId: 'one', modelId: 'speech-model', voice: 'alloy', text: 'hello' };

describe('speech transport', () => {
  it('preserves the server-provided endpoint prefix, sends the selected model, and pulls binary PCM', async () => {
    const { speech, fetcher } = make();
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
    const { speech } = make(
      vi.fn(async () => new Response('upstream-sensitive-error', { status: 401 })),
    );
    await expect(speech.start(input)).rejects.toThrow(/^request$/);
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
