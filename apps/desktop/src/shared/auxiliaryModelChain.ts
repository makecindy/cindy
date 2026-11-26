import {
  decodeCatalogModelPin,
  encodeCatalogModelPin,
  type CatalogModelPinRoute,
} from './catalogModelPin.js';
import {
  isUtilityModelProviderKind,
  type UtilityModelProviderKind,
} from './utilityModelProfiles.js';

/** User-custom chain length. Empty list means follow the built-in automatic chain. */
export const AUXILIARY_MODEL_CHAIN_MAX = 3;

/**
 * Frozen automatic chain. Highest priority first.
 *
 * Keep this as a literal list. Do not rank it from the live catalog. The first
 * three routes are Cindy AI models present in both the CN and Global public
 * catalogs, so an account-scoped catalog can safely skip any route it does not
 * expose and continue through the same cross-tenant order.
 */
export const AUTO_AUXILIARY_MODEL_CHAIN = [
  encodeCatalogModelPin({
    providerId: 'xd',
    agentKind: 'codex',
    model: 'deepseek/deepseek-v4-flash',
  }),
  encodeCatalogModelPin({
    providerId: 'xd',
    agentKind: 'codex',
    model: 'tencent/hy3',
  }),
  encodeCatalogModelPin({
    providerId: 'xd',
    agentKind: 'codex',
    model: 'qwen/qwen3.8-flash',
  }),
] as const;

export type AuxiliaryModelRefKind = 'profile' | 'catalog';

export type ParsedAuxiliaryModelRef =
  | { kind: 'profile'; id: UtilityModelProviderKind }
  | { kind: 'catalog'; route: CatalogModelPinRoute };

export function parseAuxiliaryModelRef(value: string): ParsedAuxiliaryModelRef | null {
  if (isUtilityModelProviderKind(value)) {
    return { kind: 'profile', id: value };
  }
  const route = decodeCatalogModelPin(value);
  return route ? { kind: 'catalog', route } : null;
}

/**
 * 一格选的是一条智能路由(2026-11-26 用户裁决：辅助模型也要能用路由)。存的是路由 id，不是具体模型：
 * 用的时候由主进程换成路由里本机能用的那几个模型，路由此刻会选的排在最前，其余依次兜底
 * (resolveAuxiliaryModelChainCore 的 expandRouteRef)。不认识路由的启动器(Node Host)展开为空。
 */
export const AUXILIARY_ROUTE_REF_PREFIX = 'route:';

/** 路由引用里的路由 id；不是路由引用时为 null。 */
export function auxiliaryRouteRefId(value: string): string | null {
  if (!value.startsWith(AUXILIARY_ROUTE_REF_PREFIX)) return null;
  const id = value.slice(AUXILIARY_ROUTE_REF_PREFIX.length);
  return id.length > 0 && id.trim() === id ? id : null;
}

export function encodeAuxiliaryRouteRef(routeId: string): string {
  return `${AUXILIARY_ROUTE_REF_PREFIX}${routeId}`;
}

/** 能存的引用：具体模型(profile / 目录钉)或一条路由。执行前路由会被展开成具体模型。 */
export function isAuxiliaryModelRef(value: string): boolean {
  return parseAuxiliaryModelRef(value) !== null || auxiliaryRouteRefId(value) !== null;
}

/** Stable i18n suffixes for the frozen automatic chain, in the same order. */
export const AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS = [
  'cindyDeepseekV4Flash',
  'cindyHy3',
  'cindyQwen38Flash',
] as const;
