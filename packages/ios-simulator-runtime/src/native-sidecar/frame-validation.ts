import type {
  IOSSimulatorBgraFrame,
  IOSSimulatorH264Frame,
  IOSSimulatorNativeFrame,
} from "../driver.js";

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 16 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_ROW = 64 * 1024;

export type IOSSimulatorH264Format = "annex-b" | "length-prefixed";

export interface IOSSimulatorNativeFrameValidationOptions {
  maxFrameBytes?: number;
  maxPixels?: number;
  maxBytesPerRow?: number;
}

function findAnnexBStartCode(bytes: Uint8Array, offset: number): number {
  for (let index = offset; index + 3 <= bytes.byteLength; index += 1) {
    if (
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      bytes[index + 2] === 1
    ) {
      return index;
    }
    if (
      index + 4 <= bytes.byteLength &&
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      bytes[index + 2] === 0 &&
      bytes[index + 3] === 1
    ) {
      return index;
    }
  }
  return -1;
}

function validateH264AccessUnit(
  bytes: Uint8Array,
  format: IOSSimulatorH264Format,
  keyFrame: boolean,
): void {
  const nalTypes: number[] = [];
  if (format === "annex-b") {
    let start = findAnnexBStartCode(bytes, 0);
    if (start < 0) {
      throw new IOSSimulatorNativeFrameValidationError(
        "INVALID_FRAME",
        "H.264 Annex-B frame has no start code",
      );
    }
    while (start >= 0) {
      const prefixLength = bytes[start + 2] === 1 ? 3 : 4;
      const nalStart = start + prefixLength;
      if (nalStart >= bytes.byteLength) {
        throw new IOSSimulatorNativeFrameValidationError(
          "INVALID_FRAME",
          "H.264 Annex-B frame contains an empty NAL unit",
        );
      }
      nalTypes.push(bytes[nalStart]! & 0x1f);
      start = findAnnexBStartCode(bytes, nalStart + 1);
    }
  } else {
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (offset + 4 > bytes.byteLength) {
        throw new IOSSimulatorNativeFrameValidationError(
          "INVALID_FRAME",
          "H.264 length-prefixed frame has a truncated NAL length",
        );
      }
      const length = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        4,
      ).getUint32(0, false);
      offset += 4;
      if (length === 0 || offset + length > bytes.byteLength) {
        throw new IOSSimulatorNativeFrameValidationError(
          "INVALID_FRAME",
          "H.264 length-prefixed frame has an invalid NAL length",
        );
      }
      nalTypes.push(bytes[offset]! & 0x1f);
      offset += length;
    }
  }
  if (nalTypes.some((type) => type === 0 || type > 23)) {
    throw new IOSSimulatorNativeFrameValidationError(
      "INVALID_FRAME",
      "H.264 frame contains an invalid NAL unit type",
    );
  }
  if (keyFrame && !nalTypes.includes(5)) {
    throw new IOSSimulatorNativeFrameValidationError(
      "INVALID_FRAME",
      "H.264 key frame must contain an IDR NAL unit",
    );
  }
}

export class IOSSimulatorNativeFrameValidationError extends Error {
  constructor(
    readonly code: "INVALID_FRAME" | "FRAME_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "IOSSimulatorNativeFrameValidationError";
  }
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new IOSSimulatorNativeFrameValidationError(
      "INVALID_FRAME",
      `${name} must be a positive safe integer`,
    );
  }
  return resolved;
}

function validateDimensions(
  width: number,
  height: number,
  maxPixels: number,
): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > maxPixels
  ) {
    throw new IOSSimulatorNativeFrameValidationError(
      "INVALID_FRAME",
      "Native frame dimensions exceed the correctness limits",
    );
  }
}

function validateCommon(
  frame: IOSSimulatorH264Frame | IOSSimulatorBgraFrame,
  options: IOSSimulatorNativeFrameValidationOptions,
): { maxFrameBytes: number; maxPixels: number; maxBytesPerRow: number } {
  const maxFrameBytes = positiveLimit(
    options.maxFrameBytes,
    DEFAULT_MAX_FRAME_BYTES,
    "maxFrameBytes",
  );
  const maxPixels = positiveLimit(
    options.maxPixels,
    DEFAULT_MAX_PIXELS,
    "maxPixels",
  );
  const maxBytesPerRow = positiveLimit(
    options.maxBytesPerRow,
    DEFAULT_MAX_BYTES_PER_ROW,
    "maxBytesPerRow",
  );
  validateDimensions(frame.width, frame.height, maxPixels);
  if (
    (frame.orientation !== "PORTRAIT" && frame.orientation !== "LANDSCAPE") ||
    !Number.isFinite(frame.scale) ||
    frame.scale <= 0 ||
    frame.scale > 4 ||
    (frame.colorSpace !== "srgb" &&
      frame.colorSpace !== "display-p3" &&
      frame.colorSpace !== "unknown")
  ) {
    throw new IOSSimulatorNativeFrameValidationError(
      "INVALID_FRAME",
      "Native frame orientation, scale, or color space is invalid",
    );
  }
  if (!(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength === 0) {
    throw new IOSSimulatorNativeFrameValidationError(
      "INVALID_FRAME",
      "Native frame bytes must be non-empty",
    );
  }
  if (frame.bytes.byteLength > maxFrameBytes) {
    throw new IOSSimulatorNativeFrameValidationError(
      "FRAME_TOO_LARGE",
      "Native frame bytes exceed the configured limit",
    );
  }
  if (
    !Number.isSafeInteger(frame.timestampMicros) ||
    frame.timestampMicros < 0
  ) {
    throw new IOSSimulatorNativeFrameValidationError(
      "INVALID_FRAME",
      "Native frame timestamp is invalid",
    );
  }
  return { maxFrameBytes, maxPixels, maxBytesPerRow };
}

export function validateIOSimulatorNativeFrame(
  frame: IOSSimulatorNativeFrame,
  options: IOSSimulatorNativeFrameValidationOptions = {},
): IOSSimulatorNativeFrame {
  const limits = validateCommon(frame, options);
  if (frame.encoding === "bgra") {
    if (
      !Number.isSafeInteger(frame.bytesPerRow) ||
      frame.bytesPerRow < frame.width * 4 ||
      frame.bytesPerRow > limits.maxBytesPerRow
    ) {
      throw new IOSSimulatorNativeFrameValidationError(
        "INVALID_FRAME",
        "BGRA bytesPerRow is inconsistent with the frame dimensions",
      );
    }
    const expectedBytes = frame.bytesPerRow * frame.height;
    if (expectedBytes !== frame.bytes.byteLength) {
      throw new IOSSimulatorNativeFrameValidationError(
        "INVALID_FRAME",
        "BGRA frame bytes do not match bytesPerRow and height",
      );
    }
  } else if (typeof frame.keyFrame !== "boolean") {
    throw new IOSSimulatorNativeFrameValidationError(
      "INVALID_FRAME",
      "H.264 keyFrame flag is invalid",
    );
  } else {
    validateH264AccessUnit(frame.bytes, frame.format, frame.keyFrame);
  }
  return frame;
}

export function convertIOSimulatorBgraToRgba(
  frame: IOSSimulatorBgraFrame,
  options: IOSSimulatorNativeFrameValidationOptions = {},
): Uint8Array {
  validateIOSimulatorNativeFrame(frame, options);
  const rgba = new Uint8Array(frame.width * frame.height * 4);
  for (let y = 0; y < frame.height; y += 1) {
    const sourceRow = y * frame.bytesPerRow;
    const targetRow = y * frame.width * 4;
    for (let x = 0; x < frame.width; x += 1) {
      const source = sourceRow + x * 4;
      const target = targetRow + x * 4;
      rgba[target] = frame.bytes[source + 2]!;
      rgba[target + 1] = frame.bytes[source + 1]!;
      rgba[target + 2] = frame.bytes[source]!;
      rgba[target + 3] = frame.bytes[source + 3]!;
    }
  }
  return rgba;
}

export interface IOSSimulatorNativeFrameQueueStats {
  depth: number;
  byteCount: number;
  droppedFrames: number;
  droppedBytes: number;
}

/** Latest-frame queue with deterministic memory and drop bounds. */
export class IOSSimulatorNativeFrameQueue {
  readonly #maxFrames: number;
  readonly #maxBytes: number;
  readonly #validation: IOSSimulatorNativeFrameValidationOptions;
  readonly #frames: IOSSimulatorNativeFrame[] = [];
  #byteCount = 0;
  #droppedFrames = 0;
  #droppedBytes = 0;

  constructor(
    options: {
      maxFrames?: number;
      maxBytes?: number;
      validation?: IOSSimulatorNativeFrameValidationOptions;
    } = {},
  ) {
    this.#maxFrames = positiveLimit(options.maxFrames, 2, "maxFrames");
    this.#maxBytes = positiveLimit(
      options.maxBytes,
      DEFAULT_MAX_FRAME_BYTES * 2,
      "maxBytes",
    );
    this.#validation = options.validation ?? {};
  }

  get stats(): IOSSimulatorNativeFrameQueueStats {
    return {
      depth: this.#frames.length,
      byteCount: this.#byteCount,
      droppedFrames: this.#droppedFrames,
      droppedBytes: this.#droppedBytes,
    };
  }

  enqueue(frame: IOSSimulatorNativeFrame): boolean {
    validateIOSimulatorNativeFrame(frame, this.#validation);
    if (frame.bytes.byteLength > this.#maxBytes) {
      this.#droppedFrames += 1;
      this.#droppedBytes += frame.bytes.byteLength;
      return false;
    }
    const owned: IOSSimulatorNativeFrame = {
      ...frame,
      bytes: frame.bytes.slice(),
    };
    while (
      this.#frames.length >= this.#maxFrames ||
      this.#byteCount + owned.bytes.byteLength > this.#maxBytes
    ) {
      const dropped = this.#frames.shift();
      if (!dropped) break;
      this.#byteCount -= dropped.bytes.byteLength;
      this.#droppedFrames += 1;
      this.#droppedBytes += dropped.bytes.byteLength;
    }
    this.#frames.push(owned);
    this.#byteCount += owned.bytes.byteLength;
    return true;
  }

  dequeue(): IOSSimulatorNativeFrame | null {
    const frame = this.#frames.shift() ?? null;
    if (frame) this.#byteCount -= frame.bytes.byteLength;
    return frame;
  }

  takeLatest(): IOSSimulatorNativeFrame | null {
    if (this.#frames.length <= 1) return this.dequeue();
    const latest = this.#frames.at(-1)!;
    for (const dropped of this.#frames.slice(0, -1)) {
      this.#droppedFrames += 1;
      this.#droppedBytes += dropped.bytes.byteLength;
    }
    this.#frames.length = 0;
    this.#byteCount = 0;
    return { ...latest, bytes: latest.bytes.slice() };
  }

  clear(): void {
    this.#frames.length = 0;
    this.#byteCount = 0;
  }
}
