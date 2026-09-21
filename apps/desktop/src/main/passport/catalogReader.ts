import type { WorkLouderCodexTaskCatalog, WorkLouderCodexTaskCatalogInput } from '../worklouder-codex/taskSlots.js';

export interface PassportTaskCatalogReaderDeps {
  getScope(): string | null;
  readPublished(scope: string): readonly WorkLouderCodexTaskCatalogInput[] | null;
  readLocal(): Promise<WorkLouderCodexTaskCatalog>;
  build(rows: readonly WorkLouderCodexTaskCatalogInput[]): WorkLouderCodexTaskCatalog;
}

export interface PassportTaskCatalogReader {
  readFresh(): Promise<WorkLouderCodexTaskCatalog>;
  readForRefresh(): Promise<WorkLouderCodexTaskCatalog>;
  hasCurrentSnapshot(): boolean;
  clear(): void;
}

/** Keep a good catalog through transient startup/storage errors without crossing owners. */
export function createPassportTaskCatalogReader(deps: PassportTaskCatalogReaderDeps): PassportTaskCatalogReader {
  let cached: { scope: string; catalog: WorkLouderCodexTaskCatalog } | null = null;
  let cacheEpoch = 0;

  const clearCache = (): void => {
    cached = null;
    cacheEpoch += 1;
  };

  const currentScope = (): string => {
    const scope = deps.getScope();
    if (!scope) {
      clearCache();
      throw new Error('Passport task catalog scope unavailable');
    }
    if (cached && cached.scope !== scope) clearCache();
    return scope;
  };

  const readFresh = async (): Promise<WorkLouderCodexTaskCatalog> => {
    const scope = currentScope();
    const epoch = cacheEpoch;
    const published = deps.readPublished(scope);
    const catalog = published !== null ? deps.build(published) : await deps.readLocal();
    if (cacheEpoch !== epoch || deps.getScope() !== scope) {
      clearCache();
      throw new Error('Passport task catalog scope changed');
    }
    cached = { scope, catalog };
    return catalog;
  };

  return {
    readFresh,
    async readForRefresh(): Promise<WorkLouderCodexTaskCatalog> {
      try {
        return await readFresh();
      } catch (error) {
        const scope = deps.getScope();
        if (scope && cached?.scope === scope) return cached.catalog;
        throw error;
      }
    },
    hasCurrentSnapshot(): boolean {
      const scope = deps.getScope();
      return Boolean(scope && cached?.scope === scope);
    },
    clear(): void {
      clearCache();
    },
  };
}
