import { ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { statEntry, type DirEntry } from '@cindy/file-browser-core';
import {
  createHtmlPreview,
  copyPreviewFile,
  previewLocation,
  type HtmlPreviewArgs,
} from './html-preview.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from '../filePathPolicy.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { createLogger } from '../logger.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { getDbClient } from '../localDb/client/current.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isSharedTaskPeer } from '@cindy/device-link';
import { isIpcError } from '../../shared/ipc-errors.js';
import { previewTransportErrorCode, readPreviewMetadata } from './html-preview-read.js';

const log = createLogger('html-preview');
export const HTML_PREVIEW_CHANNEL = 'maker:html-preview:open';
interface RemoteSource {
  cached?(args: HtmlPreviewArgs, root: string, rel: string): Promise<string | null>;
  stat(
    args: HtmlPreviewArgs,
    root: string,
    rel: string,
    signal?: AbortSignal,
  ): Promise<Omit<DirEntry, 'name'>>;
  /** Validate the source even when size/mtime match; they are not a complete version. */
  read(args: HtmlPreviewArgs, root: string, entry: DirEntry, signal?: AbortSignal): Promise<string>;
}

const active = new Set<() => Promise<void>>();
const requests = new Map<string, { controller: AbortController; close?: () => Promise<void> }>();
let preparing = 0;
let shuttingDown = false;
export async function disposeHtmlPreviews(): Promise<void> {
  shuttingDown = true;
  for (const request of requests.values()) request.controller.abort();
  await Promise.allSettled([...active].map((close) => close()));
}
export function registerHtmlPreviewIpc(remote: RemoteSource): void {
  ipcMain.handle(HTML_PREVIEW_CHANNEL, async (event, args: HtmlPreviewArgs) => {
    assertTrustedAppRendererEvent(event);
    if (shuttingDown || preparing >= 8)
      throwIpcError('HTML_PREVIEW_TOO_LARGE', 'Preview capacity exceeded');
    if (
      args?.requestId !== undefined &&
      (typeof args.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(args.requestId))
    )
      throwIpcError('INVALID_PARAMS', 'Invalid preview request');
    const key = args?.requestId ? `${event.sender.id}:${args.requestId}` : undefined;
    if (key && requests.has(key)) throwIpcError('INVALID_PARAMS', 'Preview request already exists');
    const request = {
      controller: new AbortController(),
      close: undefined as (() => Promise<void>) | undefined,
    };
    if (key) requests.set(key, request);
    const cancel = () => request.controller.abort();
    event.sender?.once('destroyed', cancel);
    const onNavigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame) cancel();
    };
    event.sender?.on('did-start-navigation', onNavigate);
    preparing++;
    try {
      previewLocation(args);
      const scope = captureDataOwnerBroadcastScope();
      const cacheable = !!scope.ownerScopeKey && !(args.origin.kind === 'device' && isSharedTaskPeer(args.origin.deviceId));
      const isCurrent = () =>
        !shuttingDown &&
        !request.controller.signal.aborted &&
        isDataOwnerBroadcastScopeCurrent(scope);
      const db = getDbClient().drizzle;
      // Finished snapshots are a bounded cache, not concurrent preparation slots.
      // External browsers cannot report tab closure; evict the oldest snapshot so
      // sequential opens (or failed browser launches) never block new previews for hours.
      while (active.size + preparing > 8) {
        const oldest = active.values().next().value;
        if (!oldest) break;
        await oldest();
      }
      if (!isCurrent()) throw new Error('PREVIEW_CANCELLED');
      const preview = await createHtmlPreview(args, {
        signal: request.controller.signal,
        isCurrent,
        // Log status only: paths, signed URLs and page contents are not diagnostics.
        onResourceError: (status) => log.warn('Preview resource request failed', { status }),
        cached: args.origin.kind === 'local' || !cacheable ? undefined : async (root, rel) => {
          if (!isCurrent()) return null;
          const cached = await remote.cached?.(args, root, rel);
          return isCurrent() ? cached ?? null : null;
        },
        stat: async (root, rel, signal) => {
          if (args.origin.kind !== 'local') {
            return readPreviewMetadata(
              (attemptSignal) => remote.stat(args, root, rel, attemptSignal),
              signal ?? request.controller.signal,
              isCurrent,
            );
          }
          const real = await fs.realpath(path.join(root, rel));
          if (!isPathAllowedAgainst(real, getSensitiveMediaBlocklist()))
            throw new Error('BAD_ARGS');
          return statEntry(root, rel);
        },
        read: async (root, entry, signal) => {
          if (args.origin.kind !== 'local') {
            return remote.read(args, root, entry, signal);
          }
          const source = path.join(root, entry.relPath);
          const [rootReal, real] = await Promise.all([fs.realpath(root), fs.realpath(source)]);
          if (
            !real.startsWith(rootReal + path.sep) ||
            !isPathAllowedAgainst(real, getSensitiveMediaBlocklist())
          )
            throw new Error('BAD_ARGS');
          return real;
        },
        materialize: async (source, dest, expectedSize) => {
          // The temporary tree is a view of managed media, not another persistent media store.
          await copyPreviewFile(source, dest, expectedSize);
          const file = await fs.open(dest, 'r');
          const probe = Buffer.alloc(8192);
          let mime: string | null;
          try {
            const { bytesRead } = await file.read(probe);
            mime = sniffMediaMime(probe.subarray(0, bytesRead));
          } finally {
            await file.close();
          }
          if (!isCurrent()) throw new Error('PREVIEW_CANCELLED');
          if (mime) {
            const assertStillValid = () => {
              if (!isCurrent()) throw new Error('PREVIEW_CANCELLED');
            };
            await ingestMedia(
              {
                filePath: dest,
                mimeType: mime,
                isCache: true,
                assertStillValid,
                // The server owns dest, not the managed blob. Cache eviction cannot
                // interrupt this snapshot, so it needs no persistent business ref.
                refs: [],
              },
              db,
            );
          }
          return dest;
        },
      });
      const close = async () => {
        clearTimeout(expiry);
        active.delete(close);
        if (key && requests.get(key) === request) requests.delete(key);
        request.controller.abort();
        await preview.close();
      };
      request.close = close;
      active.add(close);
      // External browser pages outlive a chat tab; retain snapshots until expiry/app shutdown.
      const expiry = setTimeout(
        () => {
          void close().catch(() => log.warn('Preview cleanup failed'));
        },
        2 * 60 * 60 * 1000,
      );
      expiry.unref();
      if (!isCurrent()) {
        await close();
        throwIpcError('HTML_PREVIEW_CANCELLED', 'Preview cancelled');
      }
      return { ok: true as const, url: preview.url };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code =
        request.controller.signal.aborted ||
        /PREVIEW_CANCELLED/.test(message) ||
        (isIpcError(error) && error.code === 'HTML_PREVIEW_CANCELLED')
          ? 'HTML_PREVIEW_CANCELLED'
          : (previewTransportErrorCode(error) ??
            (/PREVIEW_TOO_LARGE|DIRECTORY_TOO_LARGE/.test(message)
              ? 'HTML_PREVIEW_TOO_LARGE'
              : /COMPLETE_DIRECTORY_LISTING_UNSUPPORTED|unknown.*(op|method)|METHOD_NOT_FOUND|CHANNEL_NOT_ALLOWED/i.test(
                    message,
                  )
                ? 'HTML_PREVIEW_UNSUPPORTED'
                : /NOT_FOUND|ENOENT/.test(message)
                  ? 'NOT_FOUND'
                  : 'BROWSER_FILE_OPEN_FAILED'));
      if (code !== 'HTML_PREVIEW_CANCELLED') log.warn('Preview preparation failed', { code });
      throwIpcError(code, 'Could not prepare HTML preview');
    } finally {
      preparing--;
      event.sender?.removeListener('destroyed', cancel);
      event.sender?.removeListener('did-start-navigation', onNavigate);
      if (!request.close && key && requests.get(key) === request) requests.delete(key);
    }
  });
  ipcMain.handle('maker:html-preview:cancel', async (event, requestId: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId))
      throwIpcError('INVALID_PARAMS', 'Invalid preview request');
    // The sender is authoritative: another window cannot cancel this allocation.
    const request = requests.get(`${event.sender.id}:${requestId}`);
    request?.controller.abort();
    await request?.close?.();
    return { ok: true };
  });
}
