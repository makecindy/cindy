/**
 * imageProtocol.ts (image-local-cache M2)
 * ---------------------------------------------------------------------------
 * Registers the `xdt-image://` custom protocol used by the renderer to render
 * locally cached image files via standard `<img src>` requests.
 *
 * Two-step registration:
 *   1. imageSchemePrivilege — collected by protocolPrivileges.ts into the
 *      SINGLE registerSchemesAsPrivileged() call (the API replaces the whole
 *      list on every call, so per-module calls would wipe each other out).
 *      Must be registered BEFORE app.whenReady().
 *   2. registerImageProtocolHandler() — must run AFTER app.whenReady(). Wires
 *      the actual file-serving handler.
 */

import { protocol } from 'electron';
import { imageSchemePrivilege } from './protocolPrivileges.js';
import * as imageCacheStore from './imageCacheStore';

import { createLogger } from './logger';

const log = createLogger('imageProtocol');

const SCHEME = imageSchemePrivilege.scheme;

/** Privilege entry for the one-shot registerSchemesAsPrivileged at the index.ts entry. */
export { imageSchemePrivilege };

export function registerImageProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const { buffer, mimeType } = await imageCacheStore.readFile(request.url);
      // Cast Buffer → Uint8Array → ArrayBuffer slice so Response receives a
      // proper BodyInit. Buffer extends Uint8Array so this is essentially a
      // view; copying is unavoidable for a stable backing buffer.
      const body = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = (err as Error)?.message ?? '';
      if (msg.includes('path out of bounds') || msg.includes('invalid url') || msg.includes('malformed url')) {
        return new Response(null, { status: 403 });
      }
      if (code === 'ENOENT') {
        return new Response(null, { status: 404 });
      }
      log.error('[xdt-image] handler error:', err);
      return new Response(null, { status: 500 });
    }
  });
}
