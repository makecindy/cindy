/**
 * modelProtocol.ts
 * ---------------------------------------------------------------------------
 * Registers the `xdt-model://` custom protocol used by `<model-viewer>` in
 * the renderer to load locally cached 3D model files (GLB today).
 *
 * Same two-step shape as imageProtocol / videoProtocol:
 *   1. modelSchemePrivilege — collected by protocolPrivileges.ts into the
 *      single registerSchemesAsPrivileged() call (BEFORE app.whenReady())
 *   2. registerModelProtocolHandler() — AFTER  app.whenReady()
 *
 * Why a custom protocol instead of `file://`: Chromium blocks cross-scheme
 * fetches from the renderer's http(s)-like origin to `file://`. The
 * <model-viewer> Web Component internally `fetch()`es the src URL, so we
 * need a privileged scheme with supportFetchAPI:true (mirrors xdt-image /
 * xdt-video). Range requests are NOT needed — model-viewer streams the full
 * .glb up front and parses, no seeking — so we always serve 200 + full body.
 */

import { protocol } from 'electron';
import { modelSchemePrivilege } from './protocolPrivileges.js';
import * as modelCacheStore from './modelCacheStore';

import { createLogger } from './logger';

const log = createLogger('modelProtocol');

const SCHEME = modelSchemePrivilege.scheme;

/** Privilege entry for the one-shot registerSchemesAsPrivileged at the index.ts entry.
 *  supportFetchAPI is load-bearing here: <model-viewer> pulls its src via
 *  fetch(), not an <img>/<video> element load. */
export { modelSchemePrivilege };

export function registerModelProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const { buffer, mimeType } = await modelCacheStore.readFile(request.url);
      const body = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(buffer.byteLength),
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = (err as Error)?.message ?? '';
      if (
        msg.includes('path out of bounds') ||
        msg.includes('invalid url') ||
        msg.includes('malformed url') ||
        msg.includes('unknown host')
      ) {
        return new Response(null, { status: 403 });
      }
      if (code === 'ENOENT') {
        return new Response(null, { status: 404 });
      }
      log.error('[xdt-model] handler error:', err);
      return new Response(null, { status: 500 });
    }
  });
}
