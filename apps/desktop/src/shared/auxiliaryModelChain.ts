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

export function isAuxiliaryModelRef(value: string): boolean {
  return parseAuxiliaryModelRef(value) !== null;
}

/** Stable i18n suffixes for the frozen automatic chain, in the same order. */
export const AUTO_AUXILIARY_MODEL_CHAIN_I18N_KEYS = [
  'cindyDeepseekV4Flash',
  'cindyHy3',
  'cindyQwen38Flash',
] as const;
