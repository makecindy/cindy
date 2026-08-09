/**
 * art/video/providers/seedance.ts
 * ---------------------------------------------------------------------------
 * VideoProvider implementations for Volcengine ARK Seedance, routed through XD
 * Gateway's `/volcengine/api/v3/contents/generations/tasks` passthrough.
 *
 * 两代模型 = 两个**独立 provider**,不是同一个 provider 的多个 alias:
 *   - `createSeedanceProvider`   → Seedance 2.0
 *       'seedance-fast' → doubao-seedance-2-0-fast-260128 (≈2min, default)
 *       'seedance-pro'  → doubao-seedance-2-0-260128       (≈5min, quality tier)
 *   - `createSeedance25Provider` → Seedance 2.5
 *       'bytedance/seedance-2.5' → bytedance/seedance-2.5  (需显式点名)
 *
 * **为什么两代不能共用一个 provider**:`VideoProviderCapabilities` 挂在 provider
 * 上,执行器(run.ts)与主机侧的按型号校验(cindy-brain 的
 * getGhostVideoCapabilities)取的都是 `provider.capabilities` —— 是 per-provider
 * 而不是 per-alias。所以把 2.5 挂成 2.0 的第三个 alias 时,它会**整份继承 2.0 的
 * 值域**,而两代的值域差得很远,四个后果都是真的:
 *   - 时长被 2.0 的 [4,6,8,10] 卡住,2.5 的 4–30 长片一律明拒;
 *   - 1080p 被放行,而 2.5 只出到 720p,等于放过一个必然被上游拒的值;
 *   - 画幅没有 `adaptive`,首帧/首尾帧单子只能带着具体 `--ratio` 提交;
 *   - 后缀串照 2.0 的口径写 `--fps`,而方舟弱校验白名单里压根没有这一项。
 * 反向也成立:2.5 的宽值域挤进同一份 capabilities 就会替 2.0 放宽(2.0 收到
 * `duration: 30` 会一路发到上游才被拒)。两代互相放宽 = 按型号校验形同虚设。
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
 *     **两代的后缀集合不同**:2.0 分支照旧写 `--fps`(存量行为,方舟其实没有这个
 *     参数,改它会动已出片的产出口径,单独评估);2.5 分支不写。差异的出处见
 *     buildSeedance25PromptText。
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
    // 这里**只放 2.0 的档位**。2.5 归 CAPABILITIES_25,理由见文件头:
    // capabilities 是 per-provider,2.5 挂进来就会整份继承下面这些 2.0 的值域。
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
  },
  defaults: {
    duration: 4,
    resolution: '720p',
    ratio: '16:9',
    fps: 24,
  },
};

/** 4–30 的每个整数秒。方舟 2.5 的 duration 取值范围是 `[4, 30]`。 */
const SEEDANCE_25_DURATIONS: ReadonlyArray<number> = Array.from(
  { length: 27 },
  (_, i) => i + 4,
);

/**
 * Seedance 2.5。与 2.0 的差异都在这份常量里,逐项都有出处:
 *   - 时长放宽到 4–30(2.0 只有 4/6/8/10)。**不支持 `-1`**(上游的"智能选时长"):
 *     协议层 cindySlot 用 isPositiveIntWithin 收口,负数进不来,而 -1 主要服务于
 *     本次没接的视频编辑任务。
 *   - **没有 1080p**。2.5 只出 480p / 720p,所以这里不能照抄 2.0 的三档 ——
 *     抄了就会放行一个必然被上游拒的分辨率。
 *   - **`adaptive` 只当默认值,不进 `supportedRatios`**。它是 2.5 的上游默认
 *     (输出跟随输入自适应),但协议层的 GHOST_VIDEO_RATIOS 是闭集、不含它,
 *     插件显式传会先被 cindySlot 的粗筛拒掉("未知视频画幅")。所以列进
 *     supportedRatios 只会公布一个**永远到不了 provider 的值**,而错误话术还报的
 *     是协议层那五档 —— 与下面 `21:9` 不列是同一条规则。
 *     它仍必须是 `defaults.ratio`:执行器不接受"不指定" —— run.ts 会把缺省项
 *     回落成 defaults 再摊进请求体,"不指定画幅"这个语义只能由一个具体默认值
 *     来表达。**省略 ratio = 走 adaptive**,这条路径畅通,也是图生视频想要的。
 *   - `21:9` 上游支持但这里不列:协议层 GHOST_VIDEO_RATIOS 没有它,插件传不进来,
 *     列进来只会让错误话术出现一个拿不到的值。
 *   - 参考图上限仍按 9(上游到 30)。提上限要同步抬协议层的
 *     GHOST_VIDEO_MAX_SOURCES_BY_REF_MODE,不在本次范围。
 */
const CAPABILITIES_25: VideoProviderCapabilities = {
  modelAliases: [
    {
      // alias 与 catalog id 同串,且与 Art 插件 mapVideoModel 的输出逐字一致
      // (cindy-official-plugins#82 已上线):插件把用户说的 2.5 翻成这个串发来,
      // 主机白名单(cindySlot 的 whitelist.has)按它命中。改名就是断插件。
      alias: 'bytedance/seedance-2.5',
      summary: '2.5(有声,最长 30s) - 用户显式点名再选',
      // 与 alias 同串是巧合而非冗余:这里要的是**网关映射名**,不是方舟原生
      // model id(doubao-seedance-2-5-*)。XD Gateway 收下这个 LiteLLM 风格的串
      // 再自己翻译到方舟。endpoint 与请求体形状仍是方舟那套。
      internalModel: 'bytedance/seedance-2.5',
    },
  ],
  supportedDurations: SEEDANCE_25_DURATIONS,
  supportedResolutions: ['480p', '720p'],
  supportedRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  supportedFps: [24],
  maxImagesByRefMode: {
    first_and_last_frame: 2,
    reference_image: 9,
  },
  // 同 2.0:原生音画同生,顶层 generate_audio,上游默认出声。
  supportsAudio: true,
  audioDefault: true,
  // 估值,未实测。它 × 3 就是执行器的轮询超时(run.ts),30s 长片可能更慢,
  // 实测后按真实耗时回填。
  expectedSecondsByAlias: {
    'bytedance/seedance-2.5': 360,
  },
  defaults: {
    duration: 5,
    resolution: '720p',
    ratio: 'adaptive',
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

/**
 * 2.5 的后缀串。与 2.0 差两处,都是刻意的:
 *
 *   1. **不写 `--fps`**。方舟的弱校验后缀白名单是 resolution / ratio / duration /
 *      frames / seed / camera_fixed / watermark —— 压根没有 fps 这一项。
 *      capabilities 里仍声明 `[24]`,那是给回执用的(方舟视频固定 24fps:
 *      官方的帧数公式就是"时长 × 24"),不代表请求里该写这个野生 flag。
 *      注:2.0 分支照旧写 `--fps`,那是存量行为,改它会动已出片的产出口径,
 *      单独评估。
 *   2. **`adaptive` 不写 `--ratio`**。adaptive 本身就是上游默认(自适应输入),
 *      写成 `--ratio adaptive` 反而是往弱校验里塞一个非枚举值。
 *      这个分支只会由 `CAPABILITIES_25.defaults.ratio` 触发(调用方省略了 ratio)——
 *      `adaptive` 不在 supportedRatios 里,显式传进不来,理由见 CAPABILITIES_25。
 *
 * 画幅给了具体比例时**原样透传**,不按 refMode 拦。文档说 2.5 的首帧/首尾帧
 * 场景"默认且仅支持 adaptive",但这里遵循与参考图上限同一条口径:由上游在提交期
 * 裁决(忽略或报错),错误原样透传给调用方,主机不替上游立规矩。
 */
function buildSeedance25PromptText(req: VideoGenerationRequest): string {
  const flags: string[] = [];
  const d = req.duration ?? CAPABILITIES_25.defaults.duration;
  const r = req.resolution ?? CAPABILITIES_25.defaults.resolution;
  const ar = req.ratio ?? CAPABILITIES_25.defaults.ratio;
  flags.push(`--duration ${d}`);
  flags.push(`--resolution ${r}`);
  if (ar !== 'adaptive') flags.push(`--ratio ${ar}`);
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
 *
 * 两代共用这一份:content 的形状(text 节点 + 带 role 的 image_url 节点)两代
 * 完全一致,只有 text 里的后缀串不同,所以后缀构造由 `buildText` 注入。
 */
function buildSeedanceContent(
  req: VideoGenerationRequest,
  buildText: (req: VideoGenerationRequest) => string,
): SeedanceContentItem[] {
  const content: SeedanceContentItem[] = [
    { type: 'text', text: buildText(req) },
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

/** 一代 Seedance 的全部代次差异。骨架(submit/poll/download)按它参数化。 */
interface SeedanceVariant {
  /** VideoProvider.id,同时也是错误话术前缀与 VideoTaskHandle.providerId。 */
  id: string;
  capabilities: VideoProviderCapabilities;
  buildPromptText: (req: VideoGenerationRequest) => string;
}

const VARIANT_20: SeedanceVariant = {
  id: 'seedance',
  capabilities: CAPABILITIES,
  buildPromptText: buildSeedancePromptText,
};

// provider.id 刻意**不等于** alias(同 2.0 的 `seedance` 也不是任何 alias):
// alias 是对外契约(插件按它点名),id 是内部标识 + 错误话术前缀,让话术保持
// `seedance-2.5 task failed` 而不是带上网关前缀。
const VARIANT_25: SeedanceVariant = {
  id: 'seedance-2.5',
  capabilities: CAPABILITIES_25,
  buildPromptText: buildSeedance25PromptText,
};

/**
 * 共享骨架。两代打的是同一个方舟接口(同 endpoint、同请求体形状、同轮询响应),
 * 所以状态映射、下载与错误处理都在这里单源 —— 上游哪天改了轮询字段,改一处
 * 两代都跟上。
 */
function createArkSeedanceProvider(
  variant: SeedanceVariant,
  opts: CreateSeedanceProviderOptions,
): VideoProvider {
  const submitPath = opts.submitPath ?? DEFAULT_SUBMIT_PATH;
  const pollTemplate = opts.pollPathTemplate ?? DEFAULT_POLL_TEMPLATE;
  const submitUrl = joinProxyUrl(opts.baseUrl, submitPath);
  const doFetch = opts.fetchImplementation ?? fetch;
  const caps = variant.capabilities;

  function pollUrl(taskId: string): string {
    const path = pollTemplate.replace('{id}', encodeURIComponent(taskId));
    return joinProxyUrl(opts.baseUrl, path);
  }

  async function submit(
    req: VideoGenerationRequest,
    alias: string,
    signal?: AbortSignal,
  ): Promise<VideoTaskHandle> {
    const aliasInfo = caps.modelAliases.find((a) => a.alias === alias);
    if (!aliasInfo) {
      throw new GatewayHttpError(
        `${variant.id}: unknown alias '${alias}'`,
        400,
      );
    }
    const apiKey = await requireApiKey({ getApiKey: opts.getApiKey });
    const body = {
      model: aliasInfo.internalModel,
      content: buildSeedanceContent(req, variant.buildPromptText),
      // 音频开关是请求体**顶层布尔字段**,不是 content 文本里的 `--flag` 后缀
      // (画面那几项走后缀是 1.0 时代的口径,音频没有对应的后缀写法)。
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
        `${variant.id} submit response missing id`,
        res.status,
        parsed,
      );
    }
    return {
      providerId: variant.id,
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
            `${variant.id} task ${data.status} (no error message)`,
          raw: data,
        };
      case 'succeeded': {
        const url = data.content?.video_url;
        if (!url) {
          return {
            state: 'failed',
            error: `${variant.id} reported succeeded but no video_url in content`,
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
        `${variant.id} download failed HTTP ${res.status}`,
        res.status,
      );
    }
    const ab = await res.arrayBuffer();
    const mimeType = res.headers.get('content-type') ?? 'video/mp4';
    return { buffer: Buffer.from(ab), mimeType };
  }

  return {
    id: variant.id,
    capabilities: caps,
    submit,
    poll,
    download,
  };
}

/** Seedance 2.0(`seedance-fast` / `seedance-pro`)。出厂默认型号在这一家。 */
export function createSeedanceProvider(
  opts: CreateSeedanceProviderOptions,
): VideoProvider {
  return createArkSeedanceProvider(VARIANT_20, opts);
}

/** Seedance 2.5(alias `bytedance/seedance-2.5`)。opt-in,需显式点名。 */
export function createSeedance25Provider(
  opts: CreateSeedanceProviderOptions,
): VideoProvider {
  return createArkSeedanceProvider(VARIANT_25, opts);
}
