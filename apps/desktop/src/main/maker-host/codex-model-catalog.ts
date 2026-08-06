import type { Catalog, CatalogModel } from '@cindy/model-providers';
import { isAgentSelectableModel } from '@cindy/model-providers';

/** Cindy-owned provenance lives beside Codex's vendor cache, never inside it. */
export const CODEX_CINDY_MODEL_CATALOG_STATE_FILE = 'cindy-model-catalog.json';

export interface CodexModelInfoLike {
  slug: string;
  display_name?: string;
  description?: string | null;
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number;
  input_modalities?: string[];
  [key: string]: unknown;
}

export interface ProjectedCodexModel {
  slug: string;
  display_name: string;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  visibility: 'list' | 'hide';
  supported_in_api: true;
  priority: number;
  additional_speed_tiers: string[];
  service_tiers: Array<{ id: string; name: string; description: string }>;
  default_service_tier: string | null;
  supports_parallel_tool_calls: boolean;
  context_window: number;
  max_context_window: number;
  effective_context_window_percent: 95;
  /**
   * Absent = Cindy has no modality evidence for this slug (never resolved, or the
   * vendor/knowledge base never reported one). Absent must not be flattened to
   * text-only: for a native slug that would strip Codex's own image support.
   */
  input_modalities?: Array<'text' | 'image'>;
}

export interface CodexModelsResponse {
  models: CodexModelInfoLike[];
}

export interface CodexModelsCache extends CodexModelsResponse {
  fetched_at: string;
  etag: string;
  client_version: string;
  cindy_injected_slugs?: string[];
}

export interface CodexModelCatalogState {
  revision: number;
  injectedSlugs: string[];
  /**
   * Target provenance for a two-file publish that has not been finalized yet. While present,
   * injectedSlugs is the protective union of the old and target sets.
   */
  pendingInjectedSlugs?: string[];
}

interface ProjectedModel {
  model: CatalogModel;
  contextWindow: number;
}

function effortDescription(effort: string): string {
  switch (effort) {
    case 'low': return 'Fast responses with lighter reasoning';
    case 'medium': return 'Balances speed and reasoning depth';
    case 'high': return 'Greater reasoning depth for complex problems';
    case 'xhigh': return 'Extra high reasoning depth for complex problems';
    case 'max': return 'Maximum reasoning depth for the hardest problems';
    case 'ultra': return 'Maximum reasoning with automatic task delegation';
    default: return effort;
  }
}

/**
 * Codex 0.145.0 keeps one global ModelInfo per slug, while Cindy routes models by
 * (provider, model). Duplicate slugs therefore use the smallest verified window:
 * overstating the context limit is more harmful than compacting early.
 */
export function projectVerifiedCodexModels(catalog: Catalog): ProjectedCodexModel[] {
  const bySlug = new Map<string, ProjectedModel>();

  for (const provider of catalog.providers) {
    if (provider.routing.codex?.disabled === true) continue;
    for (const model of provider.models.codex ?? []) {
      if (!isAgentSelectableModel(model, { userProvider: provider.source === 'user' })) continue;
      if (model.contextWindowVerified !== true || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
        continue;
      }
      const previous = bySlug.get(model.id);
      if (!previous || model.contextWindow < previous.contextWindow) {
        bySlug.set(model.id, { model, contextWindow: model.contextWindow });
      }
    }
  }

  return [...bySlug.values()]
    .sort((a, b) =>
      (a.model.sortOrder ?? Number.MAX_SAFE_INTEGER) -
        (b.model.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.model.id.localeCompare(b.model.id),
    )
    .map(({ model, contextWindow }, index): ProjectedCodexModel => {
      // 只有目录**确实登记过**输入模态时才投影它:缺失(从未 resolve / 上游与知识库
      // 都没报)一律不投,交给下游保留原生值 —— 否则同 slug 的原生模型会被这条
      // 「猜出来的 text-only」把 Codex 自己的图片能力抹掉。
      const declaredInput = model.modalities?.input;
      const inputModalities: Array<'text' | 'image'> | undefined = declaredInput?.length
        ? (declaredInput.includes('image') ? ['text', 'image'] : ['text'])
        : undefined;
      const supportsReasoning = model.capabilities?.reasoning ?? model.efforts.length > 0;
      const defaultReasoningLevel = supportsReasoning ? model.defaultEffort : null;
      return {
        slug: model.id,
        display_name: model.name,
        description: model.description ?? null,
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: supportsReasoning
          ? model.efforts.map((effort) => ({ effort, description: effortDescription(effort) }))
          : [],
        visibility: model.defaultEnabled === false ? 'hide' : 'list',
        supported_in_api: true,
        priority: model.sortOrder ?? 1_000 + index,
        additional_speed_tiers: model.supportsFastMode ? ['fast'] : [],
        service_tiers: model.supportsFastMode
          ? [{ id: 'priority', name: 'Fast', description: 'Faster responses when supported' }]
          : [],
        default_service_tier: model.supportsFastMode ? 'priority' : null,
        supports_parallel_tool_calls: model.capabilities?.toolCall === true,
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 95,
        ...(inputModalities ? { input_modalities: inputModalities } : {}),
      };
    });
}

/**
 * Preserve Codex's provider-owned prompts and tool policy. A Cindy-only slug is
 * cloned from a native descriptor and then narrowed to Cindy's verified facts;
 * without a native template we skip additions rather than invent a system prompt.
 */
export function mergeCodexModelCatalog(
  upstream: readonly CodexModelInfoLike[],
  projected: readonly ProjectedCodexModel[],
): CodexModelsResponse {
  const merged = upstream.map((model) => ({ ...model }));
  const indexBySlug = new Map(merged.map((model, index) => [model.slug, index]));
  const template = merged.find((model) =>
    model.supported_in_api === true
    && typeof model.base_instructions === 'string'
    && model.model_messages == null,
  ) ?? merged.find((model) =>
    model.supported_in_api === true && typeof model.base_instructions === 'string',
  );

  for (const model of projected) {
    const existingIndex = indexBySlug.get(model.slug);
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];
      merged[existingIndex] = {
        ...existing,
        context_window: model.context_window,
        max_context_window: model.max_context_window,
        effective_context_window_percent: model.effective_context_window_percent,
        // 目录没登记模态就保留原生值:窗口是 Cindy 已核实的事实(可以覆盖),模态不是。
        ...(model.input_modalities ? { input_modalities: model.input_modalities } : {}),
      };
      continue;
    }
    if (!template) continue;
    indexBySlug.set(model.slug, merged.length);
    merged.push({
      ...model,
      // Cindy-only slug:模态既不能继承模板(那是另一个模型的能力),也不能缺键
      // (Codex 的 ModelInfo 要求该字段存在)。目录没登记时保守到纯文本 —— 对未知的
      // 第三方模型谎报 image 会让 Codex 附上上游根本不收的图。
      input_modalities: model.input_modalities ?? ['text'],
      // The only prompt field that Codex requires is inherited from a native
      // descriptor. Every other model-specific policy is reset to the same
      // conservative shape as Codex's own unknown-model fallback.
      shell_type: 'default',
      availability_nux: null,
      upgrade: null,
      base_instructions: template.base_instructions,
      model_messages: null,
      include_skills_usage_instructions: false,
      supports_reasoning_summary_parameter: true,
      default_reasoning_summary: 'auto',
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: 'text',
      truncation_policy: { mode: 'bytes', limit: 10_000 },
      supports_image_detail_original: false,
      auto_compact_token_limit: null,
      comp_hash: null,
      experimental_supported_tools: [],
      supports_search_tool: false,
      use_responses_lite: false,
      auto_review_model_override: null,
      tool_mode: null,
      multi_agent_version: null,
    });
  }
  return { models: merged };
}

export function mergeCodexModelsCache(
  catalog: Catalog,
  currentCache: CodexModelsCache,
  revision: number,
  now: Date = new Date(),
): CodexModelsCache {
  const previousInjected = new Set(currentCache.cindy_injected_slugs ?? []);
  const nativeModels = currentCache.models.filter((model) => !previousInjected.has(model.slug));
  const projected = projectVerifiedCodexModels(catalog);
  const nativeSlugs = new Set(nativeModels.map((model) => model.slug));
  return {
    fetched_at: now.toISOString(),
    etag: `"cindy-catalog-${revision}"`,
    client_version: currentCache.client_version,
    models: mergeCodexModelCatalog(nativeModels, projected).models,
    cindy_injected_slugs: projected
      .map((model) => model.slug)
      .filter((slug) => !nativeSlugs.has(slug)),
  };
}

export function parseCodexModelsResponse(value: unknown): CodexModelInfoLike[] | null {
  if (!value || typeof value !== 'object') return null;
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  const parsed: CodexModelInfoLike[] = [];
  for (const model of models) {
    if (!model || typeof model !== 'object') return null;
    const slug = (model as { slug?: unknown }).slug;
    if (typeof slug !== 'string' || slug.length === 0) return null;
    parsed.push({ ...(model as Record<string, unknown>), slug });
  }
  return parsed;
}

export function parseCodexModelCatalogState(value: unknown): CodexModelCatalogState | null {
  if (!value || typeof value !== 'object') return null;
  const revision = (value as { revision?: unknown }).revision;
  const injectedSlugs = (value as { injectedSlugs?: unknown }).injectedSlugs;
  const pendingInjectedSlugs = (value as { pendingInjectedSlugs?: unknown }).pendingInjectedSlugs;
  if (!Number.isInteger(revision) || (revision as number) < 0 || !Array.isArray(injectedSlugs)) {
    return null;
  }
  if (pendingInjectedSlugs !== undefined && !Array.isArray(pendingInjectedSlugs)) return null;
  const normalized = injectedSlugs.filter(
    (slug): slug is string => typeof slug === 'string' && slug.length > 0,
  );
  if (normalized.length !== injectedSlugs.length) return null;
  const pending = pendingInjectedSlugs?.filter(
    (slug): slug is string => typeof slug === 'string' && slug.length > 0,
  );
  if (pending && pending.length !== pendingInjectedSlugs?.length) return null;
  return {
    revision: revision as number,
    injectedSlugs: [...new Set(normalized)],
    ...(pending ? { pendingInjectedSlugs: [...new Set(pending)] } : {}),
  };
}

export function nativeCodexModelsFromCache(
  cache: Pick<CodexModelsCache, 'models' | 'cindy_injected_slugs'>,
  state?: CodexModelCatalogState | null,
): CodexModelInfoLike[] {
  const injected = new Set([
    ...(cache.cindy_injected_slugs ?? []),
    ...(state?.injectedSlugs ?? []),
  ]);
  return cache.models
    .filter((model) => !injected.has(model.slug))
    .map((model) => ({ ...model }));
}

/**
 * `model/list` is also the OpenAI discovery channel. Drop Cindy-only slugs from
 * that callback so xAI/XD/custom models cannot be fed back into the OpenAI
 * provider. A slug explicitly owned by OpenAI remains discoverable even when a
 * second Provider exposes the same id.
 */
export function isCodexNativeDiscoverySlug(catalog: Catalog, slug: string): boolean {
  const openAi = catalog.providers.find((provider) => provider.id === 'openai');
  if (openAi?.models.codex?.some((model) => model.id === slug)) return true;
  return !catalog.providers.some((provider) =>
    provider.id !== 'openai'
    && provider.routing.codex?.disabled !== true
    && provider.models.codex?.some((model) =>
      model.id === slug
      && isAgentSelectableModel(model, { userProvider: provider.source === 'user' }),
    ),
  );
}
