import { localizedModelDescription } from './modelDescriptions';
import { isCindyAutoModelId, type CatalogModel } from '@cindy/model-providers';
import type { ProviderLogoKind } from '@cindy/model-providers/branding';
import type { TFunction } from 'i18next';
import { getCrossLocaleString } from '@/i18n/crossLocale';

export interface ModelBrand {
  key: string;
  label: string;
  logoKind?: ProviderLogoKind;
}

const brands: Record<string, ModelBrand> = {
  anthropic: { key: 'anthropic', label: 'Anthropic', logoKind: 'anthropic' },
  openai: { key: 'openai', label: 'OpenAI', logoKind: 'openai' },
  google: { key: 'google', label: 'Google', logoKind: 'google' },
  deepseek: { key: 'deepseek', label: 'DeepSeek', logoKind: 'deepseek' },
  qwen: { key: 'qwen', label: 'Qwen', logoKind: 'alibaba' },
  moonshot: { key: 'moonshot', label: 'Moonshot', logoKind: 'moonshot' },
  zai: { key: 'zai', label: 'Z.ai', logoKind: 'zai' },
  tencent: { key: 'tencent', label: 'Tencent', logoKind: 'tencentcloud' },
  meta: { key: 'meta', label: 'Meta' },
  xai: { key: 'xai', label: 'xAI', logoKind: 'xai' },
  minimax: { key: 'minimax', label: 'MiniMax', logoKind: 'minimax' },
  bytedance: { key: 'bytedance', label: 'ByteDance', logoKind: 'volcengine' },
  alibaba: { key: 'alibaba', label: 'Alibaba', logoKind: 'alibaba' },
  elevenlabs: { key: 'elevenlabs', label: 'ElevenLabs' },
  voyage: { key: 'voyage', label: 'Voyage' },
};

const namespaces: Record<string, string> = {
  'anthropic-claude': 'anthropic',
  chatgpt: 'openai',
  codex: 'openai',
  moonshotai: 'moonshot',
  'z-ai': 'zai',
  'x-ai': 'xai',
  'x-ai-grok': 'xai',
  'bytedance-seed': 'bytedance',
};

/** Display identity only. Never use these labels to merge IDs, select a route or infer capabilities. */
export function modelBrand(model: Pick<CatalogModel, 'id'>): ModelBrand | undefined {
  // Cindy Auto is a server route, not a vendor: `auto/<groupId>` must group like the preset `auto`.
  if (isCindyAutoModelId(model.id)) return undefined;
  const id = model.id.toLowerCase();
  const slash = id.indexOf('/');
  if (slash > 0) {
    const namespace = id.slice(0, slash);
    const key = Object.hasOwn(namespaces, namespace) ? namespaces[namespace]! : namespace;
    const known = Object.hasOwn(brands, key) ? brands[key] : undefined;
    return known ?? { key: `namespace:${namespace}`, label: model.id.slice(0, slash) };
  }
  const families: Array<[RegExp, string]> = [
    [/^claude-/, 'anthropic'],
    [/^(?:gpt-|o[134](?:-|$))/, 'openai'],
    [/^gemini-/, 'google'],
    [/^deepseek-/, 'deepseek'],
    [/^qwen(?:\d|[-/])/, 'qwen'],
    [/^glm-/, 'zai'],
    [/^kimi-/, 'moonshot'],
    [/^grok-/, 'xai'],
    [/^hy\d/, 'tencent'],
    [/^(?:seedream|seedance|doubao-)/, 'bytedance'],
  ];
  return brands[families.find(([pattern]) => pattern.test(id))?.[1] ?? ''];
}

// Official Chinese family names only. Keep every version/variant suffix and leave
// unknown names (including user labels) untouched. These strings never become wire IDs.
const familyNames: Array<[RegExp, string, string]> = [
  [/^Qwen(?=[\d\s-]|$)/i, 'qwen', 'Qwen'],
  [/^Doubao(?=[\s-]|$)/i, 'doubao', 'Doubao'],
  [/^(?:Hunyuan|Hy)(?=[\d\s-]|$)/i, 'hunyuan', 'Hunyuan'],
];

type TranslateWithDefault = (key: string, defaultValue: string) => string;

function localizeModelFamily(name: string, translate: TranslateWithDefault): string {
  for (const [pattern, key, canonical] of familyNames) {
    const prefix = pattern.exec(name)?.[0];
    if (!prefix) continue;
    const translated = translate(`modelNames.families.${key}`, prefix);
    if (translated === canonical || translated === prefix || translated.toLowerCase() === prefix.toLowerCase()) return name;
    const suffix = name.slice(prefix.length);
    return translated + (/^\d/.test(suffix) ? ' ' : '') + suffix;
  }
  return name;
}

export function localizedModelName(name: string, t: TFunction): string {
  return localizeModelFamily(name, (key, defaultValue) => t(key, { defaultValue }));
}

export function localizedBrandName(brand: ModelBrand, t: TFunction): string {
  if (!Object.hasOwn(brands, brand.key)) return brand.label;
  return t(`modelNames.manufacturers.${brand.key}`, { defaultValue: brand.label });
}

/** Both localized display labels and original provider names/IDs remain searchable. */
export function matchesModelName(
  model: { id: string; name?: string; displayName?: string; description?: string; group?: string; mode?: string },
  query: string,
  t: TFunction,
): boolean {
  const name = model.name ?? model.displayName ?? model.id;
  const brand = modelBrand(model);
  const haystack = [model.id, name, model.description, brand?.label,
    localizedModelName(name, t), localizedModelDescription(model, t),
    ...(['zh-CN', 'zh-TW', 'en'] as const).flatMap((lng) => {
      // 语言包按需加载：这几种语言的模型名取自跨语言常驻表，不要求它们已加载。
      const inLocale: TranslateWithDefault = (key, defaultValue) =>
        getCrossLocaleString(lng, key) ?? defaultValue;
      return [
        localizeModelFamily(name, inLocale),
        brand && Object.hasOwn(brands, brand.key)
          ? inLocale(`modelNames.manufacturers.${brand.key}`, brand.label) : '',
      ];
    }),
  ].join(' ').toLowerCase();
  const compact = haystack.replace(/\s+/g, '');
  return query.trim().toLowerCase().split(/\s+/).every((part) => compact.includes(part));
}
