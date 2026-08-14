import { describe, expect, it, vi } from 'vitest';

import type { IOSSimulatorH264Frame } from '@cindy/ios-simulator-runtime';

import {
  codecFromH264NalUnits,
  IOSSimulatorH264Decoder,
  normalizeH264AccessUnit,
  splitAnnexBNalUnits,
  type IOSSimulatorH264DecoderRuntime,
} from '../iosSimulatorH264Decoder';

const SPS = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac]);
const PPS = new Uint8Array([0x68, 0xee, 0x3c, 0x80]);
const IDR = new Uint8Array([0x65, 0x88, 0x84]);
const DELTA = new Uint8Array([0x41, 0x9a]);

function annexB(...units: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(units.reduce((total, unit) => total + 4 + unit.length, 0));
  let offset = 0;
  for (const unit of units) {
    result.set([0, 0, 0, 1], offset);
    offset += 4;
    result.set(unit, offset);
    offset += unit.length;
  }
  return result;
}

function lengthPrefixed(...units: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(units.reduce((total, unit) => total + 4 + unit.length, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const unit of units) {
    view.setUint32(offset, unit.length);
    offset += 4;
    result.set(unit, offset);
    offset += unit.length;
  }
  return result;
}

function frame(
  keyFrame: boolean,
  bytes = keyFrame ? annexB(SPS, PPS, IDR) : annexB(DELTA),
  overrides: Partial<IOSSimulatorH264Frame> = {},
): IOSSimulatorH264Frame {
  return {
    encoding: 'h264',
    format: 'annex-b',
    bytes,
    receivedAt: '2026-07-24T00:00:00.000Z',
    width: 1206,
    height: 2622,
    orientation: 'PORTRAIT',
    scale: 3,
    colorSpace: 'srgb',
    timestampMicros: keyFrame ? 0 : 200_000,
    keyFrame,
    ...overrides,
  };
}

function harness(
  options: {
    supported?: boolean;
    maxConsecutiveErrors?: number;
    maxFramesAwaitingKeyFrame?: number;
  } = {},
) {
  const decoders: Array<{
    callbacks: {
      output(frame: { close(): void }): void;
      error(error: DOMException): void;
    };
    configure: ReturnType<typeof vi.fn>;
    decode: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const chunks: Array<{ type: 'key' | 'delta'; timestamp: number; data: Uint8Array }> = [];
  const runtime: IOSSimulatorH264DecoderRuntime = {
    isConfigSupported: vi.fn(async () => options.supported ?? true),
    createDecoder(callbacks) {
      const decoder = {
        callbacks,
        configure: vi.fn(),
        decode: vi.fn(),
        close: vi.fn(),
      };
      decoders.push(decoder);
      return decoder;
    },
    createChunk(init) {
      chunks.push(init);
      return init;
    },
  };
  const rendered: Array<{ frame: { close(): void }; width: number; height: number }> = [];
  const fallback = vi.fn();
  const decoder = new IOSSimulatorH264Decoder({
    runtime,
    renderFrame(output, width, height) {
      rendered.push({ frame: output, width, height });
    },
    onFallback: fallback,
    maxConsecutiveErrors: options.maxConsecutiveErrors,
    maxFramesAwaitingKeyFrame: options.maxFramesAwaitingKeyFrame,
  });
  return { decoder, decoders, chunks, runtime, rendered, fallback };
}

describe('iOS Simulator H.264 helpers', () => {
  it('splits Annex-B NAL units and derives the RFC 6381 codec string', () => {
    const units = splitAnnexBNalUnits(annexB(SPS, PPS, IDR));
    expect(units).toEqual([SPS, PPS, IDR]);
    expect(codecFromH264NalUnits(units)).toBe('avc1.640028');
  });

  it('normalizes four-byte length-prefixed access units to Annex-B', () => {
    const normalized = normalizeH264AccessUnit(
      frame(true, lengthPrefixed(SPS, PPS, IDR), { format: 'length-prefixed' }),
    );
    expect(normalized?.nalUnits).toEqual([SPS, PPS, IDR]);
    expect(normalized?.bytes).toEqual(annexB(SPS, PPS, IDR));
  });
});

describe('IOSSimulatorH264Decoder', () => {
  it('waits for a key frame, configures low-latency WebCodecs, and closes outputs', async () => {
    const { decoder, decoders, chunks, runtime, rendered, fallback } = harness();

    await expect(decoder.decode(frame(false), 2)).resolves.toBe('waiting-for-key-frame');
    await expect(decoder.decode(frame(true), 2)).resolves.toBe('decoded');
    await expect(decoder.decode(frame(false), 2)).resolves.toBe('decoded');

    expect(runtime.isConfigSupported).toHaveBeenCalledWith({
      codec: 'avc1.640028',
      codedWidth: 1206,
      codedHeight: 2622,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
    });
    expect(chunks.map((chunk) => chunk.type)).toEqual(['key', 'delta']);
    expect(fallback).not.toHaveBeenCalled();

    const output = { close: vi.fn() };
    decoders[0]!.callbacks.output(output);
    expect(rendered).toEqual([{ frame: output, width: 1206, height: 2622 }]);
    expect(output.close).toHaveBeenCalledOnce();
  });

  it('waits through the producer key-frame interval before falling back', async () => {
    const { decoder, decoders, fallback } = harness();

    for (let index = 0; index < 59; index += 1) {
      await expect(
        decoder.decode(frame(false, undefined, { timestampMicros: (index + 1) * 33_333 }), 2),
      ).resolves.toBe('waiting-for-key-frame');
    }
    await expect(
      decoder.decode(frame(true, undefined, { timestampMicros: 2_000_000 }), 2),
    ).resolves.toBe('decoded');

    expect(decoders).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('resets on generation or dimension changes and ignores stale decoder output', async () => {
    const { decoder, decoders, rendered } = harness();
    await decoder.decode(frame(true), 2);
    const oldDecoder = decoders[0]!;

    await decoder.decode(frame(true, undefined, { width: 1080, height: 2340 }), 3);
    expect(oldDecoder.close).toHaveBeenCalledOnce();
    expect(decoders).toHaveLength(2);

    const staleOutput = { close: vi.fn() };
    oldDecoder.callbacks.output(staleOutput);
    expect(staleOutput.close).toHaveBeenCalledOnce();
    expect(rendered).toHaveLength(0);

    const currentOutput = { close: vi.fn() };
    decoders[1]!.callbacks.output(currentOutput);
    expect(rendered[0]).toMatchObject({ width: 1080, height: 2340 });
    expect(currentOutput.close).toHaveBeenCalledOnce();
  });

  it('falls back once when WebCodecs is unavailable or a key frame never arrives', async () => {
    const unavailableFallback = vi.fn();
    const unavailable = new IOSSimulatorH264Decoder({
      runtime: null,
      renderFrame: vi.fn(),
      onFallback: unavailableFallback,
    });
    await expect(unavailable.decode(frame(true), 2)).resolves.toBe('fallback');
    await expect(unavailable.decode(frame(true), 2)).resolves.toBe('fallback');
    expect(unavailableFallback).toHaveBeenCalledOnce();
    expect(unavailableFallback).toHaveBeenCalledWith('webcodecs-unavailable');

    const waiting = harness({ maxFramesAwaitingKeyFrame: 2 });
    await expect(waiting.decoder.decode(frame(false), 2)).resolves.toBe('waiting-for-key-frame');
    await expect(waiting.decoder.decode(frame(false), 2)).resolves.toBe('fallback');
    expect(waiting.fallback).toHaveBeenCalledOnce();
    expect(waiting.fallback).toHaveBeenCalledWith('missing-key-frame');
  });

  it('requires SPS and PPS and falls back for unsupported configurations', async () => {
    const missingParameters = harness();
    await expect(missingParameters.decoder.decode(frame(true, annexB(IDR)), 2)).resolves.toBe(
      'fallback',
    );
    expect(missingParameters.fallback).toHaveBeenCalledWith('missing-parameter-sets');

    const unsupported = harness({ supported: false });
    await expect(unsupported.decoder.decode(frame(true), 2)).resolves.toBe('fallback');
    expect(unsupported.fallback).toHaveBeenCalledWith('unsupported-configuration');
  });

  it('uses an error budget, resets, and then falls back without clearing the last frame', async () => {
    const { decoder, decoders, fallback, rendered } = harness({ maxConsecutiveErrors: 2 });
    await decoder.decode(frame(true), 2);
    const lastFrame = { close: vi.fn() };
    decoders[0]!.callbacks.output(lastFrame);
    expect(rendered).toHaveLength(1);
    decoders[0]!.callbacks.error(new DOMException('decode failed'));
    expect(decoders[0]!.close).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();

    await decoder.decode(frame(true), 2);
    decoders[1]!.callbacks.error(new DOMException('decode failed again'));
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledWith('decoder-error');
    expect(rendered).toHaveLength(1);
    expect(lastFrame.close).toHaveBeenCalledOnce();
  });

  it('keeps only one latest pending frame while asynchronous configuration is in flight', async () => {
    let resolveSupport: ((value: boolean) => void) | null = null;
    const pendingSupport = new Promise<boolean>((resolve) => {
      resolveSupport = resolve;
    });
    const { decoder, chunks, runtime } = harness();
    vi.mocked(runtime.isConfigSupported).mockReturnValueOnce(pendingSupport);

    const first = decoder.decode(frame(true), 2);
    const dropped = decoder.decode(frame(false, undefined, { timestampMicros: 200_000 }), 2);
    const latest = decoder.decode(frame(false, undefined, { timestampMicros: 400_000 }), 2);
    await expect(dropped).resolves.toBe('stale');
    resolveSupport!(true);

    await expect(first).resolves.toBe('decoded');
    await expect(latest).resolves.toBe('decoded');
    expect(chunks.map((chunk) => chunk.timestamp)).toEqual([0, 400_000]);
  });

  it('closes the decoder and drops queued work on unmount', async () => {
    let resolveSupport: ((value: boolean) => void) | null = null;
    const pendingSupport = new Promise<boolean>((resolve) => {
      resolveSupport = resolve;
    });
    const { decoder, decoders, runtime } = harness();
    vi.mocked(runtime.isConfigSupported).mockReturnValueOnce(pendingSupport);
    const pending = decoder.decode(frame(true), 2);
    decoder.close();
    resolveSupport!(true);

    await expect(pending).resolves.toBe('stale');
    expect(decoders).toHaveLength(0);
    await expect(decoder.decode(frame(true), 2)).resolves.toBe('closed');
  });
});
