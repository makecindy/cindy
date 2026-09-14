/**
 * buildToolResultImageDescriptions / collectCindyMediaUrls 单元测试。
 *
 * 覆盖:注入未提供短路、producedMedia 图片成功、非图媒体过滤、result.result
 * 嵌套 URL 收集、去重、单张失败跳过、全失败不附加、非 blob/原始值/超深嵌套
 * 不崩溃、并发上限、总预算超时。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildToolResultImageDescriptions,
  collectCindyMediaUrls,
} from '../ghost.js';
import type { CindyGhostsHostDeps } from '../ghost.js';

/** 合法 cindy-media:// 图片 URL(64 位 hex hash + .jpg)。 */
const IMG_A = `cindy-media://blobs/${'a'.repeat(64)}.jpg`;
const IMG_B = `cindy-media://blobs/${'b'.repeat(64)}.jpg`;
const VIDEO = `cindy-media://blobs/${'c'.repeat(64)}.mp4`;
const AUDIO = `cindy-media://blobs/${'d'.repeat(64)}.mp3`;

function makeParams(overrides: {
  producedMedia?: string[];
  resultPayload?: unknown;
  describeImage?: CindyGhostsHostDeps['describeToolResultImage'];
}) {
  return {
    producedMedia: overrides.producedMedia ?? [],
    resultPayload: overrides.resultPayload,
    sessionId: 'sess-1',
    sessionInstanceId: 'inst-1',
    describeImage: overrides.describeImage,
  };
}

/** 成功描述结果(skipped:false)。 */
const okDesc = (description: string) => ({ skipped: false, description });

describe('buildToolResultImageDescriptions', () => {
  it('describeImage 未注入 → 返回 null', async () => {
    const out = await buildToolResultImageDescriptions(makeParams({ describeImage: undefined }));
    expect(out).toBeNull();
  });

  it('producedMedia 为空 + result 无 URL → 返回 null', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('a cat'));
    const out = await buildToolResultImageDescriptions(
      makeParams({ describeImage, resultPayload: { ok: true, text: 'no images' } }),
    );
    expect(out).toBeNull();
    expect(describeImage).not.toHaveBeenCalled();
  });

  it('producedMedia 图片成功 → 返回 xdt_media_descriptions', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('a chat list screenshot'));
    const out = await buildToolResultImageDescriptions(
      makeParams({ producedMedia: [IMG_A], describeImage }),
    );
    expect(out).toEqual({
      xdt_media_descriptions: [{ url: IMG_A, description: 'a chat list screenshot' }],
      attemptedCount: 1,
      aborted: false,
    });
    expect(describeImage).toHaveBeenCalledTimes(1);
    expect(describeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: IMG_A,
        sessionId: 'sess-1',
        sessionInstanceId: 'inst-1',
      }),
    );
    // 预算 abort signal 已透传(完成门)。断言其存在,不精确匹配实例。
    expect(describeImage.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('producedMedia 视频/音频 → 过滤,describeImage 不被调用', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    const out = await buildToolResultImageDescriptions(
      makeParams({ producedMedia: [VIDEO, AUDIO], describeImage }),
    );
    expect(out).toBeNull();
    expect(describeImage).not.toHaveBeenCalled();
  });

  it('混合图片 + 视频 → 只描述图片', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    const out = await buildToolResultImageDescriptions(
      makeParams({ producedMedia: [IMG_A, VIDEO, IMG_B], describeImage }),
    );
    expect(out?.xdt_media_descriptions).toHaveLength(2);
    expect(describeImage).toHaveBeenCalledTimes(2);
  });

  it('result.result 含图片 URL 且也在 producedMedia（主机账本）→ 收集并描述', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    const nested = {
      ok: true,
      result: {
        data: {
          attachments: [{ url: IMG_A }],
        },
      },
    };
    const out = await buildToolResultImageDescriptions(
      makeParams({ producedMedia: [IMG_A], resultPayload: nested, describeImage }),
    );
    expect(out?.xdt_media_descriptions).toEqual([{ url: IMG_A, description: 'desc' }]);
  });

  it('result.result 含图片 URL 但不在 producedMedia → 不描述（插件回显未授权 URL，安全 P1）', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    // 插件返回体里声明的 URL 不在本次调用主机账本中（producedMedia 空）：
    // 直接 resolve 读 blob 会把任意媒体字节外发，必须跳过。
    const out = await buildToolResultImageDescriptions(
      makeParams({ resultPayload: { attachments: [{ url: IMG_A }] }, describeImage }),
    );
    expect(out).toBeNull();
    expect(describeImage).not.toHaveBeenCalled();
  });

  it('producedMedia 与 result 重复 URL → 去重,describeImage 每 URL 一次', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    const out = await buildToolResultImageDescriptions(
      makeParams({
        producedMedia: [IMG_A, IMG_B],
        resultPayload: { url: IMG_A },
        describeImage,
      }),
    );
    expect(out?.xdt_media_descriptions).toHaveLength(2);
    expect(describeImage).toHaveBeenCalledTimes(2);
  });

  it('describeImage 单张抛异常 → 跳过该图,其余继续', async () => {
    const describeImage = vi
      .fn()
      .mockResolvedValueOnce(okDesc('first ok'))
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValueOnce(okDesc('third ok'));
    const out = await buildToolResultImageDescriptions(
      makeParams({
        producedMedia: [IMG_A, IMG_B, `cindy-media://blobs/${'e'.repeat(64)}.jpg`],
        describeImage,
      }),
    );
    expect(out?.xdt_media_descriptions).toHaveLength(2);
  });

  it('describeImage 全部真实尝试失败(非 skipped)→ attemptedCount 计全量(供收口告警)', async () => {
    const describeImage = vi.fn().mockResolvedValue({ skipped: false, description: null });
    const out = await buildToolResultImageDescriptions(
      makeParams({ producedMedia: [IMG_A, IMG_B], describeImage }),
    );
    expect(out).toEqual({ attemptedCount: 2, aborted: false });
    expect(out?.xdt_media_descriptions).toBeUndefined();
  });

  it('describeImage 全部有意跳过(skipped)→ attemptedCount 为 0,不触发告警', async () => {
    // 视觉桥未启用 / 模型不命中 / session 缺失等 skip 场景:功能本就没开,
    // 不得计入 attemptedCount,否则收口会误报「视觉桥不可用」。
    const describeImage = vi.fn().mockResolvedValue({ skipped: true, description: null });
    const out = await buildToolResultImageDescriptions(
      makeParams({ producedMedia: [IMG_A, IMG_B], describeImage }),
    );
    expect(out).toEqual({ attemptedCount: 0, aborted: false });
    expect(out?.xdt_media_descriptions).toBeUndefined();
  });

  it('部分跳过 + 部分真实失败 → attemptedCount 只计真实尝试', async () => {
    const describeImage = vi
      .fn()
      .mockResolvedValueOnce({ skipped: true, description: null })
      .mockResolvedValueOnce({ skipped: false, description: null })
      .mockResolvedValueOnce(okDesc('ok'));
    const out = await buildToolResultImageDescriptions(
      makeParams({
        producedMedia: [IMG_A, IMG_B, `cindy-media://blobs/${'e'.repeat(64)}.jpg`],
        describeImage,
      }),
    );
    expect(out?.xdt_media_descriptions).toEqual([
      { url: `cindy-media://blobs/${'e'.repeat(64)}.jpg`, description: 'ok' },
    ]);
    expect(out?.attemptedCount).toBe(2);
  });

  it('非 cindy-media URL 不收集', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    const out = await buildToolResultImageDescriptions(
      makeParams({
        producedMedia: ['https://example.com/img.png', 'file:///c/x.png'],
        describeImage,
      }),
    );
    expect(out).toBeNull();
    expect(describeImage).not.toHaveBeenCalled();
  });

  it('result.result 为原始值 → 不崩溃', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    for (const raw of [42, 'hello', null, true]) {
      const out = await buildToolResultImageDescriptions(
        makeParams({ resultPayload: raw, describeImage }),
      );
      expect(out).toBeNull();
    }
  });

  it('result.result 深度超过上限 → 短路不爆栈', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    let deep: unknown = IMG_A;
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    const out = await buildToolResultImageDescriptions(
      makeParams({ resultPayload: deep, describeImage }),
    );
    expect(out).toBeNull();
  });

  it('result.result 含 xdt_media_descriptions 自引用键 → 跳过', async () => {
    const describeImage = vi.fn().mockResolvedValue(okDesc('desc'));
    const out = await buildToolResultImageDescriptions(
      makeParams({
        resultPayload: { xdt_media_descriptions: [{ url: IMG_A, description: 'old' }] },
        describeImage,
      }),
    );
    expect(out).toBeNull();
  });

  it('多图并发不超过上限', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const describeImage = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okDesc('desc');
    });
    const urls = [IMG_A, IMG_B, `cindy-media://blobs/${'e'.repeat(64)}.jpg`, `cindy-media://blobs/${'f'.repeat(64)}.jpg`];
    const out = await buildToolResultImageDescriptions(
      makeParams({ producedMedia: urls, describeImage }),
    );
    expect(out?.xdt_media_descriptions).toHaveLength(4);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('总预算超时 abort 未完成请求(完成门),不硬等单张 30s', async () => {
    vi.useFakeTimers();
    try {
      // 慢描述:不 resolve,等到 signal abort 才 resolve(模拟视觉后端挂起)。
      const seenAbort = vi.fn();
      const describeImage = vi.fn().mockImplementation((input: { signal?: AbortSignal }) => {
        return new Promise<{ skipped: boolean; description: string | null }>((resolve) => {
          if (input.signal?.aborted) {
            resolve({ skipped: false, description: null });
            return;
          }
          input.signal?.addEventListener('abort', () => resolve({ skipped: false, description: null }), { once: true });
          seenAbort();
        });
      });
      const urls = [IMG_A, IMG_B];
      const pending = buildToolResultImageDescriptions(
        makeParams({ producedMedia: urls, describeImage }),
      );
      // 推进到预算超时(60s) → 共享 signal abort → 未完成请求 reject → Promise.all 收敛。
      await vi.advanceTimersByTimeAsync(60 * 1000);
      const out = await pending;
      // 未完成描述被丢弃、不附加字段,但 attemptedCount 仍返回(供收口告警)。
      expect(out).toEqual({ attemptedCount: 2, aborted: true });
      expect(out?.xdt_media_descriptions).toBeUndefined();
      expect(seenAbort).toHaveBeenCalled(); // 请求确实启动了(否则无 abort 监听可触发)。
    } finally {
      vi.useRealTimers();
    }
  });

  it('describeImage 不响应 signal 且永不 settle:Promise.race 仍在预算期返回(兜底)', async () => {
    vi.useFakeTimers();
    try {
      // 完全不响应 signal、永不 resolve 的 describeImage(模拟缓存命中等不走 fetch
      // 的路径)——只有 Promise.race 兜底能保证预算到期返回。
      const describeImage = vi.fn().mockImplementation(
        () => new Promise<{ skipped: boolean; description: string | null }>(() => {}),
      );
      const pending = buildToolResultImageDescriptions(
        makeParams({ producedMedia: [IMG_A, IMG_B], describeImage }),
      );
      await vi.advanceTimersByTimeAsync(60 * 1000);
      const out = await pending;
      // 函数在预算期返回(兜底),未完成描述被丢弃但 attemptedCount 返回。
      expect(out).toEqual({ attemptedCount: 2, aborted: true });
      expect(out?.xdt_media_descriptions).toBeUndefined();
      expect(describeImage).toHaveBeenCalledTimes(2); // 两张图都启动了,但都没 settle。
    } finally {
      vi.useRealTimers();
    }
  });

  it('预算未超时:慢请求完成后正常附加', async () => {
    vi.useFakeTimers();
    try {
      const describeImage = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return okDesc('desc');
      });
      const pending = buildToolResultImageDescriptions(
        makeParams({ producedMedia: [IMG_A], describeImage }),
      );
      await vi.advanceTimersByTimeAsync(20);
      const out = await pending;
      expect(out?.xdt_media_descriptions).toEqual([{ url: IMG_A, description: 'desc' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collectCindyMediaUrls', () => {
  it('收集嵌套数组/对象的 cindy-media 字符串', () => {
    const sink = new Set<string>();
    collectCindyMediaUrls({ a: [IMG_A, { b: VIDEO }], c: 'https://x.com/1.png' }, sink, 8);
    expect([...sink]).toEqual([IMG_A, VIDEO]);
  });

  it('跳过元数据键', () => {
    const sink = new Set<string>();
    collectCindyMediaUrls(
      { hint: IMG_A, setup: IMG_B, xdt_media_descriptions: [{ url: VIDEO }], ok: IMG_A },
      sink,
      8,
    );
    expect([...sink]).toEqual([IMG_A]);
  });

  it('深度为 0 短路', () => {
    const sink = new Set<string>();
    collectCindyMediaUrls({ nested: { url: IMG_A } }, sink, 0);
    expect(sink.size).toBe(0);
  });

  it('8 层内合法嵌套不漏(深度常量上限内)', () => {
    const sink = new Set<string>();
    // 逐层包 7 层对象,IMG_A 落在第 8 层(根 depth=8,每进一层减 1)。
    let nested: unknown = IMG_A;
    for (let i = 0; i < 7; i += 1) nested = { child: nested };
    collectCindyMediaUrls(nested, sink, 8);
    expect([...sink]).toEqual([IMG_A]);
  });

  it('超过 8 层剪断,不爆栈也不误收集更深层', () => {
    const sink = new Set<string>();
    let nested: unknown = IMG_A;
    for (let i = 0; i < 10; i += 1) nested = { child: nested };
    // 10 层包 11 层:8 层深度上限内收集不到 IMG_A(超出合法嵌套深度,防爆栈优先)。
    collectCindyMediaUrls(nested, sink, 8);
    expect(sink.size).toBe(0);
  });

  it('宽对象在节点预算耗尽时提前中止,不物化全部条目', () => {
    const sink = new Set<string>();
    let getterReads = 0;
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) {
      // getter 每次被读取计数:旧实现 Object.entries 会在预算检查前物化全部条目、
      // 触发全部 100 个 getter;新实现惰性枚举,预算耗尽即止。
      Object.defineProperty(wide, `k${i}`, {
        enumerable: true,
        get() {
          getterReads += 1;
          return `cindy-media://blobs/wide-${i}.png`;
        },
      });
    }
    collectCindyMediaUrls(wide, sink, 8, { remaining: 3 });
    // 预算 3:每访问一个键扣 1,最多访问 3 个键,绝不枚举全部 100 个条目。
    expect(sink.size).toBeLessThanOrEqual(3);
    expect(getterReads).toBeLessThanOrEqual(3);
  });
});
