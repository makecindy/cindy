import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { EXEC_SERVER_NOT_FOUND_CODE } from './execServerShortcut';

/** Codex discovers project skills by walking the task computer. Individual managed
 * paths already map there, but their virtual parent is absent from its real tree.
 * Merge only the controller's accepted entry names after its ordinary read check.
 * File reads, canonicalization of entries, and sandboxed requests still go to it. */
export function createExecServerSkillDiscovery(shadowDir: string, dirs: string[]) {
  const root = pathToFileURL(path.join(shadowDir, '.agents', 'skills')).href;
  const entries = dirs.map(dir => pathToFileURL(path.join(shadowDir, dir)).href);
  const pending = new Map<string | number, string>();
  return {
    request(data: string) {
      if (data.length > 16384 || !data.includes(root) || pending.size >= 64) return;
      try {
        const { method, id, params } = JSON.parse(data);
        if (params?.path !== root || params.sandbox != null || (typeof id !== 'string' && typeof id !== 'number')) return;
        if (method === 'fs/walk') {
          // Only the native skill discovery walk; preserve arbitrary limits and traversal options.
          const opts = params.options;
          if (opts?.maxDepth !== 6 || opts.maxDirectories !== 2000 || opts.maxEntries !== 20000
            || opts.pruneHiddenDirectories !== true || opts.followDirectorySymlinks !== true) return;
        } else if (method !== 'fs/canonicalize' && method !== 'fs/getMetadata') return;
        pending.set(id, method);
      } catch { /* Other frames are forwarded unchanged. */ }
    },
    response(data: string): string {
      if (!pending.size) return data;
      try {
        const rpc = JSON.parse(data);
        if (rpc.method !== undefined || !pending.has(rpc.id)) return data;
        const method = pending.get(rpc.id);
        pending.delete(rpc.id);
        const missing = rpc.error?.code === EXEC_SERVER_NOT_FOUND_CODE;
        if (rpc.error && !missing) return data;
        let result = rpc.result;
        if (method === 'fs/walk') {
          if (missing) result = { entries: [], errors: [], truncated: false };
          if (!Array.isArray(result?.entries) || result.truncated || result.errors?.length) return data;
          let directories = result.entries.filter((entry: { kind: string }) => entry.kind === 'directory').length;
          const existing = new Set(result.entries.map((entry: { path: string }) => entry.path));
          for (const dir of entries) {
            if (existing.has(dir)) continue;
            if (directories >= 2000 || result.entries.length + 2 > 20000) { result.truncated = true; break; }
            directories += 1;
            result.entries.push({ kind: 'directory', path: dir }, { kind: 'file', path: dir + '/SKILL.md' });
          }
        } else if (!missing) return data;
        else if (method === 'fs/canonicalize') result = { path: root };
        else result = { isDirectory: true, isFile: false, isSymlink: false, size: 0, createdAtMs: 0, modifiedAtMs: 0 };
        return JSON.stringify({ id: rpc.id, result });
      } catch { return data; }
    },
  };
}
