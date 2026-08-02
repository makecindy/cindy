/**
 * cindyMediaCatalog.ts — cindy 槽媒体能力配置的纯派生(白名单 + 默认/档位选型)。
 * [PROTOCOL]: 变更时更新此头部,然后检查 CLAUDE.md
 *
 * 输入是 providers.json 运行时目录的供应商数组(与会话模型列表**同一获取来源**,
 * 见 maker-host/active-catalog 的 getActiveCatalog),输出图像 / 视频各自的可选清单
 * 与默认选型。本文件**零模型字面量**:清单与默认全部来自目录。
 *
 * 空清单语义(2026-07 定案):目录里没有该类目的任何模型 = 该能力**暂不可用**,
 * 返回 `{ models: [], defaults: null }`,不拿打包常量(GATEWAY_IMAGE_MODELS /
 * GATEWAY_VIDEO_MODELS)冒充可用清单——与聊天侧「无可用性证明不展示」同口径
 * (active-catalog 对动态清单供应商的静态段清零)。下游据此如实降级:
 * 详情页那几行显示灰字而不是下拉,cindySlot 早拒而不是拿不在册的型号下单。
 *
 * 纯逻辑、无 IO、无 electron 依赖(规则 14):单测直测,见 __tests__/cindyMediaCatalog.test.ts。
 */

/** 目录里与媒体能力相关的供应商字段(只取本模块用得到的那几个)。 */
export interface CindyMediaProviderSlice {
  /** 供应商 id —— 停用过滤(isModelDisabled)按 (供应商, 模型) 定位 override。 */
  id: string;
  imageModels?: { id: string; name: string }[];
  imageDefaults?: { standard: string; draft?: string; best?: string };
  videoModels?: { id: string; name: string }[];
  videoDefaults?: { standard: string; draft?: string; best?: string };
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
 * 从目录供应商数组派生某一类目(image / video)的 cindy 媒体能力配置。
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
  kind: 'image' | 'video',
  isModelDisabled?: (providerId: string, modelId: string) => boolean,
  isProviderReady?: (providerId: string) => boolean,
  isProviderEditReady?: (providerId: string) => boolean,
): CindyMediaCatalogConfig {
  const models: Array<{ id: string; label: string; providerId: string; supportsEdit: boolean }> = [];
  const seen = new Set<string>();
  let rawDefaults: { standard: string; draft?: string; best?: string } | undefined;
  for (const p of providers) {
    if (isProviderReady && !isProviderReady(p.id)) continue;
    const list = kind === 'image' ? p.imageModels : p.videoModels;
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
    const d = kind === 'image' ? p.imageDefaults : p.videoDefaults;
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
