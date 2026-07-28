import {
  isPublicHttpResourceUrl,
  type BrowserControlRequest,
  type BrowserControlRuntime,
} from '@cindy/browser-control-runtime';
import { z } from 'zod';

import type { BrowserMcpDeps } from '../types.js';
import type { BrowserToolRegistry } from './tool-registry.js';
import {
  buildExtractFnSource,
  collectSelectors,
  EXTRACT_FIELD_HINT,
  ExtractSpecSchema,
  type ExtractSpec,
} from './extract.js';
import {
  loadRecipes,
  loadSiteGuides,
  mergeRecipes,
  mergeSiteGuides,
  RecipeSchema,
  SiteGuideSchema,
  type MergedRecipe,
  type MergedSiteGuide,
} from './recipe-loader.js';
import { runRecipe, findUnsafeEvaluateInterpolations } from './recipe-runner.js';
import { isHttpUrl } from './url-guard.js';

// Layered registries: bundled L1 (Vite glob, parsed once) merged with the host's
// optional L2 user layer. Cached and keyed by the L2 `version` fingerprint, so a
// user/agent that writes a new recipe (which bumps version) sees it on the next
// call even across the per-session MCP server instances that share this module.
let recipeCache: { map: Map<string, MergedRecipe>; version: string } | null = null;
let siteGuideCache: { map: Map<string, MergedSiteGuide>; version: string } | null = null;

type UserLayer = Awaited<ReturnType<NonNullable<BrowserMcpDeps['getUserRecipes']>>> | undefined;

/** Read the host's L2 user layer once (a disk scan); callers needing both
 *  registries pass the result into the `*From` builders to avoid scanning twice. */
async function resolveUserLayer(deps: BrowserMcpDeps): Promise<UserLayer> {
  return (await deps.getUserRecipes?.()) ?? undefined;
}

/** Build (or reuse the version-cached) merged recipe registry from a resolved L2 layer. */
function recipeRegistryFrom(user: UserLayer): Map<string, MergedRecipe> {
  const version = user?.version ?? '';
  if (recipeCache && recipeCache.version === version) return recipeCache.map;
  const merged = mergeRecipes(loadRecipes(), user?.recipes ?? new Map());
  recipeCache = { map: merged, version };
  return merged;
}

/** Build (or reuse the version-cached) merged siteguide registry from a resolved L2 layer. */
function siteGuideRegistryFrom(user: UserLayer): Map<string, MergedSiteGuide> {
  const version = user?.version ?? '';
  if (siteGuideCache && siteGuideCache.version === version) return siteGuideCache.map;
  const merged = mergeSiteGuides(loadSiteGuides(), user?.siteGuides ?? new Map());
  siteGuideCache = { map: merged, version };
  return merged;
}

async function recipeRegistry(deps: BrowserMcpDeps): Promise<Map<string, MergedRecipe>> {
  return recipeRegistryFrom(await resolveUserLayer(deps));
}

const ACTIONS = [
  'doctor',
  'status',
  'start',
  'stop',
  'profiles',
  'tabs',
  'open',
  'focus',
  'close',
  'snapshot',
  'screenshot',
  'navigate',
  'console',
  'pdf',
  'upload',
  'dialog',
  'act',
  'requests',
  'responseBody',
  'extract',
  'recipe',
  'siteguide',
  'saveRecipe',
] as const;

const ACT_KINDS = [
  'click',
  'clickCoords',
  'type',
  'press',
  'hover',
  'drag',
  'select',
  'fill',
  'resize',
  'wait',
  'evaluate',
  'saveResource',
  'close',
] as const;

function getRuntime(deps: BrowserMcpDeps): BrowserControlRuntime {
  return deps.getRuntime();
}

function actKindSchema(deps: BrowserMcpDeps) {
  return z.enum(ACT_KINDS).superRefine((kind, ctx) => {
    if (kind === 'saveResource' && deps.supportsResourceDownloads?.() === false) {
      ctx.addIssue({
        code: 'custom',
        message: '当前浏览器后端不支持 saveResource',
      });
    }
  });
}

function elementQuerySchema(deps: BrowserMcpDeps) {
  const nonBlankString = z.string().trim().min(1);
  return z.object({
    css: nonBlankString.optional(),
    role: nonBlankString.optional(),
    name: nonBlankString.optional(),
    text: nonBlankString.optional(),
    label: nonBlankString.optional(),
    placeholder: nonBlankString.optional(),
    testId: nonBlankString.optional(),
    exact: z.boolean().optional(),
    index: z.number().int().nonnegative().optional(),
  }).superRefine((query, ctx) => {
    const hasLookupField = [
      query.css,
      query.role,
      query.name,
      query.text,
      query.label,
      query.placeholder,
      query.testId,
    ].some((value) => typeof value === 'string' && value !== '');
    if (!hasLookupField) {
      ctx.addIssue({
        code: 'custom',
        message: 'element query requires at least one lookup field',
      });
    }
    if (deps.supportsSemanticQueries?.() === false) {
      ctx.addIssue({
        code: 'custom',
        message: '当前浏览器后端不支持语义元素查询',
      });
    }
  });
}

// Server-enforced ceiling on a single tool result (~50k tokens). A huge page /
// `extract` (multiple, no limit) / network dump would otherwise blow the
// tool-result token budget with zero truncation — `responseBody.maxChars` and
// `extract.limit` are optional + agent-controlled, so this is the backstop.
const MAX_RESULT_BYTES = 200_000;

function resultText(value: unknown): string {
  const json = JSON.stringify(value);
  // JSON.stringify returns undefined only for undefined/function inputs; callers
  // here always pass objects, but guard so the return type stays string.
  if (json === undefined) return 'null';
  if (json.length <= MAX_RESULT_BYTES) return json;
  // The preview is re-escaped by the OUTER JSON.stringify (every " / \ doubles),
  // so slicing `json` to MAX_RESULT_BYTES and embedding it can yield a final
  // string ~2x the cap for quote-heavy content — defeating this backstop. Size
  // the preview against the FINAL serialized length instead: start optimistic,
  // then shrink by the measured overflow until the whole result fits.
  const base = {
    truncated: true as const,
    bytes: json.length,
    limit: MAX_RESULT_BYTES,
    hint: '结果过大已截断;请用 limit / maxChars 缩小范围,或用 extract 精确取字段。preview 为截断后的前缀。',
  };
  const overhead = JSON.stringify({ ...base, preview: '' }).length;
  let take = MAX_RESULT_BYTES - overhead;
  let out = JSON.stringify({ ...base, preview: json.slice(0, Math.max(0, take)) });
  // Converges in 1–2 passes: cutting N escaped chars removes ≥ N from the output.
  while (out.length > MAX_RESULT_BYTES && take > 0) {
    take -= out.length - MAX_RESULT_BYTES;
    out = JSON.stringify({ ...base, preview: json.slice(0, Math.max(0, take)) });
  }
  return out;
}

/** Build an MCP error response for an MCP-only action (recipe/siteguide/extract). */
function errorResult(action: string, message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text: resultText({ ok: false, action, errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST', message }),
      },
    ],
    isError: true,
  };
}

// Forwards validated MCP args straight to the runtime. `extract` (MCP-only
// sugar) is rewritten in the handler before this is reached, so every `action`
// arriving here is a real BrowserControlAction.
function toRuntimeRequest(args: Record<string, unknown>): BrowserControlRequest {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as BrowserControlRequest;
}

export function registerBrowserTools(registry: BrowserToolRegistry, deps: BrowserMcpDeps): void {
  const actKind = actKindSchema(deps);
  const elementQuery = elementQuerySchema(deps);
  registry.register({
    name: 'browser',
    category: 'browser',
    description:
      '浏览器自动化统一入口。通过 action 选择 status/start/tabs/navigate/snapshot/screenshot/act 等操作; ' +
      '优先使用 snapshot 返回的 ref 执行 click/type/press,不要猜测 CSS selector。',
    rules: ['browser-workflow', 'recipe-author'],
    inputShape: {
      action: z.enum(ACTIONS).describe('浏览器操作类型'),
      profile: z.string().optional().describe('浏览器 profile 名;省略则使用默认隔离 profile'),
      target: z.enum(['sandbox', 'host', 'node']).optional(),
      node: z.string().optional(),
      targetUrl: z.string().optional(),
      url: z.string().optional().describe('navigate/open/wait 等操作使用的 URL'),
      targetId: z.string().optional().describe('tab 引用;优先使用 tabs/open 返回的 suggestedTargetId/tabId/label'),
      label: z.string().optional().describe('tab label'),
      limit: z.number().int().positive().optional(),
      maxChars: z.number().int().nonnegative().optional(),
      mode: z.enum(['efficient']).optional(),
      snapshotFormat: z.enum(['aria', 'ai']).optional(),
      refs: z.enum(['role', 'aria']).optional(),
      interactive: z.boolean().optional(),
      compact: z.boolean().optional(),
      depth: z.number().int().nonnegative().optional(),
      selector: z.string().optional(),
      frame: z.string().optional(),
      labels: z.boolean().optional(),
      urls: z.boolean().optional(),
      fullPage: z.boolean().optional(),
      ref: z.string().optional().describe('snapshot 返回的元素 ref'),
      element: z.string().optional(),
      type: z.enum(['png', 'jpeg']).optional(),
      level: z.string().optional(),
      paths: z.array(z.string()).optional(),
      inputRef: z.string().optional(),
      query: elementQuery
        .optional()
        .describe('action=upload 时定位文件输入框；字段语义与 act.request.query 一致'),
      timeoutMs: z.number().int().positive().optional(),
      dialogId: z.string().optional(),
      accept: z.boolean().optional(),
      promptText: z.string().optional(),
      filter: z.string().optional().describe('action=requests 时按 URL 子串过滤已捕获的请求'),
      clear: z.boolean().optional().describe('action=requests 时读取后清空缓冲'),
      extract: ExtractSpecSchema.optional().describe(
        'action=extract: 按字段 schema 从 DOM 提结构化数据(精确字段时比全页 snapshot 省 token)。' +
          'fields 的值:string=**纯 CSS 选择器**(取 textContent),取属性/链接用对象 {selector,attr} 或 {selector,type:"href"}。' +
          '例:{ from:"article.product_pod", multiple:true, fields:{ title:{selector:"h3 a",attr:"title"}, price:".price_color" } }。' +
          '不要把属性拼进选择器(如 "h3 a@title" 非法);不确定结构先用 snapshot 看 DOM。',
      ),
      recipeId: z.string().optional().describe('action=recipe: 要执行的站点配方 id(可先用 siteguide 查可用配方)'),
      inputs: z.record(z.string(), z.unknown()).optional().describe('action=recipe: 配方输入变量'),
      site: z.string().optional().describe('action=siteguide / saveRecipe: 站点 host。siteguide 带 site 返回该站指南;**siteguide 省略 site 则列出全部内置站点+可用配方目录**(用于发现有哪些现成配方)。saveRecipe 写到该站的本地层'),
      recipeDraft: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('action=saveRecipe: 要保存到本地层的配方对象(同 recipe schema:id/steps/inputs/output…),会先按 schema 校验'),
      siteGuideDraft: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('action=saveRecipe: 可选,一并保存的站点指南对象(site/entry/recipes/notes…)'),
      request: z
        .object({
          kind: actKind,
          targetId: z.string().optional(),
          ref: z.string().optional(),
          query: elementQuery
            .optional()
            .describe(
              '语义元素查询，可组合 role/name/text/label/placeholder/testId/css；' +
                '默认要求唯一匹配，多项结果时用 index 明确选择。',
            ),
          doubleClick: z.boolean().optional(),
          button: z.string().optional(),
          modifiers: z.array(z.string()).optional(),
          x: z.number().finite().optional(),
          y: z.number().finite().optional(),
          text: z.string().optional(),
          submit: z.boolean().optional(),
          slowly: z.boolean().optional(),
          key: z.string().optional(),
          delayMs: z.number().int().nonnegative().optional(),
          startRef: z.string().optional(),
          endRef: z.string().optional(),
          values: z.array(z.string()).optional(),
          fields: z.array(z.record(z.string(), z.unknown())).optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          timeMs: z.number().int().nonnegative().optional(),
          selector: z.string().optional(),
          url: z.string().optional().describe('saveResource 时使用 snapshot(urls:true) 返回的资源 URL'),
          loadState: z.string().optional(),
          textGone: z.string().optional(),
          timeoutMs: z.number().int().positive().optional(),
          fn: z.string().optional(),
        })
        .optional()
        .describe('action=act 时的具体动作请求'),
    },
    handler: async (args) => {
      const runtime = getRuntime(deps);
      try {
        // Block non-web schemes at the boundary: navigate/open to file:// /
        // chrome:// / data: would let the agent reach local files or browser
        // internals. Only the scheme is constrained — localhost/private HTTP
        // hosts stay reachable by design (see browser.ts SSRF note).
        //
        // `responseBody` is intentionally NOT guarded here: its `url` is a
        // request-URL *match pattern* (substring / wildcard like `api/quotes`
        // or `*​/api/*`), not a navigable URL, so requiring it to parse as
        // http(s) would break ad-hoc body reads. It only reads already-captured
        // responses, so it is not a navigation/file-read vector.
        if (args.action === 'navigate' || args.action === 'open') {
          const u =
            typeof args.url === 'string'
              ? args.url
              : args.action === 'open' && typeof args.targetUrl === 'string'
                ? args.targetUrl
                : undefined;
          if (typeof u === 'string' && !isHttpUrl(u)) {
            return errorResult(
              args.action,
              `url 必须是 http(s);不支持 file:// / chrome:// / data: 等协议(收到 "${u}")`,
            );
          }
        }
        if (
          args.action === 'act'
          && args.request?.kind === 'saveResource'
          && deps.supportsResourceDownloads?.() === false
        ) {
          return errorResult(
            args.action,
            '当前浏览器后端不支持 saveResource，请使用内嵌浏览器后端',
          );
        }
        if (
          args.action === 'act'
          && args.request?.kind === 'saveResource'
          && (
            typeof args.request.url !== 'string'
            || !isPublicHttpResourceUrl(args.request.url)
          )
        ) {
          return errorResult(
            args.action,
            'saveResource.url 必须是 snapshot(urls:true) 返回的 http(s) 资源地址',
          );
        }

        // recipe: run a declarative per-site flow (composition over primitives).
        // Merged L1 (bundled) + L2 (user); user version shadows builtin by id.
        if (args.action === 'recipe') {
          if (!args.recipeId) return errorResult('recipe', 'recipe requires `recipeId`');
          let entry: MergedRecipe | undefined;
          try {
            entry = (await recipeRegistry(deps)).get(args.recipeId);
          } catch (err) {
            return errorResult('recipe', `recipe registry error: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (!entry) return errorResult('recipe', `unknown recipe: ${args.recipeId}`);
          // Thread the caller's tab/profile routing into every recipe step:
          // step requests from stepToRequest carry no profile/targetId, so
          // without this each navigate/extract would fall back to the runtime's
          // default profile + last-selected tab — operating a different tab than
          // the agent explicitly selected.
          //
          // A `navigate` that swaps the Chromium target returns a replacement
          // `targetId` (the runtime resolves it post-navigation). We adopt that
          // returned id for later steps so extract/act run on the live tab — both
          // when the caller pinned a tab (the original id would go stale) AND when
          // no tab was pinned (otherwise later steps fall back to "last-selected",
          // which is ambiguous with multiple tabs open). Once a navigate hands back
          // a target, the whole recipe stays pinned to it.
          let activeTargetId = args.targetId;
          const runResult = await runRecipe(entry.recipe, args.inputs as Record<string, unknown> | undefined, {
            call: async (req) => {
              const res = await runtime.call({
                ...req,
                ...(args.profile ? { profile: args.profile } : {}),
                ...(activeTargetId ? { targetId: activeTargetId } : {}),
              });
              const next = (res.data as { targetId?: unknown } | undefined)?.targetId;
              if (typeof next === 'string' && next) activeTargetId = next;
              return res;
            },
            logger: deps.logger,
          });
          return {
            content: [
              { type: 'text', text: resultText({ action: 'recipe', provenance: entry.provenance, ...runResult }) },
            ],
            isError: !runResult.ok,
          };
        }

        // siteguide: return compact, on-demand site knowledge (entry URLs / key
        // pages / available recipes). Named to avoid colliding with a website's
        // own /sitemap.xml. Kept out of the always-present rules so the
        // prompt-cache prefix stays small. `provenance` tells the agent whether
        // this is the shipped builtin or the user's own optimized version.
        if (args.action === 'siteguide') {
          // Read the L2 user layer ONCE (one disk scan), then build both the
          // siteguide and recipe registries from it — siteguide needs the recipe
          // registry too (to expose each recipe's input schema for discovery, so
          // the agent passes required inputs first-try instead of failing into
          // "missing required input").
          let registry: Map<string, MergedSiteGuide>;
          let recipeReg: Map<string, MergedRecipe>;
          try {
            const user = await resolveUserLayer(deps);
            registry = siteGuideRegistryFrom(user);
            recipeReg = recipeRegistryFrom(user);
          } catch (err) {
            return errorResult('siteguide', `siteguide registry error: ${err instanceof Error ? err.message : String(err)}`);
          }
          const recipeInputsOf = (ids: string[] | undefined) =>
            (ids ?? []).map((id) => {
              const r = recipeReg.get(id);
              const spec = r?.recipe.inputs ?? {};
              return {
                id,
                // Surface the author's description at discovery time — it carries
                // input constraints (e.g. "id must be passed as a string") that the
                // bare input-name list cannot express.
                description: r?.recipe.description,
                inputs: Object.keys(spec),
                required: Object.entries(spec)
                  .filter(([, v]) => v?.required)
                  .map(([k]) => k),
              };
            });

          // Discovery: `siteguide` with no `site` lists the whole built-in
          // catalog (site → recipes with their input schema + auth) so the agent
          // knows which sites have recipes AND what to pass, WITHOUT guessing a
          // host or discovering inputs via trial-and-error. Compact by design.
          if (!args.site) {
            const sites = [...registry.values()]
              .map((e) => ({
                site: e.guide.site,
                provenance: e.provenance,
                auth: e.guide.auth,
                recipes: recipeInputsOf(e.guide.recipes),
              }))
              .sort((a, b) => a.site.localeCompare(b.site));
            // Also surface recipes that exist in the registry but aren't listed by
            // ANY site guide — e.g. an agent saved one via `saveRecipe` without a
            // guide. Without this they'd be undiscoverable (the agent would have to
            // remember the exact recipeId). `match` hints which host(s) they apply
            // to. Run them the same way: `recipe` with the listed id.
            const guided = new Set([...registry.values()].flatMap((e) => e.guide.recipes ?? []));
            const recipesWithoutGuide = recipeInputsOf([...recipeReg.keys()].filter((id) => !guided.has(id)))
              .map((r) => {
                const e = recipeReg.get(r.id);
                return { ...r, provenance: e?.provenance, match: e?.recipe.match ?? [] };
              })
              .sort((a, b) => a.id.localeCompare(b.id));
            return {
              content: [
                {
                  type: 'text',
                  text: resultText({
                    ok: true,
                    action: 'siteguide',
                    siteCount: sites.length,
                    sites,
                    ...(recipesWithoutGuide.length ? { recipesWithoutGuide } : {}),
                  }),
                },
              ],
              isError: false,
            };
          }
          const entry = registry.get(args.site);
          if (!entry) {
            return errorResult('siteguide', `no siteguide for "${args.site}" (available: ${[...registry.keys()].join(', ') || 'none'})`);
          }
          return {
            content: [
              {
                type: 'text',
                text: resultText({
                  ok: true,
                  action: 'siteguide',
                  provenance: entry.provenance,
                  data: entry.guide,
                  recipes: recipeInputsOf(entry.guide.recipes),
                }),
              },
            ],
            isError: false,
          };
        }

        // saveRecipe: self-grow — persist an authored recipe into the L2 user
        // layer. The draft is schema-validated here (rule 9: code-enforced format,
        // teach-via-error) before the host writes it; on success the merged
        // registry cache is invalidated so the new recipe is immediately live.
        if (args.action === 'saveRecipe') {
          if (!deps.saveUserRecipe) return errorResult('saveRecipe', 'saveRecipe 在当前 host 不可用');
          if (!args.site) return errorResult('saveRecipe', 'saveRecipe requires `site`(站点 host)');
          if (!args.recipeDraft) return errorResult('saveRecipe', 'saveRecipe requires `recipeDraft`');
          const parsed = RecipeSchema.safeParse(args.recipeDraft);
          if (!parsed.success) {
            return errorResult(
              'saveRecipe',
              `recipeDraft 不合法:${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            );
          }
          // Code-enforce interpolation safety (rule 9): a bare `{{var}}` inside an
          // `evaluate` step's JS source can break out of the string literal — reject
          // with a teach-via-error message instead of relying on recipe-author prompt.
          const unsafeInterp = findUnsafeEvaluateInterpolations(parsed.data);
          if (unsafeInterp.length > 0) {
            return errorResult('saveRecipe', `recipeDraft 插值不安全:${unsafeInterp.join('; ')}`);
          }
          let guide;
          if (args.siteGuideDraft) {
            const g = SiteGuideSchema.safeParse(args.siteGuideDraft);
            if (!g.success) {
              return errorResult(
                'saveRecipe',
                `siteGuideDraft 不合法:${g.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
              );
            }
            guide = g.data;
            // The guide is WRITTEN under `args.site`'s folder but the loader
            // INDEXES it by its embedded `site` field. A mismatch would shadow
            // another site's guide and couldn't be reset by deleting the folder.
            // Code-enforce that they agree (rule 9).
            if (guide.site !== args.site) {
              return errorResult(
                'saveRecipe',
                `siteGuideDraft.site ("${guide.site}") 必须与 site ("${args.site}") 一致`,
              );
            }
          }
          const saved = await deps.saveUserRecipe({ site: args.site, recipe: parsed.data, siteGuide: guide });
          if (saved.ok) {
            // invalidate so this session sees it now (cross-session is covered by
            // the content-derived version check in the registry).
            recipeCache = null;
            siteGuideCache = null;
          }
          return {
            content: [
              { type: 'text', text: resultText({ ok: saved.ok, action: 'saveRecipe', path: saved.path, message: saved.message }) },
            ],
            isError: !saved.ok,
          };
        }

        let result;
        if (args.action === 'extract') {
          // `extract` is composition over the existing `evaluate` primitive:
          // compile the field schema to an injected fn and run it on the page.
          if (!args.extract) {
            return errorResult('extract', 'extract requires an `extract` spec ({ from?, multiple?, fields, limit? })');
          }
          const spec = args.extract as ExtractSpec;
          // Teach-via-error (upstream idiom): the observed model mistake is
          // putting an attribute in the selector ("h3 a@title"). Catch it before
          // running and show the correct field shape instead of failing in-page.
          const attrMistake = collectSelectors(spec).find((s) => s.includes('@'));
          if (attrMistake) {
            return errorResult('extract', `选择器 "${attrMistake}" 含 "@"。${EXTRACT_FIELD_HINT}`);
          }
          // Reject frame-scoped extract instead of silently ignoring it: extract
          // compiles to act:evaluate, and the vendored /act route has no frame
          // handling, so a `frame` would run against the main document and
          // return wrong/empty data with no signal. (snapshot DOES support
          // `frame`; use it to locate, then extract on the main document.)
          if (args.frame) {
            return errorResult(
              'extract',
              'extract 暂不支持 frame(frame-scoped extraction);底层 evaluate 不接受 frame。请在主文档上 extract,或先用 snapshot 的 frame 参数定位再抓。',
            );
          }
          result = await runtime.call({
            action: 'act',
            profile: args.profile,
            targetId: args.targetId,
            request: {
              kind: 'evaluate',
              fn: buildExtractFnSource(spec),
              ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
            },
          } as BrowserControlRequest);
        } else {
          result = await runtime.call(toRuntimeRequest(args));
        }
        // For extract, the runtime call may succeed (evaluate ran) while the
        // in-page extract reports ok:false (invalid selector); surface that as an
        // error so the agent sees + acts on the embedded hint.
        const inner = (result.data as { result?: { ok?: boolean } } | undefined)?.result;
        const extractFailed = args.action === 'extract' && inner?.ok === false;
        return {
          content: [{ type: 'text', text: resultText(result) }],
          isError: !result.ok || extractFailed,
        };
      } catch (err) {
        deps.logger?.warn?.('browser runtime call failed', {
          message: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [
            {
              type: 'text',
              text: resultText({
                ok: false,
                action: args.action,
                errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
                message: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  });
}
