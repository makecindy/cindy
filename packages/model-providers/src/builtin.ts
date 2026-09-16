import type { Catalog, Provider } from './types.js';

/** No install-time catalog. Hosts install a validated server or server-cache snapshot. */
export const EMPTY_CATALOG: Catalog = { version: '0', providers: [], presets: [] };
export let SERVER_CATALOG: Catalog = EMPTY_CATALOG;
export function installServerCatalog(catalog: Catalog): void { SERVER_CATALOG = catalog; }

/** Declared windows are verified data; SDK discovery keeps its own evidence flags. */
export function withVerifiedStaticWindows(provider: Provider): Provider {
  const models: Provider['models'] = {};
  let changed = false;
  for (const [agent, list] of Object.entries(provider.models) as Array<
    [keyof Provider['models'], Provider['models'][keyof Provider['models']]]
  >) {
    if (!list) continue;
    models[agent] = list.map((m) => {
      if (m.contextWindowVerified !== undefined) return m;
      changed = true;
      return { ...m, contextWindowVerified: true };
    });
  }
  return changed ? { ...provider, models } : provider;
}
