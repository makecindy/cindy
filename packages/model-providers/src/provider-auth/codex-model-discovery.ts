import { pickModelMetadata } from "../modelMetadataLayers.js";
import { defaultEffortForCapabilities } from "../effortResolution.js";
import type { CatalogModel } from "../types.js";

interface CodexModelRaw {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  input_modalities?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  priority?: unknown;
  /** [{id:'priority', name:'Fast', ...}] —— 含 priority 即支持 Fast(bridge 映射 service_tier)。 */
  service_tiers?: unknown;
  additional_speed_tiers?: unknown;
}

/**
 * Codex runtime 可透传的推理档位(issue #352 起含 max/ultra)。
 * 这是「客户端能透传哪些档」的白名单,不是「某模型支持哪些档」——后者由每个模型
 * 自报的 supported_reasoning_levels 决定,过滤后只保留该模型真正声明的子集。
 */
export const CODEX_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/** Cindy 内部路由专用的 Codex 模型 ID，不应出现在任何用户可见模型目录。 */
const INTERNAL_CODEX_MODEL_IDS: ReadonlySet<string> = new Set([
  "codex-auto-review",
]);

export function isInternalCodexModelId(id: string): boolean {
  return INTERNAL_CODEX_MODEL_IDS.has(id);
}

export function positiveTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * codex models_cache 原始 JSON → 规范化的 Codex CatalogModel[]。纯函数。
 *
 * 只收 visibility:'list' && supported_in_api:true 且不在内部 ID 集合的模型；缺 slug 则跳过。
 * sortOrder 直接取 codex 的 priority(官方 picker 顺序);active-catalog 以它作为账号顺序
 * 重排 root,不再映射到 Registry 的排序锚点。
 */
export function mapCodexModelsToCatalog(raw: unknown): CatalogModel[] {
  const models =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { models?: unknown }).models)
      ? ((raw as { models: unknown[] }).models as CodexModelRaw[])
      : [];
  const out: CatalogModel[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    if (m.visibility !== "list" || m.supported_in_api !== true) continue;
    const slug = str(m.slug);
    if (!slug || isInternalCodexModelId(slug)) continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((e) =>
            e && typeof e === "object"
              ? str((e as { effort?: unknown }).effort)
              : null,
          )
          .filter((e): e is string => e != null && CODEX_EFFORTS.has(e))
      : [];
    const displayName = str(m.display_name) ?? slug;
    // cache 明示了才算真实上限;缺字段时补的 272k 只够展示(见下方 app-server mapper 注释)。
    const contextWindowVerified = positiveTokens(m.context_window);
    const contextWindow = contextWindowVerified
      ? (m.context_window as number)
      : Math.min(
          272_000,
          positiveTokens(m.max_context_window) ? m.max_context_window : 272_000,
        );
    // Native maximum and working default are separate facts. Never manufacture a
    // maximum from the working window when the upstream omitted it.
    const contextWindowMax =
      positiveTokens(m.max_context_window) &&
      (!contextWindowVerified || m.max_context_window >= contextWindow)
        ? m.max_context_window
        : undefined;
    const requestedDefault = str(m.default_reasoning_level);
    const defaultEffort =
      requestedDefault && efforts.includes(requestedDefault)
        ? (requestedDefault as CatalogModel["defaultEffort"])
        : defaultEffortForCapabilities(efforts as CatalogModel["efforts"]);
    const inputModalities =
      Array.isArray(m.input_modalities) &&
      m.input_modalities.every((value) => typeof value === "string")
        ? (m.input_modalities as string[])
        : undefined;
    const priority =
      typeof m.priority === "number" && Number.isFinite(m.priority)
        ? m.priority
        : 50;
    const speedTiers = [
      ...(Array.isArray(m.service_tiers)
        ? m.service_tiers.map((tier) => tier?.id)
        : []),
      ...(Array.isArray(m.additional_speed_tiers)
        ? m.additional_speed_tiers
        : []),
    ];
    const supportsFastMode =
      Array.isArray(m.service_tiers) || Array.isArray(m.additional_speed_tiers)
        ? speedTiers.some((tier) => tier === "priority" || tier === "fast")
        : undefined;

    const model: CatalogModel = {
      id: slug,
      discoveredMetadata: pickModelMetadata({
        name: str(m.display_name),
        description: str(m.description),
        contextWindow: m.context_window,
        supportsImageInput:
          inputModalities !== undefined
            ? inputModalities.includes("image")
            : undefined,
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? efforts
          : undefined,
        defaultEffort: m.default_reasoning_level,
        supportsFastMode,
      }),
      name: displayName,
      group: "gpt",
      sortOrder: priority,
      description: str(m.description) ?? undefined,
      contextWindow,
      ...(contextWindowMax !== undefined ? { contextWindowMax } : {}),
      ...(inputModalities !== undefined
        ? { supportsImageInput: inputModalities.includes("image") }
        : {}),
      ...(contextWindowVerified ? { contextWindowVerified: true } : {}),
      efforts: efforts as CatalogModel["efforts"],
      defaultEffort,
      status: "active",
      // 新发现的模型默认可见；哪些不默认显示只由模型目录的 defaultEnabled 决定。
      defaultEnabled: true,
    };
    if (efforts.includes("xhigh"))
      model.effortDisplayNames = { xhigh: "Extra High" };
    if (supportsFastMode !== undefined)
      model.supportsFastMode = supportsFastMode;
    model.supportsUltrafastMode = speedTiers.includes("ultrafast");
    out.push(model);
  }
  return out;
}
