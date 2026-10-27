import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { NativeToolMedia, ProcessMediaRef } from '@cindy/maker-shared/tool-process-media';
import { isProcessMediaUrl } from '@cindy/maker-shared/tool-process-media';
import { ingestMedia } from './ingest';
import { sniffMediaMime } from './sniffMediaMime';
import type { LedgerDb } from './ledger';
import { createLogger } from '../logger';

const log = createLogger('tool-process-media');
export interface ToolMediaOrigin {
  workdir: string;
  remoteHostId: string | null;
}

/** Native bytes never enter chat history. Store one managed copy for all clients. */
export async function materializeToolProcessMedia(
  items: NativeToolMedia[],
  db: LedgerDb,
  assertStillValid: () => void,
  origin?: ToolMediaOrigin,
): Promise<ProcessMediaRef[]> {
  const result: ProcessMediaRef[] = [];
  for (const item of items) {
    assertStillValid();
    try {
      if (item.url && isProcessMediaUrl(item.url)) {
        result.push({ kind: item.kind, url: item.url });
        continue;
      }
      const dataUrl = item.url?.match(
        /^data:((?:image|video)\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/,
      );
      const encoded = item.data ?? dataUrl?.[2];
      const sourcePath =
        item.path ?? (item.url?.startsWith('file:') ? fileURLToPath(item.url) : undefined);
      let buffer: Buffer;
      if (encoded) buffer = Buffer.from(encoded, 'base64');
      else if (sourcePath) {
        let localPath = sourcePath;
        if (origin?.remoteHostId) {
          const { materializeSshRemoteMedia } = await import('../file-browser/ssh-media');
          const remote = await materializeSshRemoteMedia(
            { workdir: origin.workdir, remoteHostId: origin.remoteHostId },
            `xdt-file://?path=${encodeURIComponent(sourcePath)}`,
          );
          assertStillValid();
          if (!remote.ok) continue;
          localPath = remote.cachePath;
        }
        buffer = await fs.readFile(localPath);
      } else continue;
      assertStillValid();
      const mimeType = sniffMediaMime(buffer, item.mimeType ?? dataUrl?.[1]);
      if (!mimeType?.startsWith(item.kind + '/')) continue;
      const media = await ingestMedia({ buffer, mimeType, refs: [], assertStillValid }, db);
      result.push({ kind: item.kind, url: media.url });
    } catch {
      // One unavailable attachment must not hide the rest; owner changes still abort.
      assertStillValid();
      log.warn('Native tool attachment could not be stored', { kind: item.kind });
    }
  }
  return [...new Map(result.map((item) => [item.kind + ':' + item.url, item])).values()];
}
