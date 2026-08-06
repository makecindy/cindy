import { resolveDefaultModel, type Catalog } from '@cindy/model-providers';

export const FALLBACK_AUTH_MODEL = 'claude-sonnet-4-6';

/** Resolve the default model stored on a newly mapped auth profile. */
export function defaultAuthModel(catalog: Pick<Catalog, 'providers' | 'defaults'>): string {
  return resolveDefaultModel(
    catalog,
    'claude-code',
    'session',
    FALLBACK_AUTH_MODEL,
  );
}
