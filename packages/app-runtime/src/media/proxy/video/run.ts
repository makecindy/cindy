/**
 * art/video/run.ts
 * ---------------------------------------------------------------------------
 * 视频生成的可复用执行器:submit → 轮询 → download 一条龙。唯一消费方:
 * 意识 cindy 槽视频代办(desktop cindy-brain)。lizi_art MCP 工具层已于
 * 2026-07-12 退役,只摘了工具壳,本执行器与 provider 层留任。
 *
 * 轮询节奏与超时口径沿用原 lizi_art 工具层(前 30s 每 5s 一拍,之后每 10s;
 * 总超时 = 预期时长 × 3),行为零变化。
 */

import type { VideoProviderRegistry } from './registry.js';
import { DEFAULT_VIDEO_REF_MODE } from './types.js';
import type {
  VideoGenerationRequest,
  VideoRefMode,
  VideoTaskHandle,
  VideoTaskStatus,
} from './types.js';

export interface PollLoopOptions {
  signal?: AbortSignal;
  /** Total timeout in ms. Default = 3× expected (registry-derived). */
  timeoutMs: number;
}

/**
 * Drive the polling loop. Provider does ONE GET per iteration; this function
 * decides cadence (every 5s for the first 30s, then every 10s) and timeout.
 */
export async function pollUntilDone(
  registry: VideoProviderRegistry,
  handle: VideoTaskHandle,
  alias: string,
  opts: PollLoopOptions,
): Promise<Extract<VideoTaskStatus, { state: 'succeeded' }>> {
  const { provider } = registry.resolveByAlias(alias);
  const start = Date.now();
  const FAST_PHASE_MS = 30_000;
  const FAST_INTERVAL_MS = 5_000;
  const SLOW_INTERVAL_MS = 10_000;
  while (true) {
    if (Date.now() - start > opts.timeoutMs) {
      throw new Error(
        `art: video task timeout after ${Math.round((Date.now() - start) / 1000)}s (provider=${handle.providerId} task=${handle.taskId})`,
      );
    }
    const status = await provider.poll(handle, opts.signal);
    if (status.state === 'succeeded') return status;
    if (status.state === 'failed') {
      throw new Error(`art: video task failed: ${status.error}`);
    }
    const elapsed = Date.now() - start;
    const interval =
      elapsed < FAST_PHASE_MS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval);
      if (opts.signal) {
        const onAbort = () => {
          clearTimeout(t);
          reject(new Error('art: video poll aborted'));
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

export interface SubmitAndAwaitVideoParams {
  /** 模型别名(registry 注册的 alias,如 'seedance-fast')。 */
  alias: string;
  prompt: string;
  /**
   * 参考图(base64 data URI)。张数上限随 refMode 走,超出即抛错(调用方
   * 折叠成结构化拒绝)。
   */
  imageDataUris?: string[];
  /**
   * 参考图用法(见 VideoRefMode)。不传 = 'first_and_last_frame',与 2026-07
   * 之前的行为逐字节同形。目标模型不支持该用法时抛错,不做静默降级——
   * 降成首尾帧会出一条用户没要的片子,还照样计费。
   */
  refMode?: VideoRefMode;
  /**
   * 画面参数(全部可选,2026-07 放开):不传的项落该模型的出厂默认,
   * 与放开之前的行为逐字节同形。传了但该模型不支持 → 抛错,不做最近似
   * 降级(上游调用方已按型号校验过一轮,这里是执行器自己的兜底)。
   */
  duration?: number;
  resolution?: string;
  ratio?: string;
  fps?: number;
  /**
   * 音频开关(可选,2026-08 加法)。与上面四项**规则不同**:那四项不传时
   * 执行器会回落该型号的出厂默认并显式提交,音频不传时**一个字段都不写**,
   * 出声与否随上游默认——本字段出现之前链上从来不提音频,这是存量产出不变的
   * 唯一保证。目标型号没有音频开关时抛错,不静默丢弃。
   */
  audio?: boolean;
  signal?: AbortSignal;
}

/** 本单实际提交/兑现的画面参数(上游任务上报值优先,缺项回落提交值)。 */
export interface SubmitAndAwaitVideoEffectiveParams {
  duration: number;
  resolution: string;
  ratio: string;
  fps: number;
  /**
   * 本单是否带音轨。缺省 = 说不上来(该型号没有音频开关,或它支持但没登记
   * 上游默认),**不是"无声"**。没有上游上报可采信时,取提交值 → 型号登记的
   * 上游默认这个顺序。
   */
  audio?: boolean;
}

/** 逐项核对画面参数是否在该模型的支持集内;不支持即抛(话术含可用值)。 */
function assertParamSupported<T extends string | number>(
  alias: string,
  name: string,
  value: T | undefined,
  supported: ReadonlyArray<T>,
): void {
  if (value === undefined || supported.includes(value)) return;
  throw new Error(
    `art: model '${alias}' does not support ${name} ${String(value)} (supported: ${supported.join(', ')})`,
  );
}

/**
 * 一条龙执行一单视频生成:别名解析 → 能力校验(参考图张数 + 画面参数)→
 * 提交 → 轮询 → 下载字节。
 * 画面参数(时长/分辨率/比例/帧率)由调用方可选覆盖,不传的项落该模型的
 * 出厂默认。返回值带回实际生效参数:上游任务上报的值优先(它才是真实
 * 产出),上游没报的那项回落我们提交的值。
 */
export async function submitAndAwaitVideo(
  registry: VideoProviderRegistry,
  params: SubmitAndAwaitVideoParams,
): Promise<{
  buffer: Buffer;
  mimeType: string;
  modelUsed: string;
  effectiveParams: SubmitAndAwaitVideoEffectiveParams;
}> {
  const resolved = registry.resolveByAlias(params.alias);
  const caps = resolved.provider.capabilities;
  const images = params.imageDataUris ?? [];
  const refMode = params.refMode ?? DEFAULT_VIDEO_REF_MODE;
  // 无图 = 文生视频,与参考图用法无关,不查 refMode(否则只支持某一种用法
  // 的 provider 会连文生视频都被误拒)。
  if (images.length > 0) {
    const maxImages = caps.maxImagesByRefMode[refMode];
    if (maxImages === undefined) {
      const supported = Object.keys(caps.maxImagesByRefMode);
      throw new Error(
        `art: model '${params.alias}' does not support refMode '${refMode}' (supported: ${supported.join(', ') || 'none'})`,
      );
    }
    if (images.length > maxImages) {
      throw new Error(
        `art: model '${params.alias}' supports at most ${maxImages} reference image(s) in refMode '${refMode}', got ${images.length}`,
      );
    }
  }
  assertParamSupported(params.alias, 'duration', params.duration, caps.supportedDurations);
  assertParamSupported(params.alias, 'resolution', params.resolution, caps.supportedResolutions);
  assertParamSupported(params.alias, 'ratio', params.ratio, caps.supportedRatios);
  assertParamSupported(params.alias, 'fps', params.fps, caps.supportedFps);
  // 音频开关走不掉 assertParamSupported(它比对值域,这里比对"有没有这个旋钮")。
  // 只在显式传时判:不传的单子压根不提音频,任何型号都放行。
  if (params.audio !== undefined && !caps.supportsAudio) {
    throw new Error(
      `art: model '${params.alias}' has no audio toggle (omit 'audio' to use the model's own default)`,
    );
  }

  const submitted: SubmitAndAwaitVideoEffectiveParams = {
    duration: params.duration ?? caps.defaults.duration,
    resolution: params.resolution ?? caps.defaults.resolution,
    ratio: params.ratio ?? caps.defaults.ratio,
    fps: params.fps ?? caps.defaults.fps,
  };
  /**
   * 回执用的推定音轨状态:插件表过态就用它的,没表态就用该型号登记的上游
   * 默认(没登记就说不上来)。**刻意不放进 `submitted`**——那个对象会整体摊进
   * 请求体,推定值一旦漏进去就等于替插件表了态,存量产出的兼容也就破了。
   */
  const effectiveAudio = params.audio ?? caps.audioDefault;
  const req: VideoGenerationRequest = {
    prompt: params.prompt,
    ...submitted,
    ratioWasExplicit: params.ratio !== undefined,
    // 三态:只有插件显式表态才写这个键,否则请求体里连键都没有。
    ...(params.audio !== undefined ? { audio: params.audio } : {}),
    images: images.length > 0 ? images : undefined,
    refMode,
  };
  const handle = await resolved.provider.submit(req, params.alias, params.signal);
  const expected = caps.expectedSecondsByAlias[params.alias] ?? 120;
  const status = await pollUntilDone(registry, handle, params.alias, {
    timeoutMs: expected * 3 * 1000,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const dl = await resolved.provider.download(status.videoUrl, params.signal);
  // 音轨回执:上游报了就采信它(它才是真实产出),否则用上面那个推定值;
  // 两头都没有就缺省 —— 缺省是"说不上来",不是"无声"。
  const audioEcho = status.meta.audio ?? effectiveAudio;
  return {
    buffer: dl.buffer,
    mimeType: dl.mimeType,
    modelUsed: handle.modelUsed,
    effectiveParams: {
      duration: status.meta.durationSec ?? submitted.duration,
      resolution: status.meta.resolution ?? submitted.resolution,
      ratio: status.meta.ratio ?? submitted.ratio,
      fps: status.meta.fps ?? submitted.fps,
      ...(audioEcho !== undefined ? { audio: audioEcho } : {}),
    },
  };
}
