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
  imageModels?: { id: string; name: string }[];
  imageDefaults?: { standard: string; draft?: string; best?: string };
  videoModels?: { id: string; name: string }[];
  videoDefaults?: { standard: string; draft?: string; best?: string };
}

export interface CindyMediaCatalogConfig {
  /** 可选清单 = 白名单 + 显示名(按目录出现序去重,first-wins)。 */
  models: Array<{ id: string; label: string }>;
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
 * - 默认:取**首个声明了默认段**的供应商(今天只有 xd 一家);目录写的默认值
 *   若不在册(型号已下架但默认没跟着改)→ 回落清单首项,不让能力卡死。
 * - 清单为空 → `defaults: null`(调用方必须先判空再用 defaults)。
 */
export function deriveCindyMediaConfig(
  providers: readonly CindyMediaProviderSlice[],
  kind: 'image' | 'video',
): CindyMediaCatalogConfig {
  const models: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  let rawDefaults: { standard: string; draft?: string; best?: string } | undefined;
  for (const p of providers) {
    const list = kind === 'image' ? p.imageModels : p.videoModels;
    for (const m of list ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push({ id: m.id, label: m.name });
    }
    // 多供应商时首个声明默认的生效(今天只有 xd 一家)。
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
