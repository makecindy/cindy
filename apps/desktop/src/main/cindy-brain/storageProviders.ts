import path from 'node:path';
import { GHOST_LIBRARY_OPS } from '../../shared/ghost.js';
import type { GhostKvStore } from './ghostKvStore.js';
import type { GhostFsSlot } from './fsSlot.js';
import type { GhostLibrarySlot } from './librarySlot.js';
import type { GhostHandoffStore } from './handoffStore.js';
import { handoffDiskName } from './handoffStore.js';
import type { PluginFileAccess } from '../mcp-apps/pluginFiles.js';
import type { HostStorageProvider, StorageSnapshot } from './storageService.js';

interface Ports {
  kv: Pick<GhostKvStore, 'readStrict' | 'write'>;
  kvChanged?(id: string): void;
  files: GhostFsSlot;
  library: GhostLibrarySlot;
  handoff: GhostHandoffStore;
  media: PluginFileAccess;
}
const unavailable = () => { throw new Error('RESOURCE_UNAVAILABLE'); };
function snapshot(result: Record<string, unknown>, name: string): StorageSnapshot {
  if (result.ok !== true || typeof result.content !== 'string' || result.encoding !== 'base64') return unavailable();
  return { name: handoffDiskName(path.posix.basename(name)), bytes: Buffer.from(result.content, 'base64') };
}

/** Adapters to existing stores only. No new storage directory or copy of their
 * state; every provider keeps its established limits and permission checks. */
export function createHostStorageProviders(ports: Ports): HostStorageProvider[] {
  return [
    { id: 'kv', operations: ['read', 'write'], available: () => true,
      async call(id, request, check) {
        check();
        if (request.op === 'read') return { ok: true, value: ports.kv.readStrict(id) };
        if (!request.value || typeof request.value !== 'object' || Array.isArray(request.value)) return { ok: false, errorCode: 'INVALID_REQUEST' };
        ports.kv.write(id, request.value as Record<string, unknown>); ports.kvChanged?.(id);
        check(); return { ok: true };
      },
      async snapshot(id, source, check) {
        check(); const value = ports.kv.readStrict(id);
        if (typeof source.key !== 'string' || !Object.hasOwn(value, source.key)) return unavailable();
        const text = JSON.stringify(value[source.key]);
        if (typeof text !== 'string') return unavailable();
        return { name: handoffDiskName(`${source.key}.json`), bytes: Buffer.from(text) };
      } },
    { id: 'data', operations: ['read', 'write', 'list', 'delete'], available: ghost => ghost.manifest.fs === true,
      call: (id, request, check) => ports.files.handleFsRequest(id, { ...request, root: 'data', callId: undefined }, () => { check(); return true; }),
      snapshot: async (id, source, check) => snapshot(await ports.files.handleFsRequest(id,
        { op: 'read', root: 'data', path: source.path, encoding: 'base64' }, () => { check(); return true; }), source.path ?? '') },
    { id: 'library', operations: GHOST_LIBRARY_OPS, available: ghost => ghost.manifest.library === true,
      call: async (id, request, check) => { check(); const result = await ports.library.handleLibraryRequest(id, request); check(); return result; },
      snapshot: async (id, source, check) => { check(); return snapshot(await ports.library.handleLibraryRequest(id,
        { op: 'read', path: source.path, encoding: 'base64' }), source.path ?? ''); } },
    { id: 'handoff', operations: ['list', 'read', 'delete', 'touch'], available: () => true,
      async call(id, request, check) {
        check();
        if (request.op === 'list') return { ok: true, files: await ports.handoff.list(id) };
        if (typeof request.ref !== 'string') return { ok: false, errorCode: 'INVALID_REQUEST' };
        if (request.op === 'delete') { check(); return { ok: true, deleted: await ports.handoff.delete(id, request.ref) }; }
        if (request.op === 'touch') { await ports.handoff.touch(id, [request.ref]); return { ok: true }; }
        const offset = request.offset ?? 0;
        if (!Number.isSafeInteger(offset) || (offset as number) < 0) return { ok: false, errorCode: 'INVALID_REQUEST' };
        const opened = await ports.handoff.open(id, request.ref);
        if (!opened) return { ok: false, errorCode: 'HANDOFF_UNAVAILABLE' };
        try {
          check();
          const data = Buffer.alloc(Math.min(64 * 1024, Math.max(0, opened.info.size - (offset as number))));
          let length = 0;
          while (length < data.length) {
            const result = await opened.file.read(data, length, data.length - length, (offset as number) + length);
            if (!result.bytesRead) return { ok: false, errorCode: 'HANDOFF_UNAVAILABLE' };
            length += result.bytesRead; check();
          }
          if ((await opened.file.stat()).size !== opened.info.size) return { ok: false, errorCode: 'HANDOFF_UNAVAILABLE' };
          check();
          await ports.handoff.touch(id, [request.ref]); check();
          return { ok: true, ...opened.info, base64: data.toString('base64'),
            nextOffset: (offset as number) + length < opened.info.size ? (offset as number) + length : null };
        } finally { await opened.file.close(); }
      },
      async snapshot(id, source, check) {
        check(); const value = typeof source.ref === 'string' ? await ports.handoff.read(id, source.ref) : null;
        if (!value || value === 'changed') return unavailable();
        return { name: value.name, bytes: value.bytes };
      } },
    { id: 'media', operations: ['read'], available: () => true,
      async call(id, request, check) {
        if (typeof request.ref !== 'string' || !request.ref.startsWith('cindy-media:')) return { ok: false, errorCode: 'INVALID_REQUEST' };
        const offset = request.offset ?? 0;
        if (!Number.isSafeInteger(offset) || (offset as number) < 0) return { ok: false, errorCode: 'INVALID_REQUEST' };
        check();
        const info = await ports.media.describe(id, request.ref);
        if (!info) return { ok: false, errorCode: 'MEDIA_UNAVAILABLE' };
        if ((offset as number) >= info.size) return { ok: true, ...info, base64: '', nextOffset: null };
        const response = await ports.media.read(id, request.ref, new Request('https://cindy.invalid/',
          { headers: { range: `bytes=${offset}-${Math.min(info.size - 1, (offset as number) + 65535)}` } }));
        if (!response.ok) return unavailable();
        const bytes = Buffer.from(await response.arrayBuffer()); check();
        if (bytes.length > 65536) return unavailable();
        return { ok: true, ...info, base64: bytes.toString('base64'), nextOffset: (offset as number) + bytes.length < info.size ? (offset as number) + bytes.length : null };
      },
      async snapshot(id, source, check) {
        if (typeof source.ref !== 'string' || !source.ref.startsWith('cindy-media:')) return unavailable();
        check(); const info = await ports.media.describe(id, source.ref);
        if (!info || info.size > 64 * 1024 * 1024) return unavailable();
        const response = await ports.media.read(id, source.ref, new Request('https://cindy.invalid/'));
        if (!response.ok) return unavailable();
        const bytes = Buffer.from(await response.arrayBuffer()); check();
        if (bytes.length !== info.size) return unavailable();
        return { bytes, name: handoffDiskName(path.posix.basename(source.ref)) };
      } },
  ];
}
