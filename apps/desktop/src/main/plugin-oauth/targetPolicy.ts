import {
  parseDeviceAuthorizationUrl,
  parsePluginAuthorizationRequest,
  type PluginAuthorizationRequest,
} from '@cindy/device-link';
import { ghostNetworkHostMatches, type GhostManifest } from '../../shared/ghost.js';
import { builtinAuthorizationTargets } from './builtinAuthorizationTargets.js';

/** Narrow only browser authorization delegation; ordinary in-flight plugin network capabilities are unchanged. */
export function bindDeviceAuthorizationTarget(
  manifest: GhostManifest,
  raw: string,
): (current: GhostManifest) => void {
  const url = new URL(parseDeviceAuthorizationUrl(raw));
  const snapshot = JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    network: manifest.network ?? null,
  });
  const allowed = (m: GhostManifest) => {
    if (url.port) return false; // HTTPS default only; no alternate local/private service on a permitted hostname.
    const builtin = Object.hasOwn(builtinAuthorizationTargets, m.id)
      ? builtinAuthorizationTargets[m.id]
      : undefined;
    if (builtin) return builtin(url);
    const declaration = m.network;
    const oauthOrigins = (declaration?.secrets ?? []).flatMap((s) =>
      s.oauth ? [new URL(s.oauth.authorizeUrl).origin] : [],
    );
    const hosts = declaration?.hosts ?? [];
    // Undeclared targets fail closed. An extra confirmation is not a substitute for a trusted target.
    return (
      oauthOrigins.includes(url.origin) ||
      hosts.some((h) => ghostNetworkHostMatches(h, url.hostname))
    );
  };
  if (!allowed(manifest)) throw new Error('DEVICE_AUTHORIZATION_TARGET_REJECTED');
  return (current) => {
    if (
      snapshot !==
        JSON.stringify({
          id: current.id,
          version: current.version,
          network: current.network ?? null,
        }) ||
      !allowed(current)
    )
      throw new Error('DEVICE_AUTHORIZATION_TARGET_REJECTED');
  };
}

/** Typed mode selection does not relax the current provider/manifest target binding. */
export function bindPluginAuthorizationTarget(
  manifest: GhostManifest,
  raw: PluginAuthorizationRequest,
): (current: GhostManifest) => void {
  const request = parsePluginAuthorizationRequest(raw);
  if (request.kind === 'loopback' && Object.hasOwn(builtinAuthorizationTargets, manifest.id))
    throw new Error('PLUGIN_AUTHORIZATION_TARGET_REJECTED');
  return bindDeviceAuthorizationTarget(manifest, request.url);
}
