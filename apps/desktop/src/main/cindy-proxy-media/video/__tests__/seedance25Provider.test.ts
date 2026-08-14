/**
 * seedance25Provider.test.ts
 * ---------------------------------------------------------------------------
 * Seedance 2.5 与 2.0 的差异点锁定。共享骨架(submit/poll/download 的 URL 拼接、
 * 状态映射、下载)由 seedanceProvider.test.ts 覆盖,这里只钉**代次差异**:
 *   - model 字段是网关映射名 `bytedance/seedance-2.5`,不是方舟原生 id;
 *   - 后缀串**不写 `--fps`**(方舟弱校验白名单里没这一项);
 *   - `adaptive` 只当默认值:省略 ratio 时**不写 `--ratio`**,而它不进
 *     supportedRatios(协议层枚举不认,显式传进不来);
 *   - 给了具体画幅就**原样透传**,不按 refMode 拦(passthrough,由上游裁决);
 *   - 时长 4–30、分辨率没有 1080p。
 *
 * alias 与 provider.id 是两个东西,本文件都钉:alias 是对外契约
 * `bytedance/seedance-2.5`(Art 插件按它点名),provider.id 是内部标识
 * `seedance-2.5`(也是错误话术前缀)。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createSeedance25Provider,
  createSeedanceProvider,
} from '../providers/seedance.js';
import { VideoProviderRegistry } from '../registry.js';
import { submitAndAwaitVideo } from '../run.js';
import type { VideoGenerationRequest } from '../types.js';

const BASE_URL = 'https://llm-proxy.example.test';
const SUBMIT_URL = `${BASE_URL}/volcengine/api/v3/contents/generations/tasks`;
const ALIAS = 'bytedance/seedance-2.5';
const MODEL = 'bytedance/seedance-2.5';

function makeProvider(fakeFetch: typeof fetch) {
  return createSeedance25Provider({
    baseUrl: BASE_URL,
    getApiKey: () => 'test-key',
    fetchImplementation: fakeFetch,
  });
}

/** submit 只回一个 task id;取回请求体给断言用。 */
function makeSubmitMock(): {
  fetchMock: typeof fetch;
  bodyOf: (i?: number) => { model: string; content: Array<Record<string, unknown>>; generate_audio?: boolean };
} {
  const calls: RequestInit[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify({ id: 'cgt-25-FAKE' }), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchMock,
    bodyOf: (i = 0) => JSON.parse(calls[i].body as string),
  };
}

/** 取 content 里那个 text 节点的文本。 */
async function promptTextOf(req: VideoGenerationRequest): Promise<string> {
  const { fetchMock, bodyOf } = makeSubmitMock();
  await makeProvider(fetchMock).submit(req, 'bytedance/seedance-2.5');
  return bodyOf().content[0].text as string;
}

describe('seedance 2.5 · capabilities', () => {
  const p = makeProvider(vi.fn() as unknown as typeof fetch);

  it('alias 是插件契约名、provider.id 是内部名,内部 model 是网关映射名', () => {
    // alias 必须与 Art 插件 mapVideoModel 的输出逐字一致
    // (cindy-official-plugins#82 已上线),改名就是断插件。
    expect(p.capabilities.modelAliases).toHaveLength(1);
    expect(p.capabilities.modelAliases[0].alias).toBe(ALIAS);
    // internalModel 与 alias 同串是巧合:这里要的是网关映射名(LiteLLM 风格),
    // 不是方舟原生 id doubao-seedance-2-5-*。
    expect(p.capabilities.modelAliases[0].internalModel).toBe(MODEL);
    expect(p.id).toBe('seedance-2.5');
  });

  it('分辨率只有 480p / 720p —— **没有 1080p**(照抄 2.0 三档就会放行必被上游拒的值)', () => {
    expect(p.capabilities.supportedResolutions).toEqual(['480p', '720p']);
    expect(p.capabilities.supportedResolutions).not.toContain('1080p');
  });

  it('时长覆盖 4–30 的每个整数秒,边界内含 4 与 30、外侧不含 3 与 31', () => {
    const d = p.capabilities.supportedDurations;
    expect(d).toHaveLength(27);
    expect(d).toContain(4);
    expect(d).toContain(30);
    expect(d).not.toContain(3);
    expect(d).not.toContain(31);
  });

  /**
   * `adaptive` 只当默认值,**不进 supportedRatios**。
   *
   * 两件事:
   *   - 它必须是 `defaults.ratio` —— 执行器不接受"不指定"(run.ts 把缺省项回落成
   *     defaults 再摊进请求体),"不指定画幅"这个语义只能由一个具体默认值表达。
   *   - 它不能进 supportedRatios —— 协议层 GHOST_VIDEO_RATIOS 是闭集、不含它,
   *     插件显式传会先被 cindySlot 粗筛拒掉("未知视频画幅"),列进来等于公布一个
   *     永远到不了 provider 的值。合法组合:assertParamSupported 在 value 为
   *     undefined 时直接 return(run.ts),压根不校验 defaults。
   */
  it('adaptive 是默认值但不在 supportedRatios 里(公布了插件也传不进来)', () => {
    expect(p.capabilities.defaults.ratio).toBe('adaptive');
    expect(p.capabilities.supportedRatios).not.toContain('adaptive');
    expect(p.capabilities.supportedRatios).toEqual([
      '16:9',
      '9:16',
      '1:1',
      '4:3',
      '3:4',
    ]);
  });

  it('有音频开关,上游默认出声(同 2.0 的原生音画同生)', () => {
    expect(p.capabilities.supportsAudio).toBe(true);
    expect(p.capabilities.audioDefault).toBe(true);
  });
});

describe('seedance 2.5 · submit body shape', () => {
  it('model 用网关映射名,URL 与 2.0 同一个 endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ id: 'cgt-25-1' }), { status: 200 });
    }) as unknown as typeof fetch;

    const handle = await makeProvider(fetchMock).submit(
      { prompt: '海浪拍打礁石', duration: 8, resolution: '720p' },
      'bytedance/seedance-2.5',
    );
    expect(handle.providerId).toBe('seedance-2.5');
    expect(handle.taskId).toBe('cgt-25-1');
    expect(handle.modelUsed).toBe(MODEL);
    expect(calls[0].url).toBe(SUBMIT_URL);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(calls[0].init.body as string).model).toBe(MODEL);
  });

  it('**不写 --fps**:方舟弱校验后缀白名单里没有 fps 这一项', async () => {
    const text = await promptTextOf({
      prompt: '一只猫打哈欠',
      duration: 6,
      resolution: '720p',
      // 执行器一定会把 fps 补进请求(run.ts 无条件回落 defaults),所以这里
      // 显式传一个值,验证 provider 拿到了也不往后缀里写。
      fps: 24,
    });
    expect(text).not.toContain('--fps');
    expect(text).toBe('一只猫打哈欠 --duration 6 --resolution 720p');
  });

  it('省略 ratio → 回落 adaptive → 不写 --ratio(这是 adaptive 唯一的到达路径)', async () => {
    const omitted = await promptTextOf({ prompt: 'p', duration: 5, resolution: '720p' });
    expect(omitted).not.toContain('--ratio');
    expect(omitted).toBe('p --duration 5 --resolution 720p');
  });

  it('provider 内部收到 adaptive 也不写 --ratio(defaults 之外没别的来路,兜底同形)', async () => {
    // 这条走的是 provider 直调,不经 cindySlot 粗筛 —— 插件路径上
    // `ratio: 'adaptive'` 会被协议层先拒(GHOST_VIDEO_RATIOS 闭集不含它),
    // 所以生产里这个值只可能来自 defaults 回落。这里钉的是"万一从别处来也同形"。
    const explicit = await promptTextOf({
      prompt: 'p',
      duration: 5,
      resolution: '720p',
      ratio: 'adaptive',
    });
    expect(explicit).not.toContain('--ratio');
    expect(explicit).toBe('p --duration 5 --resolution 720p');
  });

  it('给了具体画幅就原样透传 —— 文生视频', async () => {
    const text = await promptTextOf({
      prompt: 'p',
      duration: 5,
      resolution: '720p',
      ratio: '16:9',
    });
    expect(text).toBe('p --duration 5 --resolution 720p --ratio 16:9');
  });

  it('给了具体画幅就原样透传 —— 首帧/首尾帧场景**照样不拦**(passthrough,由上游裁决)', async () => {
    // 文档说 2.5 的首帧/首尾帧"默认且仅支持 adaptive",但主机不替上游立规矩:
    // 照写用户给的比例,忽略或报错都由方舟决定,错误原样透传。
    for (const images of [
      ['data:image/png;base64,ONE'],
      ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
    ]) {
      const text = await promptTextOf({
        prompt: 'p',
        duration: 5,
        resolution: '720p',
        ratio: '9:16',
        images,
      });
      expect(text, `images=${images.length}`).toContain('--ratio 9:16');
    }
  });

  it('给了具体画幅就原样透传 —— reference_image 模式', async () => {
    const text = await promptTextOf({
      prompt: '[图片1] 的猫',
      duration: 5,
      resolution: '720p',
      ratio: '4:3',
      refMode: 'reference_image',
      images: ['data:image/png;base64,ONE'],
    });
    expect(text).toContain('--ratio 4:3');
  });

  it('时长 30 秒放行,有参考图时同样放行(ratio 的 adaptive 规则不牵连时长)', async () => {
    const textOnly = await promptTextOf({ prompt: 'p', duration: 30, resolution: '720p' });
    expect(textOnly).toContain('--duration 30');

    const withImage = await promptTextOf({
      prompt: 'p',
      duration: 30,
      resolution: '720p',
      images: ['data:image/png;base64,ONE'],
    });
    expect(withImage).toContain('--duration 30');
  });

  it('音频开关走顶层 generate_audio,三态(不传就不写这个键)', async () => {
    const { fetchMock, bodyOf } = makeSubmitMock();
    const p = makeProvider(fetchMock);
    await p.submit({ prompt: 'p', duration: 5 }, 'bytedance/seedance-2.5');
    expect('generate_audio' in bodyOf(0)).toBe(false);

    for (const [i, audio] of [true, false].entries()) {
      await p.submit({ prompt: 'p', duration: 5, audio }, 'bytedance/seedance-2.5');
      const body = bodyOf(i + 1);
      expect(body.generate_audio, `audio=${audio}`).toBe(audio);
      expect(body.content[0].text as string).not.toContain('audio');
    }
  });

  it('参考图 role 与 2.0 同源:首尾帧分 first_frame / last_frame,参考图模式全 reference_image', async () => {
    const { fetchMock, bodyOf } = makeSubmitMock();
    const p = makeProvider(fetchMock);

    await p.submit(
      { prompt: 'p', images: ['data:image/png;base64,A', 'data:image/png;base64,B'] },
      'bytedance/seedance-2.5',
    );
    expect(bodyOf(0).content[1].role).toBe('first_frame');
    expect(bodyOf(0).content[2].role).toBe('last_frame');

    await p.submit(
      {
        prompt: 'p',
        refMode: 'reference_image',
        images: ['data:image/png;base64,A', 'data:image/png;base64,B'],
      },
      'bytedance/seedance-2.5',
    );
    expect(bodyOf(1).content.slice(1).map((c) => c.role)).toEqual([
      'reference_image',
      'reference_image',
    ]);
  });

  it('未知 alias 提交前就拒,话术带本 provider 的名字', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    const p = makeProvider(fetchMock);
    await expect(p.submit({ prompt: 'x' }, 'seedance-fast')).rejects.toThrow(
      /seedance-2\.5: unknown alias/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('seedance 2.5 · poll / 错误话术', () => {
  const handle = {
    providerId: 'seedance-2.5',
    taskId: 'cgt-25-X',
    modelUsed: MODEL,
    submittedAt: 0,
  };

  it('succeeded → 带 video_url 与上游上报的 meta', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'cgt-25-X',
          status: 'succeeded',
          content: { video_url: 'https://tos.example/v25.mp4' },
          duration: 30,
          resolution: '720p',
          ratio: '9:16',
          framespersecond: 24,
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const status = await makeProvider(fetchMock).poll(handle);
    expect(status.state).toBe('succeeded');
    if (status.state === 'succeeded') {
      expect(status.videoUrl).toBe('https://tos.example/v25.mp4');
      expect(status.meta).toMatchObject({ durationSec: 30, resolution: '720p', ratio: '9:16' });
    }
  });

  it('succeeded 但没有 video_url → failed,话术带 provider 名', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 'cgt-25-X', status: 'succeeded', content: {} }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const status = await makeProvider(fetchMock).poll(handle);
    expect(status.state).toBe('failed');
    if (status.state === 'failed') {
      expect(status.error).toContain('seedance-2.5');
    }
  });

  it('failed 且上游没给 message → 兜底话术带 provider 名', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cgt-25-X', status: 'failed' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const status = await makeProvider(fetchMock).poll(handle);
    expect(status.state).toBe('failed');
    if (status.state === 'failed') {
      expect(status.error).toContain('seedance-2.5 task failed');
    }
  });
});

describe('seedance 2.5 · 经执行器端到端', () => {
  function makeRegistry(fetchMock: typeof fetch): VideoProviderRegistry {
    const r = new VideoProviderRegistry();
    r.register(makeProvider(fetchMock));
    return r;
  }

  it('1080p 在提交前就被明拒,一个请求都不发(话术自带该型号可用值)', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    await expect(
      submitAndAwaitVideo(makeRegistry(fetchMock), {
        alias: 'bytedance/seedance-2.5',
        prompt: 'p',
        resolution: '1080p',
      }),
    ).rejects.toThrow(/does not support resolution 1080p/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('时长 30 秒走得通,而 31 秒被拒(4–30 的边界在执行器上生效)', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    await expect(
      submitAndAwaitVideo(makeRegistry(fetchMock), {
        alias: 'bytedance/seedance-2.5',
        prompt: 'p',
        duration: 31,
      }),
    ).rejects.toThrow(/does not support duration 31/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不传画面参数 → adaptive 落进请求(不写 --ratio)、回执报 adaptive', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(init.body as string);
        return new Response(JSON.stringify({ id: 'cgt-25-E2E' }), { status: 200 });
      }
      if (url.endsWith('/cgt-25-E2E')) {
        // 上游只报 status + video_url(不报 ratio),回执就得回落我们的提交值。
        return new Response(
          JSON.stringify({
            id: 'cgt-25-E2E',
            status: 'succeeded',
            content: { video_url: 'https://tos.example/e2e.mp4' },
          }),
          { status: 200 },
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }) as unknown as typeof fetch;

    const r = await submitAndAwaitVideo(makeRegistry(fetchMock), {
      alias: 'bytedance/seedance-2.5',
      prompt: '雨中的城市',
    });

    const text = JSON.parse(bodies[0]).content[0].text as string;
    expect(text).toBe('雨中的城市 --duration 5 --resolution 720p');
    expect(r.modelUsed).toBe(MODEL);
    expect(r.effectiveParams).toMatchObject({
      duration: 5,
      resolution: '720p',
      ratio: 'adaptive',
      audio: true,
    });
  });
});

/**
 * 两代值域**互不放宽**——本 PR 的核心不变量,也是唯一能证明"拆 provider 拆对了"
 * 的测试。
 *
 * 上面那些 case 只注册 2.5 一个 provider,证明的是"2.5 自己的值域对"。但两代共用
 * 一份 capabilities 的真实危害是**双向污染**:2.0 的窄值域会卡死 2.5 的长片,2.5
 * 的宽值域又会替 2.0 放宽。所以这里按真实装配同时注册两代,拿同一个执行器、同一
 * 组参数正反各打一次 —— 一份 capabilities 的实现下,这四条里必然有两条会翻。
 */
describe('两代值域互不放宽(同一执行器下的隔离)', () => {
  /** 按 cindyProxyMedia.ts 的真实装配顺序注册两代。 */
  function makeBothRegistry(fetchImplementation: typeof fetch): VideoProviderRegistry {
    const stub = { baseUrl: BASE_URL, getApiKey: () => 'k', fetchImplementation };
    const r = new VideoProviderRegistry();
    r.register(createSeedanceProvider(stub));
    r.register(createSeedance25Provider(stub));
    return r;
  }

  /**
   * 拿到该型号的拒绝话术;没被拒就返回 `'(未拒)'`。
   *
   * 值域校验(assertParamSupported)发生在任何 fetch 之前,所以桩只需要证明
   * "被拒的那一侧一个请求都没发";放行的那一侧会走到提交,让桩抛一个可辨认的
   * 错误收尾 —— 断言只看话术里有没有值域字样,不会跟它混。
   */
  async function rejection(
    alias: string,
    params: { duration?: number; resolution?: string },
  ): Promise<{ message: string; fetched: boolean }> {
    const fetchMock = vi.fn(async () => {
      throw new Error('__submitted__');
    }) as unknown as typeof fetch;
    try {
      await submitAndAwaitVideo(makeBothRegistry(fetchMock), {
        alias,
        prompt: 'p',
        ...params,
      });
      return { message: '(未拒)', fetched: true };
    } catch (e) {
      return {
        message: (e as Error).message,
        fetched: (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      };
    }
  }

  it('时长 30:2.5 放行,2.0 明拒(2.5 的宽值域没有替 2.0 放宽)', async () => {
    // 2.0 必须报"不支持 duration 30",且一个请求都不发。它放行 = 2.5 的 4–30
    // 漏进了 2.0 的 capabilities,2.0 的单子会一路发到上游才被拒。
    const v20 = await rejection('seedance-fast', { duration: 30 });
    expect(v20.message).toMatch(/does not support duration 30/);
    expect(v20.fetched).toBe(false);

    // 2.5 侧不该在**校验**这一关被拦(拦了就是 2.0 的窄值域卡住了 2.5 的长片)。
    // 它应当走到提交 —— fetched 为真就是证据。
    const v25 = await rejection('bytedance/seedance-2.5', { duration: 30 });
    expect(v25.message).not.toMatch(/does not support duration/);
    expect(v25.fetched).toBe(true);
  });

  it('1080p:2.0 放行,2.5 明拒(2.0 的三档没有漏给 2.5)', async () => {
    const v25 = await rejection('bytedance/seedance-2.5', { resolution: '1080p' });
    expect(v25.message).toMatch(/does not support resolution 1080p/);
    expect(v25.fetched).toBe(false);

    const v20 = await rejection('seedance-fast', { resolution: '1080p' });
    expect(v20.message).not.toMatch(/does not support resolution/);
    expect(v20.fetched).toBe(true);
  });
});
