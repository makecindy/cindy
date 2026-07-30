/**
 * art/video/providers/happyhorse.ts
 * ---------------------------------------------------------------------------
 * VideoProvider implementation for Aliyun DashScope HappyHorse video models,
 * routed through XD Gateway's `/dashscope/...` passthrough (per llms.txt:
 * "Video — DashScope (HappyHorse)").
 *
 * One LLM-facing alias (`happyhorse`) — opt-in, NOT a default. The seedance
 * provider remains the default video model unless the user explicitly says
 * "happyhorse" / "happy horse" / "快马" in the request (hard rule lives in
 * prompt md, not here).
 *
 * Internal model picked by request shape:
 *   - 0 images → `happyhorse-1.0-t2v` (text-to-video)
 *   - 1 image  → `happyhorse-1.0-i2v` (image-to-video, first frame)
 *
 * The other two upstream variants (`-r2v` reference-to-video, `-video-edit`
 * video editing) are NOT exposed here — they don't map cleanly to the
 * existing video_generate / video_edit tool surface (r2v wants reference
 * images for character/style consistency; video-edit needs an actual video
 * file). Add them when there's a tool surface that fits.
 *
 * Async API shape (per Aliyun docs, re-verified 2026-05-14 after upstream
 * change rejected bare-string media items):
 *   POST .../video-synthesis
 *     { model, input: { prompt,
 *                       media?: [{ type: 'first_frame',
 *                                  url: data-uri | https-url }, ...] },
 *       parameters?: { resolution?: '480P'|'720P'|'1080P', duration?: 5 } }
 *     → { request_id, output: { task_id, task_status:'PENDING' } }
 *   GET .../tasks/{task_id}
 *     → { output: { task_status:'PENDING'|'RUNNING'|'SUCCEEDED'|'FAILED',
 *                    video_url? }, usage?: { duration, SR, ratio, ... } }
 *
 * Note on resolution casing: LLM-facing lowercase ('720p') matches our
 * shared video-params rule; DashScope wants uppercase ('720P'). This
 * provider normalizes on the way out.
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

export interface CreateHappyhorseProviderOptions {
  baseUrl: string;
  /** Default `/dashscope/api/v1/services/aigc/video-generation/video-synthesis`. */
  submitPath?: string;
  /** Default template: `/dashscope/api/v1/tasks/{id}`. `{id}` substituted with task id. */
  pollPathTemplate?: string;
  getApiKey: GatewayHttpAuth['getApiKey'];
  fetchImplementation?: typeof fetch;
  logger?: LiziMcpLogger;
}

const DEFAULT_SUBMIT_PATH =
  '/dashscope/api/v1/services/aigc/video-generation/video-synthesis';
const DEFAULT_POLL_TEMPLATE = '/dashscope/api/v1/tasks/{id}';

const INTERNAL_T2V = 'happyhorse-1.0-t2v';
const INTERNAL_I2V = 'happyhorse-1.0-i2v';

const CAPABILITIES: VideoProviderCapabilities = {
  modelAliases: [
    {
      alias: 'happyhorse',
      summary: 'HappyHorse 1.0 (~3min) - 仅用户显式提及时选择',
      // The "internal" model declared here is the t2v variant; submit() picks
      // i2v when images are present. modelUsed in the returned handle reflects
      // the actual choice so the LLM-facing summary stays accurate.
      internalModel: INTERNAL_T2V,
    },
  ],
  supportedDurations: [5],
  supportedResolutions: ['480p', '720p', '1080p'],
  // DashScope HappyHorse accepts arbitrary `size` (W*H), but we expose the
  // common ratios the LLM already knows from seedance to keep the surface
  // identical. Mapping ratio → size happens in buildParameters().
  supportedRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  // No explicit fps knob in DashScope; declare 24 to match the surface.
  supportedFps: [24],
  maxImages: 1,
  expectedSecondsByAlias: {
    happyhorse: 180,
  },
  defaults: {
    duration: 5,
    resolution: '720p',
    ratio: '16:9',
    fps: 24,
  },
};

interface DashScopeSubmitResponse {
  request_id?: string;
  output?: {
    task_id?: string;
    task_status?: string;
  };
  code?: string;
  message?: string;
}

interface DashScopePollResponse {
  request_id?: string;
  output?: {
    task_id?: string;
    task_status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    video_url?: string;
    message?: string;
  };
  usage?: {
    duration?: number;
    SR?: number;
    ratio?: string;
    [k: string]: unknown;
  };
}

function pickInternalModel(req: VideoGenerationRequest): string {
  const imageCount = (req.images ?? []).length;
  return imageCount > 0 ? INTERNAL_I2V : INTERNAL_T2V;
}

function buildInput(
  req: VideoGenerationRequest,
): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: req.prompt };
  const images = req.images ?? [];
  if (images.length > 0) {
    // i2v requires array of MediaItem objects, not bare strings. happyhorse
    // only supports first-frame i2v (maxImages: 1), so type is always
    // 'first_frame'. Bare-string form returns Pydantic
    // "Input should be a valid dictionary or instance of MediaItem".
    input.media = images.map((url) => ({ type: 'first_frame', url }));
  }
  return input;
}

/** Translate the LLM-facing knobs to DashScope's `parameters` block. */
function buildParameters(
  req: VideoGenerationRequest,
): Record<string, unknown> | undefined {
  const params: Record<string, unknown> = {};
  if (req.resolution) {
    params.resolution = req.resolution.toUpperCase(); // '720p' → '720P'
  }
  if (req.duration) {
    params.duration = req.duration;
  }
  if (req.ratio) {
    // DashScope wants `size` as 'W*H' (not ratio). Map common ratios at our
    // declared resolution. Unknown ratio → omit and let DashScope default.
    const sr = req.resolution ?? CAPABILITIES.defaults.resolution;
    const longSide =
      sr === '1080p' ? 1920 : sr === '480p' ? 854 : 1280;
    const shortSide =
      sr === '1080p' ? 1080 : sr === '480p' ? 480 : 720;
    // 每档的像素量以该档 16:9(longSide*shortSide)为上限,任何比例都不得
    // 超过——超了就是偷偷升档:DashScope 可能直接拒,或按更高分辨率出片
    // 并计费。4:3 原先拿 longSide 当宽再推高(720p → 1280*960 = 基准的
    // 1.33 倍)是唯一越线的一项,改成以高锚定该档短边(960*720)。
    // 注:3:4 与 4:3 的长边口径并不对称(540*720 vs 960*720),那是既有
    // 映射,两者都在基准像素量之内,统一口径需要 DashScope 侧的权威依据,
    // 不在本次范围。
    const ratioMap: Record<string, string> = {
      '16:9': `${longSide}*${shortSide}`,
      '9:16': `${shortSide}*${longSide}`,
      '1:1': `${shortSide}*${shortSide}`,
      '4:3': `${Math.round((shortSide * 4) / 3)}*${shortSide}`,
      '3:4': `${Math.round((shortSide * 3) / 4)}*${shortSide}`,
    };
    const size = ratioMap[req.ratio];
    if (size) params.size = size;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

export function createHappyhorseProvider(
  opts: CreateHappyhorseProviderOptions,
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
    if (alias !== 'happyhorse') {
      throw new GatewayHttpError(
        `happyhorse: unknown alias '${alias}'`,
        400,
      );
    }
    const apiKey = await requireApiKey({ getApiKey: opts.getApiKey });
    const internalModel = pickInternalModel(req);
    const body: Record<string, unknown> = {
      model: internalModel,
      input: buildInput(req),
    };
    const parameters = buildParameters(req);
    if (parameters) body.parameters = parameters;

    const res = await doFetch(submitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // DashScope async mode is implicit on this passthrough (probe shows
        // it returns task_id even without the header), but we send it for
        // future-proofing — the upstream docs treat it as the canonical way
        // to opt into async.
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(body),
      signal,
    });
    const parsed = await parseJsonResponse<DashScopeSubmitResponse>(
      res,
      opts.logger,
    );
    const taskId = parsed.output?.task_id;
    if (!taskId) {
      throw new GatewayHttpError(
        'happyhorse submit response missing output.task_id',
        res.status,
        parsed,
      );
    }
    return {
      providerId: 'happyhorse',
      taskId,
      modelUsed: internalModel,
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
    const data = await parseJsonResponse<DashScopePollResponse>(
      res,
      opts.logger,
    );
    const status = data.output?.task_status;
    switch (status) {
      case 'PENDING':
        return { state: 'pending', raw: data };
      case 'RUNNING':
        return { state: 'running', raw: data };
      case 'FAILED':
        return {
          state: 'failed',
          error:
            data.output?.message ??
            'happyhorse task FAILED (no message in output)',
          raw: data,
        };
      case 'SUCCEEDED': {
        const url = data.output?.video_url;
        if (!url) {
          return {
            state: 'failed',
            error:
              'happyhorse reported SUCCEEDED but no output.video_url',
            raw: data,
          };
        }
        // DashScope `usage.SR` (e.g. 1080) is the height; map back to '720p'.
        const sr = data.usage?.SR;
        const resolution =
          sr === 1080 ? '1080p' : sr === 480 ? '480p' : sr === 720 ? '720p' : undefined;
        return {
          state: 'succeeded',
          videoUrl: url,
          meta: {
            durationSec: data.usage?.duration,
            resolution,
            ratio: data.usage?.ratio,
            usage: data.usage as Record<string, unknown> | undefined,
          },
          raw: data,
        };
      }
      default:
        // Unknown status → treat as still running rather than failing the
        // task; lets DashScope add intermediate states without breaking us.
        return { state: 'running', raw: data };
    }
  }

  async function download(
    videoUrl: string,
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    // DashScope returns an OSS signed URL — plain GET, no auth header.
    const res = await doFetch(videoUrl, { method: 'GET', signal });
    if (!res.ok) {
      throw new GatewayHttpError(
        `happyhorse download failed HTTP ${res.status}`,
        res.status,
      );
    }
    const ab = await res.arrayBuffer();
    const mimeType = res.headers.get('content-type') ?? 'video/mp4';
    return { buffer: Buffer.from(ab), mimeType };
  }

  return {
    id: 'happyhorse',
    capabilities: CAPABILITIES,
    submit,
    poll,
    download,
  };
}
