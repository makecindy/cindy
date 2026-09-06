import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { WebMicAudioEngine } from '../WebMicAudioEngine';

vi.mock('../audioContextPool', () => ({ PCM16K_WORKLET_NAME: 'pcm16k-worklet' }));

type Capture = {
  output: number[];
  feed: (input: Float32Array) => void;
  drain: () => Promise<void>;
  reset: () => Promise<void>;
};

function createWorkletCapture(rate: number): Capture {
  const output: number[] = [];
  type Processor = {
    port: { onmessage: (event: { data: Record<string, unknown> }) => void };
    process: (inputs: Float32Array[][]) => void;
  };
  let ProcessorClass: (new () => Processor) | undefined;
  vm.runInNewContext(
    readFileSync(join(process.cwd(), 'src/renderer/voice-input/pcm16k-worklet.js'), 'utf8'),
    {
      AudioWorkletProcessor: class {
        port = {
          onmessage: null,
          postMessage: (message: { type: string; pcm16k?: ArrayBuffer }) => {
            if (message.type === 'pcm16k') output.push(...new Int16Array(message.pcm16k!));
          },
        };
      },
      currentTime: 0,
      sampleRate: rate,
      registerProcessor: (_name: string, cls: new () => Processor) => {
        ProcessorClass = cls;
      },
    },
  );
  if (!ProcessorClass) throw new Error('Worklet was not registered');
  const processor = new ProcessorClass();
  const send = (data: Record<string, unknown>): void => processor.port.onmessage({ data });
  return {
    output,
    feed: (input) => processor.process([[input]]),
    drain: async () => {
      send({ type: 'flush', flushId: 1 });
    },
    reset: async () => {
      send({ type: 'setActive', active: true, reset: true });
    },
  };
}

function createFallbackCapture(rate: number): Capture {
  const output: number[] = [];
  const engine = new WebMicAudioEngine({ workletUrl: '', chunkMs: 40 });
  engine.onPcm16k(({ pcm16k }) => output.push(...new Int16Array(pcm16k)));
  // Feed the same boundary as ScriptProcessorNode. No device or browser is needed.
  const fallback = engine as unknown as {
    handleInputFrame: (input: Float32Array, sourceRate: number) => void;
  };
  return {
    output,
    feed: (input) => fallback.handleInputFrame(input, rate),
    drain: () => engine.drainBufferedAudio(),
    reset: () => engine.stop(),
  };
}

function feedChunks(capture: Capture, input: Float32Array, sizes: number[]): void {
  let block = 0;
  for (let offset = 0; offset < input.length; block++) {
    const end = Math.min(input.length, offset + sizes[block % sizes.length]);
    capture.feed(input.subarray(offset, end));
    offset = end;
  }
}

// Offline oracle uses absolute positions, independent of streaming carry/state.
function expectedPcm(input: Float32Array, rate: number): number[] {
  const ratio = rate / 16_000;
  const count = rate === 16_000 ? input.length : Math.ceil((input.length - 1) / ratio);
  return Array.from({ length: count }, (_, i) => {
    const position = i * ratio;
    const left = Math.floor(position);
    const fraction = position - left;
    const value =
      input[left] * (1 - fraction) + input[Math.min(left + 1, input.length - 1)] * fraction;
    return Math.trunc(value * (value < 0 ? 0x8000 : 0x7fff));
  });
}

describe.each([
  ['AudioWorklet', createWorkletCapture],
  ['ScriptProcessor fallback', createFallbackCapture],
] as const)('%s continuous resampling', (_name, createCapture) => {
  it.each([48_000, 44_100, 32_000, 16_000, 8_000])(
    'keeps a constant signal intact at %i Hz, including the tail',
    async (rate) => {
      const capture = createCapture(rate);
      const input = new Float32Array(12_800).fill(0.5);
      feedChunks(capture, input, [128]);
      await capture.drain();
      expect(capture.output).toEqual(expectedPcm(input, rate));
      const count = capture.output.length;
      await capture.drain();
      expect(capture.output).toHaveLength(count);
    },
  );

  it.each([48_000, 44_100, 8_000])(
    'preserves the waveform across arbitrary block boundaries at %i Hz',
    async (rate) => {
      const input = Float32Array.from({ length: 4097 }, (_, i) => Math.sin(i * 0.13) * 0.7);
      const expected = expectedPcm(input, rate);
      for (const sizes of [[128], [1024], [1, 127, 257, 63]]) {
        const capture = createCapture(rate);
        feedChunks(capture, input, sizes);
        await capture.drain();
        expect(capture.output).toHaveLength(expected.length);
        // At most one PCM unit of rounding error from fractional-rate accumulation.
        const error = Math.max(...capture.output.map((value, i) => Math.abs(value - expected[i])));
        expect(error).toBeLessThanOrEqual(1);
      }
    },
  );

  it('does not carry samples or fractional position into the next recording', async () => {
    const capture = createCapture(44_100);
    feedChunks(capture, new Float32Array(256).fill(-0.75), [128]);
    await capture.reset();
    capture.output.length = 0;
    const next = new Float32Array(4097).fill(0.5);
    feedChunks(capture, next, [128]);
    await capture.drain();
    expect(capture.output).toEqual(expectedPcm(next, 44_100));
  });
});
