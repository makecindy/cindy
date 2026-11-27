import { isSafeGhostRelativePath } from './internal/ghostPath.js';
import { GHOST_LOCALES, type GhostLocale } from './locales.js';
import type { GhostManifestLocales } from './manifest.js';

/**
 * 插件详细介绍（`ghost.json.readme`）：按语言指向包内 Markdown 文件，只给人看。
 * 图片只能引用包内文件，宿主读出后以 data URL（或插件服务端签发的地址）随正文交给界面；
 * 外部图片地址一律不加载。正文和图片都不进入模型上下文。
 */

/** 单个介绍 Markdown 文件的字节上限。 */
export const GHOST_README_MAX_BYTES = 128 * 1024;
/** 单张介绍图片的字节上限，与图标一致；手机端单段数据也按它留足余量。 */
export const GHOST_README_IMAGE_MAX_BYTES = 512 * 1024;
/** 一份介绍最多带出的图片数量。 */
export const GHOST_README_MAX_IMAGES = 8;
/** 一份介绍所有图片的字节总上限。 */
export const GHOST_README_IMAGES_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/**
 * 宿主交给界面的介绍内容。`images` 的键是包内规范路径（见
 * `resolveGhostReadmeAssetPath`），值是可直接显示的图片地址；不在表里的图片不显示。
 */
export interface GhostReadmeContent {
  /** 实际选用的介绍文件（包内相对路径），用于解析正文里的相对图片地址。 */
  path: string;
  markdown: string;
  images: Record<string, string>;
}

/**
 * 校验 manifest 的 `readme` 声明：语言到包内 `.md` 文件的映射，必须提供 `en`。
 * `isReservedPath` 收到小写折叠后的路径，返回 true 表示与其它声明文件冲突。
 */
export function validateGhostReadmeDeclaration(
  value: unknown,
  isReservedPath: (pathFold: string) => boolean,
): { ok: true; readme: GhostManifestLocales } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'readme 必须是语言到包内 Markdown 文件路径的对象' };
  }
  const raw = value as Record<string, unknown>;
  const unknownLocale = Object.keys(raw).find(
    (locale) => !(GHOST_LOCALES as readonly string[]).includes(locale),
  );
  if (unknownLocale) {
    return {
      ok: false,
      reason: `readme 含宿主不支持的语言 ${JSON.stringify(unknownLocale)}(可用:${GHOST_LOCALES.join(' / ')})`,
    };
  }
  if (raw.en === undefined) {
    return { ok: false, reason: 'readme 必须提供 en，作为所有不支持语言的固定回退' };
  }
  const normalized: Partial<Record<GhostLocale, string>> = {};
  const seen = new Set<string>();
  for (const locale of GHOST_LOCALES) {
    const path = raw[locale];
    if (path === undefined) continue;
    if (!isSafeGhostRelativePath(path) || !path.toLowerCase().endsWith('.md')) {
      return { ok: false, reason: `readme.${locale} 必须是安装目录内以 .md 结尾的安全相对路径` };
    }
    const fold = path.toLowerCase();
    if (isReservedPath(fold)) {
      return {
        ok: false,
        reason: `readme.${locale} 路径 ${JSON.stringify(path)} 与插件其他声明文件大小写折叠后冲突`,
      };
    }
    // 多个语言可以共用同一份文件（例如只写了英文）；大小写不同的同一路径视为笔误。
    for (const existing of seen) {
      if (existing.toLowerCase() === fold && existing !== path) {
        return { ok: false, reason: `readme 含大小写不同的重复路径 ${JSON.stringify(path)}` };
      }
    }
    seen.add(path);
    normalized[locale] = path;
  }
  return { ok: true, readme: { ...normalized, en: normalized.en! } };
}

/** 按界面语言选介绍文件；缺少该语言时固定回退英文。 */
export function selectGhostReadmePath(
  readme: GhostManifestLocales | undefined,
  locale: string | null | undefined,
): string | null {
  if (!readme) return null;
  const known = (GHOST_LOCALES as readonly string[]).includes(locale ?? '')
    ? (locale as GhostLocale)
    : null;
  return (known ? readme[known] : undefined) ?? readme.en ?? null;
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/** 与图标同一份图片格式白名单（不含 SVG）；manifest.ts 引用本文件，这里不反向依赖它。 */
const README_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;

/**
 * 把介绍正文里的图片地址解析成包内规范路径：相对介绍文件所在目录，允许 `./` 与
 * 不越出包根的 `../`。外部地址、绝对路径、带查询或锚点、越界或非白名单图片格式
 * 一律返回 null（即不显示）。宿主读图与界面查表共用这一个函数，保证两边键一致。
 */
export function resolveGhostReadmeAssetPath(readmePath: string, src: string): string | null {
  let value = src.trim();
  if (!value || URL_SCHEME_RE.test(value) || value.startsWith('/') || value.includes('\\')) {
    return null;
  }
  if (value.includes('?') || value.includes('#')) return null;
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  const segments = readmePath.split('/').slice(0, -1);
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = segments.join('/');
  if (!isSafeGhostRelativePath(resolved) || !README_IMAGE_EXT_RE.test(resolved)) return null;
  return resolved;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
// 图片说明与目标都有长度上界：未闭合的 `![` 很多时，每个起点最多扫描固定长度，
// 扫描总量与正文长度成线性（介绍正文最大 128 KB，运行在 Electron Main 里）。
const INLINE_IMAGE_RE = /!\[[^\]]{0,300}\]\(\s*<?([^)\s>]{1,256})/g;
const REFERENCE_IMAGE_RE = /!\[([^\]]{0,300})\]\[([^\]]{0,300})\]/g;
const SHORTCUT_IMAGE_RE = /!\[([^\]]{1,300})\](?![[(])/g;
const DEFINITION_RE = /^ {0,3}\[([^\]]{1,300})\]:\s*<?([^\s>]{1,256})>?/;
const CODE_SPAN_RE = /(`+[^`]*`+)/;

/**
 * 逐行处理正文里"不是代码"的部分：围栏代码块整体跳过，行内代码不参与。
 * `fn` 收到一段非代码文本，返回替换后的文本；返回 null 的整行（仅在没有行内代码时）被丢弃。
 */
function mapOutsideCode(markdown: string, fn: (text: string) => string | null): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const open = FENCE_OPEN_RE.exec(line);
    if (fence !== null) {
      out.push(line);
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1]!;
      out.push(line);
      continue;
    }
    const parts = line.split(CODE_SPAN_RE);
    if (parts.length === 1) {
      const mapped = fn(line);
      if (mapped !== null) out.push(mapped);
      continue;
    }
    out.push(parts.map((part, i) => (i % 2 === 1 ? part : (fn(part) ?? ''))).join(''));
  }
  return out.join('\n');
}

function collectDefinitions(markdown: string): Map<string, string> {
  const definitions = new Map<string, string>();
  mapOutsideCode(markdown, (text) => {
    const match = DEFINITION_RE.exec(text);
    if (match) definitions.set(match[1]!.trim().toLowerCase(), match[2]!);
    return text;
  });
  return definitions;
}

/**
 * 把引用式、简写引用式图片改写成行内图片，并去掉引用定义行。手机端的 Markdown 解析器
 * 只认行内图片，宿主读图（collectGhostReadmeImagePaths）认引用式；手机用这份规范化
 * 正文既做图片查表也做渲染，两边才一致。代码里的示例原样保留。
 */
export function inlineGhostReadmeReferenceImages(markdown: string): string {
  const definitions = collectDefinitions(markdown);
  if (definitions.size === 0) return markdown;
  const inline = (alt: string, url: string | undefined, original: string) =>
    url && !/[()]/.test(url) ? `![${alt}](${url})` : original;
  return mapOutsideCode(markdown, (text) => {
    const definition = DEFINITION_RE.exec(text);
    if (definition) return null;
    return text
      .replace(REFERENCE_IMAGE_RE, (all, alt: string, ref: string) =>
        inline(alt, definitions.get((ref || alt).trim().toLowerCase()), all),
      )
      .replace(SHORTCUT_IMAGE_RE, (all, alt: string) =>
        inline(alt, definitions.get(alt.trim().toLowerCase()), all),
      );
  });
}

/**
 * 找出正文里真正作为 Markdown 图片出现的包内图片（行内、引用式、简写引用式），按出现顺序
 * 去重。围栏代码块、行内代码、外部地址与 HTML `<img>` 不计入（HTML 不渲染）。宿主读图和
 * Forge 打包检查共用这一个结果。
 */
export function collectGhostReadmeImagePaths(markdown: string, readmePath: string): string[] {
  const definitions = collectDefinitions(markdown);
  const targets: string[] = [];
  mapOutsideCode(markdown, (text) => {
    for (const match of text.matchAll(INLINE_IMAGE_RE)) targets.push(match[1]!);
    for (const match of text.matchAll(REFERENCE_IMAGE_RE)) {
      const url = definitions.get((match[2] || match[1]!).trim().toLowerCase());
      if (url) targets.push(url);
    }
    for (const match of text.matchAll(SHORTCUT_IMAGE_RE)) {
      const url = definitions.get(match[1]!.trim().toLowerCase());
      if (url) targets.push(url);
    }
    return text;
  });
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const resolved = resolveGhostReadmeAssetPath(readmePath, target);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    paths.push(resolved);
  }
  return paths;
}
