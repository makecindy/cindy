import {
  isPublicHttpResourceUrl,
  parseBrowserProxyServer,
  type BrowserControlRequest,
  type BrowserControlResult,
  type BrowserControlRuntime,
} from '@cindy/browser-control-runtime';
import { z } from 'zod';

import {
  INLINE_IMAGE_TARGET_BYTES,
  type BrowserMcpDeps,
  type ResolvedBrowserScreenshot,
} from '../types.js';
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
  type Recipe,
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
  'setBackend',
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

/** Tools that read page script state, network traffic or console output. */
function readsPageState(request: BrowserControlRequest): boolean {
  if (request.action === 'recipeCommand') return request.recipeCommand?.method !== 'Cindy.end';
  if (request.action === 'console' || request.action === 'requests' || request.action === 'responseBody') return true;
  const act = request.request as { kind?: unknown; fn?: unknown } | undefined;
  return request.action === 'act' && (act?.kind === 'evaluate' || (act?.kind === 'wait' && act.fn !== undefined));
}

function getRuntime(deps: BrowserMcpDeps, onDispatch?: () => void): BrowserControlRuntime {
  const runtime = deps.getRuntime();
  const restricted = deps.pageReadsRestricted;
  if (!restricted && !onDispatch) return runtime;
  // Every path (tool actions, extract, recipes, hints) goes through this check.
  return {
    call: async (request) => {
      if (restricted && readsPageState(request)
        && await restricted({
          ...(request.profile ? { profile: request.profile } : {}),
          ...(request.targetId ? { targetId: request.targetId } : {}),
        }).catch(() => true)) {
        return {
          ok: false,
          action: request.action,
          errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
          message: 'The owner just entered a password on this page through Cindy. Script evaluation, network and console reads are paused here until the tab leaves this page. Use snapshot or screenshot, or navigate on.',
          data: { reason: 'secret_entered' },
        };
      }
      // This is the sole boundary after host preflight and before execution;
      // callers must count attempts here, including throws/timeouts afterwards.
      onDispatch?.();
      return runtime.call(request);
    },
  };
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

/**
 * 代输入 hint on a page that asks for a password or a one-time code: the
 * owner should fill it from their own device. A cheap DOM check after a
 * snapshot; any failure means no hint.
 */
const LOGIN_WALL_FN = `() => {
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {}
  }
  const has = (selector) => docs.some((doc) => doc.querySelector(selector));
  return {
    password: !!has('input[type=password]'),
    code: !!has('input[autocomplete="one-time-code"]'),
  };
}`;

async function detectLoginWall(runtime: BrowserControlRuntime, profile: unknown, targetId: unknown) {
  try {
    const checked = await runtime.call({
      action: 'act',
      ...(typeof profile === 'string' ? { profile } : {}),
      ...(typeof targetId === 'string' ? { targetId } : {}),
      request: { kind: 'evaluate', fn: LOGIN_WALL_FN, timeoutMs: 2000 },
    } as BrowserControlRequest);
    const found = (checked.data as { result?: { password?: unknown; code?: unknown } } | undefined)?.result;
    if (!checked.ok || (found?.password !== true && found?.code !== true)) return null;
    return {
      fields: [found.password === true ? 'password' : null, found.code === true ? 'one-time-code' : null].filter(Boolean),
      hint: 'This page asks for a password or verification code. Do not type it yourself: call request_input_handoff with this browser window so the owner completes the sign-in from their phone or another computer, then continue when it ends.',
    };
  } catch {
    return null;
  }
}

function readTargetId(result: { data?: unknown }): string | undefined {
  const id = (result.data as { targetId?: unknown } | undefined)?.targetId;
  return typeof id === 'string' && id ? id : undefined;
}

/** Some runtime role snapshots ignore maxChars; bound the advertised observation here. */
function limitAfterSnapshot(result: BrowserControlResult, maxChars: number): BrowserControlResult {
  const data = result.data as { snapshot?: unknown; refs?: Record<string, unknown>; [key: string]: unknown } | undefined;
  if (!result.ok || typeof data?.snapshot !== 'string' || data.snapshot.length <= maxChars) return result;
  const prefix = data.snapshot.slice(0, maxChars);
  const newline = prefix.lastIndexOf('\n');
  const snapshot = newline >= 0 ? prefix.slice(0, newline) : prefix;
  const visibleRefs = new Set([...snapshot.matchAll(/\[ref=([^\]]+)\]/g)].map((match) => match[1]));
  return {
    ...result,
    data: {
      ...data,
      snapshot,
      ...(data.refs ? { refs: Object.fromEntries(Object.entries(data.refs).filter(([id]) => visibleRefs.has(id))) } : {}),
      // The original statistics describe the full page, not this bounded view.
      stats: undefined,
      truncated: true,
      originalChars: data.snapshot.length,
      hint: '快照正文已截断；若缺少所需内容，请缩小 selector 范围或单独 snapshot 补读，不要重复已成功的动作。',
    },
  };
}

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

function browserScreenshotError(
  errorCode:
    | 'BROWSER_SCREENSHOT_INVALID'
    | 'BROWSER_SCREENSHOT_TOO_LARGE'
    | 'BROWSER_SCREENSHOT_COMPRESSION_UNAVAILABLE',
  message: string,
): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text: resultText({ ok: false, action: 'screenshot', errorCode, message }),
      },
    ],
    isError: true,
  };
}

function screenshotMetadata(
  result: BrowserControlResult,
  mimeType: string,
  bytes: number,
  originalBytes: number,
): Record<string, unknown> {
  const rawData = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
  const boundedString = (key: string, maxChars: number): string | undefined => {
    const value = rawData[key];
    return typeof value === 'string' ? value.slice(0, maxChars) : undefined;
  };
  const boundedCount = (key: string): number | undefined => {
    const value = rawData[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;
  };
  const annotationCount = Array.isArray(rawData.annotations)
    ? rawData.annotations.length
    : undefined;
  return {
    ok: true,
    action: 'screenshot',
    data: {
      ...(boundedString('targetId', 512) ? { targetId: boundedString('targetId', 512) } : {}),
      ...(boundedString('tabId', 512) ? { tabId: boundedString('tabId', 512) } : {}),
      ...(boundedString('url', 4_096) ? { url: boundedString('url', 4_096) } : {}),
      ...(typeof rawData.labels === 'boolean' ? { labels: rawData.labels } : {}),
      ...(boundedCount('labelsCount') !== undefined
        ? { labelsCount: boundedCount('labelsCount') }
        : {}),
      ...(boundedCount('labelsSkipped') !== undefined
        ? { labelsSkipped: boundedCount('labelsSkipped') }
        : {}),
      ...(annotationCount !== undefined ? { annotationCount } : {}),
      mimeType,
      bytes,
      ...(bytes !== originalBytes ? { originalBytes } : {}),
    },
  };
}

async function screenshotToolResult(
  result: BrowserControlResult,
  deps: BrowserMcpDeps,
) {
  if (!result.ok) {
    return {
      content: [{ type: 'text' as const, text: resultText(result) }],
      isError: true,
    };
  }
  if (!deps.resolveScreenshot) {
    return browserScreenshotError(
      'BROWSER_SCREENSHOT_INVALID',
      '当前 host 无法把浏览器截图解析为模型图片输入。',
    );
  }

  let resolved: ResolvedBrowserScreenshot;
  try {
    resolved = await deps.resolveScreenshot(result);
  } catch (err) {
    // resolver 抛错(路径越界 / Base64 损坏 / MIME 不匹配等)是截图内容校验
    // 失败,不是 runtime 动作失败:映射到稳定的 BROWSER_SCREENSHOT_INVALID,
    // 不能穿透到外层被泛化成 BROWSER_RUNTIME_ACTION_FAILED。原始 error 可能
    // 含文件路径,只进 host 日志,不进模型可见的错误信封。
    deps.logger?.warn('browser screenshot resolve failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return browserScreenshotError(
      'BROWSER_SCREENSHOT_INVALID',
      '浏览器截图内容校验失败，无法作为模型图片输入。',
    );
  }
  const originalBytes = resolved.buffer.byteLength;
  let buffer = resolved.buffer;
  let mimeType: string = resolved.mimeType;

  if (buffer.byteLength > INLINE_IMAGE_TARGET_BYTES) {
    let compressed: Awaited<ReturnType<NonNullable<BrowserMcpDeps['compressInlineImage']>>> = null;
    try {
      compressed = (await deps.compressInlineImage?.(buffer, mimeType, {
        targetBytes: INLINE_IMAGE_TARGET_BYTES,
      })) ?? null;
    } catch (err) {
      // CompressInlineImageFn 契约是永不 throw;真 throw 了按"压缩器不可用"
      // 降级处理,不让异常穿透成 BROWSER_RUNTIME_ACTION_FAILED。
      deps.logger?.warn('browser screenshot compression threw, treating as unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      compressed = null;
    }
    // null 是压缩器的契约降级值(sharp 缺失 / 解码失败 / 超时,见
    // CompressInlineImageFn):不是图片本身超标,不能报 TOO_LARGE。截图仍
    // 超过内联预算所以必须 fail-closed,但错误码和文案要说真话。
    if (!compressed) {
      return browserScreenshotError(
        'BROWSER_SCREENSHOT_COMPRESSION_UNAVAILABLE',
        '浏览器截图超过模型内联传输上限，且当前主机图片压缩不可用（压缩器缺失、无法解码或超时），无法安全内联。',
      );
    }
    if (compressed.buffer.byteLength > INLINE_IMAGE_TARGET_BYTES) {
      return browserScreenshotError(
        'BROWSER_SCREENSHOT_TOO_LARGE',
        '浏览器截图压缩后仍超过模型内联传输上限。请缩小窗口后重试。',
      );
    }
    buffer = compressed.buffer;
    mimeType = compressed.mime;
  }

  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) || buffer.byteLength === 0) {
    return browserScreenshotError(
      'BROWSER_SCREENSHOT_INVALID',
      '浏览器截图没有返回受支持的有效图片。',
    );
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: resultText(screenshotMetadata(result, mimeType, buffer.byteLength, originalBytes)),
      },
      {
        type: 'image' as const,
        data: buffer.toString('base64'),
        mimeType,
      },
    ],
    isError: false,
  };
}

// Forwards validated MCP args straight to the runtime. `extract` (MCP-only
// sugar) is rewritten in the handler before this is reached, so every `action`
// arriving here is a real BrowserControlAction.
function toRuntimeRequest(args: Record<string, unknown>): BrowserControlRequest {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && key !== 'afterSnapshot') out[key] = value;
  }
  return out as unknown as BrowserControlRequest;
}

export function registerBrowserTools(registry: BrowserToolRegistry, deps: BrowserMcpDeps): void {
  // Session-local evidence and repair budget: never share successful trials
  // between agents, and never retain caller inputs or page contents here.
  const verifiedDrafts = new Map<string, { site: string; content: string }>();
  const failedRecipes = new Set<string>();
  const repairUsed = new Set<string>();
  const runningRecipes = new Set<string>();
  const recovery = '先重新观察当前页面；当前任务每个配方最多验证一轮修订。失败后回普通操作。写操作先核实是否已成功，不得自动重放。';
  function draftIssue(recipe: Recipe, site: string | undefined): string | undefined {
    if (recipe.validation) return 'validation 由宿主管理，recipeDraft 不得提供';
    if (!site || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(site)) return '试跑配方需要 site（完整站点 host）';
    const unsafe = findUnsafeEvaluateInterpolations(recipe);
    if (unsafe.length) return `recipeDraft 插值不安全:${unsafe.join('; ')}`;
    for (const step of recipe.steps) {
      if (['click', 'type', 'select', 'extract', 'evaluate'].includes(step.action) && !step.guard) {
        return '交互和读取步骤必须有 guard:{url,selector?,text?}，先确认页面身份';
      }
      for (const url of [step.guard?.url, step.action === 'navigate' ? step.url : undefined]) {
        if (url !== undefined) {
          try {
            if (!isHttpUrl(url) || new URL(url).hostname !== site.toLowerCase()) return 'guard/navigation URL 必须属于 site';
          } catch { return 'guard/navigation URL 不合法'; }
        }
      }
    }
    const last = recipe.steps.at(-1);
    if (!last?.expect || !last.as || recipe.output !== `{{${last.as}}}`) {
      return '最后一步必须用 expect 验证结果，并用 as/output 返回该结果';
    }
    return undefined;
  }
  const actKind = actKindSchema(deps);
  const elementQuery = elementQuerySchema(deps);
  registry.register({
    name: 'browser',
    category: 'browser',
    description:
      '浏览器自动化统一入口。通过 action 选择 status/start/tabs/navigate/snapshot/screenshot/act 等操作; ' +
      'status 返回实际浏览器模式; setBackend 切换并保存全局浏览器模式(内置 rsb-webview / 外置 external)。' +
      '优先使用 snapshot 返回的 ref 执行 click/type/press,不要猜测 CSS selector。' +
      'act/open/navigate/upload 可带 afterSnapshot:{}，一次返回动作结果和精简快照；可用 selector 限定区域。' +
      '注意:直接调用本工具时,wait/evaluate/saveResource 不是顶层 action(会报 INVALID_ARGS),它们只能作为 act 的 request.kind 子操作(配方 steps 里仅 wait/evaluate 是合法 DSL action,saveResource 在配方中同样不可用)。',
    rules: ['browser-workflow', 'recipe-author'],
    inputShape: {
      action: z.enum(ACTIONS).describe('浏览器操作类型'),
      backend: z
        .enum(['external', 'rsb-webview'])
        .optional()
        .describe('仅 action=setBackend: 切换全局自动化目标并保存设置; 会影响其他任务,两种模式的登录态与标签页不互通'),
      proxyServer: z.string().optional().describe(
        'action=start 时使用的代理 URL（如 http://host:port）。**不支持带用户名/密码的认证代理**，带 userinfo 会被直接拒绝',
      ),
      proxyAllowedHostnames: z.array(z.string()).min(1).max(32).optional().describe(
        'action=start 且启用代理时允许导航的公网 DNS 名称或 *.example.com 模式；代理模式默认禁止导航',
      ),
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
      afterSnapshot: z.strictObject({
        selector: z.string().trim().min(1).optional(),
        frame: z.string().trim().min(1).optional(),
        interactive: z.boolean().optional(),
        depth: z.number().int().nonnegative().optional(),
        maxChars: z.number().int().min(1).max(20_000).optional(),
      }).optional().describe('动作成功后读取精简快照，正文默认最多 4000 字符；只读失败不改变动作的成功状态，不要重复动作'),
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
        .describe('action=recipe: 带 site 试跑候选配方；成功后 action=saveRecipe 保存相同 site 和 recipeDraft。需要 guard 页面校验和末步 expect 结果校验。'),
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
      try {
        if (args.afterSnapshot && (!['act', 'open', 'navigate', 'upload'].includes(args.action)
          || (args.action === 'act' && args.request?.kind === 'close'))) {
          return errorResult(args.action, 'afterSnapshot 仅用于 act（不含 close）、open、navigate、upload');
        }
        // Host configuration is not a vendored browser action. Await the same
        // lifecycle transition as Settings before issuing any new page actions.
        if (args.action === 'setBackend') {
          if (!args.backend) {
            return errorResult(args.action, 'setBackend requires backend: external or rsb-webview');
          }
          if (!deps.setBackend) return errorResult(args.action, '当前宿主不支持切换浏览器模式');
          const backend = await deps.setBackend(args.backend);
          const ok = backend === args.backend;
          return {
            content: [{
              type: 'text',
              text: resultText({
                ok,
                action: args.action,
                data: { backend, scope: 'global', ...(ok ? { persisted: true } : {}) },
                ...(!ok ? { message: '浏览器模式已发生变化,请重新查询 status' } : {}),
              }),
            }],
            isError: !ok,
          };
        }
        if (args.backend !== undefined) {
          return errorResult(args.action, 'backend 仅用于 setBackend; 请先切换模式,再操作页面');
        }
        if (args.proxyServer !== undefined || args.proxyAllowedHostnames !== undefined) {
          if (args.action !== 'start') {
            return errorResult(
              args.action,
              'proxyServer 与 proxyAllowedHostnames 仅可用于 action=start；其他操作请省略这些字段',
            );
          }
          try {
            parseBrowserProxyServer(args.proxyServer, args.proxyAllowedHostnames);
          } catch (err) {
            return errorResult(
              args.action,
              err instanceof Error ? err.message : 'proxyServer 不合法',
            );
          }
        }
        let onRecipeDispatch: (() => void) | undefined;
        const runtime = getRuntime(deps, () => onRecipeDispatch?.());
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
          let entry: MergedRecipe | undefined;
          const candidate = args.recipeDraft !== undefined;
          if (candidate) {
            const parsed = RecipeSchema.safeParse(args.recipeDraft);
            if (!parsed.success) return errorResult('recipe', `recipeDraft 不合法:${parsed.error.message}`);
            if (args.recipeId && args.recipeId !== parsed.data.id) return errorResult('recipe', 'recipeId 必须与 recipeDraft.id 一致');
            const issue = draftIssue(parsed.data, args.site);
            if (issue) return errorResult('recipe', issue);
            entry = { recipe: parsed.data, provenance: 'user' };
          } else {
            if (!args.recipeId) return errorResult('recipe', 'recipe requires recipeId 或 recipeDraft + site');
            entry = (await recipeRegistry(deps)).get(args.recipeId);
          }
          if (!entry) return errorResult('recipe', `unknown recipe: ${args.recipeId}`);
          const id = entry.recipe.id;
          const persisted = candidate ? (await recipeRegistry(deps)).get(id)?.recipe : entry.recipe;
          if (runningRecipes.has(id)) return errorResult('recipe', '该配方正在执行，请勿并发重放');
          if (candidate && persisted?.validation && persisted.validation.site !== args.site) {
            return errorResult('recipe', '已有配方的修订必须保存在原站点，请保持相同 site');
          }
          const suspended = failedRecipes.has(id) || persisted?.validation?.state === 'suspended';
          if (!candidate && suspended) return errorResult('recipe', `配方已暂停复用。${recovery}`);
          if (candidate && repairUsed.has(id)) return errorResult('recipe', `本任务的修复验证次数已用完。${recovery}`);
          verifiedDrafts.delete(id);
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
          let lastCallDispatched = false;
          onRecipeDispatch = () => {
            lastCallDispatched = true;
            if (candidate && suspended) repairUsed.add(id);
          };
          runningRecipes.add(id);
          const runResult = await runRecipe(entry.recipe, args.inputs as Record<string, unknown> | undefined, {
            targetId: args.targetId,
            recipeSecrets: deps.recipeSecrets,
            recipeFiles: deps.recipeFiles,
            call: async (req) => {
              lastCallDispatched = false;
              const res = await runtime.call({
                ...req,
                ...(args.profile ? { profile: args.profile } : {}),
                ...((req.targetId ?? activeTargetId) ? { targetId: req.targetId ?? activeTargetId } : {}),
              });
              const next = (res.data as { targetId?: unknown; tabId?: unknown } | undefined)?.targetId
                ?? (res.data as { tabId?: unknown } | undefined)?.tabId;
              if (typeof next === 'string' && next) activeTargetId = next;
              return res;
            },
            logger: deps.logger,
          }).finally(() => runningRecipes.delete(id));
          let maintenanceMessage: string | undefined;
          if (runResult.ok && candidate) {
            verifiedDrafts.set(id, { site: args.site!, content: JSON.stringify(entry.recipe) });
          } else if (!runResult.ok && lastCallDispatched && runResult.failureKind !== 'input' && runResult.failedStep !== undefined) {
            // A failed draft is not evidence that the saved active version is
            // stale. Keep its state, while limiting new/previously failed drafts.
            if (!candidate || !persisted || suspended) failedRecipes.add(id);
            // Only failure while using the saved definition can suspend it on disk.
            if (!candidate && persisted && deps.saveUserRecipe) {
              try {
                // Bundled recipes predate validation metadata; their guide
                // supplies the owning site. Never guess from a host substring.
                const sites = persisted.validation ? [persisted.validation.site] :
                  [...siteGuideRegistryFrom(await resolveUserLayer(deps)).values()]
                    .filter((g) => g.guide.recipes?.includes(id)).map((g) => g.guide.site);
                if (sites.length === 1) {
                  const saved = await deps.saveUserRecipe({ site: sites[0],
                    recipe: { ...persisted, validation: { site: sites[0], state: 'suspended' } } });
                  if (!saved.ok) maintenanceMessage = '本任务已暂停；跨任务停用保存失败，请勿复用旧配方。';
                  recipeCache = null;
                } else maintenanceMessage = '本任务已暂停；无法确定配方所属站点，未保存跨任务停用状态。';
              } catch { maintenanceMessage = '本任务已暂停；跨任务停用保存失败，请勿复用旧配方。'; }
            }
          }
          return {
            content: [
              { type: 'text', text: resultText({ action: 'recipe', provenance: entry.provenance, ...runResult,
                ...(!runResult.ok ? { recovery, maintenanceMessage } : candidate ? { verified: true } : {}) }) },
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
          const recipeInputsOf = (ids: string[] | undefined, compact = false) =>
            (ids ?? []).map((id) => {
              const r = recipeReg.get(id);
              const spec = r?.recipe.inputs ?? {};
              if (compact && id.startsWith('opencli:')) return {
                id, access: r?.recipe.access,
                ...(r?.recipe.validation ? { state: r.recipe.validation.state } : {}),
              };
              return {
                id,
                // Surface the author's description at discovery time — it carries
                // input constraints (e.g. "id must be passed as a string") that the
                // bare input-name list cannot express.
                description: r?.recipe.description,
                ...(r?.recipe.validation ? { state: r.recipe.validation.state } : {}),
                ...(r?.recipe.access ? { access: r.recipe.access } : {}),
                ...(r?.recipe.adapter ? { parameters: spec } : {}),
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
                recipes: recipeInputsOf(e.guide.recipes, true),
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
                    recipeCount: recipeReg.size,
                    hint: '按 site 查询完整参数、默认值及 read/write 分类。',
                    sites,
                    ...(recipesWithoutGuide.length ? { recipesWithoutGuide } : {}),
                  }),
                },
              ],
              isError: false,
            };
          }
          const entry = registry.get(args.site) ?? [...registry.values()].find(value =>
            Array.isArray(value.guide.aliases) && value.guide.aliases.includes(args.site));
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
          const issue = draftIssue(parsed.data, args.site);
          if (issue) return errorResult('saveRecipe', issue);
          const verified = verifiedDrafts.get(parsed.data.id);
          if (!verified || verified.site !== args.site || verified.content !== JSON.stringify(parsed.data)) {
            return errorResult('saveRecipe', '请先用 action=recipe、site、相同 recipeDraft 试跑并通过校验；不能保存未验证或已改动的配方');
          }
          const saved = await deps.saveUserRecipe({ site: args.site,
            recipe: { ...parsed.data, validation: { site: args.site, state: 'active' } }, siteGuide: guide });
          if (saved.ok) {
            verifiedDrafts.delete(parsed.data.id);
            failedRecipes.delete(parsed.data.id);
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
        if (args.action === 'screenshot') {
          return await screenshotToolResult(result, deps);
        }
        if (args.action === 'snapshot' && result.ok) {
          const loginWall = await detectLoginWall(runtime, args.profile, readTargetId(result) ?? args.targetId);
          // First key, so it survives truncation of a large snapshot.
          if (loginWall) result = { loginWall, ...result } as typeof result;
        }
        if (args.afterSnapshot && result.ok) {
          // Keep observation separate: a successful upload/click must never be
          // reported as failed (and replayed) because its follow-up read failed.
          const snapshotOptions = args.afterSnapshot;
          const targetId = readTargetId(result) ?? args.request?.targetId ?? args.targetId;
          let afterSnapshot: BrowserControlResult;
          try {
            afterSnapshot = await runtime.call({
              action: 'snapshot',
              profile: args.profile,
              targetId,
              snapshotFormat: 'ai',
              refs: snapshotOptions.selector || snapshotOptions.frame ? 'role' : 'aria',
              compact: true,
              maxChars: 4000,
              ...snapshotOptions,
            });
            if (afterSnapshot.ok) {
              const loginWall = await detectLoginWall(runtime, args.profile, readTargetId(afterSnapshot) ?? targetId);
              if (loginWall) afterSnapshot = { loginWall, ...afterSnapshot } as typeof afterSnapshot;
              afterSnapshot = limitAfterSnapshot(afterSnapshot, snapshotOptions.maxChars ?? 4000);
            }
          } catch (err) {
            afterSnapshot = {
              ok: false,
              action: 'snapshot',
              errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
              message: err instanceof Error ? err.message : String(err),
            };
          }
          result = { ...result, afterSnapshot } as typeof result;
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
