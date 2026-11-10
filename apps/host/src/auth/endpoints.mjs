/**
 * Endpoint manifest for the host process.
 *
 * The manifests are the same build-time files the Desktop ships
 * (`config/endpoint.json` for CN, `config/endpoint.global.json` for Global), so
 * the host talks to the same auth server and never invents its own endpoints.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hostRuntimeLayout } from '../runtime-layout.mjs';

/**
 * @param {'cn' | 'global'} region
 * @param {string} [overrideDir]
 * @returns {{ authApiBaseUrl: string, authDesktopCallbackUrl?: string, deviceLinkApiBaseUrl?: string, oauthBrokerApiBaseUrl?: string, modelAccessApiBaseUrl?: string }}
 */
export function readAuthEndpoints(region, overrideDir = process.env.CINDY_HOST_ENDPOINT_DIR) {
  const dir = overrideDir?.trim() || hostRuntimeLayout().configDir;
  const file = path.join(dir, region === 'cn' ? 'endpoint.json' : 'endpoint.global.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = manifest.authApiBaseUrl;
  if (typeof base !== 'string' || !/^https:\/\//.test(base)) {
    throw new Error(`endpoint manifest has no usable authApiBaseUrl: ${file}`);
  }
  const callback = manifest.authDesktopCallbackUrl;
  return {
    authApiBaseUrl: base,
    ...(typeof manifest.oauthBrokerApiBaseUrl === 'string' && /^https:\/\//.test(manifest.oauthBrokerApiBaseUrl)
      ? { oauthBrokerApiBaseUrl: manifest.oauthBrokerApiBaseUrl } : {}),
    ...(typeof manifest.deviceLinkApiBaseUrl === 'string' && /^https:\/\//.test(manifest.deviceLinkApiBaseUrl)
      ? { deviceLinkApiBaseUrl: manifest.deviceLinkApiBaseUrl } : {}),
    ...(typeof manifest.modelAccessApiBaseUrl === 'string' && /^https:\/\//.test(manifest.modelAccessApiBaseUrl)
      ? { modelAccessApiBaseUrl: manifest.modelAccessApiBaseUrl } : {}),
    ...(typeof callback === 'string' && callback ? { authDesktopCallbackUrl: callback } : {}),
  };
}
