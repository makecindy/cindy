import type { AsrProvider } from '@cindy/voice-input-core';
import { OggOpusDecoder } from 'ogg-opus-decoder';
import { resamplePcm16 } from './RealtimeAsrWebSocketProvider.js';

/** Passport recordings are bounded mono Opus; decoding never writes audio to disk. */
export async function decodeRecordedOpus(bytes: Uint8Array): Promise<ArrayBuffer> {
  if (!bytes.length || bytes.length > 160_000) throw new Error('Invalid recording size');
  const decoder = new OggOpusDecoder();
  try {
    await decoder.ready;
    const audio = await decoder.decodeFile(bytes);
    if (audio.errors.length || audio.channelData.length !== 1 ||
        !audio.samplesDecoded || audio.samplesDecoded > 31 * audio.sampleRate) {
      throw new Error('Invalid mono Opus recording');
    }
    const samples = audio.channelData[0];
    const pcm = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * 2);
    }
    const mono = resamplePcm16(pcm, audio.sampleRate, 16_000);
    return Uint8Array.from(mono).buffer;
  } finally {
    decoder.free();
  }
}

/** Feed a finished recording through the same provider contract as the microphone. */
export async function transcribeRecordedPcm(
  pcm: ArrayBuffer,
  provider: AsrProvider,
  isCurrent: () => boolean,
): Promise<string> {
  let text = '';
  let failure: unknown;
  let settle: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    if (!isCurrent()) throw new Error('Voice recording configuration changed');
    if (failure) throw failure;
  };
  provider.onEvent((event) => {
    if (event.type === 'stable') text = event.text;
    if (event.type === 'error') failure = new Error(event.message);
    if (event.type === 'stable' || event.type === 'error') settle?.();
  });
  try {
    if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 31 * 32_000) {
      throw new Error('Invalid PCM recording');
    }
    check();
    await provider.start();
    check();
    for (let offset = 0; offset < pcm.byteLength; offset += 3200) {
      check();
      provider.appendAudio(pcm.slice(offset, offset + 3200));
    }
    await provider.flushAudio();
    check();
    // Some providers acknowledge commit before their final transcript arrives.
    if (!text.trim()) {
      await new Promise<void>((resolve) => { settle = resolve; timeout = setTimeout(resolve, 5000); });
      check();
    }
    if (!text.trim()) throw new Error('Empty dictation');
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timeout);
    provider.onEvent(() => {});
    try { await provider.stop(); } catch (error) { failure ??= error; }
    try { await provider.dispose?.(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  return text.trim();
}
