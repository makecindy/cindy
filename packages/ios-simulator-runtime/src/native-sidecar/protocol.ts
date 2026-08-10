const HEADER_BYTES = 5;
const STREAM_METADATA_PREFIX_BYTES = 4;

export const IOS_SIMULATOR_NATIVE_SIDECAR_PROTOCOL_VERSION = 1;

export enum IOSSimulatorNativeSidecarMessageKind {
  Json = 1,
  Binary = 2,
  StreamFrame = 3,
  StreamEnd = 4,
}

export interface IOSSimulatorNativeSidecarProtocolLimits {
  jsonBytes: number;
  binaryBytes: number;
  streamFrameBytes: number;
  streamEndBytes: number;
  streamMetadataBytes: number;
}

export const IOS_SIMULATOR_NATIVE_SIDECAR_DEFAULT_LIMITS: Readonly<IOSSimulatorNativeSidecarProtocolLimits> =
  Object.freeze({
    jsonBytes: 1024 * 1024,
    binaryBytes: 16 * 1024 * 1024,
    streamFrameBytes: 16 * 1024 * 1024,
    streamEndBytes: 64 * 1024,
    streamMetadataBytes: 64 * 1024,
  });

/**
 * Largest encoded/raw frame payload that always fits in one stream frame
 * after its length prefix and bounded JSON metadata are included.
 */
export const IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES =
  IOS_SIMULATOR_NATIVE_SIDECAR_DEFAULT_LIMITS.streamFrameBytes -
  IOS_SIMULATOR_NATIVE_SIDECAR_DEFAULT_LIMITS.streamMetadataBytes -
  STREAM_METADATA_PREFIX_BYTES;

export interface IOSSimulatorNativeSidecarFrame {
  kind: IOSSimulatorNativeSidecarMessageKind;
  body: Uint8Array;
}

export interface IOSSimulatorNativeSidecarRequest {
  version: number;
  id: string;
  op: string;
  simulatorUdid: string;
  generation: number;
  params?: Record<string, unknown>;
}

export interface IOSSimulatorNativeSidecarReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface IOSSimulatorNativeSidecarStreamFrameMetadata {
  streamId: string;
  simulatorUdid: string;
  generation: number;
  sequence: number;
  encoding: "h264" | "bgra";
  h264Format?: "annex-b" | "length-prefixed";
  width: number;
  height: number;
  orientation: "PORTRAIT" | "LANDSCAPE";
  scale: number;
  colorSpace: "srgb" | "display-p3" | "unknown";
  timestampMicros: number;
  keyFrame?: boolean;
  bytesPerRow?: number;
}

export interface IOSSimulatorNativeSidecarStreamEnd {
  streamId: string;
  simulatorUdid: string;
  generation: number;
  reason: "max-frames" | "aborted" | "eof" | "error";
  message?: string;
}

export class IOSSimulatorNativeSidecarProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IOSSimulatorNativeSidecarProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requirePositiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

function normalizeLimits(
  limits: Partial<IOSSimulatorNativeSidecarProtocolLimits> = {},
): IOSSimulatorNativeSidecarProtocolLimits {
  const merged = {
    ...IOS_SIMULATOR_NATIVE_SIDECAR_DEFAULT_LIMITS,
    ...limits,
  };
  return {
    jsonBytes: requirePositiveLimit(merged.jsonBytes, "jsonBytes"),
    binaryBytes: requirePositiveLimit(merged.binaryBytes, "binaryBytes"),
    streamFrameBytes: requirePositiveLimit(
      merged.streamFrameBytes,
      "streamFrameBytes",
    ),
    streamEndBytes: requirePositiveLimit(
      merged.streamEndBytes,
      "streamEndBytes",
    ),
    streamMetadataBytes: requirePositiveLimit(
      merged.streamMetadataBytes,
      "streamMetadataBytes",
    ),
  };
}

function maxBodyBytes(
  kind: IOSSimulatorNativeSidecarMessageKind,
  limits: IOSSimulatorNativeSidecarProtocolLimits,
): number {
  switch (kind) {
    case IOSSimulatorNativeSidecarMessageKind.Json:
      return limits.jsonBytes;
    case IOSSimulatorNativeSidecarMessageKind.Binary:
      return limits.binaryBytes;
    case IOSSimulatorNativeSidecarMessageKind.StreamFrame:
      return limits.streamFrameBytes;
    case IOSSimulatorNativeSidecarMessageKind.StreamEnd:
      return limits.streamEndBytes;
    default:
      throw new IOSSimulatorNativeSidecarProtocolError(
        `Unknown native sidecar message kind ${String(kind)}`,
      );
  }
}

function concatBytes(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

export function encodeIOSSimulatorNativeSidecarFrame(
  kind: IOSSimulatorNativeSidecarMessageKind,
  body: Uint8Array,
  customLimits: Partial<IOSSimulatorNativeSidecarProtocolLimits> = {},
): Uint8Array {
  const limits = normalizeLimits(customLimits);
  const maxBytes = maxBodyBytes(kind, limits);
  if (body.byteLength > maxBytes) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      `Native sidecar frame exceeds ${maxBytes} bytes`,
    );
  }
  const output = new Uint8Array(HEADER_BYTES + body.byteLength);
  new DataView(output.buffer).setUint32(0, body.byteLength, true);
  output[4] = kind;
  output.set(body, HEADER_BYTES);
  return output;
}

export function encodeIOSSimulatorNativeSidecarJson(
  value: unknown,
  kind:
    | IOSSimulatorNativeSidecarMessageKind.Json
    | IOSSimulatorNativeSidecarMessageKind.StreamEnd = IOSSimulatorNativeSidecarMessageKind.Json,
  limits: Partial<IOSSimulatorNativeSidecarProtocolLimits> = {},
): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      `Unable to encode native sidecar JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof json !== "string") {
    throw new IOSSimulatorNativeSidecarProtocolError(
      "Native sidecar JSON payload is not serializable",
    );
  }
  return encodeIOSSimulatorNativeSidecarFrame(
    kind,
    new TextEncoder().encode(json),
    limits,
  );
}

export function decodeIOSSimulatorNativeSidecarJson(
  frame: IOSSimulatorNativeSidecarFrame,
): Record<string, unknown> {
  if (
    frame.kind !== IOSSimulatorNativeSidecarMessageKind.Json &&
    frame.kind !== IOSSimulatorNativeSidecarMessageKind.StreamEnd
  ) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      "Native sidecar frame does not contain JSON",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame.body),
    );
  } catch {
    throw new IOSSimulatorNativeSidecarProtocolError(
      "Native sidecar emitted malformed JSON",
    );
  }
  if (!isRecord(value)) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      "Native sidecar JSON must be an object",
    );
  }
  return value;
}

export function encodeIOSSimulatorNativeSidecarStreamFrame(
  metadata: IOSSimulatorNativeSidecarStreamFrameMetadata,
  bytes: Uint8Array,
  customLimits: Partial<IOSSimulatorNativeSidecarProtocolLimits> = {},
): Uint8Array {
  const limits = normalizeLimits(customLimits);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > limits.streamMetadataBytes) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      `Native sidecar stream metadata exceeds ${limits.streamMetadataBytes} bytes`,
    );
  }
  const body = new Uint8Array(
    STREAM_METADATA_PREFIX_BYTES + metadataBytes.byteLength + bytes.byteLength,
  );
  new DataView(body.buffer).setUint32(0, metadataBytes.byteLength, true);
  body.set(metadataBytes, STREAM_METADATA_PREFIX_BYTES);
  body.set(bytes, STREAM_METADATA_PREFIX_BYTES + metadataBytes.byteLength);
  return encodeIOSSimulatorNativeSidecarFrame(
    IOSSimulatorNativeSidecarMessageKind.StreamFrame,
    body,
    limits,
  );
}

export function decodeIOSSimulatorNativeSidecarStreamFrame(
  frame: IOSSimulatorNativeSidecarFrame,
  customLimits: Partial<IOSSimulatorNativeSidecarProtocolLimits> = {},
): {
  metadata: IOSSimulatorNativeSidecarStreamFrameMetadata;
  bytes: Uint8Array;
} {
  if (frame.kind !== IOSSimulatorNativeSidecarMessageKind.StreamFrame) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      "Native sidecar frame is not a stream frame",
    );
  }
  if (frame.body.byteLength < STREAM_METADATA_PREFIX_BYTES) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      "Native sidecar stream frame has no metadata length",
    );
  }
  const limits = normalizeLimits(customLimits);
  const metadataLength = new DataView(
    frame.body.buffer,
    frame.body.byteOffset,
    STREAM_METADATA_PREFIX_BYTES,
  ).getUint32(0, true);
  if (
    metadataLength === 0 ||
    metadataLength > limits.streamMetadataBytes ||
    STREAM_METADATA_PREFIX_BYTES + metadataLength > frame.body.byteLength
  ) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      "Native sidecar stream metadata length is invalid",
    );
  }
  const metadataFrame: IOSSimulatorNativeSidecarFrame = {
    kind: IOSSimulatorNativeSidecarMessageKind.Json,
    body: frame.body.subarray(
      STREAM_METADATA_PREFIX_BYTES,
      STREAM_METADATA_PREFIX_BYTES + metadataLength,
    ),
  };
  const metadata = decodeIOSSimulatorNativeSidecarJson(metadataFrame);
  if (
    typeof metadata.streamId !== "string" ||
    metadata.streamId.trim().length === 0 ||
    typeof metadata.simulatorUdid !== "string" ||
    metadata.simulatorUdid.trim().length === 0 ||
    !Number.isSafeInteger(metadata.generation) ||
    Number(metadata.generation) <= 0 ||
    !Number.isSafeInteger(metadata.sequence) ||
    Number(metadata.sequence) < 0 ||
    (metadata.encoding !== "h264" && metadata.encoding !== "bgra") ||
    (metadata.encoding === "h264" &&
      metadata.h264Format !== "annex-b" &&
      metadata.h264Format !== "length-prefixed") ||
    (metadata.encoding === "bgra" && metadata.h264Format !== undefined) ||
    !Number.isSafeInteger(metadata.width) ||
    Number(metadata.width) <= 0 ||
    !Number.isSafeInteger(metadata.height) ||
    Number(metadata.height) <= 0 ||
    (metadata.orientation !== "PORTRAIT" &&
      metadata.orientation !== "LANDSCAPE") ||
    typeof metadata.scale !== "number" ||
    !Number.isFinite(metadata.scale) ||
    metadata.scale <= 0 ||
    metadata.scale > 4 ||
    (metadata.colorSpace !== "srgb" &&
      metadata.colorSpace !== "display-p3" &&
      metadata.colorSpace !== "unknown") ||
    !Number.isSafeInteger(metadata.timestampMicros) ||
    Number(metadata.timestampMicros) < 0 ||
    (metadata.keyFrame !== undefined &&
      typeof metadata.keyFrame !== "boolean") ||
    (metadata.bytesPerRow !== undefined &&
      (!Number.isSafeInteger(metadata.bytesPerRow) ||
        Number(metadata.bytesPerRow) <= 0)) ||
    (metadata.encoding === "bgra" &&
      (!Number.isSafeInteger(metadata.bytesPerRow) ||
        Number(metadata.bytesPerRow) < Number(metadata.width) * 4))
  ) {
    throw new IOSSimulatorNativeSidecarProtocolError(
      "Native sidecar stream metadata is invalid",
    );
  }
  return {
    metadata:
      metadata as unknown as IOSSimulatorNativeSidecarStreamFrameMetadata,
    bytes: frame.body
      .subarray(STREAM_METADATA_PREFIX_BYTES + metadataLength)
      .slice(),
  };
}

/** Incremental decoder for arbitrary stdout chunk boundaries. */
export class IOSSimulatorNativeSidecarFrameDecoder {
  readonly #limits: IOSSimulatorNativeSidecarProtocolLimits;
  #buffer = new Uint8Array();
  #failed = false;

  constructor(limits: Partial<IOSSimulatorNativeSidecarProtocolLimits> = {}) {
    this.#limits = normalizeLimits(limits);
  }

  push(chunk: Uint8Array): IOSSimulatorNativeSidecarFrame[] {
    if (this.#failed) {
      throw new IOSSimulatorNativeSidecarProtocolError(
        "Native sidecar decoder is already failed",
      );
    }
    this.#buffer = concatBytes(this.#buffer, chunk);
    const frames: IOSSimulatorNativeSidecarFrame[] = [];
    try {
      while (this.#buffer.byteLength >= HEADER_BYTES) {
        const view = new DataView(
          this.#buffer.buffer,
          this.#buffer.byteOffset,
          HEADER_BYTES,
        );
        const bodyLength = view.getUint32(0, true);
        const kind = this.#buffer[4] as IOSSimulatorNativeSidecarMessageKind;
        const limit = maxBodyBytes(kind, this.#limits);
        if (bodyLength > limit) {
          throw new IOSSimulatorNativeSidecarProtocolError(
            `Native sidecar frame declares ${bodyLength} bytes, limit is ${limit}`,
          );
        }
        const totalLength = HEADER_BYTES + bodyLength;
        if (this.#buffer.byteLength < totalLength) break;
        frames.push({
          kind,
          body: this.#buffer.subarray(HEADER_BYTES, totalLength).slice(),
        });
        this.#buffer = this.#buffer.subarray(totalLength).slice();
      }
      return frames;
    } catch (error) {
      this.#failed = true;
      this.#buffer = new Uint8Array();
      throw error;
    }
  }

  finish(): void {
    if (this.#failed) return;
    if (this.#buffer.byteLength !== 0) {
      this.#failed = true;
      this.#buffer = new Uint8Array();
      throw new IOSSimulatorNativeSidecarProtocolError(
        "Native sidecar stream ended inside a framed message",
      );
    }
  }
}
