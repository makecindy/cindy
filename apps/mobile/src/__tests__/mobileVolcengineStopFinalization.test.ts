import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setMobileDebugSink } from '@/debug/mobileDebugLog';
import { gzip } from 'pako';
import type { AsrEvent } from '@cindy/voice-input-core';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import {
  MobileVolcengineSaucAsrProvider,
  definiteVolcengineTranscriptPrefix,
  getVolcengineTranscriptConfirmation,
} from '@/session/mobileRealtimeAsrProvider';

const RATE = 16_000;

// The stop decision is logged to the voice Debug log; capture it per test.
let decisions: Array<{ fastFinish: boolean; missedReasons: string[] }> = [];
beforeEach(() => {
  decisions = [];
  setMobileDebugSink((_level, _scope, args) => {
    if (args[0] === 'volcengine sauc stop finalization decision') {
      decisions.push(args[1] as { fastFinish: boolean; missedReasons: string[] });
    }
  });
});
afterEach(() => setMobileDebugSink(undefined));

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: ArrayBuffer): void {
    this.sent.push(new Uint8Array(data));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(data: ArrayBuffer): void {
    this.onmessage?.({ data });
  }
}

type Utterance = { text: string; definite: boolean; end_time?: number };

function responsePacket(text: string, utterances: Utterance[], last = false): ArrayBuffer {
  const payload = gzip(JSON.stringify({ result: { text, utterances } }));
  // Full server response, JSON + gzip. The protocol last response carries a
  // negative sequence (flag 0x3) before the payload size.
  const header = last ? 12 : 8;
  const packet = new Uint8Array(header + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([0x11, last ? 0x93 : 0x90, 0x11, 0x00], 0);
  if (last) view.setInt32(4, -2, false);
  view.setUint32(header - 4, payload.length, false);
  packet.set(payload, header);
  return packet.buffer;
}

function pcm(ms: number, peak: number): ArrayBuffer {
  const samples = new Int16Array((RATE * ms) / 1000);
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.round(peak * Math.sin((2 * Math.PI * i) / 16));
  return samples.buffer;
}

function credential(): StoredMobileVoiceCredential {
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-09-26T00:00:00.000Z',
    proxyBaseUrl: 'https://voice.example.test/proxy',
    proxyApiKey: 'sk-mobile-voice',
    hostDeviceId: 'host-a',
    storageVersion: 1,
    syncedAt: '2026-09-26T00:01:00.000Z',
    asr: {
      provider: 'litellm-volcengine-sauc-asr',
      model: 'volcengine-sauc-asr',
      auth: 'api-key',
      mode: 'provider-native-websocket',
      endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
      pcmSampleRate: RATE,
      protocolProfile: 'volcengine-sauc-duration',
      resourceId: 'volc.seedasr.sauc.duration',
    },
    refiner: {
      provider: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    },
  };
}

async function startedProvider(flushTimeoutMs = 60_000): Promise<{
  provider: MobileVolcengineSaucAsrProvider;
  socket: FakeSocket;
  events: AsrEvent[];
}> {
  FakeSocket.instances = [];
  const events: AsrEvent[] = [];
  const provider = new MobileVolcengineSaucAsrProvider({
    credential: credential(),
    websocketFactory: FakeSocket as never,
    flushTimeoutMs,
    connectionProvider: async () => ({
      websocketUrl: 'wss://voice.example.test/sauc',
      authorizationToken: 'ticket',
    }),
  });
  provider.onEvent((event) => events.push(event));
  const started = provider.start();
  for (let i = 0; i < 10 && FakeSocket.instances.length === 0; i++) await Promise.resolve();
  const socket = FakeSocket.instances[0];
  socket.open();
  await started;
  return { provider, socket, events };
}

/** Resolves true when flushAudio settled without any further server response. */
async function settlesWithoutFinalResponse(flush: Promise<void>): Promise<boolean> {
  const pending = Symbol('pending');
  const result = await Promise.race([
    flush.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(pending), 20)),
  ]);
  return result === true;
}

const isFinalAudioPacket = (bytes: Uint8Array | undefined): boolean => bytes?.[1] === 0x23;

describe('mobile Volcengine SAUC transcript confirmation', () => {
  it('confirms only an aggregate whose utterances are all definite and cover the text', () => {
    const payload = (utterances: Utterance[], text = '你好。今天开会。') => ({
      result: { text, utterances },
    });
    expect(
      getVolcengineTranscriptConfirmation(
        payload([
          { text: '你好。', definite: true, end_time: 800 },
          { text: '今天开会。', definite: true, end_time: 2100 },
        ]),
        '你好。今天开会。',
      ),
    ).toEqual({ confirmed: true, endMs: 2100 });
    // A confirmed first sentence must not confirm an unfinished tail.
    expect(
      getVolcengineTranscriptConfirmation(
        payload([
          { text: '你好。', definite: true, end_time: 800 },
          { text: '今天开会。', definite: false, end_time: 2100 },
        ]),
        '你好。今天开会。',
      ).confirmed,
    ).toBe(false);
    // Utterances that do not add up to the transcript are not evidence.
    expect(
      getVolcengineTranscriptConfirmation(
        payload([{ text: '你好。', definite: true, end_time: 800 }]),
        '你好。今天开会。',
      ).confirmed,
    ).toBe(false);
    // Missing or invalid timestamps keep confirmation but give no position.
    expect(
      getVolcengineTranscriptConfirmation(
        payload([{ text: '你好。今天开会。', definite: true }]),
        '你好。今天开会。',
      ),
    ).toEqual({ confirmed: true, endMs: 0 });
    expect(
      getVolcengineTranscriptConfirmation({ result: { text: 'x', definite: true } }, 'x').confirmed,
    ).toBe(false);
  });
});

describe('mobile Volcengine SAUC stop finalization', () => {
  it('sends every audio packet immediately instead of holding one back', async () => {
    const { provider, socket } = await startedProvider();
    const before = socket.sent.length;
    provider.appendAudio(pcm(40, 3000));
    expect(socket.sent.length).toBe(before + 1);
    provider.appendAudio(pcm(40, 3000));
    expect(socket.sent.length).toBe(before + 2);
  });

  it('skips waiting for the final response when the full transcript is confirmed past the last sound', async () => {
    const { provider, socket, events } = await startedProvider();
    provider.appendAudio(pcm(500, 3000));
    provider.appendAudio(pcm(2500, 0));
    socket.receive(responsePacket('你好。', [{ text: '你好。', definite: true, end_time: 520 }]));
    expect(events.at(-1)).toMatchObject({ type: 'stable', text: '你好。' });

    expect(await settlesWithoutFinalResponse(provider.flushAudio())).toBe(true);
    // The protocol final packet is still sent; only the wait is skipped.
    expect(isFinalAudioPacket(socket.sent.at(-1))).toBe(true);
    expect(decisions).toEqual([expect.objectContaining({ fastFinish: true, missedReasons: [] })]);
  });

  it('publishes stable when only the confirmation state changes', async () => {
    const { provider, socket, events } = await startedProvider();
    provider.appendAudio(pcm(500, 3000));
    socket.receive(responsePacket('你好。', [{ text: '你好。', definite: false, end_time: 520 }]));
    socket.receive(responsePacket('你好。', [{ text: '你好。', definite: true, end_time: 520 }]));
    expect(
      events
        .filter((event) => event.type === 'partial' || event.type === 'stable')
        .map((event) => event.type),
    ).toEqual(['partial', 'stable']);
  });

  it.each([
    [
      'an unconfirmed tail',
      [
        { text: '你好。', definite: true, end_time: 520 },
        { text: '今天', definite: false, end_time: 900 },
      ],
      '你好。今天',
      2500,
      'transcript_not_fully_confirmed',
    ],
    [
      'sound after the confirmed position',
      [{ text: '你好。', definite: true, end_time: 200 }],
      '你好。',
      2500,
      'sound_after_confirmed_audio',
    ],
    [
      'less than 2 s of silence',
      [{ text: '你好。', definite: true, end_time: 520 }],
      '你好。',
      1500,
      'silence_under_2000ms',
    ],
    [
      'a missing timestamp',
      [{ text: '你好。', definite: true }],
      '你好。',
      2500,
      'no_confirmed_audio_position',
    ],
  ] as const)(
    'waits for the final response with %s',
    async (_label, utterances, text, silenceMs, expectedReason) => {
      const { provider, socket, events } = await startedProvider();
      provider.appendAudio(pcm(500, 3000));
      provider.appendAudio(pcm(silenceMs, 0));
      socket.receive(responsePacket(text, [...utterances]));

      const flush = provider.flushAudio();
      expect(await settlesWithoutFinalResponse(flush)).toBe(false);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].fastFinish).toBe(false);
      expect(decisions[0].missedReasons).toContain(expectedReason);
      socket.receive(
        responsePacket(
          '你好。今天开会。',
          [{ text: '你好。今天开会。', definite: true, end_time: 2400 }],
          true,
        ),
      );
      await flush;
      expect(events.at(-1)).toMatchObject({
        type: 'stable',
        text: '你好。今天开会。',
      });
    },
  );

  it('always waits after a recovery replay restarted the audio clock', async () => {
    const { provider, socket } = await startedProvider();
    provider.appendAudio(pcm(500, 3000));
    const recovered = provider.recover();
    for (let i = 0; i < 10 && FakeSocket.instances.length < 2; i++) await Promise.resolve();
    const nextSocket = FakeSocket.instances[1];
    nextSocket.open();
    await recovered;
    expect(socket.readyState).toBe(3);
    provider.appendAudio(pcm(2500, 0));
    nextSocket.receive(
      responsePacket('你好。', [{ text: '你好。', definite: true, end_time: 520 }]),
    );

    const flush = provider.flushAudio();
    expect(await settlesWithoutFinalResponse(flush)).toBe(false);
    nextSocket.receive(
      responsePacket('你好。', [{ text: '你好。', definite: true, end_time: 520 }], true),
    );
    await flush;
  });
});

describe('mobile Volcengine SAUC recovery prefix', () => {
  it('finalizes only the leading definite utterances of an aggregate', () => {
    const payload = (text: string, utterances: Utterance[]) => ({ result: { text, utterances } });
    expect(
      definiteVolcengineTranscriptPrefix(
        payload('你好。今天开会', [
          { text: '你好。', definite: true, end_time: 800 },
          { text: '今天开会', definite: false },
        ]),
        '你好。今天开会',
      ),
    ).toBe('你好。');
    // Whitespace the aggregate inserts between utterances is tolerated.
    expect(
      definiteVolcengineTranscriptPrefix(
        payload('Hello. Meet today', [
          { text: 'Hello.', definite: true },
          { text: 'Meet today', definite: false },
        ]),
        'Hello. Meet today',
      ),
    ).toBe('Hello.');
    expect(
      definiteVolcengineTranscriptPrefix(
        payload('你好', [{ text: '你好', definite: false }]),
        '你好',
      ),
    ).toBe('');
    // Legacy responses without utterances keep the whole-aggregate marker.
    expect(
      definiteVolcengineTranscriptPrefix({ result: { text: '你好', definite: true } }, '你好'),
    ).toBe('你好');
  });

  it('lets a recovery replay correct an indefinite tail after an earlier definite sentence', async () => {
    const { provider, socket, events } = await startedProvider();
    provider.appendAudio(pcm(500, 3000));
    socket.receive(
      responsePacket('你好。今天看', [
        { text: '你好。', definite: true, end_time: 400 },
        { text: '今天看', definite: false },
      ]),
    );
    const recovered = provider.recover();
    for (let i = 0; i < 10 && FakeSocket.instances.length < 2; i++) await Promise.resolve();
    const nextSocket = FakeSocket.instances[1];
    nextSocket.open();
    await recovered;
    // The replay corrects the misheard tail instead of appending after it.
    nextSocket.receive(
      responsePacket('今天开会。', [{ text: '今天开会。', definite: true, end_time: 900 }]),
    );
    expect(events.at(-1)).toMatchObject({ type: 'stable', text: '你好。今天开会。' });
  });
});
