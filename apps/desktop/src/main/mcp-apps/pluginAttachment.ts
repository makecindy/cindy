import { GHOST_HANDOFF_MAX_BYTES_PER_FILE, GHOST_HANDOFF_MAX_FILES } from '../../shared/ghost.js';
import type { PluginUiAttachmentResult } from '../../shared/pluginUi.js';
import type { PluginFileAccess } from './pluginFiles.js';
import { appDownloadName } from './downloadFile.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { GhostHandoffStore } from '../cindy-brain/handoffStore.js';
import type { GhostCardService } from '../cindy-brain/cardService.js';

/** Track the native provider call through the existing card lifecycle. */
export async function callPluginAttachmentTool(input: {
  instance: string; sessionId: string | null; tool: string;
}, ports: {
  cards: Pick<GhostCardService, 'registerCall' | 'finalizeCall'>;
  call(callId: string): Promise<CallToolResult>;
}): Promise<CallToolResult> {
  const callId = randomUUID();
  // Retain task correlation without asserting an Agent-authorized local call.
  ports.cards.registerCall(callId, { ghostId: input.instance, sessionId: input.sessionId, tool: input.tool,
    toolUseId: null });
  try { return await ports.call(callId); }
  finally { ports.cards.finalizeCall(callId); }
}

/** Main-owned, user-added input. This is a transfer, not an Agent file grant. */
export async function callPluginAttachmentProvider(input: {
  instance: string; bytes: Uint8Array; args: Record<string, unknown>; handoffDeclared: boolean;
}, ports: {
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  assertStillValid(): void;
  ensureReady(): Promise<void>;
  assertReady(): void;
  handoff: Pick<GhostHandoffStore, 'hold' | 'currentRoot' | 'import' | 'delete'>;
  supportsMedia(mimeType: string): boolean;
  deposit(buffer: Buffer, mimeType: string): Promise<{ hash: string; cleanup(): Promise<void> }>;
  call(args: Record<string, unknown>): Promise<CallToolResult>;
}): Promise<CallToolResult> {
  const check = async () => { ports.signal.throwIfAborted(); await ports.assertCurrent(); ports.signal.throwIfAborted(); };
  await check();
  const file = input.args.attachment as { name?: unknown; size?: unknown; mimeType?: unknown } | undefined;
  if (!file || typeof file.name !== 'string' ||
      typeof file.mimeType !== 'string' || !Number.isSafeInteger(file.size) || (file.size as number) < 1 ||
      (file.size as number) > GHOST_HANDOFF_MAX_BYTES_PER_FILE) throw new Error('MCP_APP_INVALID_REQUEST');
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== file.size) throw new Error('MCP_APP_FILE_INVALID');
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const mimeType = sniffMediaMime(bytes, file.mimeType);
  if (!mimeType && ports.supportsMedia(file.mimeType)) throw new Error('MCP_APP_FILE_INVALID');
  // Preserve the existing required-settings flow before making a plugin copy.
  await ports.ensureReady();
  await check();
  ports.assertReady();
  let cleanup = async () => {};
  let release: (() => void) | undefined;
  let delivered = false;
  try {
    const args = { ...input.args };
    // Only Host supplies file references. Other declared arguments keep their original meaning.
    delete args.cindy_handoff_files;
    if (mimeType) {
      const media = await ports.deposit(bytes, mimeType);
      cleanup = media.cleanup;
      args.attachments = [media.hash];
    } else {
      if (!input.handoffDeclared) throw new Error('MCP_APP_INVALID_REQUEST');
      release = ports.handoff.hold(input.instance) ?? undefined;
      if (!release) throw new Error('MCP_APP_SOURCE_UNAVAILABLE');
      const root = ports.handoff.currentRoot();
      const files = await ports.handoff.import(input.instance, [{ name: file.name, bytes }], ports.assertStillValid, root);
      cleanup = async () => { for (const file of files) await ports.handoff.delete(input.instance, file.ref, root); };
      args.cindy_handoff_files = files;
    }
    await check();
    ports.assertReady();
    const result = await ports.call(args);
    await check();
    delivered = result.isError !== true;
    return result;
  } finally {
    try { if (!delivered) await cleanup(); }
    finally { release?.(); }
  }
}

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
