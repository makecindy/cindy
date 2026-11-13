import { app } from 'electron';
import { parsePluginObjectUrl, type PluginObjectUrlOptions } from '@cindy/plugin-protocol';
import { getClientEndpoint } from '../clientEndpointsService.js';

/** An explicit local Plugin endpoint is the sole HTTP delivery exception in an unpackaged Host. */
export function pluginObjectUrlOptions(): PluginObjectUrlOptions | undefined {
  if (app.isPackaged !== false) return undefined;
  try {
    const endpoint = new URL(getClientEndpoint('pluginApiBaseUrl'));
    if (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) &&
        !endpoint.username && !endpoint.password && !endpoint.hash)
      return { developmentObjectOrigin: endpoint.origin };
  } catch { /* Missing or invalid endpoint never enables HTTP. */ }
  return undefined;
}

export function pluginObjectUrlAllowed(url: string, options: PluginObjectUrlOptions | undefined): boolean {
  try { parsePluginObjectUrl(url, 'download.url', options); return true; } catch { return false; }
}
