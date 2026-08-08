import type { IOSSimulatorH264Frame } from '@cindy/ios-simulator-runtime';

export type IOSSimulatorH264FallbackReason =
  | 'webcodecs-unavailable'
  | 'missing-key-frame'
  | 'missing-parameter-sets'
  | 'unsupported-configuration'
  | 'decoder-error';

export type IOSSimulatorH264DecodeResult =
  'decoded' | 'waiting-for-key-frame' | 'fallback' | 'closed' | 'stale';

interface H264DecoderConfiguration {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  optimizeForLatency: true;
  hardwareAcceleration: 'prefer-hardware';
}

interface H264EncodedChunkInit {
  type: 'key' | 'delta';
  timestamp: number;
  data: Uint8Array;
}

interface H264DecodedFrame {
  close(): void;
}

interface H264Decoder {
  configure(configuration: H264DecoderConfiguration): void;
  decode(chunk: unknown): void;
  close(): void;
}

interface H264DecoderCallbacks {
  output(frame: H264DecodedFrame): void;
  error(error: DOMException): void;
}

export interface IOSSimulatorH264DecoderRuntime {
  isConfigSupported(configuration: H264DecoderConfiguration): Promise<boolean>;
  createDecoder(callbacks: H264DecoderCallbacks): H264Decoder;
  createChunk(init: H264EncodedChunkInit): unknown;
}

export interface IOSSimulatorH264DecoderOptions {
  runtime?: IOSSimulatorH264DecoderRuntime | null;
  renderFrame(frame: H264DecodedFrame, width: number, height: number): void;
  onFrameRendered?: () => void;
  onFallback(reason: IOSSimulatorH264FallbackReason): void;
  maxConsecutiveErrors?: number;
  maxFramesAwaitingKeyFrame?: number;
}

interface DecoderIdentity {
  generation: number;
  width: number;
  height: number;
  codec: string;
}

interface PendingDecode {
  frame: IOSSimulatorH264Frame;
  generation: number;
  epoch: number;
  resolve(result: IOSSimulatorH264DecodeResult): void;
}

const ANNEX_B_START_CODE = new Uint8Array([0, 0, 0, 1]);
// The producer forces an IDR every two seconds and supports up to 60 FPS.
// Waiting 120 access units prevents a late-attaching renderer from falling
// back immediately before the next valid key frame arrives.
const DEFAULT_MAX_FRAMES_AWAITING_KEY_FRAME = 120;

function readStartCode(bytes: Uint8Array, offset: number): number {
  if (offset + 3 > bytes.byteLength || bytes[offset] !== 0 || bytes[offset + 1] !== 0) return 0;
  if (bytes[offset + 2] === 1) return 3;
  if (offset + 4 <= bytes.byteLength && bytes[offset + 2] === 0 && bytes[offset + 3] === 1)
    return 4;
  return 0;
}

export function splitAnnexBNalUnits(bytes: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const startCodeLength = readStartCode(bytes, offset);
    if (startCodeLength === 0) {
      offset += 1;
      continue;
    }
    const start = offset + startCodeLength;
    let end = start;
    while (end < bytes.byteLength && readStartCode(bytes, end) === 0) end += 1;
    if (end > start) units.push(bytes.subarray(start, end));
    offset = end;
  }
  return units;
}

function lengthPrefixedNalUnits(bytes: Uint8Array): Uint8Array[] | null {
  const units: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) return null;
    const length =
      bytes[offset]! * 0x1000000 +
      bytes[offset + 1]! * 0x10000 +
      bytes[offset + 2]! * 0x100 +
      bytes[offset + 3]!;
    offset += 4;
    if (length <= 0 || offset + length > bytes.byteLength) return null;
    units.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return units;
}

function joinAnnexBNalUnits(units: Uint8Array[]): Uint8Array {
  const byteLength = units.reduce(
    (total, unit) => total + ANNEX_B_START_CODE.byteLength + unit.byteLength,
    0,
  );
  const annexB = new Uint8Array(byteLength);
  let offset = 0;
  for (const unit of units) {
    annexB.set(ANNEX_B_START_CODE, offset);
    offset += ANNEX_B_START_CODE.byteLength;
    annexB.set(unit, offset);
    offset += unit.byteLength;
  }
  return annexB;
}

export function normalizeH264AccessUnit(frame: IOSSimulatorH264Frame): {
  bytes: Uint8Array;
  nalUnits: Uint8Array[];
} | null {
  const nalUnits =
    frame.format === 'annex-b'
      ? splitAnnexBNalUnits(frame.bytes)
      : lengthPrefixedNalUnits(frame.bytes);
  if (!nalUnits?.length) return null;
  return {
    bytes: frame.format === 'annex-b' ? frame.bytes.slice() : joinAnnexBNalUnits(nalUnits),
    nalUnits,
  };
}

export function codecFromH264NalUnits(nalUnits: Uint8Array[]): string | null {
  const sequenceParameterSet = nalUnits.find((unit) => (unit[0]! & 0x1f) === 7);
  if (!sequenceParameterSet || sequenceParameterSet.byteLength < 4) return null;
  const codecBytes = sequenceParameterSet.subarray(1, 4);
  return `avc1.${Array.from(codecBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function containsNalType(nalUnits: Uint8Array[], type: number): boolean {
  return nalUnits.some((unit) => (unit[0]! & 0x1f) === type);
}

export function createBrowserIOSSimulatorH264DecoderRuntime(): IOSSimulatorH264DecoderRuntime | null {
  const browser = globalThis as typeof globalThis & {
    VideoDecoder?: {
      new (callbacks: {
        output(frame: { close(): void }): void;
        error(error: DOMException): void;
      }): {
        configure(configuration: H264DecoderConfiguration): void;
        decode(chunk: unknown): void;
        close(): void;
      };
      isConfigSupported(configuration: H264DecoderConfiguration): Promise<{ supported?: boolean }>;
    };
    EncodedVideoChunk?: new (init: H264EncodedChunkInit) => unknown;
  };
  const VideoDecoderConstructor = browser.VideoDecoder;
  const EncodedVideoChunkConstructor = browser.EncodedVideoChunk;
  if (!VideoDecoderConstructor || !EncodedVideoChunkConstructor) return null;
  return {
    async isConfigSupported(configuration) {
      const support = await VideoDecoderConstructor.isConfigSupported(configuration);
      return support.supported === true;
    },
    createDecoder(callbacks) {
      return new VideoDecoderConstructor(callbacks);
    },
    createChunk(init) {
      return new EncodedVideoChunkConstructor(init);
    },
  };
}

/**
 * Owns one low-latency WebCodecs decoder. High-frequency frame state remains
 * outside React, and the caller keeps the last JPEG/canvas visible on fallback.
 */
export class IOSSimulatorH264Decoder {
  readonly #runtime: IOSSimulatorH264DecoderRuntime | null;
  readonly #renderFrame: IOSSimulatorH264DecoderOptions['renderFrame'];
  readonly #onFrameRendered: IOSSimulatorH264DecoderOptions['onFrameRendered'];
  readonly #onFallback: IOSSimulatorH264DecoderOptions['onFallback'];
  readonly #maxConsecutiveErrors: number;
  readonly #maxFramesAwaitingKeyFrame: number;

  #decoder: H264Decoder | null = null;
  #identity: DecoderIdentity | null = null;
  #decoderToken = 0;
  #epoch = 0;
  #consecutiveErrors = 0;
  #framesAwaitingKeyFrame = 0;
  #fallbackReason: IOSSimulatorH264FallbackReason | null = null;
  #closed = false;
  #processing = false;
  #pendingDecode: PendingDecode | null = null;

  constructor(options: IOSSimulatorH264DecoderOptions) {
    this.#runtime = options.runtime ?? createBrowserIOSSimulatorH264DecoderRuntime();
    this.#renderFrame = options.renderFrame;
    this.#onFrameRendered = options.onFrameRendered;
    this.#onFallback = options.onFallback;
    this.#maxConsecutiveErrors = Math.max(1, options.maxConsecutiveErrors ?? 3);
    this.#maxFramesAwaitingKeyFrame = Math.max(
      1,
      options.maxFramesAwaitingKeyFrame ?? DEFAULT_MAX_FRAMES_AWAITING_KEY_FRAME,
    );
  }

  decode(frame: IOSSimulatorH264Frame, generation: number): Promise<IOSSimulatorH264DecodeResult> {
    if (this.#closed) return Promise.resolve('closed');
    return new Promise((resolve) => {
      this.#pendingDecode?.resolve('stale');
      this.#pendingDecode = {
        frame,
        generation,
        epoch: this.#epoch,
        resolve,
      };
      void this.#drain();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#epoch += 1;
    this.#pendingDecode?.resolve('closed');
    this.#pendingDecode = null;
    this.#disposeDecoder();
  }

  async #drain(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#pendingDecode) {
        const pending = this.#pendingDecode;
        this.#pendingDecode = null;
        const result = await this.#decode(pending.frame, pending.generation, pending.epoch);
        pending.resolve(result);
      }
    } finally {
      this.#processing = false;
      if (this.#pendingDecode) void this.#drain();
    }
  }

  async #decode(
    frame: IOSSimulatorH264Frame,
    generation: number,
    requestedEpoch: number,
  ): Promise<IOSSimulatorH264DecodeResult> {
    if (this.#closed) return 'closed';
    if (requestedEpoch !== this.#epoch) return 'stale';
    if (this.#fallbackReason) return 'fallback';
    if (!this.#runtime) return this.#activateFallback('webcodecs-unavailable');

    const normalized = normalizeH264AccessUnit(frame);
    if (!normalized) return this.#recordDecoderError();

    const dimensionsChanged = Boolean(
      this.#identity &&
      (this.#identity.generation !== generation ||
        this.#identity.width !== frame.width ||
        this.#identity.height !== frame.height),
    );
    if (dimensionsChanged) this.#resetForKeyFrame();

    if (!this.#decoder) {
      if (!frame.keyFrame) {
        this.#framesAwaitingKeyFrame += 1;
        if (this.#framesAwaitingKeyFrame >= this.#maxFramesAwaitingKeyFrame) {
          return this.#activateFallback('missing-key-frame');
        }
        return 'waiting-for-key-frame';
      }
      if (!containsNalType(normalized.nalUnits, 7) || !containsNalType(normalized.nalUnits, 8)) {
        return this.#activateFallback('missing-parameter-sets');
      }
      const codec = codecFromH264NalUnits(normalized.nalUnits);
      if (!codec) return this.#activateFallback('missing-parameter-sets');
      const configuration: H264DecoderConfiguration = {
        codec,
        codedWidth: frame.width,
        codedHeight: frame.height,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
      };
      let supported = false;
      try {
        supported = await this.#runtime.isConfigSupported(configuration);
      } catch {
        return this.#recordDecoderError();
      }
      if (this.#closed || requestedEpoch !== this.#epoch || this.#fallbackReason) {
        return 'stale';
      }
      if (!supported) return this.#activateFallback('unsupported-configuration');
      try {
        this.#createDecoder({ generation, width: frame.width, height: frame.height, codec });
      } catch {
        return this.#recordDecoderError();
      }
      this.#framesAwaitingKeyFrame = 0;
    }

    try {
      this.#decoder!.decode(
        this.#runtime.createChunk({
          type: frame.keyFrame ? 'key' : 'delta',
          timestamp: frame.timestampMicros,
          data: normalized.bytes,
        }),
      );
      return 'decoded';
    } catch {
      return this.#recordDecoderError();
    }
  }

  #createDecoder(identity: DecoderIdentity): void {
    const token = ++this.#decoderToken;
    this.#identity = identity;
    const decoder = this.#runtime!.createDecoder({
      output: (frame) => {
        if (this.#closed || token !== this.#decoderToken || this.#fallbackReason) {
          frame.close();
          return;
        }
        try {
          this.#renderFrame(frame, identity.width, identity.height);
          this.#consecutiveErrors = 0;
          this.#onFrameRendered?.();
        } catch {
          this.#recordDecoderError();
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (!this.#closed && token === this.#decoderToken) this.#recordDecoderError();
      },
    });
    this.#decoder = decoder;
    try {
      decoder.configure({
        codec: identity.codec,
        codedWidth: identity.width,
        codedHeight: identity.height,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
      });
    } catch (error) {
      this.#disposeDecoder();
      this.#identity = null;
      throw error;
    }
  }

  #recordDecoderError(): IOSSimulatorH264DecodeResult {
    this.#consecutiveErrors += 1;
    if (this.#consecutiveErrors >= this.#maxConsecutiveErrors) {
      return this.#activateFallback('decoder-error');
    }
    this.#resetForKeyFrame();
    return 'waiting-for-key-frame';
  }

  #resetForKeyFrame(): void {
    this.#disposeDecoder();
    this.#identity = null;
    this.#framesAwaitingKeyFrame = 0;
  }

  #disposeDecoder(): void {
    this.#decoderToken += 1;
    const decoder = this.#decoder;
    this.#decoder = null;
    try {
      decoder?.close();
    } catch {
      // Closing an already-failed decoder is best effort.
    }
  }

  #activateFallback(reason: IOSSimulatorH264FallbackReason): IOSSimulatorH264DecodeResult {
    if (this.#fallbackReason) return 'fallback';
    this.#fallbackReason = reason;
    this.#disposeDecoder();
    this.#onFallback(reason);
    return 'fallback';
  }
}
