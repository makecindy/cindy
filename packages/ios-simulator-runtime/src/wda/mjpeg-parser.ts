import { WdaError } from "./errors.js";

const HEADER_SEPARATOR = new Uint8Array([13, 10, 13, 10]);
const CRLF = new Uint8Array([13, 10]);
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface MjpegParserOptions {
  boundary: string;
  maxHeaderBytes?: number;
  maxFrameBytes?: number;
}

function findBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from <= haystack.length ? from : -1;
  outer: for (
    let index = from;
    index <= haystack.length - needle.length;
    index += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function requirePositiveLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      `${label} must be a positive integer`,
    );
  }
  return resolved;
}

function parseContentLength(headerBytes: Uint8Array): number {
  const headerText = new TextDecoder("latin1", { fatal: false }).decode(
    headerBytes,
  );
  const contentLengthValues = headerText
    .split("\r\n")
    .filter((line) => /^content-length\s*:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
  if (
    contentLengthValues.length !== 1 ||
    !/^\d+$/.test(contentLengthValues[0] ?? "")
  ) {
    throw new WdaError(
      "STREAM_ERROR",
      "MJPEG part must contain exactly one valid Content-Length",
    );
  }
  const length = Number(contentLengthValues[0]);
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new WdaError(
      "STREAM_ERROR",
      "MJPEG Content-Length must be a positive integer",
    );
  }
  return length;
}

/**
 * Incremental multipart MJPEG parser. It trusts only a bounded Content-Length and
 * never scans JPEG bytes for a boundary, so arbitrary network chunking is safe.
 */
export class MjpegFrameParser {
  readonly #boundary: Uint8Array;
  readonly #maxHeaderBytes: number;
  readonly #maxFrameBytes: number;
  #buffer: Uint8Array = new Uint8Array();
  #state: "boundary" | "headers" | "frame" | "ended" = "boundary";
  #frameLength = 0;

  constructor(options: MjpegParserOptions) {
    const normalizedBoundary = options.boundary.trim().replace(/^--/, "");
    if (!normalizedBoundary || /[\r\n]/.test(normalizedBoundary)) {
      throw new WdaError("INVALID_CONFIGURATION", "MJPEG boundary is invalid");
    }
    this.#boundary = new TextEncoder().encode(`--${normalizedBoundary}`);
    this.#maxHeaderBytes = requirePositiveLimit(
      options.maxHeaderBytes,
      DEFAULT_MAX_HEADER_BYTES,
      "maxHeaderBytes",
    );
    this.#maxFrameBytes = requirePositiveLimit(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
  }

  /** Consume a network chunk and return every complete JPEG contained in it. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.#state === "ended") return [];
    this.#buffer = concatBytes(this.#buffer, chunk);
    const frames: Uint8Array[] = [];

    while (true) {
      if (this.#state === "boundary") {
        const boundaryIndex = findBytes(this.#buffer, this.#boundary);
        if (boundaryIndex < 0) {
          const retained = Math.min(
            this.#buffer.length,
            this.#boundary.length - 1,
          );
          this.#buffer = this.#buffer.slice(this.#buffer.length - retained);
          break;
        }
        if (this.#buffer.length < boundaryIndex + this.#boundary.length + 2) {
          this.#buffer = this.#buffer.slice(boundaryIndex);
          break;
        }
        this.#buffer = this.#buffer.slice(
          boundaryIndex + this.#boundary.length,
        );
        if (this.#buffer[0] === 45 && this.#buffer[1] === 45) {
          this.#state = "ended";
          this.#buffer = new Uint8Array();
          break;
        }
        if (this.#buffer[0] !== CRLF[0] || this.#buffer[1] !== CRLF[1]) {
          throw new WdaError(
            "STREAM_ERROR",
            "MJPEG boundary is not followed by CRLF",
          );
        }
        this.#buffer = this.#buffer.slice(2);
        this.#state = "headers";
      }

      if (this.#state === "headers") {
        const separatorIndex = findBytes(this.#buffer, HEADER_SEPARATOR);
        if (separatorIndex < 0) {
          if (this.#buffer.length > this.#maxHeaderBytes) {
            throw new WdaError(
              "STREAM_ERROR",
              "MJPEG part headers exceed the configured limit",
            );
          }
          break;
        }
        if (separatorIndex > this.#maxHeaderBytes) {
          throw new WdaError(
            "STREAM_ERROR",
            "MJPEG part headers exceed the configured limit",
          );
        }
        this.#frameLength = parseContentLength(
          this.#buffer.slice(0, separatorIndex),
        );
        if (this.#frameLength > this.#maxFrameBytes) {
          throw new WdaError(
            "RESPONSE_TOO_LARGE",
            "MJPEG frame exceeds the configured limit",
          );
        }
        this.#buffer = this.#buffer.slice(
          separatorIndex + HEADER_SEPARATOR.length,
        );
        this.#state = "frame";
      }

      if (this.#state === "frame") {
        if (this.#buffer.length < this.#frameLength) break;
        const frame = this.#buffer.slice(0, this.#frameLength);
        if (
          frame[0] !== 0xff ||
          frame[1] !== 0xd8 ||
          frame[frame.length - 2] !== 0xff ||
          frame[frame.length - 1] !== 0xd9
        ) {
          throw new WdaError(
            "STREAM_ERROR",
            "MJPEG part does not contain a JPEG frame",
          );
        }
        frames.push(frame);
        this.#buffer = this.#buffer.slice(this.#frameLength);
        if (
          this.#buffer.length >= 2 &&
          this.#buffer[0] === CRLF[0] &&
          this.#buffer[1] === CRLF[1]
        ) {
          this.#buffer = this.#buffer.slice(2);
        }
        this.#frameLength = 0;
        this.#state = "boundary";
      }
    }

    return frames;
  }

  /** Assert that EOF did not cut a header or JPEG body in half. */
  finish(): void {
    if (this.#state === "headers" || this.#state === "frame") {
      throw new WdaError(
        "STREAM_ERROR",
        "MJPEG stream ended inside a multipart frame",
      );
    }
  }
}

/** Extract a multipart boundary parameter from an HTTP Content-Type value. */
export function parseMjpegBoundary(contentType: string | null): string {
  if (!contentType || !/^multipart\//i.test(contentType.trim())) {
    throw new WdaError(
      "STREAM_ERROR",
      "MJPEG response is not multipart content",
    );
  }
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(
    contentType,
  );
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim().replace(/^--/, "");
  if (!boundary || /[\r\n]/.test(boundary)) {
    throw new WdaError(
      "STREAM_ERROR",
      "MJPEG response has no valid boundary parameter",
    );
  }
  return boundary;
}
