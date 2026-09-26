/**
 * unified-downloader — Public TypeScript types.
 * ---------------------------------------------------------------------------
 * Public contract: this module owns the downloader option, progress and error types.
 *
 * The downloader exposes ONLY a TS API (no IPC, no events emitter). All
 * progress / retry / resume signals flow through callbacks on `DownloadOptions`.
 */

export interface DownloadOptions {
  /** Absolute HTTP(S) URL to fetch. */
  url: string;
  /** Absolute target file path on disk. The downloader writes `${targetPath}.part`
   * during the transfer and renames to `targetPath` after SHA256 passes. */
  targetPath: string;
  /** Optional caller policy, checked before dispatch and every redirect. */
  validateUrl?: (url: string) => void;
  /** Maximum bytes allowed on disk, including resumed bytes. */
  maxBytes?: number;
  /** Called after all bytes arrive, before checksum verification. */
  onVerifying?: () => void;
  /** 64-char lowercase hex SHA256 (uppercase accepted, lowercased internally). */
  sha256: string;
  /** Optional. When provided, Content-Length must match for fresh downloads. */
  expectedSize?: number;
  /** Raw progress events (no clamping / no smoothing — caller-side concern). */
  onProgress?: (e: ProgressEvent) => void;
  /** Fired before each backoff sleep. Use for logging/telemetry. */
  onRetry?: (e: RetryEvent) => void;
  /** Fired once per attempt that resumes from a non-zero offset. */
  onResume?: (e: ResumeEvent) => void;
  /** Caller can abort the in-flight download (queued, executing, or backing off). */
  signal?: AbortSignal;
  /** Logger; falls back to console when omitted. */
  logger?: Logger;
  /** Override retry strategy. */
  retry?: Partial<RetryConfig>;
  /** Override timeout strategy. */
  timeout?: Partial<TimeoutConfig>;
}

export interface DownloadResult {
  /** Final file path (== targetPath when resolve fires). */
  path: string;
  /** File size in bytes (== Content-Length / verified body). */
  size: number;
  /** Lowercase hex SHA256 of the file (matches expected sha256). */
  sha256: string;
  /** True when the file already existed at targetPath and matched sha256 — no network I/O. */
  fromCache: boolean;
  /** Wall-clock duration from enqueue to resolve, in ms. */
  durationMs: number;
  /** Bytes restored from `.part` before the network request started (0 = full download). */
  resumedFromBytes: number;
}

export interface ProgressEvent {
  /** Total bytes written to `.part` so far (cumulative across resume). */
  loaded: number;
  /** Total bytes expected; null when Content-Length / expectedSize are unknown. */
  total: number | null;
  /** Raw percent. Null when total is null. May exceed 100 if server lies — caller clamps. */
  percent: number | null;
  /** 5-second sliding window throughput in bytes/sec; 0 until ~1s of samples accumulated. */
  speedBps: number;
}

export interface RetryEvent {
  /** 1-based: the attempt that is ABOUT to start. */
  attempt: number;
  /** Backoff sleep before the next attempt, in ms. */
  delayMs: number;
  /** Underlying error (typically a DownloadError). */
  cause: Error;
}

export interface ResumeEvent {
  /** Bytes restored from `.part`. */
  fromBytes: number;
  /** Total bytes expected (may be null). */
  totalBytes: number | null;
}

export type DownloadErrorCode =
  | 'NETWORK'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'CHECKSUM'
  | 'DISK'
  | 'ABORTED'
  | 'INVALID_ARG';

export class DownloadError extends Error {
  public readonly code: DownloadErrorCode;
  public readonly cause?: Error;
  public readonly httpStatus?: number;

  constructor(
    code: DownloadErrorCode,
    message: string,
    cause?: Error,
    httpStatus?: number,
  ) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.cause = cause;
    this.httpStatus = httpStatus;
  }
}

export interface RetryConfig {
  /** Default 6. */
  maxAttempts: number;
  /** Default 1000. */
  baseDelayMs: number;
  /** Default 30000. */
  maxDelayMs: number;
  /** Default 0.25 (±25%). */
  jitterRatio: number;
}

export interface TimeoutConfig {
  /** Default 10000 — time from request.end to first response event. */
  connectMs: number;
  /** Default 30000 — max gap between data chunks before treating as dead. */
  idleMs: number;
}

export interface Logger {
  debug?(msg: string, meta?: unknown): void;
  info?(msg: string, meta?: unknown): void;
  warn?(msg: string, meta?: unknown): void;
  error?(msg: string, meta?: unknown): void;
}
