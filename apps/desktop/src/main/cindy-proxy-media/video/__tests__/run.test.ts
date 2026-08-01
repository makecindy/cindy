/**
 * run.test.ts
 * ---------------------------------------------------------------------------
 * submitAndAwaitVideo 的画面参数契约(2026-07 放开细调):不传落型号出厂
 * 默认(与放开前逐字节同形)、传了透传、型号不支持即抛(不做最近似降级)、
 * 返回值里的实际生效参数以上游上报值优先。
 */

import { describe, it, expect, vi } from 'vitest';
import { VideoProviderRegistry } from '../registry.js';
import { submitAndAwaitVideo } from '../run.js';
import type {
  VideoGenerationRequest,
  VideoProvider,
  VideoResultMeta,
  VideoTaskStatus,
} from '../types.js';

function makeProvider(opts: {
  submitted: VideoGenerationRequest[];
  /** succeeded 时上游上报的 meta(留空 = 上游什么都没报)。 */
  meta?: VideoResultMeta;
  maxImagesByRefMode?: Partial<Record<'first_and_last_frame' | 'reference_image', number>>;
}): VideoProvider {
  return {
    id: 'fake',
    capabilities: {
      modelAliases: [{ alias: 'fake-fast', internalModel: 'fake-1', summary: '' }],
      supportedDurations: [4, 6, 8],
      supportedResolutions: ['480p', '720p', '1080p'],
      supportedRatios: ['16:9', '9:16'],
      supportedFps: [24],
      maxImagesByRefMode: opts.maxImagesByRefMode ?? {
        first_and_last_frame: 2,
        reference_image: 9,
      },
      expectedSecondsByAlias: { 'fake-fast': 1 },
      defaults: { duration: 4, resolution: '720p', ratio: '16:9', fps: 24 },
    },
    submit: async (req) => {
      opts.submitted.push(req);
      return { providerId: 'fake', taskId: 't1', modelUsed: 'fake-1', submittedAt: 0 };
    },
    poll: async () => ({
      state: 'succeeded',
      videoUrl: 'https://example.invalid/v.mp4',
      meta: opts.meta ?? {},
    }),
    download: async () => ({ buffer: Buffer.from([1, 2]), mimeType: 'video/mp4' }),
  };
}

function makeRegistry(provider: VideoProvider): VideoProviderRegistry {
  const r = new VideoProviderRegistry();
  r.register(provider);
  return r;
}

describe('submitAndAwaitVideo · 画面参数', () => {
  it('不传任何参数 → 提交该型号的出厂默认(放开前后行为一致)', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(makeProvider({ submitted }));
    const r = await submitAndAwaitVideo(registry, { alias: 'fake-fast', prompt: 'p' });
    expect(submitted[0]).toMatchObject({
      prompt: 'p',
      duration: 4,
      resolution: '720p',
      ratio: '16:9',
      fps: 24,
    });
    // 上游没报 meta → 回执回落我们提交的值。
    expect(r.effectiveParams).toEqual({
      duration: 4,
      resolution: '720p',
      ratio: '16:9',
      fps: 24,
    });
  });

  it('传了的项透传,没传的项落默认', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(makeProvider({ submitted }));
    await submitAndAwaitVideo(registry, {
      alias: 'fake-fast',
      prompt: 'p',
      duration: 8,
      ratio: '9:16',
    });
    expect(submitted[0]).toMatchObject({
      duration: 8,
      ratio: '9:16',
      resolution: '720p',
      fps: 24,
    });
  });

  it('型号不支持的值 → 抛错且不提交,话术带该型号可用值', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(makeProvider({ submitted }));
    await expect(
      submitAndAwaitVideo(registry, { alias: 'fake-fast', prompt: 'p', duration: 10 }),
    ).rejects.toThrow(/does not support duration 10 \(supported: 4, 6, 8\)/);
    await expect(
      submitAndAwaitVideo(registry, { alias: 'fake-fast', prompt: 'p', ratio: '1:1' }),
    ).rejects.toThrow(/does not support ratio 1:1/);
    expect(submitted).toHaveLength(0);
  });

  it('回执优先用上游上报的真实值,上游没报的那项回落提交值', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(
      makeProvider({
        submitted,
        // 上游只报了时长与分辨率(实际产出与请求不同,以上游为准)。
        meta: { durationSec: 6, resolution: '1080p' },
      }),
    );
    const r = await submitAndAwaitVideo(registry, {
      alias: 'fake-fast',
      prompt: 'p',
      duration: 8,
      resolution: '480p',
      ratio: '9:16',
    });
    expect(r.effectiveParams).toEqual({
      duration: 6,
      resolution: '1080p',
      ratio: '9:16',
      fps: 24,
    });
  });

  it('参考图超出型号上限 → 抛错且不提交', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(makeProvider({ submitted, maxImagesByRefMode: { first_and_last_frame: 1 } }));
    await expect(
      submitAndAwaitVideo(registry, {
        alias: 'fake-fast',
        prompt: 'p',
        imageDataUris: ['data:image/png;base64,a', 'data:image/png;base64,b'],
      }),
    ).rejects.toThrow(/at most 1 reference image/);
    expect(submitted).toHaveLength(0);
  });

  it('张数上限按 refMode 分别算:首尾帧 2 张拒,同一型号参考图 2 张放行', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(
      makeProvider({
        submitted,
        maxImagesByRefMode: { first_and_last_frame: 1, reference_image: 9 },
      }),
    );
    const twoImages = ['data:image/png;base64,a', 'data:image/png;base64,b'];
    await expect(
      submitAndAwaitVideo(registry, { alias: 'fake-fast', prompt: 'p', imageDataUris: twoImages }),
    ).rejects.toThrow(/at most 1 reference image/);
    expect(submitted).toHaveLength(0);

    await submitAndAwaitVideo(registry, {
      alias: 'fake-fast',
      prompt: 'p',
      imageDataUris: twoImages,
      refMode: 'reference_image',
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0].refMode).toBe('reference_image');
  });

  it('型号不支持该 refMode → 抛错且不提交(不降级成另一种用法)', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(
      makeProvider({ submitted, maxImagesByRefMode: { first_and_last_frame: 2 } }),
    );
    await expect(
      submitAndAwaitVideo(registry, {
        alias: 'fake-fast',
        prompt: 'p',
        imageDataUris: ['data:image/png;base64,a'],
        refMode: 'reference_image',
      }),
    ).rejects.toThrow(/does not support refMode 'reference_image'/);
    expect(submitted).toHaveLength(0);
  });

  it('不传 refMode → 落首尾帧(存量调用方行为不变)', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(makeProvider({ submitted }));
    await submitAndAwaitVideo(registry, {
      alias: 'fake-fast',
      prompt: 'p',
      imageDataUris: ['data:image/png;base64,a'],
    });
    expect(submitted[0].refMode).toBe('first_and_last_frame');
  });

  it('文生视频不查 refMode 支持性(无图 = 与参考图用法无关)', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(
      makeProvider({ submitted, maxImagesByRefMode: { reference_image: 9 } }),
    );
    await submitAndAwaitVideo(registry, { alias: 'fake-fast', prompt: 'p' });
    expect(submitted).toHaveLength(1);
  });

  it('参考图为空时不塞 images 键(与老载荷同形)', async () => {
    const submitted: VideoGenerationRequest[] = [];
    const registry = makeRegistry(makeProvider({ submitted }));
    await submitAndAwaitVideo(registry, { alias: 'fake-fast', prompt: 'p', imageDataUris: [] });
    expect(submitted[0].images).toBeUndefined();
  });

  it('轮询失败 → 抛出上游错因', async () => {
    const provider = makeProvider({ submitted: [] });
    const failing: VideoProvider = {
      ...provider,
      poll: vi.fn(async () => ({ state: 'failed', error: 'quota exceeded' }) as VideoTaskStatus),
    };
    await expect(
      submitAndAwaitVideo(makeRegistry(failing), { alias: 'fake-fast', prompt: 'p' }),
    ).rejects.toThrow(/quota exceeded/);
  });
});
