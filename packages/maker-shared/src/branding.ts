/**
 * branding — 产品品牌展示名的单一事实源（single source of truth）。
 *
 * 目标：把散落在 UI 文案、窗口标题、LLM 可见描述里的品牌名收敛到一处，
 * 未来改名只改这里（i18n 文案经 defaultVariables 注入 {{appName}} 同步生效）。
 *
 * 边界（改名时也【不要】跟随本常量变化的标识符，改了会造成数据迁移事故）：
 * 磁盘 / 协议 / 系统注册层标识符统一由 brandIdentity.ts 管理（2026-07 身份翻转时
 * 一次性切换并各自钉死），包括深链协议、userData 目录名、productName、deviceId
 * 前缀、AppUserModelId、bundle id，以及浏览器自动化的受管 profile 目录名
 * （mcp-integrations/browser.ts 的 MANAGED_PROFILE，翻转时定格 'Cindy'）。
 * 这些标识符之后同样不跟随本常量变化——与展示名解耦正是本模块存在的意义。
 *
 * 稳定标识符边界由本模块常量和相关测试维护，不随展示名迁移。
 */

/** 产品对用户 / LLM 展示的品牌名（唯一规范写法，不要再派生其它变体）。 */
export const BRAND_NAME = 'Cindy';

/** Monochrome silhouette of the Antigravity plugin icon (source blob 99877890). */
export const ANTIGRAVITY_MARK_PATH = 'M12 3.2c2.8 0 4 3.1 5 6.1 1.4 4.2 2.5 7.6 5.4 10.4h-1.5c-2.9 0-4.6-3.1-6.2-5.8-.9-1.4-1.7-2.1-2.7-2.1s-1.8.7-2.7 2.1c-1.6 2.7-3.3 5.8-6.2 5.8H1.6C4.5 16.9 5.6 13.5 7 9.3c1-3 2.2-6.1 5-6.1Z';

export function isAntigravityPluginId(id: string | null | undefined): boolean {
  return /^(?:_root__|_ns__[a-z0-9-]+__)?(?:agy|agy-acp|agy-plugin|cindy-antigravity-acp|cindy-antigravity-plugin|antigravity)$/i.test(id ?? '');
}

export function isAntigravityPluginName(name: string | null | undefined): boolean {
  return /^antigravity$/i.test(name?.trim() ?? '');
}

/** Accept local and remote quota source IDs, scoped plugin instances and extracted providers. */
export function isAntigravityProviderId(id: string | null | undefined, legacyName?: string): boolean {
  const match = /(?:^|:)acp-plugin:([^:]+):([^:~]+)(?:~[^:]+)?$/i.exec(id ?? '');
  return !!match && (isAntigravityPluginName(legacyName) ||
    (isAntigravityPluginId(match[1]) && /^(?:agy|antigravity)$/i.test(match[2] ?? '')));
}

export const ANTIGRAVITY_MARK_DATA_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${ANTIGRAVITY_MARK_PATH}"/></svg>`,
);
