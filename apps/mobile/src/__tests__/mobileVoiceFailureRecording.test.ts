// Test value: personal failure-only recording is a new persistence/privacy boundary.
// Existing text-only diagnostics tests cannot exercise WAV files, retention or ownership.
// Minimal inputs: a PCM chunk followed by success/cancel/failure, and an account switch
// during a write. Unit tier uses an in-memory filesystem, no native I/O or real timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsrEvent, AsrProvider } from '@cindy/voice-input-core';
import { ungzip } from 'pako';

const disk = vi.hoisted(() => ({ files: new Map<string, string>(), onWrite: undefined as undefined | (() => void) }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' },
  getInfoAsync: async (path: string) => ({ exists: [...disk.files.keys()].some((p) => p.startsWith(path)) }),
  readDirectoryAsync: async (path: string) => [...new Set([...disk.files.keys()].filter((p) => p.startsWith(path)).map((p) => p.slice(path.length).split('/')[0]))],
  makeDirectoryAsync: async () => undefined,
  writeAsStringAsync: async (path: string, text: string) => { disk.files.set(path, text); disk.onWrite?.(); },
  deleteAsync: async (path: string) => { for (const key of disk.files.keys()) if (key.startsWith(path)) disk.files.delete(key); },
}));
vi.mock('@/auth/secureStorage', () => ({ getSecureItem: vi.fn(async () => null) }));
vi.mock('@/session/mobileRealtimeAudio', () => ({ startMobileRealtimeAudio: vi.fn() }));
vi.mock('@/config/env', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config/env')>(),
  VOICE_API_BASE_URL: 'https://voice.example.invalid',
}));

import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { bindMobileVoiceFailureRecording, createMobileVoiceFailureRecording } from '@/session/mobileVoiceFailureRecording';
import { createMobileVoiceControllerSession } from '@/session/mobileVoiceController';
import { createMobileCindyVoiceCredential } from '@/session/mobileCindyVoiceSession';
import { __testing as prewarm } from '@/session/mobileVoicePrewarm';
import { MobileVolcengineSaucAsrProvider } from '@/session/mobileRealtimeAsrProvider';

const pcm = new Int16Array([1000, -2000, 3000, -4000]).buffer;
const root = 'file:///cache/voice-failure-diagnostics/';
function recording() {
  const r = createMobileVoiceFailureRecording()!;
  r.begin('voice-test-run');
  return r;
}
function manifest() {
  const entry = [...disk.files].find(([path]) => path.endsWith('/manifest.json'));
  return entry ? JSON.parse(entry[1]) : undefined;
}
function wav(suffix: string) {
  return Buffer.from([...disk.files].find(([path]) => path.endsWith(suffix))![1], 'base64');
}

beforeEach(() => {
  vi.stubEnv('EXPO_PUBLIC_VOICE_FAILURE_DIAGNOSTICS', '1');
  disk.files.clear(); disk.onWrite = undefined;
  setMobileAuthOwner('diagnostics-test-account');
});
afterEach(() => { vi.unstubAllEnvs(); disk.onWrite = undefined; });

describe('personal mobile failure recordings', () => {
  it('records actual SAUC sends, retry connections, final silence and empty responses', async () => {
    const frames: ArrayBuffer[] = [];
    class Socket {
      readyState = 0;
      onopen: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror = null;
      onclose = null;
      constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); }); }
      close() { this.readyState = 3; }
      send(data: string | ArrayBuffer) {
        if (typeof data === 'string') return;
        frames.push(data);
        if (new Uint8Array(data)[1] !== 0x23) return;
        const payload = new TextEncoder().encode('{"result":{"text":""}}');
        const reply = new Uint8Array(12 + payload.length);
        reply.set([0x11, 0x93, 0x10, 0]);
        const view = new DataView(reply.buffer);
        view.setInt32(4, -3); view.setUint32(8, payload.length); reply.set(payload, 12);
        queueMicrotask(() => this.onmessage?.({ data: reply.buffer }));
      }
    }
    const r = recording();
    const provider = new MobileVolcengineSaucAsrProvider({
      credential: createMobileCindyVoiceCredential('test-host'), failureRecording: r,
      websocketFactory: Socket,
      connectionProvider: async () => ({ websocketUrl: 'wss://test.invalid', authorizationToken: 'fake-ticket', sessionId: '11111111-1111-4111-8111-111111111111' }),
    });
    await provider.start();
    provider.appendAudio(pcm, { sampleRate: 16000, capturedAt: 1, convertedAt: 1, chunkIndex: 0, durationMs: 0.25 });
    await provider.flushAudio();
    await provider.recover();
    await provider.flushAudio();
    await r.finish('empty_transcript');
    await provider.stop();
    const wirePcm = frames.filter((f) => new Uint8Array(f)[1] === 0x21).map((f) => Buffer.from(ungzip(new Uint8Array(f).subarray(12))));
    expect(wirePcm).toEqual([Buffer.from(pcm), Buffer.from(pcm)]);
    for (const id of [1, 2]) {
      expect(wav(`sent-${id}.wav`).subarray(44, 44 + pcm.byteLength)).toEqual(Buffer.from(pcm));
      expect(wav(`sent-${id}.wav`).length).toBe(44 + pcm.byteLength + 9600);
    }
    expect(manifest().events.filter((e: { kind: string }) => e.kind === 'response')).toEqual([
      expect.objectContaining({ attempt: 1, transcriptChars: 0, flags: 3, hasParsedPayload: true }),
      expect.objectContaining({ attempt: 2, transcriptChars: 0, flags: 3, hasParsedPayload: true }),
    ]);
  });

  it('is opt-in and requires a signed-in owner', () => {
    vi.stubEnv('EXPO_PUBLIC_VOICE_FAILURE_DIAGNOSTICS', '');
    expect(createMobileVoiceFailureRecording()).toBeUndefined();
    vi.stubEnv('EXPO_PUBLIC_VOICE_FAILURE_DIAGNOSTICS', '1');
    setMobileAuthOwner(null);
    expect(createMobileVoiceFailureRecording()).toBeUndefined();
    expect(disk.files.size).toBe(0);
  });

  it('saves exact capture and per-connection PCM as playable WAV, without URLs/tickets', async () => {
    const r = recording();
    r.captured(pcm, 16000);
    const first = r.connection(16000, '11111111-1111-4111-8111-111111111111');
    const second = r.connection(16000, 'wss://private.invalid/?ticket=SECRET');
    r.sent(first, new Uint8Array(pcm), 2, 40);
    r.sent(second, new Uint8Array(pcm), 2, 40);
    r.event('response', { attempt: 2, transcriptChars: 0, flags: 3 });
    await r.finish('empty_transcript');
    expect(wav('capture.wav').subarray(44)).toEqual(Buffer.from(pcm));
    expect(wav('sent-1.wav').subarray(44)).toEqual(Buffer.from(pcm));
    expect(wav('sent-2.wav').subarray(44)).toEqual(Buffer.from(pcm));
    expect(wav('capture.wav').readUInt32LE(24)).toBe(16000);
    expect(wav('capture.wav').readUInt32LE(40)).toBe(pcm.byteLength);
    expect(manifest().attempts).toHaveLength(2);
    expect(JSON.stringify(manifest())).not.toContain('SECRET');
    await r.finish(); // teardown after an error must not delete the evidence
    expect(manifest().reason).toBe('empty_transcript');
  });

  it('discards successful/cancelled runs and rejects late callbacks from that run', async () => {
    const r = recording();
    r.captured(pcm, 16000);
    const old = r.connection(16000);
    await r.finish();
    r.captured(pcm, 16000);
    await r.finish('late_error');
    expect(disk.files.size).toBe(0);
    r.begin('next-run');
    r.sent(old, new Uint8Array(pcm), 3, 40);
    await r.finish('silent_empty');
    expect(manifest().attempts).toEqual([]);
    expect(manifest().tracks[0].bytes).toBe(0);
  });

  it('caps retained PCM and retains the final diagnostic event after many packets', async () => {
    const r = recording();
    const large = new Uint8Array(9 * 1024 * 1024);
    r.captured(large.buffer, 16000);
    for (let i = 0; i < 600; i++) r.event('send', { sequence: i });
    r.event('response', { flags: 3, transcriptChars: 0 });
    await r.finish('empty_transcript');
    expect(manifest().tracks[0]).toMatchObject({ bytes: large.length, storedBytes: 8 * 1024 * 1024, truncated: true });
    expect(manifest().events.at(-1).kind).toBe('response');
    expect(manifest().droppedEvents).toBeGreaterThan(0);
  });

  it('prunes expired/overflow bundles while leaving unrelated cache files alone', async () => {
    const first = recording(); await first.finish(); // drain initial owner cleanup
    disk.files.set(`${root}${Date.now() - 25 * 3600000}-old/manifest.json`, '{}');
    disk.files.set('file:///cache/other.txt', 'keep');
    for (let i = 0; i < 4; i++) { const r = recording(); await r.finish('silent_empty'); }
    expect([...disk.files.keys()].filter((p) => p.endsWith('manifest.json'))).toHaveLength(3);
    expect([...disk.files.keys()].some((p) => p.includes('-old/'))).toBe(false);
    expect(disk.files.get('file:///cache/other.txt')).toBe('keep');
  });

  it('removes partially written audio when the account changes mid-save', async () => {
    const r = recording(); r.captured(pcm, 16000);
    disk.onWrite = () => { disk.onWrite = undefined; setMobileAuthOwner('other-account'); };
    await r.finish('empty_transcript');
    expect(disk.files.size).toBe(0);
  });

  it('storage failure is best effort and removes incomplete files', async () => {
    const r = recording(); r.captured(pcm, 16000);
    disk.onWrite = () => { throw new Error('disk unavailable'); };
    await expect(r.finish('empty_transcript')).resolves.toBeUndefined();
    expect(disk.files.size).toBe(0);
  });

  it.each(['silent', 'success', 'cancel'] as const)('connects the controller and prewarmed provider: %s', async (outcome) => {
    let listener: (event: AsrEvent) => void = () => {};
    const r = createMobileVoiceFailureRecording()!;
    const provider: AsrProvider = bindMobileVoiceFailureRecording({
      async start() {}, async stop() {}, async flushAudio() {},
      onEvent(callback) { listener = callback; },
      appendAudio() { if (outcome === 'success') listener({ type: 'stable', text: 'test', at: Date.now() }); },
    }, r);
    const session = createMobileVoiceControllerSession({
      credential: createMobileCindyVoiceCredential('fake-host'), initialDraft: '', refiner: null,
      asr: prewarm.withPrewarmedStart(provider, Promise.resolve()), onDraftChanged() {},
      startAudio: async ({ onChunk }) => {
        onChunk({ pcm16: outcome === 'silent' ? new Int16Array(4).buffer : pcm, trace: { sampleRate: 16000, capturedAt: 1, convertedAt: 1, chunkIndex: 0, durationMs: 0.25 } });
        return async () => {};
      },
    });
    await session.start();
    if (outcome === 'cancel') await session.cancel(); else await session.stop();
    // A queued sentinel finish waits for the serial storage boundary without real sleeps.
    const sentinel = recording(); await sentinel.finish('silent_empty');
    const bundles = [...disk.files].filter(([path]) => path.endsWith('manifest.json')).map(([, text]) => JSON.parse(text));
    const controllerBundle = bundles.find((b) => b.runId !== 'voice-test-run');
    if (outcome === 'silent') expect(controllerBundle).toMatchObject({ reason: 'silent_empty', tracks: [expect.objectContaining({ bytes: 8 })] });
    else expect(controllerBundle).toBeUndefined();
  });
});
