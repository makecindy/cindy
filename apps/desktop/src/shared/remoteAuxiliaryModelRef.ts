import {
  decodeCatalogModelPin,
  encodeCatalogModelPin,
  type CatalogModelPinRoute,
} from './catalogModelPin.js';

/** Reserved provider namespace inside the backwards-compatible catalog pin. */
export const REMOTE_AUXILIARY_PROVIDER_PREFIX = 'cindy-remote-aux:';
const V1_PREFIX = `${REMOTE_AUXILIARY_PROVIDER_PREFIX}//v1/`;

export interface RemoteAuxiliaryRoute extends CatalogModelPinRoute {
  deviceId: string;
}

/** Includes unknown versions and damaged reserved routes: never resolve these locally. */
export function isReservedRemoteAuxiliaryModelRef(ref: string): boolean {
  if (!ref.startsWith('cat:')) return false;
  const end = ref.indexOf(':', 4);
  if (end < 0) return false;
  try {
    return decodeURIComponent(ref.slice(4, end)).toLowerCase().startsWith(REMOTE_AUXILIARY_PROVIDER_PREFIX);
  } catch {
    return false;
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Reserved-namespace predicate, including unsupported versions. */
export const isRemoteAuxiliaryModelRef = isReservedRemoteAuxiliaryModelRef;

export function encodeRemoteAuxiliaryModelRef(route: RemoteAuxiliaryRoute): string {
  if (!route.deviceId || !route.providerId || !route.model
    || /[\s/\\]/u.test(route.deviceId)
    || hasControlCharacters(route.providerId + route.model)
    || !['codex', 'claude-code', 'pi'].includes(route.agentKind)
    || route.providerId.toLowerCase().startsWith(REMOTE_AUXILIARY_PROVIDER_PREFIX)
    || route.deviceId.startsWith('share:')) {
    throw new TypeError('Invalid remote auxiliary route');
  }
  return encodeCatalogModelPin({
    ...route,
    providerId: `${V1_PREFIX}${encodeURIComponent(route.deviceId)}/${encodeURIComponent(route.providerId)}`,
  });
}

/** Only supported v1 identities decode; reserved unknown versions remain unavailable. */
export function decodeRemoteAuxiliaryModelRef(ref: string): RemoteAuxiliaryRoute | null {
  const route = decodeCatalogModelPin(ref);
  if (!route?.providerId.startsWith(V1_PREFIX)) return null;
  const parts = route.providerId.slice(V1_PREFIX.length).split('/');
  if (parts.length !== 2) return null;
  try {
    const result = {
      deviceId: decodeURIComponent(parts[0]!),
      providerId: decodeURIComponent(parts[1]!),
      agentKind: route.agentKind,
      model: route.model,
    };
    // Use the same structural validation for both entry points.
    encodeRemoteAuxiliaryModelRef(result);
    return result;
  } catch {
    return null;
  }
}
