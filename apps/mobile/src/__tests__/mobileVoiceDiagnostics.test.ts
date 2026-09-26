import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async () => null),
  setSecureItem: vi.fn(async () => undefined),
  deleteSecureItem: vi.fn(async () => undefined),
}));
vi.mock('@/session/mobileRealtimeAudio', () => ({ startMobileRealtimeAudio: vi.fn() }));

import type { AsrEvent, AsrProvider, AudioTrace, RefinementResult } from '@cindy/voice-input-core';
import { setMobileDebugSink } from '@/debug/mobileDebugLog';
import { serializeMobileDebugRecord } from '@/debug/mobileDebugRecord';
import type { StoredMobileVoiceCredential } from '@/session/mobileVoiceCredentialStore';
import { createMobileVoiceControllerSession } from '@/session/mobileVoiceController';

const SPOKEN = '周五下午三点和财务对预算';
const REFINED = '周五下午 3 点和财务核对预算。';

class SpeakingAsr implements AsrProvider {
  private callback: (event: AsrEvent) => void = () => {};
  async start(): Promise<void> {
    this.callback({ type: 'connected', at: Date.now() });
  }
  async stop(): Promise<void> {}
  appendAudio(): void {
    this.callback({ type: 'partial', text: SPOKEN.slice(0, 4), at: Date.now() });
  }
  async flushAudio(): Promise<void> {
    this.callback({ type: 'stable', text: SPOKEN, at: Date.now() });
  }
  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }
}

function credential(): StoredMobileVoiceCredential {
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-09-26T00:00:00.000Z',
    proxyBaseUrl: 'https://voice.example.test/proxy',
    proxyApiKey: '',
    hostDeviceId: 'host-a',
    storageVersion: 1,
    syncedAt: '2026-09-26T00:01:00.000Z',
    asr: {
      provider: 'litellm-volcengine-sauc-asr',
      model: 'volcengine-sauc-asr',
      auth: 'api-key',
      mode: 'provider-native-websocket',
      pcmSampleRate: 16_000,
      protocolProfile: 'volcengine-sauc-duration',
      resourceId: 'volc.seedasr.sauc.duration',
    },
    refiner: {
      provider: 'managed',
      model: 'auto',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    },
  };
}

async function startAudibleAudio({
  onChunk,
}: {
  onChunk: (chunk: { pcm16: ArrayBuffer; trace: AudioTrace }) => void;
}): Promise<() => Promise<void>> {
  onChunk({
    pcm16: new Int16Array(160).fill(1000).buffer,
    trace: { capturedAt: 1, convertedAt: 2, chunkIndex: 1, sampleRate: 16000, durationMs: 10 },
  });
  return async () => undefined;
}

let records: string[] = [];
beforeEach(() => {
  records = [];
  setMobileDebugSink((level, scope, args) =>
    records.push(serializeMobileDebugRecord(level, scope, args)),
  );
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setMobileDebugSink(undefined);
  vi.restoreAllMocks();
});

const messages = () =>
  records.map(
    (line) => JSON.parse(line) as { scope: string; args: [string, Record<string, unknown>?] },
  );

describe('mobile voice diagnostics', () => {
  it('records the run stages and summaries in the voice scope without any dictated text', async () => {
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr: new SpeakingAsr(),
      refiner: {
        async refine(input): Promise<RefinementResult> {
          return {
            accepted: true,
            sourceSegmentIds: input.segmentIds,
            basedOnText: input.text,
            refinedText: REFINED,
            elapsedMs: 12,
          };
        },
      },
      startAudio: startAudibleAudio,
      onDraftChanged: () => {},
    });
    await session.start();
    await session.stop();

    const logged = messages();
    expect(logged.every((record) => record.scope === 'voice')).toBe(true);
    const names = logged.map((record) => record.args[0]);
    for (const name of [
      'start',
      'capture live',
      'stop requested',
      'latency summary',
      'refinement latency summary',
      'stop finished',
    ]) {
      expect(names).toContain(name);
    }
    const summary = logged.find((record) => record.args[0] === 'latency summary')!.args[1]!;
    expect(summary).toMatchObject({
      provider: 'litellm-volcengine-sauc-asr',
      submitSource: 'stable',
      chars: SPOKEN.length,
    });
    const refinement = logged.find((record) => record.args[0] === 'refinement latency summary')!
      .args[1]!;
    expect(refinement).toMatchObject({
      outcome: 'accepted',
      basedOnChars: SPOKEN.length,
      refinedChars: REFINED.length,
    });

    const everything = records.join('');
    for (const fragment of [SPOKEN, SPOKEN.slice(0, 4), REFINED, '财务'])
      expect(everything).not.toContain(fragment);
  });

  it('tells runs apart, logs ASR readiness, and treats no_change as a normal outcome', async () => {
    const originalCrypto = globalThis.crypto;
    // React Native has no crypto.randomUUID; ids then share a fixed prefix.
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      const runIds: unknown[] = [];
      for (let run = 0; run < 2; run++) {
        records = [];
        const session = createMobileVoiceControllerSession({
          credential: credential(),
          initialDraft: '',
          asr: new SpeakingAsr(),
          refiner: {
            async refine(input): Promise<RefinementResult> {
              return {
                accepted: false,
                sourceSegmentIds: input.segmentIds,
                basedOnText: input.text,
                refinedText: input.text,
                rejectionReason: 'no_change',
                elapsedMs: 5,
              };
            },
          },
          startAudio: startAudibleAudio,
          onDraftChanged: () => {},
        });
        await session.start();
        await session.stop();
        const logged = messages();
        const ids = new Set(logged.map((record) => record.args[1]?.runId).filter(Boolean));
        expect(ids.size).toBe(1);
        runIds.push([...ids][0]);
        expect(logged.map((record) => record.args[0])).toContain('asr ready');
        const refinement = JSON.parse(
          records.find((line) => line.includes('refinement latency summary'))!,
        ) as { level: string };
        expect(refinement.level).toBe('info');
      }
      expect(runIds[0]).not.toBe(runIds[1]);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    }
  });

  it('logs a silent recording ending without ASR finalization', async () => {
    class QuietAsr extends SpeakingAsr {
      appendAudio(): void {}
    }
    const session = createMobileVoiceControllerSession({
      credential: credential(),
      initialDraft: '',
      asr: new QuietAsr(),
      refiner: null,
      startAudio: async ({ onChunk }) => {
        onChunk({
          pcm16: new Int16Array(320).buffer,
          trace: {
            capturedAt: 1,
            convertedAt: 2,
            chunkIndex: 1,
            sampleRate: 16000,
            durationMs: 20,
          },
        });
        return async () => undefined;
      },
      onDraftChanged: () => {},
    });
    await session.start();
    records = [];
    await session.stop();
    const logged = messages();
    const stop = logged.find((record) => record.args[0] === 'stop requested')!.args[1]!;
    expect(stop).toMatchObject({ captureLive: true, soundDetected: false, hasTranscript: false });
    expect(logged.map((record) => record.args[0])).toContain(
      'silent recording ended without ASR finalization',
    );
    expect(logged.map((record) => record.args[0])).not.toContain('latency summary');
  });
});
