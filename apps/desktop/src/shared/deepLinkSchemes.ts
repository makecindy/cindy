/**
 * deepLinkSchemes — 深链 scheme 的 main / renderer 共用单点。
 *
 * scheme 事实源在 `@cindy/maker-shared/brand-identity`(`BRAND_IDENTITY.primaryScheme`
 * + `legacySchemes`,2026-07 品牌翻转后为 cindy 主 + xdt-maker 历史);本模块把它
 * 派生成解析 / 生成两侧需要的形态,双端(src/main、src/renderer)只从这里取值,
 * 不再各自硬编码字面量:
 *  - **生成**:新链接一律用主 scheme(`buildDeepLink` / `DEEP_LINK_URL_PREFIX`);
 *  - **解析**:主 + 历史 scheme 都认(`matchDeepLinkPrefix` / 正则 scheme 组),
 *    存量消息里的 `xdt-maker://` 老链接永远可点。
 *
 * ⚠️ 边界:这里只管**深链**(OS 级注册的 `<scheme>://session|project|focus/...`)。
 * `xdt-image://` / `xdt-file://` 等进程内资源 scheme 是 B 类永久标识符,与品牌
 * 无关,不从这里派生。
 */

import { BRAND_IDENTITY, allDeepLinkSchemes } from '@cindy/maker-shared/brand-identity';

/** 深链主 scheme(生成侧唯一使用的 scheme)。 */
export const DEEP_LINK_PRIMARY_SCHEME: string = BRAND_IDENTITY.primaryScheme;

/** 解析 / OS 注册需要认的全部 scheme(主 + 历史),主 scheme 恒为首位。 */
export const DEEP_LINK_SCHEMES: readonly string[] = allDeepLinkSchemes();

/** 生成侧 URL 前缀:`cindy://`。 */
export const DEEP_LINK_URL_PREFIX = `${DEEP_LINK_PRIMARY_SCHEME}://`;

/** 解析侧要认的全部 URL 前缀(与 DEEP_LINK_SCHEMES 同序,主前缀恒为首位)。 */
export const DEEP_LINK_URL_PREFIXES: readonly string[] = DEEP_LINK_SCHEMES.map(
  (scheme) => `${scheme}://`,
);

/**
 * settings/providers 深链的 connect id 边界。
 * connect 可指向内置 provider 或 preset：字符集覆盖 catalog provider id 的
 * `[A-Za-z0-9_-]` 契约，也覆盖 preset 的小写 slug 子集；长度上限只约束外部
 * URL 输入，避免把无界字符串送进 IPC / renderer。
 */
const DEEP_LINK_PROVIDER_CONNECT_ID_RE = /^[A-Za-z0-9_-]+$/;
export const DEEP_LINK_PROVIDER_CONNECT_ID_MAX_LENGTH = 128;

export function isDeepLinkProviderConnectId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= DEEP_LINK_PROVIDER_CONNECT_ID_MAX_LENGTH
    && DEEP_LINK_PROVIDER_CONNECT_ID_RE.test(value)
  );
}

/**
 * 内嵌进匹配正则的 scheme 备选组源(非捕获):`(?:cindy|xdt-maker)`。
 * scheme 里的 `-` 在组内是字面量,其余字符按正则元字符防御性转义
 * (scheme 值来自 brand-identity,理论上永远是 [a-z-],转义只是兜底)。
 */
export const DEEP_LINK_SCHEME_RE_GROUP = `(?:${DEEP_LINK_SCHEMES.map((scheme) =>
  scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
).join('|')})`;

/**
 * url 若以任一深链前缀(`cindy://` / `xdt-maker://`)开头,返回命中的前缀;
 * 否则 null。解析端一律用它取前缀长度切片,**禁止**按固定字面量长度切
 * (双 scheme 长度不同,写死长度会切错)。
 */
export function matchDeepLinkPrefix(url: string): string | null {
  if (typeof url !== 'string') return null;
  for (const prefix of DEEP_LINK_URL_PREFIXES) {
    if (url.startsWith(prefix)) return prefix;
  }
  return null;
}

/** url 是否是本产品深链(任一 scheme)。 */
export function isDeepLinkUrl(url: string): boolean {
  return matchDeepLinkPrefix(url) !== null;
}

/** WHATWG `URL.protocol`(形如 `cindy:`,带冒号)是否属于本产品深链 scheme。 */
export function isDeepLinkProtocol(protocol: string): boolean {
  return DEEP_LINK_SCHEMES.some((scheme) => protocol === `${scheme}:`);
}

/** 文本里是否出现任一深链前缀(linkify / 粘贴管线的快速预筛)。 */
export function textContainsDeepLink(text: string): boolean {
  return DEEP_LINK_URL_PREFIXES.some((prefix) => text.includes(prefix));
}

/**
 * 剥掉「任一 scheme 前缀 + 指定路径前缀」,返回剩余部分;不匹配 → null。
 * 例:stripDeepLinkPathPrefix('xdt-maker://session/abc?x=1', 'session/')
 * → 'abc?x=1';stripDeepLinkPathPrefix('cindy://project/x', 'session/') → null。
 * 注意剩余部分可能是空串(`cindy://session/`),调用方自行判空。
 */
export function stripDeepLinkPathPrefix(url: string, pathPrefix: string): string | null {
  const schemePrefix = matchDeepLinkPrefix(url);
  if (schemePrefix === null) return null;
  const rest = url.slice(schemePrefix.length);
  return rest.startsWith(pathPrefix) ? rest.slice(pathPrefix.length) : null;
}

/** url 是否形如 `<任一scheme>://<pathPrefix>...`(session / project / session-card 分支判定)。 */
export function hasDeepLinkPathPrefix(url: string, pathPrefix: string): boolean {
  return stripDeepLinkPathPrefix(url, pathPrefix) !== null;
}

/** 生成:主 scheme 深链。pathPart 形如 `session/<encoded-id>`(编码由调用方负责)。 */
export function buildDeepLink(pathPart: string): string {
  return `${DEEP_LINK_URL_PREFIX}${pathPart}`;
}
