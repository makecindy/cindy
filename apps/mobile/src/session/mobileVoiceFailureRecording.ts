/** Personal experiment only. Never enable this flag in a distributed build/OTA. */
import type { AsrProvider } from '@cindy/voice-input-core';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

type Fields = Record<string, string | number | boolean | undefined>;
type Track = { chunks: Uint8Array[]; bytes: number; storedBytes: number; sampleRate: number };
export type VoiceDiagnosticAttempt = { id: number; sessionId?: string; audio: Track };
const recordings = new WeakMap<AsrProvider, MobileVoiceFailureRecording>();
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 512;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DIRECTORY = 'voice-failure-diagnostics/';
let storageTail = Promise.resolve();
let subscribed = false;

function storageJob(job: () => Promise<void>): Promise<void> {
  storageTail = storageTail.then(job).catch(() => {
    // Do not log file contents, error text, credentials or dictated words.
    mobileDebugLog('warn', 'voice', 'local failure recording storage unavailable');
  });
  return storageTail;
}

/** Cleanup runs on the next diagnostic use, not while the OS suspends the app. */
async function prune(keep = 3): Promise<void> {
  const fs = await import('expo-file-system/legacy');
  if (!fs.cacheDirectory) return;
  const root = fs.cacheDirectory + DIRECTORY;
  if (!(await fs.getInfoAsync(root)).exists) return;
  const names = (await fs.readDirectoryAsync(root))
    .filter((name) => /^\d{13}-[a-z0-9]+$/.test(name)).sort().reverse();
  for (const [index, name] of names.entries()) {
    if (index >= keep || Date.now() - Number(name.slice(0, 13)) >= MAX_AGE_MS) {
      await fs.deleteAsync(root + name, { idempotent: true });
    }
  }
}

export function createMobileVoiceFailureRecording(): MobileVoiceFailureRecording | undefined {
  if (process.env.EXPO_PUBLIC_VOICE_FAILURE_DIAGNOSTICS !== '1') return undefined;
  if (!getMobileAuthOwner().accountKey) return undefined;
  if (!subscribed) {
    subscribed = true;
    subscribeMobileAuthOwner(() => { void storageJob(() => prune(0)); });
  }
  void storageJob(() => prune());
  return new MobileVoiceFailureRecording();
}

export function bindMobileVoiceFailureRecording<T extends AsrProvider>(
  provider: T, recording: MobileVoiceFailureRecording | undefined,
): T {
  if (recording) recordings.set(provider, recording);
  return provider;
}

export function mobileVoiceFailureRecording(provider: AsrProvider): MobileVoiceFailureRecording | undefined {
  return recordings.get(provider);
}

/** No file writes until a terminal failure. All hooks are optional and bounded. */
class MobileVoiceFailureRecording {
  private owner = getMobileAuthOwner();
  private runId = '';
  private startedAt = Date.now();
  private finished = false;
  private retainedBytes = 0;
  private capture: Track = { chunks: [], bytes: 0, storedBytes: 0, sampleRate: 16000 };
  private attempts: VoiceDiagnosticAttempt[] = [];
  private events: Array<Fields & { at: number; kind: string }> = [];
  private droppedEvents = 0;

  begin(runId: string): void {
    if (this.finished) {
      this.owner = getMobileAuthOwner();
      this.startedAt = Date.now();
      this.finished = false;
    }
    this.runId = runId;
    this.event('start');
  }

  private active(): boolean {
    return !this.finished && !!this.owner.accountKey && isMobileAuthOwnerCurrent(this.owner);
  }

  event(kind: string, fields: Fields = {}): void {
    if (!this.active()) return;
    // Keep the tail, including the final response, even for a long recording.
    if (this.events.length >= MAX_EVENTS) { this.droppedEvents++; this.events.shift(); }
    this.events.push({ ...fields, at: Date.now(), kind });
  }

  connection(sampleRate: number, sessionId?: string): VoiceDiagnosticAttempt | undefined {
    if (!this.active() || this.attempts.length >= 8) return undefined;
    const attempt = {
      id: this.attempts.length + 1,
      // Only an opaque server UUID. Never retain a URL, ticket or authorization header.
      sessionId: sessionId && /^[a-f0-9-]{36}$/i.test(sessionId) ? sessionId : undefined,
      audio: { chunks: [], bytes: 0, storedBytes: 0, sampleRate },
    };
    this.attempts.push(attempt);
    this.event('connection', { attempt: attempt.id, sessionId: attempt.sessionId });
    return attempt;
  }

  captured(pcm: ArrayBuffer, sampleRate: number): void {
    if (!this.active()) return;
    this.append(this.capture, new Uint8Array(pcm), sampleRate);
  }

  sent(attempt: VoiceDiagnosticAttempt | undefined, pcm: Uint8Array, sequence: number, wireBytes: number): void {
    if (!this.active() || !attempt || !this.attempts.includes(attempt)) return;
    this.append(attempt.audio, pcm, attempt.audio.sampleRate);
    this.event('socket_send_returned', { attempt: attempt.id, sequence, pcmBytes: pcm.byteLength, wireBytes });
  }

  private append(track: Track, pcm: Uint8Array, sampleRate: number): void {
    track.bytes += pcm.byteLength;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || pcm.byteLength % 2) {
      this.event('invalid_pcm'); return;
    }
    if (track.storedBytes && track.sampleRate !== sampleRate) {
      this.event('sample_rate_changed', { sampleRate }); return;
    }
    track.sampleRate = sampleRate;
    const length = Math.min(pcm.byteLength, MAX_BYTES - this.retainedBytes) & ~1;
    if (length <= 0) return;
    track.chunks.push(pcm.slice(0, length));
    track.storedBytes += length;
    this.retainedBytes += length;
  }

  /** Success/cancel never write. A subsequent cancel cannot erase a recorded failure. */
  finish(reason?: string): Promise<void> {
    if (this.finished) return Promise.resolve();
    const shouldSave = this.active() && !!reason && !!this.runId;
    this.finished = true;
    const capture = this.capture;
    const attempts = this.attempts;
    const owner = this.owner;
    const metadata = {
      version: 1, runId: this.runId, startedAt: this.startedAt, endedAt: Date.now(), reason,
      boundary: 'capture = PCM delivered to JS before speaker filter; sent = PCM whose socket.send returned, NOT server receipt',
      supportedWireAudio: 'volcengine-sauc-duration only; other providers have capture/timeline only',
      events: this.events, droppedEvents: this.droppedEvents,
    };
    this.capture = { chunks: [], bytes: 0, storedBytes: 0, sampleRate: 16000 };
    this.attempts = [];
    this.events = [];
    this.droppedEvents = 0;
    this.retainedBytes = 0;
    if (!shouldSave) return Promise.resolve();
    return storageJob(async () => {
      if (!isMobileAuthOwnerCurrent(owner)) return;
      const fs = await import('expo-file-system/legacy');
      if (!fs.cacheDirectory) return;
      await prune(2);
      const directory = `${fs.cacheDirectory}${DIRECTORY}${Date.now()}-${Math.random().toString(36).slice(2)}/`;
      try {
        await fs.makeDirectoryAsync(directory, { intermediates: true });
        const tracks = [{ name: 'capture', track: capture }, ...attempts.map((a) => ({ name: `sent-${a.id}`, track: a.audio }))];
        for (const { name, track } of tracks) {
          if (!isMobileAuthOwnerCurrent(owner)) return;
          if (track.storedBytes) await fs.writeAsStringAsync(directory + name + '.wav', wavBase64(track), { encoding: fs.EncodingType.Base64 });
        }
        if (!isMobileAuthOwnerCurrent(owner)) return;
        await fs.writeAsStringAsync(directory + 'manifest.json', JSON.stringify({
          ...metadata,
          attempts: attempts.map(({ id, sessionId }) => ({ id, sessionId })),
          tracks: tracks.map(({ name, track }) => ({ name, sampleRate: track.sampleRate, bytes: track.bytes, storedBytes: track.storedBytes, truncated: track.bytes !== track.storedBytes })),
        }, null, 2));
        mobileDebugLog('info', 'voice', 'local failure recording saved', { runId: metadata.runId, directory });
      } catch (error) {
        await fs.deleteAsync(directory, { idempotent: true }).catch(() => undefined);
        throw error;
      } finally {
        if (!isMobileAuthOwnerCurrent(owner)) await fs.deleteAsync(directory, { idempotent: true });
      }
    });
  }
}

function wavBase64(track: Track): string {
  const bytes = new Uint8Array(44 + track.storedBytes);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  }
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, track.sampleRate, true); view.setUint32(28, track.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, track.storedBytes, true);
  let offset = 44;
  for (const chunk of track.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  // Chunked string conversion avoids spreading a multi-megabyte typed array.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
