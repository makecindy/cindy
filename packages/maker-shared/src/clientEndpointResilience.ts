import cnManifest from '../../../config/endpoint.json';
import globalManifest from '../../../config/endpoint.global.json';
import mirrors from '../../../config/endpoint-manifest-mirrors.json';
import {
  parseClientEndpointManifest,
  type ClientEndpointRegion,
  type ParseClientEndpointManifestResult,
} from './clientEndpointSchema';
import {
  findUntrustedCachedEndpoint,
  REGION_ENDPOINT_DOMAIN,
} from './clientEndpointOrigins';

export const ENDPOINT_DISCOVERY_TIMEOUT_MS = 2_500;
const STORAGE_TIMEOUT_MS = 500;
export const ENDPOINT_CACHE_MAX_CHARS = 128 * 1024;

export type EndpointManifestFetchResult =
  { ok: true; text: string } | { ok: false; detail: string };
export type EndpointManifestSource = 'network' | 'mirror' | 'cache' | 'bundled';
export interface EndpointManifestCacheEntry {
  savedAt: string;
  sourceUrl: string;
  manifestText: string;
}
export type ResilientEndpointResult =
  | {
      ok: true;
      parsed: Extract<ParseClientEndpointManifestResult, { ok: true }>;
      text: string;
      source: EndpointManifestSource;
    }
  | { ok: false; reason: string };

export function classifyEndpointManifestFailure(
  reason: string,
): 'network' | 'config' {
  if (!reason.startsWith('fetch-failed')) return 'config';
  const detail = reason.slice('fetch-failed'.length).replace(/^:/, '');
  if (detail === 'missing-manifest-base-url') return 'config';
  const status = /^http-(\d+)$/.exec(detail)?.[1];
  return status &&
    Number(status) < 500 &&
    ![407, 408, 425, 429].includes(Number(status))
    ? 'config'
    : 'network';
}

function parseForRegion(
  text: string,
  region: ClientEndpointRegion,
): ParseClientEndpointManifestResult {
  const parsed = parseClientEndpointManifest(text);
  if (parsed.ok && parsed.region !== null && parsed.region !== region) {
    return { ok: false, reason: `region-mismatch:${region}:${parsed.region}` };
  }
  return parsed;
}

export function parseTrustedEndpointSnapshot(
  text: string,
  region: ClientEndpointRegion,
) {
  if (text.length > ENDPOINT_CACHE_MAX_CHARS) return null;
  const parsed = parseForRegion(text, region);
  if (
    !parsed.ok ||
    findUntrustedCachedEndpoint(parsed.endpoints, {
      regionDomain: REGION_ENDPOINT_DOMAIN[region],
      crossRegionDomain: REGION_ENDPOINT_DOMAIN.global,
    })
  )
    return null;
  return parsed;
}

const bundledManifests = { cn: cnManifest, global: globalManifest };

/** Custom/self-hosted discovery must never fall back to Cindy production. */
export function getBundledEndpointManifest(
  region: ClientEndpointRegion,
  sourceUrl: string,
): string | null {
  const manifest = bundledManifests[region];
  if (sourceUrl !== `${manifest.cdnBaseUrl}/endpoint.json`) return null;
  return JSON.stringify(manifest);
}

/** Mirrors are build-time trust anchors, never supplied by downloaded/cache data. */
export function getEndpointManifestMirrors(
  region: ClientEndpointRegion,
  sourceUrl: string,
): readonly string[] {
  return getBundledEndpointManifest(region, sourceUrl) === null
    ? []
    : mirrors[region];
}

export function readTrustedEndpointCache(
  value: unknown,
  region: ClientEndpointRegion,
  sourceUrl: string,
): {
  parsed: Extract<ParseClientEndpointManifestResult, { ok: true }>;
  text: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<EndpointManifestCacheEntry>;
  if (
    entry.sourceUrl !== sourceUrl ||
    typeof entry.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(entry.savedAt)) ||
    typeof entry.manifestText !== 'string'
  )
    return null;
  const parsed = parseTrustedEndpointSnapshot(entry.manifestText, region);
  return parsed ? { parsed, text: entry.manifestText } : null;
}

/** Bounds optional storage and buggy transports too; late completion cannot apply endpoints. */
async function bounded<T>(
  operation: () => T | Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ResilientEndpointDeps {
  region: ClientEndpointRegion;
  sourceUrl: string;
  /** Transport must cancel its request at timeoutMs; no credentials are sent. */
  fetchText(
    url: string,
    timeoutMs: number,
  ): Promise<EndpointManifestFetchResult>;
  readCache?(): unknown | Promise<unknown>;
  writeCache?(entry: EndpointManifestCacheEntry): unknown | Promise<unknown>;
  timeoutMs?: number;
  /** Host/build injected only. Undefined selects the compiled anchors. */
  mirrorUrls?: readonly string[];
  bundledText?: string | null;
}

/** One complete snapshot per resolution. Primary configuration errors remain fatal. */
export async function resolveResilientEndpointManifest(
  deps: ResilientEndpointDeps,
): Promise<ResilientEndpointResult> {
  if (!deps.sourceUrl)
    return { ok: false, reason: 'fetch-failed:missing-manifest-base-url' };
  const timeoutMs = deps.timeoutMs ?? ENDPOINT_DISCOVERY_TIMEOUT_MS;
  // At most one independent mirror keeps the whole discovery budget bounded.
  const mirrorUrls =
    deps.mirrorUrls ?? getEndpointManifestMirrors(deps.region, deps.sourceUrl);
  const urls = [...new Set([deps.sourceUrl, ...mirrorUrls])].slice(0, 2);
  let reason = 'fetch-failed';
  for (const [index, url] of urls.entries()) {
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      reason = 'invalid-manifest-url';
      if (index === 0) return { ok: false, reason };
      continue;
    }
    if (address.protocol !== 'https:' || address.username || address.password) {
      reason = 'invalid-manifest-url';
      if (index === 0) return { ok: false, reason };
      continue;
    }
    const fetched = await bounded<EndpointManifestFetchResult>(
      async () => {
        try {
          return await deps.fetchText(url, timeoutMs);
        } catch (error) {
          const detail =
            error instanceof Error
              ? `${error.name}:${error.message}`
              : String(error);
          return {
            ok: false,
            detail: detail.replace(/\s+/g, ' ').trim().slice(0, 120),
          };
        }
      },
      timeoutMs,
      { ok: false, detail: `timeout-${timeoutMs}ms` },
    );
    if (fetched.ok) {
      const parsed = parseForRegion(fetched.text, deps.region);
      if (!parsed.ok) {
        if (index === 0) return parsed;
        reason = parsed.reason;
        continue;
      }
      const restorable = parseTrustedEndpointSnapshot(
        fetched.text,
        deps.region,
      );
      // A mirror cannot redirect authentication to another region, even on old region-less manifests.
      if (index > 0 && !restorable) {
        reason = 'untrusted-mirror-endpoints';
        continue;
      }
      // Do not persist custom endpoint domains that the offline reader cannot trust.
      if (restorable)
        await bounded(
          () =>
            deps.writeCache?.({
              savedAt: new Date().toISOString(),
              sourceUrl: deps.sourceUrl,
              manifestText: fetched.text,
            }),
          STORAGE_TIMEOUT_MS,
          undefined,
        );
      return {
        ok: true,
        parsed,
        text: fetched.text,
        source: index === 0 ? 'network' : 'mirror',
      };
    }
    reason = `fetch-failed:${fetched.detail}`;
    if (index === 0 && classifyEndpointManifestFailure(reason) !== 'network')
      return { ok: false, reason };
  }
  const cached = readTrustedEndpointCache(
    await bounded(() => deps.readCache?.(), STORAGE_TIMEOUT_MS, undefined),
    deps.region,
    deps.sourceUrl,
  );
  if (cached) return { ok: true, ...cached, source: 'cache' };
  const text =
    deps.bundledText === undefined
      ? getBundledEndpointManifest(deps.region, deps.sourceUrl)
      : deps.bundledText;
  const parsed = text ? parseTrustedEndpointSnapshot(text, deps.region) : null;
  return parsed && text
    ? { ok: true, parsed, text, source: 'bundled' }
    : { ok: false, reason };
}
