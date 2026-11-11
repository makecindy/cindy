import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ENDPOINT_CACHE_MAX_CHARS,
  resolveResilientEndpointManifest,
  type ClientEndpointRegion,
  type EndpointManifestFetchResult,
  type ResilientEndpointDeps,
} from '@cindy/maker-shared/client-endpoints';

/** No env import: both startup and env's cross-region loader use this adapter. */
export async function fetchMobileEndpointManifest(
  url: string,
  timeoutMs: number,
): Promise<EndpointManifestFetchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(
      `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`,
      {
        signal: controller.signal,
      },
    );
    if (!response.ok) return { ok: false, detail: `http-${response.status}` };
    return { ok: true, text: await response.text() };
  } catch (error) {
    const detail =
      error instanceof Error ? `${error.name}:${error.message}` : String(error);
    return {
      ok: false,
      detail: timedOut
        ? `timeout-${timeoutMs}ms`
        : detail.replace(/\s+/g, ' ').slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveMobileEndpointManifest(
  region: ClientEndpointRegion,
  baseUrl: string,
  overrides: Partial<
    Pick<
      ResilientEndpointDeps,
      'fetchText' | 'timeoutMs' | 'readCache' | 'writeCache'
    >
  > = {},
) {
  const sourceUrl = baseUrl
    ? `${baseUrl.replace(/\/+$/, '')}/endpoint.json`
    : '';
  const key = `cindy.mobile.endpoint-manifest.v1.${region}.${encodeURIComponent(sourceUrl)}`;
  return resolveResilientEndpointManifest({
    region,
    sourceUrl,
    fetchText: fetchMobileEndpointManifest,
    readCache: async () => {
      const raw = await AsyncStorage.getItem(key);
      if (!raw || raw.length > ENDPOINT_CACHE_MAX_CHARS) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    writeCache: async (entry) => {
      const raw = JSON.stringify(entry);
      if (raw.length <= ENDPOINT_CACHE_MAX_CHARS)
        await AsyncStorage.setItem(key, raw);
    },
    ...overrides,
  });
}
