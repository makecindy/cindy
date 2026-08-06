import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { Catalog } from '@cindy/model-providers';

import {
  CODEX_CINDY_MODEL_CATALOG_STATE_FILE,
  mergeCodexModelsCache,
  nativeCodexModelsFromCache,
  parseCodexModelCatalogState,
  parseCodexModelsResponse,
  projectVerifiedCodexModels,
  type CodexModelCatalogState,
  type CodexModelInfoLike,
  type CodexModelsCache,
} from './codex-model-catalog.js';
import {
  CodexModelCatalogNeedsNativeModelsError,
  CodexModelCatalogStaleGenerationError,
} from './codex-model-catalog-sync.js';

interface WriteCodexModelCatalogCacheInput {
  codexHome: string;
  catalog: Catalog;
  revision: number;
  nativeModels?: readonly CodexModelInfoLike[] | null;
  isCurrent?: () => boolean;
  now?: Date;
}

function ensureCurrent(isCurrent?: () => boolean): void {
  if (isCurrent && !isCurrent()) throw new CodexModelCatalogStaleGenerationError();
}

function cachePath(codexHome: string): string {
  return path.join(codexHome, 'models_cache.json');
}

export function codexModelCatalogStatePath(codexHome: string): string {
  return path.join(codexHome, CODEX_CINDY_MODEL_CATALOG_STATE_FILE);
}

function parseModelsCache(value: unknown): CodexModelsCache | null {
  if (!value || typeof value !== 'object') return null;
  const models = parseCodexModelsResponse(value);
  const clientVersion = (value as { client_version?: unknown }).client_version;
  if (!models || typeof clientVersion !== 'string' || clientVersion.length === 0) return null;
  const injected = (value as { cindy_injected_slugs?: unknown }).cindy_injected_slugs;
  if (injected !== undefined && !Array.isArray(injected)) return null;
  return {
    fetched_at: typeof (value as { fetched_at?: unknown }).fetched_at === 'string'
      ? (value as { fetched_at: string }).fetched_at
      : new Date(0).toISOString(),
    etag: typeof (value as { etag?: unknown }).etag === 'string'
      ? (value as { etag: string }).etag
      : '',
    client_version: clientVersion,
    models,
    ...(Array.isArray(injected)
      ? {
          cindy_injected_slugs: injected.filter(
            (slug): slug is string => typeof slug === 'string' && slug.length > 0,
          ),
        }
      : {}),
  };
}

async function readCatalogState(codexHome: string): Promise<CodexModelCatalogState | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(codexModelCatalogStatePath(codexHome), 'utf8'));
    const parsed = parseCodexModelCatalogState(raw);
    if (!parsed) throw new CodexModelCatalogNeedsNativeModelsError('invalid Cindy Codex catalog state');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    if (error instanceof CodexModelCatalogNeedsNativeModelsError) throw error;
    throw new CodexModelCatalogNeedsNativeModelsError(
      `Cindy Codex catalog state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readCatalogStateSync(codexHome: string): CodexModelCatalogState | null {
  try {
    return parseCodexModelCatalogState(
      JSON.parse(readFileSync(codexModelCatalogStatePath(codexHome), 'utf8')),
    );
  } catch {
    return null;
  }
}

function effectiveCatalogState(
  cache: Pick<CodexModelsCache, 'etag'>,
  state: CodexModelCatalogState | null,
): CodexModelCatalogState | null {
  if (!state?.pendingInjectedSlugs) return state;
  // The cache rename is the transaction commit point. A matching Cindy etag proves that it
  // succeeded even if the final sidecar rename failed; otherwise retain the protective union so
  // the old vendor cache cannot reclassify stale Cindy injections as native models.
  if (cache.etag !== `"cindy-catalog-${state.revision}"`) return state;
  return {
    revision: state.revision,
    injectedSlugs: state.pendingInjectedSlugs,
  };
}

function isCindyCatalogEtag(etag: string): boolean {
  return /^"cindy-catalog-\d+"$/.test(etag);
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsp.writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await fsp.rename(tempPath, filePath);
    await fsp.chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeCodexModelCatalogCache(
  input: WriteCodexModelCatalogCacheInput,
): Promise<void> {
  ensureCurrent(input.isCurrent);
  const file = cachePath(input.codexHome);
  let parsed: CodexModelsCache;
  try {
    const value = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
    const cache = parseModelsCache(value);
    if (!cache) throw new Error('invalid Codex models cache');
    parsed = cache;
  } catch (error) {
    if (error instanceof CodexModelCatalogNeedsNativeModelsError) throw error;
    throw new CodexModelCatalogNeedsNativeModelsError(
      `Codex native model cache is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let state: CodexModelCatalogState | null;
  try {
    state = await readCatalogState(input.codexHome);
  } catch (error) {
    if (!input.nativeModels || input.nativeModels.length === 0) throw error;
    state = null;
  }
  state = effectiveCatalogState(parsed, state);
  // A Cindy etag proves the vendor-shaped file has already contained projected models. Without
  // provenance (or a fresh model/list snapshot) those entries cannot safely be reclassified as
  // native: doing so would make a removed injection survive every later catalog refresh.
  if (
    !state
    && isCindyCatalogEtag(parsed.etag)
    && (!input.nativeModels || input.nativeModels.length === 0)
  ) {
    throw new CodexModelCatalogNeedsNativeModelsError(
      'Cindy Codex catalog provenance is unavailable; native model warm-up is required',
    );
  }
  if (state) parsed.cindy_injected_slugs = state.injectedSlugs;
  const nativeModels = !state && input.nativeModels && input.nativeModels.length > 0
    ? input.nativeModels.map((model) => ({ ...model }))
    : nativeCodexModelsFromCache(parsed, state);
  const projected = projectVerifiedCodexModels(input.catalog);
  const hasNativeTemplate = nativeModels.some((model) =>
    model.supported_in_api === true && typeof model.base_instructions === 'string',
  );
  if (projected.length > 0 && !hasNativeTemplate) {
    throw new CodexModelCatalogNeedsNativeModelsError('Codex native ModelInfo template is unavailable');
  }

  const currentCache: CodexModelsCache = {
    ...parsed,
    models: nativeModels,
    cindy_injected_slugs: state?.injectedSlugs ?? parsed.cindy_injected_slugs,
  };
  const payload = mergeCodexModelsCache(
    input.catalog,
    currentCache,
    input.revision,
    input.now,
  );
  const payloadSlugs = new Set(payload.models.map((model) => model.slug));
  if (projected.some((model) => !payloadSlugs.has(model.slug))) {
    throw new CodexModelCatalogNeedsNativeModelsError('Codex catalog projection lacks a native template');
  }

  const injectedSlugs = payload.cindy_injected_slugs ?? [];
  const previousInjectedSlugs = state?.injectedSlugs ?? parsed.cindy_injected_slugs ?? [];
  const protectiveInjectedSlugs = [
    ...new Set([...injectedSlugs, ...previousInjectedSlugs]),
  ];
  const needsFinalSidecar = protectiveInjectedSlugs.length > injectedSlugs.length;
  const { cindy_injected_slugs: _legacyMarker, ...vendorCache } = payload;
  // Publish a protective provenance union first. If the vendor-cache rename fails, old injected
  // ids stay classified as Cindy-owned; if the final sidecar rename fails, pendingInjectedSlugs plus
  // the cache etag make the transaction recoverable on the next attempt.
  ensureCurrent(input.isCurrent);
  await writeJsonAtomically(codexModelCatalogStatePath(input.codexHome), {
    revision: input.revision,
    injectedSlugs: protectiveInjectedSlugs,
    ...(needsFinalSidecar ? { pendingInjectedSlugs: injectedSlugs } : {}),
  } satisfies CodexModelCatalogState);
  ensureCurrent(input.isCurrent);
  await writeJsonAtomically(file, vendorCache);
  if (needsFinalSidecar) {
    ensureCurrent(input.isCurrent);
    await writeJsonAtomically(codexModelCatalogStatePath(input.codexHome), {
      revision: input.revision,
      injectedSlugs,
    } satisfies CodexModelCatalogState);
  }
}

/** Read-through for the proxy. A malformed/missing sidecar fails closed. */
export function readNativeCodexModelsFromCache(codexHome: string): CodexModelInfoLike[] | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(codexHome), 'utf8')) as unknown;
    const cache = parseModelsCache(raw);
    if (!cache) return null;
    const state = effectiveCatalogState(cache, readCatalogStateSync(codexHome));
    const hasSidecar = (() => {
      try {
        readFileSync(codexModelCatalogStatePath(codexHome), 'utf8');
        return true;
      } catch {
        return false;
      }
    })();
    if (!state && (hasSidecar || isCindyCatalogEtag(cache.etag))) return null;
    return nativeCodexModelsFromCache(cache, state);
  } catch {
    return null;
  }
}
