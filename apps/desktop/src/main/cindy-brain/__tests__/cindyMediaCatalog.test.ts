/**
 * cindyMediaCatalog.test.ts — cindy 槽媒体能力配置派生的纯函数单测。
 *
 * 重点锁住「空清单 = 能力暂不可用」这条新口径:目录没给该类目模型时返回
 * { models: [], defaults: null },不再落回打包常量(旧行为)、也不能因取
 * models[0] 抛错。附带锁住去重、默认在册校验与多供应商 first-wins。
 */

import { describe, it, expect } from 'vitest';

import { deriveCindyMediaConfig, type CindyMediaProviderSlice } from '../cindyMediaCatalog';

const XD: CindyMediaProviderSlice = {
  id: 'xd',
  imageModels: [
    { id: 'gpt-image-2', name: 'GPT Image 2' },
    { id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image' },
    { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
  ],
  imageDefaults: { standard: 'gpt-image-2', draft: 'gemini-3.1-flash-image' },
  videoModels: [
    { id: 'seedance-fast', name: 'Seedance 快速' },
    { id: 'seedance-pro', name: 'Seedance Pro' },
  ],
  videoDefaults: { standard: 'seedance-fast', best: 'seedance-pro' },
  embeddingModels: [
    { id: 'voyage/voyage-4', name: 'Voyage 4' },
    { id: 'voyage/voyage-4-large', name: 'Voyage 4 Large' },
    { id: 'text-embedding-3-small', name: 'OpenAI Embedding 3 Small' },
  ],
  embeddingDefaults: {
    standard: 'voyage/voyage-4',
    draft: 'text-embedding-3-small',
    best: 'voyage/voyage-4-large',
  },
};

describe('deriveCindyMediaConfig — 正常目录', () => {
  it('清单按目录序、label 取 name、providerId 记归属;draft/best 缺省回落 standard', () => {
    const image = deriveCindyMediaConfig([XD], 'image');
    expect(image.models).toEqual([
      { id: 'gpt-image-2', label: 'GPT Image 2', providerId: 'xd', supportsEdit: true },
      { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image', providerId: 'xd', supportsEdit: true },
      { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', providerId: 'xd', supportsEdit: true },
    ]);
    // best 没声明 → 回落 standard。
    expect(image.defaults).toEqual({
      standard: 'gpt-image-2',
      draft: 'gemini-3.1-flash-image',
      best: 'gpt-image-2',
    });

    const video = deriveCindyMediaConfig([XD], 'video');
    expect(video.models.map((m) => m.id)).toEqual(['seedance-fast', 'seedance-pro']);
    expect(video.defaults).toEqual({
      standard: 'seedance-fast',
      draft: 'seedance-fast',
      best: 'seedance-pro',
    });
  });

  it('同 id 跨供应商去重(first-wins),默认取首个声明默认段的供应商', () => {
    const other: CindyMediaProviderSlice = {
      id: 'other',
      imageModels: [
        { id: 'gpt-image-2', name: '重复条目(应被忽略)' },
        { id: 'other-image-1', name: 'Other Image 1' },
      ],
      imageDefaults: { standard: 'other-image-1' },
    };
    const cfg = deriveCindyMediaConfig([XD, other], 'image');
    expect(cfg.models.map((m) => m.id)).toEqual([
      'gpt-image-2',
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'other-image-1',
    ]);
    expect(cfg.models[0].label).toBe('GPT Image 2');
    expect(cfg.defaults?.standard).toBe('gpt-image-2');
  });

  it('目录写的默认值不在册(型号已下架)→ 回落清单首项,不卡死能力', () => {
    const stale: CindyMediaProviderSlice = {
      id: 'stale',
      imageModels: [{ id: 'live-model', name: 'Live Model' }],
      imageDefaults: { standard: 'retired-model', draft: 'also-retired' },
    };
    expect(deriveCindyMediaConfig([stale], 'image').defaults).toEqual({
      standard: 'live-model',
      draft: 'live-model',
      best: 'live-model',
    });
  });

  it('只声明清单不声明默认段 → 默认全取首项', () => {
    const noDefaults: CindyMediaProviderSlice = {
      id: 'nd',
      videoModels: [
        { id: 'v1', name: 'V1' },
        { id: 'v2', name: 'V2' },
      ],
    };
    expect(deriveCindyMediaConfig([noDefaults], 'video').defaults).toEqual({
      standard: 'v1',
      draft: 'v1',
      best: 'v1',
    });
  });
});

describe('deriveCindyMediaConfig — 空清单即不可用', () => {
  it('供应商完全没有该类目 → { models: [], defaults: null },不抛', () => {
    const imageOnly: CindyMediaProviderSlice = {
      id: 'io',
      imageModels: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
      imageDefaults: { standard: 'gpt-image-2' },
    };
    const video = deriveCindyMediaConfig([imageOnly], 'video');
    expect(video.models).toEqual([]);
    expect(video.defaults).toBeNull();
    // 同一份目录里另一类目仍然可用。
    expect(deriveCindyMediaConfig([imageOnly], 'image').defaults?.standard).toBe('gpt-image-2');
  });

  it('供应商数组为空 / 清单为空数组 → 同样是不可用,不落回任何写死清单', () => {
    const cases: CindyMediaProviderSlice[][] = [[], [{ id: 'e1' }], [{ id: 'e2', imageModels: [], videoModels: [] }]];
    for (const providers of cases) {
      for (const kind of ['image', 'video'] as const) {
        const cfg = deriveCindyMediaConfig(providers, kind);
        expect(cfg.models).toEqual([]);
        expect(cfg.defaults).toBeNull();
      }
    }
  });

  it('清单空但声明了默认段(目录自相矛盾)→ 仍判不可用', () => {
    const contradictory: CindyMediaProviderSlice = {
      id: 'c',
      videoModels: [],
      videoDefaults: { standard: 'seedance-fast' },
    };
    const cfg = deriveCindyMediaConfig([contradictory], 'video');
    expect(cfg.models).toEqual([]);
    expect(cfg.defaults).toBeNull();
  });
});

describe('deriveCindyMediaConfig — 停用过滤(model-disable override)', () => {
  it('停用条目不进清单也不占 first-wins;目录默认指向停用型号时回落清单首项', () => {
    const cfg = deriveCindyMediaConfig(
      [XD],
      'image',
      (providerId, modelId) => providerId === 'xd' && modelId === 'gpt-image-2',
    );
    expect(cfg.models.map((m) => m.id)).toEqual(['gemini-3-pro-image', 'gemini-3.1-flash-image']);
    // imageDefaults.standard 指向被停用的 gpt-image-2 → 回落清单首项。
    expect(cfg.defaults).toEqual({
      standard: 'gemini-3-pro-image',
      draft: 'gemini-3.1-flash-image',
      best: 'gemini-3-pro-image',
    });
  });

  it('供应商级停用(谓词对该供应商恒真)→ 全类目不可用', () => {
    const cfg = deriveCindyMediaConfig([XD], 'video', (providerId) => providerId === 'xd');
    expect(cfg.models).toEqual([]);
    expect(cfg.defaults).toBeNull();
  });

  it('不传谓词 = 不过滤(既有调用方为空的兼容路径)', () => {
    expect(deriveCindyMediaConfig([XD], 'image').models).toHaveLength(3);
  });
});

describe('deriveCindyMediaConfig — 就绪过滤(isProviderReady,2026-07 图像多来源)', () => {
  const GEMINI: CindyMediaProviderSlice = {
    id: 'gemini',
    imageModels: [{ id: 'gemini/gemini-3-pro-image', name: 'Gemini 3 Pro Image' }],
  };

  it('未就绪的供应商整段跳过(含其 defaults 声明),不长出"可选但必失败"的型号', () => {
    const cfg = deriveCindyMediaConfig([XD, GEMINI], 'image', undefined, (id) => id === 'xd');
    expect(cfg.models.map((m) => m.id)).toEqual([
      'gpt-image-2',
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
    ]);
    // 未就绪供应商若声明了 defaults,同样不参与选型。
    const withDefaults = deriveCindyMediaConfig(
      [{ ...GEMINI, imageDefaults: { standard: 'gemini/gemini-3-pro-image' } }, XD],
      'image',
      undefined,
      (id) => id === 'xd',
    );
    expect(withDefaults.defaults?.standard).toBe('gpt-image-2');
  });

  it('全部未就绪 → 能力不可用;不传谓词 = 全就绪(既有调用方兼容路径)', () => {
    const none = deriveCindyMediaConfig([XD, GEMINI], 'image', undefined, () => false);
    expect(none.models).toEqual([]);
    expect(none.defaults).toBeNull();
    const all = deriveCindyMediaConfig([XD, GEMINI], 'image');
    expect(all.models.map((m) => m.providerId)).toEqual(['xd', 'xd', 'xd', 'gemini']);
  });

  it('providerId 归属按 first-wins 定格:同 id 先到者得,后来的供应商不改归属', () => {
    const clash: CindyMediaProviderSlice = {
      id: 'other',
      imageModels: [{ id: 'gpt-image-2', name: '重复条目' }],
    };
    const cfg = deriveCindyMediaConfig([XD, clash], 'image');
    expect(cfg.models.find((m) => m.id === 'gpt-image-2')?.providerId).toBe('xd');
  });
});

describe('deriveCindyMediaConfig — supportsEdit(仅生成来源,2026-07)', () => {
  const XAI: CindyMediaProviderSlice = {
    id: 'xai',
    imageModels: [{ id: 'xai/aurora', name: 'Aurora' }],
  };

  it('不传 isProviderEditReady → 所有条目 supportsEdit=true(兼容路径)', () => {
    const cfg = deriveCindyMediaConfig([XD, XAI], 'image');
    expect(cfg.models.every((m) => m.supportsEdit)).toBe(true);
  });

  it('isProviderEditReady 为 false 的来源条目 supportsEdit=false,仍进生成清单', () => {
    const cfg = deriveCindyMediaConfig(
      [XD, XAI],
      'image',
      undefined,
      () => true,
      (id) => id !== 'xai',
    );
    expect(cfg.models.map((m) => m.id)).toContain('xai/aurora');
    expect(cfg.models.find((m) => m.id === 'xai/aurora')?.supportsEdit).toBe(false);
    expect(cfg.models.find((m) => m.id === 'gpt-image-2')?.supportsEdit).toBe(true);
  });
});

describe('deriveCindyMediaConfig — 向量类目(embed)', () => {
  it('读 embeddingModels / embeddingDefaults,与 image / video 同一套派生规则', () => {
    const cfg = deriveCindyMediaConfig([XD], 'embed');
    expect(cfg.models.map((m) => m.id)).toEqual([
      'voyage/voyage-4',
      'voyage/voyage-4-large',
      'text-embedding-3-small',
    ]);
    expect(cfg.defaults).toEqual({
      standard: 'voyage/voyage-4',
      draft: 'text-embedding-3-small',
      best: 'voyage/voyage-4-large',
    });
  });

  it('目录没声明向量段 → 空清单 + defaults null(能力暂不可用,不落回别的类目)', () => {
    const imageOnly: CindyMediaProviderSlice = {
      id: 'xd',
      imageModels: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
      imageDefaults: { standard: 'gpt-image-2' },
    };
    expect(deriveCindyMediaConfig([imageOnly], 'embed')).toEqual({ models: [], defaults: null });
  });

  it('停用过滤:被停用的型号不进清单,目录默认指向它时回落清单首项', () => {
    const cfg = deriveCindyMediaConfig(
      [XD],
      'embed',
      (_providerId, modelId) => modelId === 'voyage/voyage-4',
    );
    expect(cfg.models.map((m) => m.id)).toEqual([
      'voyage/voyage-4-large',
      'text-embedding-3-small',
    ]);
    expect(cfg.defaults?.standard).toBe('voyage/voyage-4-large');
  });

  it('供应商未就绪(本地模式无网关)→ 整段跳过,能力暂不可用', () => {
    expect(deriveCindyMediaConfig([XD], 'embed', undefined, () => false)).toEqual({
      models: [],
      defaults: null,
    });
  });
});

describe('deriveCindyMediaConfig — 向量只认 XD(派单还不是 provider-aware)', () => {
  /**
   * 图像已经是多来源(imageChannelRegistry 按 providerId 取执行通道),向量还没有
   * 对应的分流层:执行端是单例 EmbeddingService,只握着 XD Gateway 一个 baseUrl +
   * 一把 key。远端目录能给**任何** provider 加 embeddingModels,一旦放进白名单,
   * 用户会看到"可选"的型号、以为用的是自己填的 key,实际拿 XD 的凭证去计费
   * (PR #1707 review)。
   */
  const GEMINI: CindyMediaProviderSlice = {
    id: 'gemini',
    embeddingModels: [{ id: 'gemini-embedding-2-preview', name: 'Gemini Embedding 2' }],
    embeddingDefaults: { standard: 'gemini-embedding-2-preview' },
  };

  it('非 XD 供应商声明的向量清单不进白名单', () => {
    expect(deriveCindyMediaConfig([GEMINI], 'embed')).toEqual({ models: [], defaults: null });
  });

  it('非 XD 的向量默认段也不生效(不能顶掉 XD 的默认)', () => {
    const cfg = deriveCindyMediaConfig([GEMINI, XD], 'embed');
    expect(cfg.models.map((m) => m.id)).toEqual([
      'voyage/voyage-4',
      'voyage/voyage-4-large',
      'text-embedding-3-small',
    ]);
    expect(cfg.defaults?.standard).toBe('voyage/voyage-4');
  });

  it('图像 / 视频不受此限(它们本来就是多来源)', () => {
    const gemImage: CindyMediaProviderSlice = {
      id: 'gemini',
      imageModels: [{ id: 'gemini-own-image', name: 'Gemini 自有图像' }],
    };
    expect(deriveCindyMediaConfig([gemImage], 'image').models.map((m) => m.id)).toEqual([
      'gemini-own-image',
    ]);
  });
});

describe('deriveCindyMediaConfig — 客户端不认识的向量型号不进清单', () => {
  /**
   * 目录是热更的,可能给出比 EmbeddingModelId 这个静态联合更新的型号 id。不滤掉的话
   * 它会照常展示、可被钉选、甚至成为目录默认,而执行侧的纵深防御会把每一次请求变成
   * INTERNAL —— UI 先宣称可用、下单才失败(PR #1707 review)。
   *
   * 过滤复用的是 isModelDisabled 那个"别进清单"钩子,所以既有的降级语义照旧:
   * 被滤条目不占 first-wins,目录默认指向它时回落清单首项。
   */
  const KNOWN = new Set(['voyage/voyage-4', 'voyage/voyage-4-large', 'text-embedding-3-small']);
  const notKnown = (_p: string, modelId: string): boolean => !KNOWN.has(modelId);

  it('未知型号被滤掉,已知的照常在册', () => {
    const withFuture: CindyMediaProviderSlice = {
      ...XD,
      embeddingModels: [
        { id: 'voyage/voyage-99-future', name: '客户端还不认识的型号' },
        ...XD.embeddingModels!,
      ],
    };
    const cfg = deriveCindyMediaConfig([withFuture], 'embed', notKnown);
    expect(cfg.models.map((m) => m.id)).toEqual([
      'voyage/voyage-4',
      'voyage/voyage-4-large',
      'text-embedding-3-small',
    ]);
  });

  it('目录默认指向未知型号 → 回落清单首项,而不是钉一个必失败的默认', () => {
    const badDefault: CindyMediaProviderSlice = {
      ...XD,
      embeddingDefaults: { standard: 'voyage/voyage-99-future' },
    };
    const cfg = deriveCindyMediaConfig([badDefault], 'embed', notKnown);
    expect(cfg.defaults?.standard).toBe('voyage/voyage-4');
  });

  it('整份清单都不认识 → 空清单(能力不可用,而非逐单 INTERNAL)', () => {
    const allFuture: CindyMediaProviderSlice = {
      ...XD,
      embeddingModels: [{ id: 'voyage/voyage-99-future', name: '未来型号' }],
      embeddingDefaults: { standard: 'voyage/voyage-99-future' },
    };
    expect(deriveCindyMediaConfig([allFuture], 'embed', notKnown)).toEqual({
      models: [],
      defaults: null,
    });
  });
});
