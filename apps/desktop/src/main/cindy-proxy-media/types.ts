import type { LiziMcpLogger, SavedImage, SavedVideoRef } from '@cindy/mcps';
import type { VideoProviderRegistry } from './video/registry.js';
import type { VideoProvider } from './video/types.js';

export type CindyProxyMediaMaybePromise<T> = T | Promise<T>;

export interface CindyProxyMediaImageRefResolverResult {
  absPath: string;
}

export interface CindyProxyMediaProxyConfig {
  baseUrl: string;
  generatePath: string;
  editPath: string;
}

export interface CindyProxyMediaImageApiConfig {
  getApiKey(): CindyProxyMediaMaybePromise<string | null>;
  proxy: CindyProxyMediaProxyConfig;
  fetchImplementation?: typeof fetch;
}

export interface CindyProxyMediaStorageAdapter {
  saveImage(b64: string, mime?: string): Promise<SavedImage>;
  resolveImageRef(ref: string): Promise<string>;
}

export interface CindyProxyMediaVideoStorageAdapter {
  saveVideo(buffer: Buffer, mime: string): Promise<SavedVideoRef>;
}

export interface CindyProxyMediaServiceOptions {
  imageApi: CindyProxyMediaImageApiConfig;
  storage: CindyProxyMediaStorageAdapter;
  /**
   * Optional video providers list (one per supported model family). Empty
   * or omitted ⇒ backend.videoRegistry is undefined (host 侧 cindy 槽据此
   * 判定视频能力不可用)。Adding a new model later = construct a new
   * VideoProvider impl and append it here; nothing else needs to change.
   */
  videoProviders?: ReadonlyArray<VideoProvider>;
  /** Required when videoProviders is non-empty. */
  videoStorage?: CindyProxyMediaVideoStorageAdapter;
  logger?: LiziMcpLogger;
}

/**
 * XD Gateway 图像/视频后端服务。lizi_art MCP 工具层已退役(2026-07-12),
 * 本服务只作为 cindy 槽(意识代办)与 mivo 存储复用的后端能力载体,
 * 不再对任何 agent 暴露工具。
 */
export interface CindyProxyMediaService {
  backend: CindyProxyMediaBackendDeps;
}

/**
 * XD Gateway 图像模型目录——全应用图像模型清单的**唯一事实源**(意识 cindy 槽
 * 白名单/详情页下拉都从这里派生,不许再抄一份)。
 * 加模型 = 只改这里;将来图像模型进 OSS providers.json 目录热更时,本常量
 * 降级为兜底。label 供 UI 展示(当前全部经 XD Gateway,供应商后缀由 UI 拼)。
 */
export const GATEWAY_IMAGE_MODELS = [
  { id: 'gpt-image-2', label: 'GPT Image 2' },
  { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image' },
  { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image' },
] as const;

export type GatewayImageModel = (typeof GATEWAY_IMAGE_MODELS)[number]['id'];

/**
 * XD Gateway 视频模型目录——全应用视频模型清单的**唯一事实源**(与
 * GATEWAY_IMAGE_MODELS 同地位:意识 cindy 槽白名单/详情页下拉从这里派生)。
 * id 即 video provider 层的 alias(seedance.ts / happyhorse.ts 声明,注册期
 * 全局唯一);顺序敏感——首项是出厂默认。providers.json 目录热更接管后,
 * 本常量降级为兜底;与 provider 声明的一致性由同源守卫测试锁住。
 */
export const GATEWAY_VIDEO_MODELS = [
  { id: 'seedance-fast', label: 'Seedance 快速' },
  { id: 'seedance-pro', label: 'Seedance Pro' },
  { id: 'happyhorse', label: 'HappyHorse 1.0' },
] as const;

export type GatewayVideoModel = (typeof GATEWAY_VIDEO_MODELS)[number]['id'];

export interface GatewayImageGenerateParams {
  model: GatewayImageModel;
  prompt: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high';
  n?: number;
}

export interface GatewayImageEditParams {
  model: GatewayImageModel;
  prompt: string;
  imagePaths: string[];
  size?: string;
  quality?: 'low' | 'medium' | 'high';
  n?: number;
}

export interface GatewayImageItem {
  b64_json: string;
  revised_prompt?: string;
  url?: string | null;
}

export interface GatewayImageUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    image_tokens?: number;
    text_tokens?: number;
  };
  output_tokens_details?: {
    image_tokens?: number;
    text_tokens?: number;
  };
}

export interface GatewayImageResponse {
  created: number;
  data: GatewayImageItem[];
  size?: string;
  quality?: string;
  output_format?: string;
  background?: string | null;
  usage?: GatewayImageUsage;
}

/**
 * XD Gateway 图像/视频后端能力集(原 ArtMcpDeps)。lizi_art MCP 工具层已退役
 * (2026-07-12),本接口只服务 host 侧直连调用:cindy 槽(意识代办)与 mivo
 * 的存储复用,不再对 agent 暴露任何工具。
 */
export interface CindyProxyMediaBackendDeps {
  generateImage(
    params: GatewayImageGenerateParams,
    signal?: AbortSignal,
  ): Promise<GatewayImageResponse>;
  editImage(
    params: GatewayImageEditParams,
    signal?: AbortSignal,
  ): Promise<GatewayImageResponse>;
  saveImage(b64: string, mime?: string): Promise<SavedImage>;
  resolveImageRef(ref: string): Promise<string>;
  /**
   * Video provider registry. Optional — absent ⇒ host 侧视频能力不可用
   * (cindy 槽据此拒绝视频代办)。
   * Type-only import to keep types.ts free of runtime cycles.
   */
  videoRegistry?: VideoProviderRegistry;
  /** Persist a generated video buffer; returns the renderable video URL. */
  saveVideo?(buffer: Buffer, mime: string): Promise<SavedVideoRef>;
  logger?: LiziMcpLogger;
}
