import {
  BARE_HTTP_URL_RE_SOURCE,
  clipBareHttpAutolink,
} from '@cindy/maker-shared/url-text-boundary';
import {
  SESSION_DEEP_LINK_RE_SOURCE,
  PROJECT_DEEP_LINK_RE_SOURCE,
  parseSessionDeepLinkHref,
  parseProjectDeepLinkHref,
  findMarkdownLabelStart,
  unescapeMarkdownLabelBrackets,
} from '@/lib/deepLink';
import { stripDeepLinkPathPrefix } from '../../../shared/deepLinkSchemes';

/**
 * Combined linkify pattern: matches either
 *   1. an http(s):// URL, OR
 *   2. an absolute local image path (Windows or POSIX) ending in a known
 *      image extension. Captured greedily up to whitespace so paths with
 *      spaces in folder names need to be wrapped in markdown to work — same
 *      tradeoff as URL detection (also stops at whitespace).
 *
 * Image extension whitelist mirrors the renderer's ImageLightbox cohort
 * (png/jpg/jpeg/gif/webp/svg/bmp/ico) and the main-process xdt-file://
 * protocol's IMAGE_EXT_WHITELIST. Keep them in sync.
 */
// 匹配源与切边都来自 maker-shared/url-text-boundary：ASCII-only 匹配，
// 半角括号/包裹引号/尾部句读由 clipBareHttpAutolink 统一收口。
const URL_RE = new RegExp(`(${BARE_HTTP_URL_RE_SOURCE})`, 'g');
const IMG_PATH_RE =
  /([A-Za-z]:[\\/][^\s<>"']*?\.(?:png|jpe?g|gif|webp|svg|bmp|ico)|\/[^\s<>"']*?\.(?:png|jpe?g|gif|webp|svg|bmp|ico))/gi;
// \u4F1A\u8BDD\u6DF1\u94FE cindy://session/<id>[?message=<clientId>](\u5386\u53F2 xdt-maker:// \u540C):ASCII \u767D\u540D\u5355,CJK /
// \u7A7A\u767D / \u4E2D\u6587\u6807\u70B9\u5904\u5929\u7136\u6536\u5C3E;\u5C3E\u90E8\u7C98\u8FDE\u7684\u82F1\u6587\u53E5\u8BFB\u5728 findLinkifyMatches \u91CC\u5265\u6389\u3002
// \u6B63\u5219\u6E90\u4E0E sessionLinkPaste(\u8F93\u5165\u6846\u7C98\u8D34\u8F6C chip)\u5171\u4EAB lib/deepLink.ts \u7684
// SESSION_DEEP_LINK_RE_SOURCE,\u4E0E remarkSessionLinks(AI \u6D88\u606F)/ mobile
// sessionLinks \u7684\u5339\u914D\u53E3\u5F84\u4FDD\u6301\u4E00\u81F4\u3002
const SESSION_URL_RE = new RegExp(SESSION_DEEP_LINK_RE_SOURCE, 'g');
// `[\u6807\u9898](\u6DF1\u94FE)` markdown \u5F62\u5F0F:\u8F93\u5165\u6846\u7C98\u8D34 chip \u5316\u540E\u6309\u6B64\u5F62\u5F0F\u5E8F\u5217\u5316\u53D1\u9001
// (sessionLinkPaste),\u7528\u6237\u6D88\u606F\u662F\u7EAF\u6587\u672C\u6E32\u67D3,\u8FD9\u91CC\u663E\u5F0F\u8BC6\u522B\u5E76\u628A label \u4EA4\u7ED9
// SessionLinkChip(\u4F5C\u8005 label \u4F18\u5148,\u4E0D\u67E5\u5E93)\u3002\u5339\u914D\u951A\u5B9A `](href)` \u6536\u5C3E,
// label \u8D77\u70B9\u7528 findMarkdownLabelStart \u65B9\u62EC\u53F7\u5E73\u8861\u56DE\u626B(CommonMark \u8BED\u4E49,
// `[[WIP] \u6807\u9898]` \u53D6\u5916\u5C42\u3001`[x] [\u6807\u9898]` \u53EA\u53D6\u7D27\u90BB,PR #970 \u4E24\u8F6E\u53CD\u9988\u5B9A\u7A3F)\u3002
const SESSION_MD_CLOSE_RE = new RegExp(
  `\\]\\((${SESSION_DEEP_LINK_RE_SOURCE})\\)`,
  'g',
);
// \u9879\u76EE\u6DF1\u94FE(\u88F8 / markdown \u5F62\u5F0F),\u4E0E session \u540C\u4E00\u5957\u5904\u7406\u53E3\u5F84 \u2192 ProjectLinkChip\u3002
const PROJECT_URL_RE = new RegExp(PROJECT_DEEP_LINK_RE_SOURCE, 'g');
const PROJECT_MD_CLOSE_RE = new RegExp(
  `\\]\\((${PROJECT_DEEP_LINK_RE_SOURCE})\\)`,
  'g',
);

interface DeepLinkMatchFields {
  index: number;
  length: number;
  /** \u6574\u6BB5\u5339\u914D\u6587\u672C(markdown \u5F62\u5F0F\u542B `[..](..)` \u5305\u88C5,\u88F8\u94FE\u63A5\u5373 href)\u3002 */
  text: string;
  /** \u6DF1\u94FE\u672C\u4F53,chip \u7684\u8DF3\u8F6C\u76EE\u6807\u3002 */
  href: string;
  /** markdown \u5F62\u5F0F\u7684\u663E\u5F0F\u6807\u9898;\u88F8\u94FE\u63A5 / \u7A7A\u6807\u9898 / \u6807\u9898\u5373 href \u65F6\u7F3A\u7701\u3002 */
  label?: string;
}

export type LinkifyMatch =
  | { kind: 'url'; index: number; length: number; text: string }
  | { kind: 'img'; index: number; length: number; text: string }
  | ({ kind: 'session' } & DeepLinkMatchFields)
  | ({ kind: 'project' } & DeepLinkMatchFields);

function pushUrlMatch(
  matches: LinkifyMatch[],
  source: string,
  index: number,
  raw: string,
): number | null {
  const end = clipBareHttpAutolink(raw, { prefix: source.slice(0, index) });
  if (end <= 0) return null;
  const text = raw.slice(0, end);
  matches.push({
    kind: 'url',
    index,
    length: text.length,
    text,
  });
  return text.length;
}

export function findLinkifyMatches(text: string): LinkifyMatch[] {
  const matches: LinkifyMatch[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const length = pushUrlMatch(matches, text, m.index, m[0]);
    if (length != null && length < m[0].length) {
      URL_RE.lastIndex = m.index + length;
    }
  }
  IMG_PATH_RE.lastIndex = 0;
  while ((m = IMG_PATH_RE.exec(text)) !== null) {
    matches.push({
      kind: 'img',
      index: m.index,
      length: m[0].length,
      text: m[0],
    });
  }
  // markdown 形式先扫:`[标题](深链)` 的整段(含包装)归属一个 session 匹配,
  // 其内部的裸深链随后会被重叠过滤丢弃(markdown 匹配起点更靠前)。
  SESSION_MD_CLOSE_RE.lastIndex = 0;
  while ((m = SESSION_MD_CLOSE_RE.exec(text)) !== null) {
    const href = m[1];
    if (!parseSessionDeepLinkHref(href)) continue;
    const open = findMarkdownLabelStart(text, m.index);
    if (open < 0) continue;
    // `\]` / `\[` 是 label 里的字面括号(回扫已按转义语义跳过)→ 展示前反转义。
    const label = unescapeMarkdownLabelBrackets(text.slice(open + 1, m.index)).trim();
    const end = m.index + m[0].length;
    matches.push({
      kind: 'session',
      index: open,
      length: end - open,
      text: text.slice(open, end),
      href,
      ...(label && label !== href ? { label } : {}),
    });
  }
  SESSION_URL_RE.lastIndex = 0;
  while ((m = SESSION_URL_RE.exec(text)) !== null) {
    // Strip trailing English punctuation glued to the link, then reject
    // empty-id matches by slicing at the *actually matched* scheme prefix —
    // cindy:// and legacy xdt-maker:// differ in length, so a fixed-literal
    // slice would cut at the wrong offset.
    const trimmed = m[0].replace(/[.,;:!?]+$/, '');
    if (!stripDeepLinkPathPrefix(trimmed, 'session/')) continue;
    matches.push({
      kind: 'session',
      index: m.index,
      length: trimmed.length,
      text: trimmed,
      href: trimmed,
    });
  }
  // 项目深链:markdown 形式 → 裸形式,处理口径与 session 一致。
  PROJECT_MD_CLOSE_RE.lastIndex = 0;
  while ((m = PROJECT_MD_CLOSE_RE.exec(text)) !== null) {
    const href = m[1];
    if (!parseProjectDeepLinkHref(href)) continue;
    const open = findMarkdownLabelStart(text, m.index);
    if (open < 0) continue;
    // 同 session:label 反转义后展示。
    const label = unescapeMarkdownLabelBrackets(text.slice(open + 1, m.index)).trim();
    const end = m.index + m[0].length;
    matches.push({
      kind: 'project',
      index: open,
      length: end - open,
      text: text.slice(open, end),
      href,
      ...(label && label !== href ? { label } : {}),
    });
  }
  PROJECT_URL_RE.lastIndex = 0;
  while ((m = PROJECT_URL_RE.exec(text)) !== null) {
    const trimmed = m[0].replace(/[.,;:!?]+$/, '');
    if (!parseProjectDeepLinkHref(trimmed)) continue;
    matches.push({
      kind: 'project',
      index: m.index,
      length: trimmed.length,
      text: trimmed,
      href: trimmed,
    });
  }
  // Sort by start index; on tie, prefer URL (http patterns are unambiguous).
  // Then drop any match that overlaps a previous accepted one.
  // session 与 url/img 的 scheme / 形态互斥,不会真正同起点撞车,tie-break
  // 沿用原规则即可。
  matches.sort((a, b) =>
    a.index - b.index || (a.kind === 'url' ? -1 : 1),
  );
  const accepted: LinkifyMatch[] = [];
  let cursor = 0;
  for (const candidate of matches) {
    if (candidate.index < cursor) continue;
    accepted.push(candidate);
    cursor = candidate.index + candidate.length;
  }
  return accepted;
}
