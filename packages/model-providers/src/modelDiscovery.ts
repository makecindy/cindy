import {
  pickModelMetadata,
  type DiscoveredModel,
} from "./modelMetadataLayers.js";

/** OpenRouter exposes one unpaginated catalog; Anthropic headers select a rewritten CLI view. */
export function isOpenRouterModelsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://openrouter.ai' && url.pathname.replace(/\/+$/, '') === '/api/v1/models';
  } catch { return false; }
}

/**
 * 解析 OpenAI / Anthropic「列模型」响应的三种形状（`{data:[{id}]}` / `{models:[{id|slug}]}` /
 * 字符串数组）为去重后的 `{id, name, contextWindow?}[]`；无法识别返回 null。显示名优先取
 * 条目的 `display_name`（Anthropic 形状）/ `name` 字段，缺省回退 id。
 * contextWindow 尽力从常见字段读取（OpenRouter `context_length` / 通用 `context_window` /
 * Moonshot 等 `max_context_length` / Anthropic 兼容端点 `max_input_tokens`,与
 * model-discovery/anthropic.ts 认的字段对齐），无或非法时缺省——缺省的模型仍会
 * 回落保守默认(#386)。
 * 纯函数——OAuth 自动发现（本模块）与 API key 表单「获取模型列表」（provider-model-fetch）共用。
 */
export function parseModelsListResponse(
  json: unknown,
  sourceUrl?: string,
): DiscoveredModel[] | null {
  const list = (() => {
    if (Array.isArray(json)) return json;
    if (!json || typeof json !== "object") return null;
    const o = json as { data?: unknown; models?: unknown };
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.models)) return o.models;
    return null;
  })();
  if (!list) return null;
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : typeof (item as { slug?: unknown }).slug === "string"
              ? (item as { slug: string }).slug
              : typeof (item as { key?: unknown }).key === 'string'
                ? (item as { key: string }).key
                : typeof (item as { model_name?: unknown }).model_name === 'string'
                  ? (item as { model_name: string }).model_name
                  : null
          : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rec =
      item && typeof item === "object"
        ? (item as {
            display_name?: unknown;
            name?: unknown;
            context_length?: unknown;
            context_window?: unknown;
            max_context_length?: unknown;
            max_input_tokens?: unknown;
          })
        : null;
    const name =
      rec && typeof rec.display_name === "string" && rec.display_name.length > 0
        ? rec.display_name
        : rec && typeof rec.name === "string" && rec.name.length > 0
          ? rec.name
          : id;
    const rawWindow = rec
      ? [
          rec.context_length,
          rec.context_window,
          rec.max_context_length,
          rec.max_input_tokens,
        ].find(
          // Math.floor(v) > 0 而非 v > 0:0 < v < 1(如 context_length: 0.5)会通过
          // v > 0 但取整成 contextWindow: 0——按取整后的值校验才不会漏这个区间
          // (review P2)。Number.isSafeInteger(Math.floor(v)) 拒绝超出安全整数范围的
          // 异常值(如 context_length: 1e20)——这类值会通过取整后为正的校验,但落盘后
          // Main 的正数校验反而会因为超界而拒绝整份供应商配置,内置 OAuth 发现分支则会
          // 把这个失真值当真实窗口注入目录(review P2)。
          (v) =>
            typeof v === "number" &&
            Number.isFinite(v) &&
            Math.floor(v) > 0 &&
            Number.isSafeInteger(Math.floor(v)),
        )
      : undefined;
    const record =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const info = record.model_info && typeof record.model_info === 'object'
      ? record.model_info as Record<string, unknown> : {};
    const capabilities = record.capabilities && typeof record.capabilities === 'object'
      ? record.capabilities as Record<string, unknown> : {};
    const architecture = record.architecture as
      { input_modalities?: unknown; output_modalities?: unknown } | undefined;
    const reasoning = record.reasoning as
      | {
          supportedEfforts?: unknown;
          defaultEffort?: unknown;
          supported_efforts?: unknown;
          default_effort?: unknown;
          required?: unknown;
          mandatory?: unknown;
        }
      | undefined;
    const rawDefault =
      reasoning?.defaultEffort !== undefined
        ? reasoning.defaultEffort
        : reasoning?.default_effort !== undefined
          ? reasoning.default_effort
          : record.default_effort;
    const modalities = record.modalities ??
      (Array.isArray(architecture?.input_modalities) && Array.isArray(architecture?.output_modalities)
        ? { input: architecture.input_modalities, output: architecture.output_modalities } : undefined);
    const inputModalities = (modalities as { input?: unknown } | undefined)?.input;
    const isVercel = sourceUrl !== undefined && (() => {
      try { const url = new URL(sourceUrl); return url.origin === 'https://ai-gateway.vercel.sh'
        && url.pathname.replace(/\/+$/, '') === '/v1/models'; } catch { return false; }
    })();
    const discoveredMetadata = pickModelMetadata({
      ...([rec?.display_name, rec?.name].some(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
        ? { name }
        : {}),
      mode: record.mode ?? info.mode ?? (isVercel && record.type === 'language' ? 'chat' : isVercel ? record.type : undefined),
      modalities,
      officialDocs: record.officialDocs,
      description: record.description,
      group: record.group,
      contextWindow:
        typeof rawWindow === "number" ? Math.floor(rawWindow) : info.max_input_tokens,
      maxOutputTokens:
        record.max_output_tokens ?? info.max_output_tokens ??
        record.maxOutputTokens ??
        (isVercel ? record.max_tokens : undefined) ??
        (record.top_provider as Record<string, unknown> | undefined)
          ?.max_completion_tokens,
      efforts:
        reasoning?.supportedEfforts ??
        (Array.isArray(reasoning?.supported_efforts)
          ? reasoning.supported_efforts.filter((value) => value !== "none")
          : undefined) ??
        record.supported_efforts ??
        (isVercel && Array.isArray(record.reasoning_options)
          ? record.reasoning_options.find((option: unknown) =>
              option && typeof option === 'object' && (option as { type?: unknown }).type === 'effort')?.values
          : undefined) ??
        (record.reasoning === false || info.supports_reasoning === false ||
          (Array.isArray(record.supported_parameters) && !record.supported_parameters.some(value =>
            typeof value === 'string' && ['reasoning', 'reasoning_effort', 'reasoning_budget', 'thinking'].includes(value)))
          ? [] : undefined),
      supportsToolCalls: Array.isArray(record.supported_parameters)
        ? record.supported_parameters.includes("tools")
        : info.supports_function_calling ?? capabilities.trained_for_tool_use,
      reasoningRequired: reasoning?.required ?? reasoning?.mandatory,
      defaultEffort: rawDefault === "none" ? null : rawDefault,
      supportsFastMode: record.supports_fast_mode ?? record.supportsServiceTier,
      supportsImageInput:
        record.supports_image_input ?? info.supports_vision ?? capabilities.vision ??
        (Array.isArray(inputModalities)
          ? inputModalities.includes("image")
          : undefined),
    });
    // OpenRouter and Vercel document USD per token. Never apply these units to arbitrary proxies.
    const prices =
      sourceUrl && (isOpenRouterModelsUrl(sourceUrl) || (isVercel && record.type === 'language'))
        ? (record.pricing as Record<string, unknown> | undefined)
        : undefined;
    const discoveredCost = Object.fromEntries(
      (isVercel ? [
        ['input', 'input'], ['output', 'output'],
        ['input_cache_read', 'cacheRead'], ['input_cache_write', 'cacheWrite'],
      ] : [
        ["prompt", "input"],
        ["completion", "output"],
        ["input_cache_read", "cacheRead"],
        ["input_cache_write", "cacheWrite"],
      ]).flatMap(([source, target]) => {
        const raw = prices?.[source!];
        if (
          (typeof raw !== "string" || raw.trim() === "") &&
          typeof raw !== "number"
        )
          return [];
        const amount = Number(raw) * 1_000_000;
        return Number.isFinite(amount) && amount >= 0 ? [[target, amount]] : [];
      }),
    );
    out.push({
      id,
      discoveredMetadata,
      ...(Object.keys(discoveredCost).length ? { discoveredCost } : {}),
      name,
      ...(typeof rawWindow === "number"
        ? { contextWindow: Math.floor(rawWindow) }
        : {}),
    });
  }
  return out;
}
