import { GHOST_HANDOFF_MAX_BYTES_PER_FILE, GHOST_HANDOFF_MAX_FILES } from '../../shared/ghost.js';
import type { PluginUiAttachmentResult } from '../../shared/pluginUi.js';
import type { PluginFileAccess } from './pluginFiles.js';
import { appDownloadName } from './downloadFile.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

/** Import provider-owned resource links through the original file reader/cache. */
export async function preparePluginAttachmentResult(instance: string, raw: unknown, ports: {
  access: PluginFileAccess;
  stage(name: string, buffer: Buffer, mimeType: string): Promise<{ path: string; url?: string }>;
  cleanup(paths: string[]): Promise<void> | void;
  assertCurrent(): Promise<void>;
  signal: AbortSignal;
}): Promise<PluginUiAttachmentResult> {
  const check = async () => { ports.signal.throwIfAborted(); await ports.assertCurrent(); ports.signal.throwIfAborted(); };
  await check();
  const result = raw as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  if (result?.isError) throw new Error('MCP_APP_ACTION_FAILED');
  let data = result?.structuredContent;
  if (!data) { try { data = JSON.parse(result?.content?.find(block => block.type === 'text')?.text ?? ''); } catch { throw new Error('MCP_APP_INVALID_RESULT'); } }
  if (!data || typeof data !== 'object' || !('handled' in data) || typeof data.handled !== 'boolean') throw new Error('MCP_APP_INVALID_RESULT');
  if (!data.handled) return { handled: false };
  const value = data as { text?: unknown; files?: unknown };
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 128000) ||
      value.files !== undefined && (!Array.isArray(value.files) || value.files.length > GHOST_HANDOFF_MAX_FILES)) throw new Error('MCP_APP_INVALID_RESULT');
  const files: NonNullable<PluginUiAttachmentResult['files']> = [];
  try {
    for (const link of (value.files ?? []) as { type?: string; uri?: unknown; name?: unknown }[]) {
      if (!link || link.type !== 'resource_link' || typeof link.uri !== 'string' || !/^(?:library:|handoff:|cindy-media:)/.test(link.uri) ||
          typeof link.name !== 'string' || !link.name.trim() || link.name.length > 200) throw new Error('MCP_APP_FILE_NOT_AUTHORIZED');
      const info = await ports.access.describe(instance, link.uri);
      await check();
      if (!info || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > GHOST_HANDOFF_MAX_BYTES_PER_FILE) throw new Error('MCP_APP_FILE_NOT_AUTHORIZED');
      const response = await ports.access.read(instance, link.uri, new Request('https://cindy.invalid/', { signal: ports.signal }));
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        await check();
        if (!response.ok || !reader) throw new Error('MCP_APP_FILE_UNAVAILABLE');
        while (true) {
          const next = await reader.read(); await check();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > info.size) throw new Error('MCP_APP_FILE_INVALID');
          chunks.push(next.value);
        }
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      if (size !== info.size) throw new Error('MCP_APP_FILE_INVALID');
      const buffer = Buffer.concat(chunks);
      const mediaMime = sniffMediaMime(buffer, info.mimeType);
      if (!mediaMime && /^(image|audio|video)\//.test(info.mimeType)) throw new Error('MCP_APP_FILE_INVALID');
      const mimeType = mediaMime ?? info.mimeType, name = appDownloadName(link.name);
      await check();
      const stored = await ports.stage(name, buffer, mimeType);
      files.push({ name, size, mimeType, ...stored });
      await check();
    }
    if (!value.text && !files.length) throw new Error('MCP_APP_INVALID_RESULT');
    return { handled: true, ...(value.text ? { text: value.text as string } : {}), ...(files.length ? { files } : {}) };
  } catch (error) { await ports.cleanup(files.map(file => file.path)); throw error; }
}
