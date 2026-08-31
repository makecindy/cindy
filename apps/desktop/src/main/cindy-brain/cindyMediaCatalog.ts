/**
 * cindyMediaCatalog.ts — cindy 槽能力配置的纯派生(白名单 + 默认/档位选型)。
 * [PROTOCOL]: 变更时更新此头部,然后检查 CLAUDE.md
 *
 * 输入是 active catalog 的供应商数组(与会话模型列表**同一获取来源**,
 * 见 maker-host/active-catalog 的 getActiveCatalog)。其中 XD 媒体由 Gateway `/models`
 * 动态投影，第三方媒体来自各 Provider 目录；本文件**零模型字面量**。
 *
 * 文件名留着 "Media" 是历史(2026-08-04 加入向量类目时未改名,避免一次纯改名
 * 的大 diff 冲掉 blame);三个类目共用同一套派生规则,差异只在读目录的哪个字段。
 *
 * 空清单语义(2026-07 定案):目录里没有该类目的任何模型 = 该能力**暂不可用**,
 * 返回 `{ models: [], defaults: null }`,不拿打包常量(GATEWAY_IMAGE_MODELS /
 * GATEWAY_VIDEO_MODELS)冒充可用清单——与聊天侧「无可用性证明不展示」同口径
 * (active-catalog 对动态清单供应商的静态段清零)。下游据此如实降级:
 * 详情页那几行显示灰字而不是下拉,cindySlot 早拒而不是拿不在册的型号下单。
 *
 * 纯逻辑、无 IO、无 electron 依赖(规则 14):单测直测,见 __tests__/cindyMediaCatalog.test.ts。
 */

/**
 * 本模块派生的能力类目。`embed` 与 image / video 共用同一套派生规则(白名单、
 * first-wins 去重、停用过滤、默认档位、空清单降级)—— 差异只在读目录的哪个字段。
 */
export type CindyCapabilityKind = 'image' | 'video' | 'embed';

export type CindyCoreMediaType = 'image' | 'video';

/**
 * Core 媒体目录只按媒体类型与 Core 可执行性筛选。旧视频 alias Registry 属于
 * `cindy-request` 执行器实现细节，不能参与这里的模型可见性判断。
 */
export function selectExecutableCoreMediaModels<T extends { mode?: string }>(
  models: readonly T[],
  type: CindyCoreMediaType,
  isExecutable: (model: T) => boolean = () => true,
): T[] {
  const mode = type === 'image' ? 'image_generation' : 'video_generation';
  return models.filter((model) => model.mode === mode && isExecutable(model));
}

/** 目录里与媒体能力相关的供应商字段(只取本模块用得到的那几个)。 */
export interface CindyMediaProviderSlice {
  /** 供应商 id —— 停用过滤(isModelDisabled)按 (供应商, 模型) 定位 override。 */
  id: string;
  imageModels?: { id: string; name: string }[];
  imageDefaults?: { standard: string; draft?: string; best?: string };
  videoModels?: { id: string; name: string }[];
  videoDefaults?: { standard: string; draft?: string; best?: string };
  embeddingModels?: { id: string; name: string }[];
  embeddingDefaults?: { standard: string; draft?: string; best?: string };
}

export interface CindyMediaCatalogConfig {
  /**
   * 可选清单 = 白名单 + 显示名(按目录出现序去重,first-wins)。
   * `providerId` = 该条目的归属来源(first-wins 定格)——图像多来源后派发端按它
   * 从 imageChannelRegistry 取执行通道,不再默认全部发 XD 网关(2026-07)。
   */
  models: Array<{
    id: string;
    label: string;
    providerId: string;
    /** 该来源是否支持图像编辑。仅对 image 类目有意义;video 类目始终为 true。 */
    supportsEdit: boolean;
  }>;
  /**
   * 默认 / 档位选型。null = 目录没有该类目的任何模型(能力暂不可用);
   * 非 null 时 standard / draft / best 三个值必定在 models 里。
   */
  defaults: { standard: string; draft: string; best: string } | null;
}

/**
 * 仅在旧 cindy-request 入口收窄候选；失效默认随清单一起恢复，交给既有偏好
 * 迁移逻辑持久化，不能只在执行时换型号而保留页面上的旧配置。
 */
export function filterLegacyCindyMediaConfig<T extends CindyMediaCatalogConfig['models'][number]>(
  config: { models: T[]; defaults: CindyMediaCatalogConfig['defaults'] },
  isExecutable: (model: T) => boolean,
): { models: T[]; defaults: CindyMediaCatalogConfig['defaults'] } {
  const models = config.models.filter(isExecutable);
  if (models.length === 0) return { models, defaults: null };
  const valid = (id: string | undefined) =>
    id !== undefined && models.some((model) => model.id === id) ? id : null;
  const standard = valid(config.defaults?.standard) ?? models[0]!.id;
  return {
    models,
    defaults: {
      standard,
      draft: valid(config.defaults?.draft) ?? standard,
      best: valid(config.defaults?.best) ?? standard,
    },
  };
}

/**
 * 向量派单唯一的执行来源。图像已经是多来源(imageChannelRegistry 按 providerId
 * 取通道),向量还没有对应的分流层,所以这里必须写死。
 * 加 provider-aware 路由时,把这个常量连同下面的 `kind === 'embed'` 守卫一起去掉。
 */
const EMBED_DISPATCH_PROVIDER_ID = 'xd';

/**
 * 从目录供应商数组派生某一类目(image / video / embed)的 cindy 能力配置。
 *
 * - 清单:按供应商出现序拼接、按 id 去重(first-wins),`label` 取目录 `name`。
 * - 停用过滤:`isModelDisabled(providerId, modelId)` 为 true 的条目不进清单
 *   (用户在 设置 → 模型供应商 停用的媒体模型;缺省 = 不过滤)。被停用条目
 *   **不占** first-wins 的 seen;目录默认值指向被停用型号时同样回落清单首项。
 * - 就绪过滤:`isProviderReady(providerId)` 为 false 的供应商**整段跳过**
 *   (含其 defaults 声明)——执行通道凭证未配置的来源(如 Gemini 没填 key)
 *   不能进白名单,否则清单长出"可选但必失败"的型号(2026-07 图像多来源)。
 *   缺省 = 全就绪。设置页展示不受此影响(那边走 buildRegistry,不经本函数)。
 * - 默认:取**首个声明了默认段**的供应商(今天只有 xd 一家;契约测试锁定
 *   非 xd 内置供应商不得声明 imageDefaults,防 BUILTIN 顺序把默认顶掉);
 *   目录写的默认值若不在册(型号已下架但默认没跟着改)→ 回落清单首项。
 * - 清单为空 → `defaults: null`(调用方必须先判空再用 defaults)。
 */
export function deriveCindyMediaConfig(
  providers: readonly CindyMediaProviderSlice[],
  kind: CindyCapabilityKind,
  isModelDisabled?: (providerId: string, modelId: string) => boolean,
  isProviderReady?: (providerId: string) => boolean,
  isProviderEditReady?: (providerId: string) => boolean,
): CindyMediaCatalogConfig {
  const models: Array<{ id: string; label: string; providerId: string; supportsEdit: boolean }> = [];
  const seen = new Set<string>();
  let rawDefaults: { standard: string; draft?: string; best?: string } | undefined;
  for (const p of providers) {
    if (isProviderReady && !isProviderReady(p.id)) continue;
    // 向量派单**还不是 provider-aware**:执行端是单例 EmbeddingService,只握着
    // XD Gateway 的一个 baseUrl + 一把 key,没有按 provider 分流的通道。所以只认
    // XD 声明的向量清单 —— 非 XD 供应商(远端目录可以给任何 provider 加这个字段)
    // 声明了也不能进白名单,否则会长出"界面可选、实际拿 XD 的凭证去计费"的型号,
    // 用户以为用的是自己填的 key(PR #1707 review)。
    // 向量在任何区域都只认 XD,因为它连 provider-aware 路由都还没有。
    // 地区政策由 Gateway 通过目录下发负责，客户端不按构建区域裁剪模型。
    if (kind === 'embed' && p.id !== EMBED_DISPATCH_PROVIDER_ID) continue;
    const list =
      kind === 'image' ? p.imageModels : kind === 'video' ? p.videoModels : p.embeddingModels;
    for (const m of list ?? []) {
      if (seen.has(m.id)) continue;
      if (isModelDisabled?.(p.id, m.id)) continue;
      seen.add(m.id);
      models.push({
        id: m.id,
        label: m.name,
        providerId: p.id,
        supportsEdit: isProviderEditReady ? isProviderEditReady(p.id) : true,
      });
    }
    // 多供应商时首个声明默认的生效(契约测试锁定只有 xd 声明)。
    const d =
      kind === 'image'
        ? p.imageDefaults
        : kind === 'video'
          ? p.videoDefaults
          : p.embeddingDefaults;
    if (!rawDefaults && d) rawDefaults = d;
  }
  if (models.length === 0) return { models, defaults: null };
  const valid = (id: string | undefined): string | null =>
    id !== undefined && seen.has(id) ? id : null;
  const standard = valid(rawDefaults?.standard) ?? models[0].id;
  return {
    models,
    defaults: {
      standard,
      draft: valid(rawDefaults?.draft) ?? standard,
      best: valid(rawDefaults?.best) ?? standard,
    },
  };
}
