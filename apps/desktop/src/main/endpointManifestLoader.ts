import {
  readTrustedEndpointCache,
  resolveResilientEndpointManifest,
  type ClientEndpointRegion,
  type ResilientEndpointDeps,
} from '@cindy/maker-shared/client-endpoints';
import { readEndpointManifestCache, writeEndpointManifestCache } from './endpointManifestCache';

/** Keep the legacy build cache readable; each realm now writes its own atomic file. */
export function resolveDesktopEndpointManifest(
  userDataDir: string,
  region: ClientEndpointRegion,
  baseUrl: string,
  fetchText: ResilientEndpointDeps['fetchText'],
) {
  const sourceUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/endpoint.json` : '';
  return resolveResilientEndpointManifest({
    region,
    sourceUrl,
    fetchText,
    readCache: () => {
      const scoped = readEndpointManifestCache(userDataDir, region);
      if (readTrustedEndpointCache(scoped, region, sourceUrl)) return scoped;
      return readEndpointManifestCache(userDataDir);
    },
    writeCache: (entry) => writeEndpointManifestCache(userDataDir, entry, region),
  });
}
