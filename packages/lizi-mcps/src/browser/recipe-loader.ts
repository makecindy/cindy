/// <reference path="../vite-env.d.ts" />

/**
 * Site Recipe + SiteGuide registry.
 *
 * A *recipe* is a declarative, per-site flow (navigate → type → click → wait →
 * extract) the agent can run with one call instead of blind full-page probing.
 * A *siteguide* is compact per-site knowledge (entry URLs, key pages, available
 * recipe ids) the agent can pull on demand.
 *
 * Both are bundled as JSON data via Vite `import.meta.glob('?raw')`. Parsing is
 * split into a PURE `parseRecipes()` / `parseSiteGuides()` (zod-validated, unit
 * testable with hand-written entries) and a thin `loadRecipes()` / `loadSiteGuides()`
 * that only does the glob then delegates to the pure parser.
 *
 * Recipe steps reuse the existing browser action vocabulary; interactive steps
 * (`click`/`type`/`select`) carry a stable CSS `selector` that the vendored
 * `act` resolves directly — no hardcoded snapshot refs, so recipes survive
 * across sessions.
 */
import { z } from 'zod';
import upstreamCatalog from '@jackwener/opencli/catalog';

import { ExtractSpecSchema } from './extract.js';

/** Cheap page identity check, evaluated before a step (no model call). */
const RecipeGuardSchema = z.object({
  url: z.string().min(1),
  selector: z.string().optional(),
  text: z.string().optional(),
});
const RecipeExpectationSchema = z.object({
  minCount: z.number().int().positive().optional(),
  requiredFields: z.array(z.string().min(1)).optional(),
  equals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).refine((v) => v.minCount !== undefined || Boolean(v.requiredFields?.length) || Boolean(Object.keys(v.equals ?? {}).length), 'expect must contain a result check');

/** A single declarative step. `action` maps to a browser primitive (see runner). */
export const RecipeStepSchema = z.object({
  action: z.enum([
    'navigate',
    'click',
    'type',
    'select',
    'wait',
    'extract',
    'evaluate',
    'requests',
    'responseBody',
  ]),
  url: z.string().optional(),
  selector: z.string().optional(),
  /** action=evaluate: a function-expression source run in page context via the
   *  existing `act:evaluate` primitive (its return value lands at
   *  `result.data.result`, store it with `as`). Async fns are awaited. The key
   *  use is a same-origin, cookie-carrying `fetch` on login/anti-bot sites: the
   *  page is already on the target domain, so `fetch(path, {credentials:'include'})`
   *  sends the logged-in session cookies — unlike a blind navigate to a JSON URL,
   *  which anti-bot serves SPA HTML. `{{vars}}` are interpolated into the source. */
  fn: z.string().optional(),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  submit: z.boolean().optional(),
  loadState: z.string().optional(),
  textGone: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  filter: z.string().optional(),
  maxChars: z.number().int().positive().optional(),
  extract: ExtractSpecSchema.optional(),
  /** Store this step's result `data` under `vars[as]` for later `{{as}}` / output use. */
  as: z.string().optional(),
  /** If true, a failed step is logged but does not abort the recipe. */
  optional: z.boolean().optional(),
  guard: RecipeGuardSchema.optional(),
  expect: RecipeExpectationSchema.optional(),
}).refine((s) => !s.expect || s.action === 'extract' || s.action === 'evaluate', 'expect is only supported for extract/evaluate')
  .refine((s) => !s.optional || (!s.guard && !s.expect), 'validation steps cannot be optional');

export const RecipeSchema = z.object({
  id: z.string().min(1),
  /** Host substrings this recipe applies to (advisory, surfaced via siteguide). */
  match: z.array(z.string()).optional(),
  description: z.string().optional(),
  inputs: z.record(z.string(), z.object({ required: z.boolean().optional(), type: z.string().optional(), default: z.unknown().optional(), description: z.string().optional(), choices: z.array(z.string()).optional() })).optional(),
  /** A fixed bundled command id, never an arbitrary module path. */
  adapter: z.string().optional(),
  adapterInputMap: z.record(z.string(), z.string()).optional(),
  access: z.enum(['read', 'write']).optional(),
  steps: z.array(RecipeStepSchema).default([]),
  /** Output template, e.g. "{{results}}". A bare single-var ref returns that var verbatim. */
  output: z.string().optional(),
  /** Host-owned state; authored drafts cannot supply this. Legacy files remain runnable. */
  validation: z.object({
    site: z.string(),
    state: z.enum(['candidate', 'active', 'suspended']),
    /** Newly learned recipes stay in their browser profile; legacy files omit it. */
    profile: z.string().optional(),
  }).optional(),
}).refine(recipe => recipe.adapter ? recipe.steps.length === 0 : recipe.steps.length > 0, 'recipe requires steps or a bundled adapter, exclusively');

export type Recipe = z.infer<typeof RecipeSchema>;
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

/** Deferred candidates can only compose known read primitives, never authored
 * page code or interactive steps. This is a capability check, not a promise
 * about a remote site's GET side effects; normal recipe approval still applies. */
export function deferredRecipeIssue(recipe: Recipe): string | undefined {
  if (recipe.access !== 'read') return '延后验证仅支持声明为 read 的新流程';
  if (recipe.adapter || recipe.steps.some(step => step.fn !== undefined
    || !['navigate', 'wait', 'extract', 'requests', 'responseBody'].includes(step.action))) {
    return '延后验证仅支持 navigate、无 fn 的 wait、extract、requests、responseBody；交互、evaluate 或脚本步骤必须在当次真实操作中验证后再保存，不能为测试重放写操作';
  }
  return undefined;
}

/** SiteGuide is loose, agent-facing knowledge; we validate only the shape we rely on. */
export const SiteGuideSchema = z
  .object({
    site: z.string(),
    auth: z.string().optional(),
    entry: z.record(z.string(), z.string()).optional(),
    pages: z.array(z.unknown()).optional(),
    recipes: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .passthrough();

export type SiteGuide = z.infer<typeof SiteGuideSchema>;

/** PURE: validate raw `{ path → json string }` entries into an id→Recipe map. */
export function parseRecipes(rawEntries: Record<string, string>): Map<string, Recipe> {
  const map = new Map<string, Recipe>();
  for (const [path, raw] of Object.entries(rawEntries)) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`recipe ${path}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = RecipeSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`recipe ${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    if (map.has(parsed.data.id)) {
      throw new Error(`duplicate recipe id "${parsed.data.id}" (${path})`);
    }
    map.set(parsed.data.id, parsed.data);
  }
  return map;
}

/** PURE: validate raw entries into a site→SiteGuide map. */
export function parseSiteGuides(rawEntries: Record<string, string>): Map<string, SiteGuide> {
  const map = new Map<string, SiteGuide>();
  for (const [path, raw] of Object.entries(rawEntries)) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`siteguide ${path}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = SiteGuideSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`siteguide ${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    map.set(parsed.data.site, parsed.data);
  }
  return map;
}

/**
 * Where a merged entry came from:
 *  - 'builtin'    — only in the bundled L1 catalog (ships with the app).
 *  - 'user'       — only in the user's L2 layer (a new site they authored).
 *  - 'overridden' — exists in both; the user's L2 version shadows L1.
 * "Restore default" = delete the user's L2 file → the entry falls back to L1.
 */
export type Provenance = 'builtin' | 'user' | 'overridden';
export interface MergedRecipe {
  recipe: Recipe;
  provenance: Provenance;
}
export interface MergedSiteGuide {
  guide: SiteGuide;
  provenance: Provenance;
}

/**
 * PURE: merge bundled (L1) + user (L2) recipes by `id`. A user recipe with the
 * same id as a builtin one REPLACES it wholesale (a recipe is one indivisible
 * execution unit — never a field-level merge). rule 20: uncustomized sites keep
 * tracking the shipped L1; customized ones keep the user's version.
 */
export function mergeRecipes(
  builtin: Map<string, Recipe>,
  user: Map<string, Recipe>,
): Map<string, MergedRecipe> {
  const out = new Map<string, MergedRecipe>();
  for (const [id, recipe] of builtin) out.set(id, { recipe, provenance: 'builtin' });
  for (const [id, recipe] of user) {
    out.set(id, { recipe, provenance: out.has(id) ? 'overridden' : 'user' });
  }
  return out;
}

/** PURE: merge bundled (L1) + user (L2) site guides by `site` (same semantics). */
export function mergeSiteGuides(
  builtin: Map<string, SiteGuide>,
  user: Map<string, SiteGuide>,
): Map<string, MergedSiteGuide> {
  const out = new Map<string, MergedSiteGuide>();
  for (const [site, guide] of builtin) out.set(site, { guide, provenance: 'builtin' });
  for (const [site, guide] of user) {
    out.set(site, { guide, provenance: out.has(site) ? 'overridden' : 'user' });
  }
  return out;
}

/** Glob recipe JSON bundled at build time (Vite), then parse. */
export function loadRecipes(): Map<string, Recipe> {
  const mods = import.meta.glob(['./recipes/*/recipe.json', './cindy-recipes/*/*.recipe.json'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const recipes = parseRecipes(mods);
  for (const entry of upstreamCatalog) {
    const id = `opencli:${entry.site}/${entry.name}`;
    recipes.set(id, {
      id, adapter: `${entry.site}/${entry.name}`, access: entry.access as 'read' | 'write',
      description: entry.description, match: entry.domain ? [entry.domain] : [], steps: [],
      inputs: Object.fromEntries(entry.args.map(arg => [arg.name, {
        required: arg.required, type: arg.type, default: 'default' in arg ? arg.default : undefined,
        description: arg.help, choices: 'choices' in arg ? arg.choices as string[] : undefined,
      }])),
    });
  }
  return recipes;
}

/** Glob siteguide JSON bundled at build time (Vite), then parse. */
export function loadSiteGuides(): Map<string, SiteGuide> {
  const mods = import.meta.glob(['./recipes/*/siteguide.json', './cindy-recipes/*/siteguide.json'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const guides = parseSiteGuides(mods);
  const siteKeys = new Map<string, string>();
  for (const recipe of loadRecipes().values()) {
    if (recipe.id.startsWith('opencli:') || !recipe.adapter) continue;
    const host = recipe.match?.find(host => guides.has(host));
    if (host) siteKeys.set(recipe.adapter.split('/')[0], host);
  }
  for (const entry of upstreamCatalog) {
    if (!siteKeys.has(entry.site)) siteKeys.set(entry.site, entry.domain || entry.site);
  }
  for (const entry of upstreamCatalog) {
    const site = siteKeys.get(entry.site)!;
    const id = `opencli:${entry.site}/${entry.name}`;
    const guide = guides.get(site) ?? { site, recipes: [], notes: '内置 OpenCLI 适配器；先查看参数与 read/write 分类。登录、API 凭据和平台依赖按具体命令要求准备。' };
    guide.recipes = [...(guide.recipes ?? []), id];
    const aliases = Array.isArray(guide.aliases) ? guide.aliases as string[] : [];
    guide.aliases = [...new Set([...aliases, entry.site, ...(entry.domain ? [entry.domain] : [])])];
    guides.set(site, guide);
  }
  // Cindy additions can extend an existing site's capabilities (e.g. Steam
  // reviews) without replacing its upstream guide or duplicating the site.
  for (const recipe of loadRecipes().values()) {
    if (recipe.adapter) continue;
    const host = recipe.match?.find(host => guides.has(host));
    if (!host) continue;
    const guide = guides.get(host)!;
    guide.recipes = [...new Set([...(guide.recipes ?? []), recipe.id])];
  }
  return guides;
}
