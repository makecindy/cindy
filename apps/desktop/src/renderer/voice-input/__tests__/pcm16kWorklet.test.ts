import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

type WorkletProcessorConstructor = new () => {
  port: {
    onmessage: ((event: { data?: unknown }) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
  carry: number;
  process: (inputs: Float32Array[][]) => boolean;
  resample: (input: Float32Array, fromRate: number, toRate: number) => number[];
};

function loadProcessor(): WorkletProcessorConstructor {
  let processorClass: WorkletProcessorConstructor | undefined;
  class AudioWorkletProcessor {
    port = {
      onmessage: null,
      postMessage: vi.fn(),
    };
  }

  const context = vm.createContext({
    AudioWorkletProcessor,
    currentTime: 0,
    performance: { now: () => 0 },
    registerProcessor: (_name: string, processor: WorkletProcessorConstructor) => {
      processorClass = processor;
    },
    sampleRate: 48_000,
  });
  vm.runInContext(
    readFileSync(join(process.cwd(), 'src/renderer/voice-input/pcm16k-worklet.js'), 'utf8'),
    context,
  );
  if (!processorClass) throw new Error('PCM16k worklet processor was not registered.');
  return processorClass;
}

describe('PCM16k worklet', () => {
  it('resamples and posts pcm16k frames while active', () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const resample = vi.spyOn(processor, 'resample');

    processor.port.onmessage?.({
      data: { type: 'config', targetSampleRate: 16_000, chunkMs: 10, timeOriginMs: 0 },
    });

    expect(processor.process([[new Float32Array(480).fill(0.5)]])).toBe(true);
    expect(resample).toHaveBeenCalledTimes(1);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    const [message, transfer] = processor.port.postMessage.mock.calls[0];
    expect(message).toMatchObject({
      type: 'pcm16k',
      trace: { chunkIndex: 0, sampleRate: 16_000, durationMs: 10 },
    });
    expect(message.pcm16k).toBe(transfer[0]);
  });

  it('does not resample input while inactive', () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const resample = vi.spyOn(processor, 'resample');

    processor.port.onmessage?.({
      data: { type: 'setActive', active: false, reset: true },
    });

    expect(processor.process([[new Float32Array(128)]])).toBe(true);
    expect(resample).not.toHaveBeenCalled();
  });

  it('resets resampler carry when toggling active state with reset', () => {
    const Processor = loadProcessor();
    const processor = new Processor();

    processor.resample(new Float32Array(128), 48_000, 16_000);
    expect(processor.carry).not.toBe(0);

    processor.port.onmessage?.({
      data: { type: 'setActive', active: false, reset: true },
    });

    expect(processor.carry).toBe(0);
  });

  it('permanently stops processing after disposal, including without inputs', () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const resample = vi.spyOn(processor, 'resample');

    processor.port.onmessage?.({ data: { type: 'dispose' } });
    processor.port.onmessage?.({ data: { type: 'dispose' } });
    processor.port.onmessage?.({ data: { type: 'setActive', active: true, reset: true } });
    processor.port.onmessage?.({ data: { type: 'config', chunkMs: 10 } });

    expect(processor.process([])).toBe(false);
    expect(processor.process([[new Float32Array(480).fill(0.5)]])).toBe(false);
    expect(resample).not.toHaveBeenCalled();
    expect(processor.port.postMessage).not.toHaveBeenCalled();
  });

  it('keeps temporary deactivation resumable', () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    processor.port.onmessage?.({ data: { type: 'config', chunkMs: 10 } });
    processor.port.onmessage?.({ data: { type: 'setActive', active: false, reset: true } });
    expect(processor.process([])).toBe(true);
    expect(processor.process([[new Float32Array(480)]])).toBe(true);
    expect(processor.port.postMessage).not.toHaveBeenCalled();

    processor.port.onmessage?.({ data: { type: 'setActive', active: true, reset: true } });
    expect(processor.process([[new Float32Array(480).fill(0.5)]])).toBe(true);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    expect(processor.port.postMessage.mock.calls[0][0]).toMatchObject({ type: 'pcm16k' });
  });

  it('allows draining before disposal and drops buffered audio after disposal', () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    processor.process([[new Float32Array(128).fill(0.5)]]);
    expect(processor.port.postMessage).not.toHaveBeenCalled();
    processor.port.onmessage?.({ data: { type: 'flush', flushId: 'last-frame' } });
    expect(processor.port.postMessage.mock.calls.map(([message]) => message.type))
      .toEqual(['pcm16k', 'flushed']);

    processor.process([[new Float32Array(128).fill(0.5)]]);
    processor.port.postMessage.mockClear();
    processor.port.onmessage?.({ data: { type: 'dispose' } });
    processor.port.onmessage?.({ data: { type: 'flush', flushId: 'too-late' } });
    expect(processor.process([])).toBe(false);
    expect(processor.port.postMessage).not.toHaveBeenCalled();
  });
});
