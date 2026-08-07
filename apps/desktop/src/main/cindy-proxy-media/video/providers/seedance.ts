/**
 * art/video/providers/seedance.ts
 * ---------------------------------------------------------------------------
 * VideoProvider implementation for Volcengine ARK Doubao Seedance 2.x models,
 * routed through XD Gateway's `/volcengine/api/v3/contents/generations/tasks`
 * passthrough.
 *
 * Three model choices exposed:
 *   - 'seedance-fast' → doubao-seedance-2-0-fast-260128 (≈2min, default)
 *   - 'seedance-pro'  → doubao-seedance-2-0-260128       (≈5min, quality tier)
 *   - 'bytedance/seedance-2.5' → doubao-seedance-2-5-260628 (explicit opt-in)
 *
 * API quirks worth knowing:
 *   - Submit body uses Volcengine's chat-style `content` array:
 *       [{type:'text', text:'<prompt> --duration 4 --resolution 720p ...'},
 *        {type:'image_url', image_url:{url:'data:...|https://...'}, role:'first_frame'},
 *        ...]
 *     LLM-facing knobs (duration/resolution/ratio/fps) are NOT separate body
 *     fields — they have to be appended as `--key value` flag suffixes inside
 *     the text content node. This provider does that translation so the LLM
 *     never has to construct flag strings.
 *   - Poll returns the final mp4 as a 24h-signed TOS URL in `content.video_url`;
 *     download has no extra auth, plain GET.
 */

import { Buffer } from 'node:buffer';
import {
  joinProxyUrl,
  parseJsonResponse,
  requireApiKey,
  GatewayHttpError,
  type GatewayHttpAuth,
} from '../../api/gatewayHttp.js';
import type { LiziMcpLogger } from '@cindy/mcps';
import type {
  VideoGenerationRequest,
  VideoProvider,
  VideoProviderCapabilities,
  VideoTaskHandle,
  VideoTaskStatus,
} from '../types.js';

export interface CreateSeedanceProviderOptions {
  baseUrl: string;
  /** Path to the submit endpoint, default `/volcengine/api/v3/contents/generations/tasks`. */
  submitPath?: string;
  /** Path template for poll, default `/volcengine/api/v3/contents/generations/tasks/{id}`.
   *  `{id}` is substituted with the task id. */
  pollPathTemplate?: string;
  getApiKey: GatewayHttpAuth['getApiKey'];
  fetchImplementation?: typeof fetch;
  logger?: LiziMcpLogger;
}

const DEFAULT_SUBMIT_PATH = '/volcengine/api/v3/contents/generations/tasks';
const DEFAULT_POLL_TEMPLATE =
  '/volcengine/api/v3/contents/generations/tasks/{id}';

const CAPABILITIES: VideoProviderCapabilities = {
  modelAliases: [
    {
      alias: 'seedance-fast',
      summary: '快(~2min) - 默认,首选',
      internalModel: 'doubao-seedance-2-0-fast-260128',
    },
    {
      alias: 'seedance-pro',
      summary: '精(~5min) - 用户显式要"高质量"再选',
      internalModel: 'doubao-seedance-2-0-260128',
    },
    {
      alias: 'bytedance/seedance-2.5',
      summary: 'Seedance 2.5(~5min) - 用户显式点名 2.5 再选',
      internalModel: 'doubao-seedance-2-5-260628',
    },
  ],
  supportedDurations: [4, 6, 8, 10],
  supportedResolutions: ['480p', '720p', '1080p'],
  supportedRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  supportedFps: [24],
  // 首尾帧与参考图是同一个 seedance-2.0 模型的两种 role,不换模型。
  // 参考图上限 9 的出处:方舟官方 role 枚举里有 reference_image,但官方页
  // 正文是 SPA 抓不到,9 图/3 视频/3 音频的数字来自 fal、Replicate、接口AI
  // 等多家聚合平台的一致口径,**未实测**。真实上限更低时上游会在提交期拒,
  // 错误原样透传给调用方,不会静默出片。
  maxImagesByRefMode: {
    first_and_last_frame: 2,
    reference_image: 9,
  },
  // Seedance 2.0 原生音画同生(对白 / 音效 / 音乐),开关是请求体顶层的
  // `generate_audio`,**上游默认 true** —— 也就是说本 provider 在接入音频开关
  // 之前出的片子本来就是有声的。所以 audioDefault 必须是 true:回执要如实报
  // 现状,而请求侧不传就照旧一个字段都不写(见 run.ts 的三态)。
  supportsAudio: true,
  audioDefault: true,
  expectedSecondsByAlias: {
    'seedance-fast': 120,
    'seedance-pro': 300,
    'bytedance/seedance-2.5': 300,
  },
  defaults: {
    duration: 4,
    resolution: '720p',
    ratio: '16:9',
    fps: 24,
  },
};

interface SeedancePollResponse {
  id: string;
  model: string;
  status: 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  content?: { video_url?: string };
  error?: { message?: string; code?: string };
  resolution?: string;
  ratio?: string;
  duration?: number;
  framespersecond?: number;
  usage?: Record<string, unknown>;
}

/** Append `--duration N --resolution Xp --ratio R --fps F` to the prompt
 *  text node. Order matches Volcengine docs (the parser is order-tolerant
 *  but matching docs makes test fixtures readable). */
function buildSeedancePromptText(req: VideoGenerationRequest): string {
  const flags: string[] = [];
  const d = req.duration ?? CAPABILITIES.defaults.duration;
  const r = req.resolution ?? CAPABILITIES.defaults.resolution;
  const ar = req.ratio ?? CAPABILITIES.defaults.ratio;
  const fps = req.fps ?? CAPABILITIES.defaults.fps;
  flags.push(`--duration ${d}`);
  flags.push(`--resolution ${r}`);
  flags.push(`--ratio ${ar}`);
  flags.push(`--fps ${fps}`);
  return `${req.prompt} ${flags.join(' ')}`;
}

interface SeedanceContentItem {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
  role?: 'first_frame' | 'last_frame' | 'reference_image';
}

/**
 * 参考图 → content 数组。role 由 refMode 决定:
 *   - first_and_last_frame:第 1 张 first_frame,第 2 张 last_frame(老行为)。
 *   - reference_image:每张都是 reference_image,顺序即提示词里的
 *     「图片1 / 图片2 / …」序号,所以**不能重排**。
 * 两种 role 不混用:方舟文档只是并列列出,没说能否共存,混发等于赌未定义
 * 行为。
 */
function buildSeedanceContent(req: VideoGenerationRequest): SeedanceContentItem[] {
  const content: SeedanceContentItem[] = [
    { type: 'text', text: buildSeedancePromptText(req) },
  ];
  const images = req.images ?? [];
  if (req.refMode === 'reference_image') {
    for (const url of images) {
      content.push({
        type: 'image_url',
        image_url: { url },
        role: 'reference_image',
      });
    }
    return content;
  }
  if (images.length > 0) {
    content.push({
      type: 'image_url',
      image_url: { url: images[0] },
      role: 'first_frame',
    });
  }
  if (images.length > 1) {
    content.push({
      type: 'image_url',
      image_url: { url: images[1] },
      role: 'last_frame',
    });
  }
  return content;
}

export function createSeedanceProvider(
  opts: CreateSeedanceProviderOptions,
): VideoProvider {
  const submitPath = opts.submitPath ?? DEFAULT_SUBMIT_PATH;
  const pollTemplate = opts.pollPathTemplate ?? DEFAULT_POLL_TEMPLATE;
  const submitUrl = joinProxyUrl(opts.baseUrl, submitPath);
  const doFetch = opts.fetchImplementation ?? fetch;

  function pollUrl(taskId: string): string {
    const path = pollTemplate.replace('{id}', encodeURIComponent(taskId));
    return joinProxyUrl(opts.baseUrl, path);
  }

  async function submit(
    req: VideoGenerationRequest,
    alias: string,
    signal?: AbortSignal,
  ): Promise<VideoTaskHandle> {
    const aliasInfo = CAPABILITIES.modelAliases.find((a) => a.alias === alias);
    if (!aliasInfo) {
      throw new GatewayHttpError(
        `seedance: unknown alias '${alias}'`,
        400,
      );
    }
    const apiKey = await requireApiKey({ getApiKey: opts.getApiKey });
    const body = {
      model: aliasInfo.internalModel,
      content: buildSeedanceContent(req),
      // 音频开关是请求体**顶层布尔字段**,不是 content 文本里的 `--flag` 后缀
      // (画面那四项走后缀是 1.0 时代的口径,音频没有对应的后缀写法)。
      // 三态:调用方没表态就不写这个键,上游按自己的默认(true)出片,与本
      // 字段出现之前的请求体逐字节同形。
      ...(req.audio !== undefined ? { generate_audio: req.audio } : {}),
    };
    const res = await doFetch(submitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    const parsed = await parseJsonResponse<{ id?: string }>(res, opts.logger);
    if (!parsed.id) {
      throw new GatewayHttpError(
        'seedance submit response missing id',
        res.status,
        parsed,
      );
    }
    return {
      providerId: 'seedance',
      taskId: parsed.id,
      modelUsed: aliasInfo.internalModel,
      submittedAt: Date.now(),
    };
  }

  async function poll(
    handle: VideoTaskHandle,
    signal?: AbortSignal,
  ): Promise<VideoTaskStatus> {
    const apiKey = await requireApiKey({ getApiKey: opts.getApiKey });
    const res = await doFetch(pollUrl(handle.taskId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const data = await parseJsonResponse<SeedancePollResponse>(res, opts.logger);
    switch (data.status) {
      case 'pending':
      case 'queued':
        return { state: 'pending', raw: data };
      case 'running':
        return { state: 'running', raw: data };
      case 'failed':
      case 'cancelled':
        return {
          state: 'failed',
          error:
            data.error?.message ??
            `seedance task ${data.status} (no error message)`,
          raw: data,
        };
      case 'succeeded': {
        const url = data.content?.video_url;
        if (!url) {
          return {
            state: 'failed',
            error: 'seedance reported succeeded but no video_url in content',
            raw: data,
          };
        }
        return {
          state: 'succeeded',
          videoUrl: url,
          meta: {
            durationSec: data.duration,
            resolution: data.resolution,
            ratio: data.ratio,
            fps: data.framespersecond,
            usage: data.usage,
          },
          raw: data,
        };
      }
      default:
        return {
          state: 'running',
          raw: data,
        };
    }
  }

  async function download(
    videoUrl: string,
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    // Seedance returns a 24h-signed TOS URL — plain GET, no auth header.
    const res = await doFetch(videoUrl, { method: 'GET', signal });
    if (!res.ok) {
      throw new GatewayHttpError(
        `seedance download failed HTTP ${res.status}`,
        res.status,
      );
    }
    const ab = await res.arrayBuffer();
    const mimeType = res.headers.get('content-type') ?? 'video/mp4';
    return { buffer: Buffer.from(ab), mimeType };
  }

  return {
    id: 'seedance',
    capabilities: CAPABILITIES,
    submit,
    poll,
    download,
  };
}
