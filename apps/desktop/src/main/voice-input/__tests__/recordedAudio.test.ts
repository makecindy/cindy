import type { AsrEvent, AsrProvider } from '@cindy/voice-input-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRecordedOpus, transcribeRecordedPcm } from '../recordedAudio.js';

function provider() {
  let emit: (event: AsrEvent) => void = () => {};
  const asr = {
    onEvent: (callback: (event: AsrEvent) => void) => { emit = callback; },
    start: vi.fn(async () => {}),
    appendAudio: vi.fn(),
    flushAudio: vi.fn(async () => { emit({ type: 'stable', text: '继续这个任务', at: 1 }); }),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies AsrProvider;
  return { asr, emit: (event: AsrEvent) => emit(event) };
}

describe('finished audio through the selected ASR provider', () => {
  afterEach(() => vi.useRealTimers());
  it('waits for a final result arriving after flush returns', async () => {
    vi.useFakeTimers();
    const { asr, emit } = provider();
    asr.flushAudio.mockImplementation(async () => {
      setTimeout(() => emit({ type: 'stable', text: '延迟的完整结果', at: 1 }), 20);
    });
    const result = transcribeRecordedPcm(new ArrayBuffer(3200), asr, () => true);
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toBe('延迟的完整结果');
    expect(asr.dispose).toHaveBeenCalledOnce();
  });
  it('decodes a one-second mono Opus recording to 16 kHz PCM', async () => {
    // Generated silence, encoded with libopus at 16 kbit/s and 40 ms frames.
    const ogg = Buffer.from('T2dnUwACAAAAAAAAAABW99d1AAAAAOM8iIsBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAFb313UBAAAAcLdd/wE9T3B1c1RhZ3MMAAAATGF2ZjYyLjMuMTAwAQAAAB0AAABlbmNvZGVyPUxhdmM2Mi4xMS4xMDAgbGlib3B1c09nZ1MAAIC7AAAAAAAAVvfXdQIAAADZTL7mGQ8PDw8PDw8PDw8PDw8PDw8PDw8PDw8PDw9QBfJgm3YXu8ctixaZ6LBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBQA+S85GbjPDy1CIprIUBPZ2dTAAS4vAAAAAAAAFb313UDAAAAe55W8gEPUAPkvORm4zw8tQiKayFA', 'base64');
    const pcm = await decodeRecordedOpus(ogg);
    expect(pcm.byteLength).toBe(32_000);
  });
  it('sends all PCM in bounded chunks and waits for the final transcript', async () => {
    const { asr } = provider();
    const pcm = Uint8Array.from({ length: 7000 }, (_, i) => i % 256).buffer;
    await expect(transcribeRecordedPcm(pcm, asr, () => true)).resolves.toBe('继续这个任务');
    expect(asr.appendAudio.mock.calls.map(([chunk]) => chunk.byteLength)).toEqual([3200, 3200, 600]);
    expect(Buffer.concat(asr.appendAudio.mock.calls.map(([chunk]) => Buffer.from(chunk)))).toEqual(Buffer.from(pcm));
    expect(asr.flushAudio).toHaveBeenCalledOnce();
    expect(asr.stop).toHaveBeenCalledOnce();
    expect(asr.dispose).toHaveBeenCalledOnce();
  });
  it('does not send audio when the owner or model changes during connection', async () => {
    const { asr } = provider();
    let current = true;
    asr.start.mockImplementation(async () => { current = false; });
    await expect(transcribeRecordedPcm(new ArrayBuffer(3200), asr, () => current)).rejects.toThrow('configuration changed');
    expect(asr.appendAudio).not.toHaveBeenCalled();
    expect(asr.stop).toHaveBeenCalledOnce();
    expect(asr.dispose).toHaveBeenCalledOnce();
  });
  it('preserves the provider failure even if cleanup also fails', async () => {
    const { asr } = provider();
    asr.start.mockRejectedValue(new Error('HTTP 403 model denied'));
    asr.stop.mockRejectedValue(new Error('cleanup failed'));
    await expect(transcribeRecordedPcm(new ArrayBuffer(3200), asr, () => true)).rejects.toThrow('HTTP 403');
    expect(asr.dispose).toHaveBeenCalledOnce();
  });
  it('rejects an error event instead of returning partial text', async () => {
    const { asr, emit } = provider();
    asr.flushAudio.mockImplementation(async () => {
      emit({ type: 'partial', text: '未完成', at: 1 });
      emit({ type: 'error', message: 'upstream rejected audio', at: 2 });
    });
    await expect(transcribeRecordedPcm(new ArrayBuffer(3200), asr, () => true)).rejects.toThrow('upstream rejected audio');
  });
  it('rejects empty recognition and invalid PCM', async () => {
    vi.useFakeTimers();
    const { asr } = provider();
    asr.flushAudio.mockResolvedValue(undefined);
    const empty = expect(transcribeRecordedPcm(new ArrayBuffer(3200), asr, () => true)).rejects.toThrow('Empty dictation');
    await vi.advanceTimersByTimeAsync(5000);
    await empty;
    await expect(transcribeRecordedPcm(new ArrayBuffer(1), asr, () => true)).rejects.toThrow('Invalid PCM');
  });
  it('rejects invalid Opus rather than substituting another format', async () => {
    await expect(decodeRecordedOpus(new Uint8Array())).rejects.toThrow('Invalid recording size');
    await expect(decodeRecordedOpus(new Uint8Array([1, 2, 3]))).rejects.toThrow('Invalid mono Opus');
  });
});
