import { BRAND_IDENTITY, allDeepLinkSchemes } from '@cindy/maker-shared/brand-identity';

// 深链双 scheme(身份单点派生):cindy 主 + xdt-maker 永久兼容(存量消息里的
// 老链接不能死);生成一律用主 scheme。与桌面端 shared/deepLinkSchemes 同源镜像。
const DEEP_LINK_SCHEMES = allDeepLinkSchemes();
export const DEEP_LINK_SCHEME_GROUP = DEEP_LINK_SCHEMES.join('|');

const SESSION_LINK_PREFIX = `${BRAND_IDENTITY.primaryScheme}://session/`;
const SESSION_LINK_PREFIXES = DEEP_LINK_SCHEMES.map((s) => `${s}://session/`);

/** 返回 url 命中的前缀(任一 scheme),未命中 → null。 */
function matchPrefix(url: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (url.startsWith(prefix)) return prefix;
  }
  return null;
}

/** url 是否任一 scheme 的 Cindy 深链(session/project 等一切形态)。 */
export function isCindyDeepLinkUrl(url: string): boolean {
  return typeof url === 'string' && DEEP_LINK_SCHEMES.some((s) => url.startsWith(`${s}://`));
}

export function buildMobileSessionDeepLink(sessionId: string): string {
  return `${SESSION_LINK_PREFIX}${encodeURIComponent(sessionId)}`;
}

/** 带消息锚点的会话深链(clientId 语义,与桌面端 builder 等价镜像)。 */
export function buildMobileSessionMessageDeepLink(
  sessionId: string,
  messageClientId: string,
): string {
  return `${buildMobileSessionDeepLink(sessionId)}?message=${encodeURIComponent(messageClientId)}`;
}

export interface SessionDeepLinkTarget {
  sessionId: string;
  /** `?message=<clientId>` 锚点;无锚点 / 锚点值非法时为 null(sessionId 仍有效)。 */
  messageClientId: string | null;
  /** `?device=<deviceId>` 冻结的会话归属设备;旧格式深链 / 参数值非法时为 null。 */
  deviceId: string | null;
}

/**
 * 解析 `xdt-maker://session/<id>[?message=<clientId>]`。
 * 非本形态 / sessionId 为空或解码失败 → null。
 * 手解而不用 `new URL()`:WHATWG URL 对 non-special scheme 的切分行为
 * 跨引擎(Hermes / Node)不稳,split 最稳——与桌面端实现同源镜像。
 */
export function parseSessionDeepLinkUrl(url: string): SessionDeepLinkTarget | null {
  if (typeof url !== 'string') return null;
  const prefix = matchPrefix(url, SESSION_LINK_PREFIXES);
  if (!prefix) return null;
  const rest = url.slice(prefix.length);
  const hashIdx = rest.indexOf('#');
  const noHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const queryIdx = noHash.indexOf('?');
  const rawId = (queryIdx >= 0 ? noHash.slice(0, queryIdx) : noHash).replace(/\/+$/, '');
  if (!rawId) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!sessionId) return null;
  let messageClientId: string | null = null;
  let deviceId: string | null = null;
  if (queryIdx >= 0) {
    const query = noHash.slice(queryIdx + 1);
    for (const pair of query.split('&')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = pair.slice(0, eqIdx);
      if (key !== 'message' && key !== 'device') continue;
      if (key === 'message' ? messageClientId !== null : deviceId !== null) continue;
      const rawValue = pair.slice(eqIdx + 1);
      if (!rawValue) continue;
      try {
        const decoded = decodeURIComponent(rawValue);
        if (!decoded) continue;
        if (key === 'message') messageClientId = decoded;
        else deviceId = decoded;
      } catch {
        // 参数编码非法 → 按无该参数处理
      }
    }
  }
  return { sessionId, messageClientId, deviceId };
}

/**
 * 会话深链的文本匹配正则(ASCII 白名单,CJK / 空白 / 中文标点处天然收尾)。
 * tokenizer 与标题预取共用同一来源;`g` flag 使用方需注意 lastIndex,
 * 这里每次调用都新建实例避免共享状态。
 */
export function createSessionLinkPattern(): RegExp {
  return new RegExp(SESSION_DEEP_LINK_RE_SOURCE, 'g');
}

export const SESSION_DEEP_LINK_RE_SOURCE =
  `(?:${DEEP_LINK_SCHEME_GROUP}):\\/\\/session\\/[A-Za-z0-9%~_-]+(?:\\?[A-Za-z0-9%&=~._-]*)?`;

/** 剥掉裸链接匹配尾部粘连的英文标点(句尾 `.` `,` 等),返回修剪后的 URL。 */
export function trimSessionLinkMatch(match: string): string {
  return match.replace(/[.,;:!?]+$/, '');
}

const PROJECT_LINK_PREFIX = `${BRAND_IDENTITY.primaryScheme}://project/`;
const PROJECT_LINK_PREFIXES = DEEP_LINK_SCHEMES.map((s) => `${s}://project/`);

/**
 * 解析 `xdt-maker://project/<urlencoded-workingDir>` → workingDir(目标端
 * native 绝对路径)。非本形态 / 为空 / 解码失败 → null。与桌面端
 * renderer/lib/deepLink.ts 的 parseProjectDeepLinkHref 等价镜像。
 */
export function parseProjectDeepLinkUrl(url: string): { workingDir: string } | null {
  if (typeof url !== 'string') return null;
  const prefix = matchPrefix(url, PROJECT_LINK_PREFIXES);
  if (!prefix) return null;
  const rest = url.slice(prefix.length);
  const hashIdx = rest.indexOf('#');
  const noHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const queryIdx = noHash.indexOf('?');
  const raw = (queryIdx >= 0 ? noHash.slice(0, queryIdx) : noHash).replace(/\/+$/, '');
  if (!raw) return null;
  let workingDir: string;
  try {
    workingDir = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return workingDir ? { workingDir } : null;
}

export const PROJECT_DEEP_LINK_RE_SOURCE =
  `(?:${DEEP_LINK_SCHEME_GROUP}):\\/\\/project\\/[A-Za-z0-9%~._!*-]+(?![A-Za-z0-9%~._!*('-])`;

export function createProjectLinkPattern(): RegExp {
  return new RegExp(PROJECT_DEEP_LINK_RE_SOURCE, 'g');
}

function isMarkdownEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charCodeAt(cursor) === 92; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Locate the matching `[` for the `]` in `[label](deep-link)`. */
export function findMarkdownLabelStart(text: string, closeBracketIndex: number): number {
  if (isMarkdownEscaped(text, closeBracketIndex)) return -1;
  let depth = 1;
  for (let cursor = closeBracketIndex - 1; cursor >= 0; cursor -= 1) {
    const code = text.charCodeAt(cursor);
    if (code === 10) return -1;
    if (code !== 91 && code !== 93) continue;
    if (isMarkdownEscaped(text, cursor)) continue;
    if (code === 93) depth += 1;
    else if (--depth === 0) return cursor;
  }
  return -1;
}

export function unescapeMarkdownLabelBrackets(label: string): string {
  return label.replace(/\\([[\]])/g, '$1');
}

/** workingDir 末段目录名(POSIX / Windows 分隔符都认;取不出末段回退原串)。 */
export function projectDisplayName(workingDir: string): string {
  const trimmed = workingDir.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return base || workingDir;
}

/** UUID 展示辅助:截成 `83639512…7ed0`,与桌面端 lib/sessionId.ts 等价镜像。 */
export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 13) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}

/** 从一段消息文本里抽出全部 session 深链的 sessionId(去重),给标题 map 预取用。 */
export function extractSessionLinkIds(text: string): string[] {
  if (!text || !SESSION_LINK_PREFIXES.some((p) => text.includes(p))) return [];
  const ids = new Set<string>();
  const pattern = createSessionLinkPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const target = parseSessionDeepLinkUrl(trimSessionLinkMatch(match[0]));
    if (target) ids.add(target.sessionId);
  }
  return [...ids];
}
