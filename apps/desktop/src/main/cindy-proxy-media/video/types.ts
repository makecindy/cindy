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

/**
 * 参考图的用法。同样是「N 张图」,两种模式出片完全不同,所以由调用方显式
 * 声明,不靠张数隐式推断:
 *   - 'first_and_last_frame'(缺省):1 张=首帧动画,2 张=首尾帧过渡。
 *     2026-07 之前的唯一行为,不传该字段即走这条,行为完全一致。
 *     注:"载荷逐字节同形"只成立在插件协议面(shared/ghost.ts——不传就连键
 *     都没有);本类型是 desktop 内部的归一化请求,执行链会在组装请求时补上
 *     默认值,但该字段仍是可选的,**provider 必须容忍缺省**(缺省即按
 *     'first_and_last_frame' 处理),不要假设一定拿得到。
 *   - 'reference_image':多张参考图锁主体/元素/风格,由模型另行构图。
 *     提示词里须用 `[Image 1]`、`[Image 2]` 指代第几张,否则模型不知道
 *     每张图各自的用途——这条是上游要求,主机不代写提示词(passthrough)。
 */
export const VIDEO_REF_MODES = ['first_and_last_frame', 'reference_image'] as const;
export type VideoRefMode = (typeof VIDEO_REF_MODES)[number];

export const DEFAULT_VIDEO_REF_MODE: VideoRefMode = 'first_and_last_frame';

/** A single video generation request, normalized for any vendor. */
export interface VideoGenerationRequest {
  /** User's original prompt — passthrough rule applies (no rewriting). */
  prompt: string;
  /** 参考图用法(见 VideoRefMode)。不传 = 'first_and_last_frame'。 */
  refMode?: VideoRefMode;
  /** Seconds. Provider may reject values not in `capabilities.supportedDurations`. */
  duration?: number;
  /** '480p' | '720p' | '1080p'. Provider declares supported set. */
  resolution?: string;
  /** 'W:H' aspect ratio string. Provider declares supported set. */
  ratio?: string;
  /** Frames per second. Provider declares supported set. */
  fps?: number;
  /**
   * Reference images, base64 data URIs (`data:image/png;base64,...`). 张数
   * 上限随 `refMode` 变化,provider 在 `capabilities.maxImagesByRefMode` 里
   * 逐模式声明,handler 据此预拒。
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
  /**
   * 逐 refMode 的参考图张数上限。**同一张数在两种模式下不是一回事**,所以
   * 上限也不共用:
   *   - 缺席该模式的键 = 本 provider 不支持这种用法(handler 明拒,不下发)。
   *   - 0 = 只能文生视频。
   * 例:happyhorse 的首尾帧模式走 `-i2v`(只有首帧,上限 1),参考图模式走
   * `-r2v`(换了个上游模型,上限 9)——两者是不同模型,不是同模型换参数。
   */
  maxImagesByRefMode: Readonly<Partial<Record<VideoRefMode, number>>>;
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
