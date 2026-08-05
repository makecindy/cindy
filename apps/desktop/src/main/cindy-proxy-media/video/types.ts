/**
 * art/video/types.ts
 * ---------------------------------------------------------------------------
 * Vendor-agnostic video generation provider contract. Adding a new video
 * model later (kling / wan / luma / runway / ...) means writing one new
 * VideoProvider implementation and registering it via VideoProviderRegistry
 * — the MCP tool surface, the renderer pipeline, and the xdt-video://
 * protocol stay untouched.
 *
 * Design contract:
 *   - LLM only sees `alias` strings (e.g. 'seedance-fast', 'seedance-pro');
 *     each provider declares which aliases it owns.
 *   - LLM-facing parameters are normalized (duration in seconds, ratio as
 *     'W:H', resolution as '720p'/etc.). Provider implementations translate
 *     into vendor-specific shape (e.g. seedance prompt flag suffix).
 *   - Long-running polling is driven by the MCP handler, not the provider.
 *     Provider just exposes `submit` / `poll` / `download`.
 */

import type { CindyProxyMediaMaybePromise } from '../types.js';

export type VideoMaybePromise<T> = CindyProxyMediaMaybePromise<T>;

/** A single video generation request, normalized for any vendor. */
export interface VideoGenerationRequest {
  /** User's original prompt — passthrough rule applies (no rewriting). */
  prompt: string;
  /** Seconds. Provider may reject values not in `capabilities.supportedDurations`. */
  duration?: number;
  /** '480p' | '720p' | '1080p'. Provider declares supported set. */
  resolution?: string;
  /** 'W:H' aspect ratio string. Provider declares supported set. */
  ratio?: string;
  /** Frames per second. Provider declares supported set. */
  fps?: number;
  /**
   * 0–2 reference images, base64 data URIs (`data:image/png;base64,...`).
   *   - 1 image → first frame (animation)
   *   - 2 images → first + last frame (transition)
   * Provider declares `capabilities.maxImages` so the handler can pre-reject.
   */
  images?: string[];
  /** Provider-specific direct passthrough (seed, watermark, negative_prompt, ...). */
  extra?: Record<string, unknown>;
}

/** Handle returned by `submit`, used to drive `poll` / `download`. */
export interface VideoTaskHandle {
  /** Same as VideoProvider.id. Survives JSON round-trips so the handler can
   *  re-resolve the provider if needed. */
  providerId: string;
  /** Provider-internal task id (opaque to the handler). */
  taskId: string;
  /** Vendor's true model name, kept for echo back to LLM in the final result. */
  modelUsed: string;
  /** ms since epoch when submit completed. */
  submittedAt: number;
}

export interface VideoResultMeta {
  durationSec?: number;
  resolution?: string;
  ratio?: string;
  fps?: number;
  /** Free-form vendor usage data (token counts, etc.). */
  usage?: Record<string, unknown>;
}

export type VideoTaskStatus =
  | { state: 'pending'; raw?: unknown }
  | { state: 'running'; raw?: unknown }
  | {
      state: 'succeeded';
      videoUrl: string;
      meta: VideoResultMeta;
      raw?: unknown;
    }
  | { state: 'failed'; error: string; raw?: unknown };

export interface VideoModelAlias {
  /** Public-facing alias the LLM picks (e.g. 'seedance-fast'). */
  alias: string;
  /** One-line Chinese summary used in tool descriptions. */
  summary: string;
  /** Vendor-internal model id (e.g. 'doubao-seedance-2-0-fast-260128'). */
  internalModel: string;
}

export interface VideoProviderCapabilities {
  /**
   * Which model aliases this provider owns. Multiple aliases per provider
   * are common (fast vs pro tiers). Aliases must be globally unique across
   * the registry.
   */
  modelAliases: ReadonlyArray<VideoModelAlias>;
  supportedDurations: ReadonlyArray<number>;
  supportedResolutions: ReadonlyArray<string>;
  supportedRatios: ReadonlyArray<string>;
  supportedFps: ReadonlyArray<number>;
  /** 0 = text-to-video only, 1 = first-frame, 2 = first+last frame. */
  maxImages: 0 | 1 | 2;
  /**
   * Approximate generation time in seconds, keyed by alias. Used by the
   * placeholder card to render "≈Xmin" hints and by the handler to compute
   * a polling timeout (3× the expected time).
   */
  expectedSecondsByAlias: Readonly<Record<string, number>>;
  /** Default values when LLM omits optional parameters. */
  defaults: Readonly<{
    duration: number;
    resolution: string;
    ratio: string;
    fps: number;
  }>;
}

export interface VideoProvider {
  /** Stable provider id (e.g. 'seedance', 'kling', 'luma'). */
  readonly id: string;
  readonly capabilities: VideoProviderCapabilities;
  /** Submit a generation task. The provider translates `req` to its own body
   *  shape and POSTs. Returns a handle the handler uses for polling. */
  submit(
    req: VideoGenerationRequest,
    alias: string,
    signal?: AbortSignal,
  ): VideoMaybePromise<VideoTaskHandle>;
  /** One poll iteration. Handler decides cadence; provider just GETs once. */
  poll(
    handle: VideoTaskHandle,
    signal?: AbortSignal,
  ): VideoMaybePromise<VideoTaskStatus>;
  /** Fetch the final video bytes. Default impl can plain GET videoUrl;
   *  providers whose URLs need special headers override. */
  download(
    videoUrl: string,
    signal?: AbortSignal,
  ): VideoMaybePromise<{ buffer: Buffer; mimeType: string }>;
}
