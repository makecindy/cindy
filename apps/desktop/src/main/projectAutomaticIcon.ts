import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  activeOwnerScopeKey,
  ownerScopedUserDataPath,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
} from './appSessionState.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';
import { createLogger } from './logger.js';
import { getDbClient } from './localDb/client/current.js';
import {
  projectKeyComparisonKey,
  projectIdentityKey,
  normalizeProjectKey,
} from '../shared/projectKeys.js';
import {
  collapseWorktreeDirForGrouping,
  sessionProjectDirectory,
} from '@cindy/maker-shared/worktree-paths';
import { isProjectImage, type AutomaticProjectIcon } from '@cindy/maker-shared/project-alias-sync';
import { requireObject, throwIpcError } from './utils/ipcValidate.js';
import {
  importProjectIcon,
  readProjectIconBytes,
  releasePreviousProjectImages,
} from './projectIconMedia.js';
import { discoverProjectIcon, safeIconUrl, localIconPath } from './projectIconDiscovery.js';
import { createOutboundTransport } from './maker-host/outbound-fetch.js';
import { createEnvOutboundProxyResolver } from '@cindy/anthropic-compat-proxy';
import { createMakerLogger } from './maker-host/logger-adapter.js';
import { withCrossProcessLock } from './device-link/crossProcessLock.js';
const transport = createOutboundTransport(
  createEnvOutboundProxyResolver(),
  createMakerLogger('project-auto-icons'),
);
const runtime: {
  fetch: typeof transport.guardedOutboundFetch;
  readRemote?: (
    host: string,
    workdir: string,
    relPath: string,
  ) => Promise<{ eof: boolean; size: number; dataBase64: string }>;
} = { fetch: transport.guardedOutboundFetch };
export function configureProjectIconRuntime(ports: Partial<typeof runtime>) {
  Object.assign(runtime, ports);
}

type Entry = Omit<AutomaticProjectIcon, 'image'> & { icon: string | null; checkedAt: number };
const cache = createOverrideSettingsFile<{ entries: Record<string, Entry> }>({
  filePath: () => ownerScopedUserDataPath('project-auto-icons.json'),
  defaults: { entries: {} },
  normalize(raw) {
    const entries: Record<string, Entry> = {};
    const source = (raw as { entries?: Record<string, Entry> })?.entries;
    if (source && typeof source === 'object')
      for (const [key, v] of Object.entries(source)) {
        if (
          normalizeProjectKey(key) &&
          v &&
          (v.icon === null || isProjectImage(v.icon)) &&
          Number.isFinite(v.checkedAt) &&
          typeof v.source === 'string' &&
          v.source.length <= 2048 &&
          ['local', 'website', 'github', 'none'].includes(v.kind)
        )
          entries[key] = v;
      }
    return { entries };
  },
  scopeKey: activeOwnerScopeKey,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  maxBytes: 2 * 1024 * 1024,
  log: createLogger('project-auto-icons'),
  label: 'project-auto-icons',
});
const pending = new Map<string, Promise<AutomaticProjectIcon>>();
let active = 0;
const waiters: (() => void)[] = [];
const EMPTY: AutomaticProjectIcon = { image: null, source: '', kind: 'none', candidate: false };

export async function resolveAutomaticProjectIcon(input: unknown): Promise<AutomaticProjectIcon> {
  const body = requireObject(input, 'input');
  const parsedKey =
    typeof body.projectKey === 'string' && body.projectKey.length <= 4096
      ? normalizeProjectKey(body.projectKey)
      : null;
  if (!parsedKey || (!parsedKey.startsWith('local:') && !parsedKey.startsWith('remote:')))
    throwIpcError('INVALID_PARAMS', 'Invalid project identity');
  const key = projectKeyComparisonKey(parsedKey, process.platform) ?? parsedKey;
  const owner = getActiveDataOwnerPushStamp();
  const assertCurrent = () => {
    const next = getActiveDataOwnerPushStamp();
    if (
      !owner.dataOwnerId ||
      isAppSessionBoundaryPending() ||
      owner.dataOwnerId !== next.dataOwnerId ||
      owner.ownerGeneration !== next.ownerGeneration
    )
      throwIpcError('PRECONDITION_FAILED', 'Project account changed');
  };
  assertCurrent();
  const id = `${activeOwnerScopeKey()}:${owner.ownerGeneration}:${key}`;
  if (pending.has(id)) return pending.get(id)!;
  if (pending.size >= 128) return EMPTY;
  const run = async () => {
    // Only projects already belonging to this account can cause file or network reads.
    const separator = key.startsWith('remote:') ? key.indexOf(':', 7) : -1;
    const host = separator >= 0 ? decodeURIComponent(key.slice(7, separator)) : null;
    const directory = host ? key.slice(separator + 1) : key.slice(6);
    const collation = !host && process.platform === 'win32' ? 'NOCASE' : 'BINARY';
    // Filter in SQL before materializing history; JS below retains the exact grouping check.
    const directorySql = "replace(rtrim(coalesce(project_dir, working_dir), '/\\'), char(92), '/')";
    const prefix = directory.replace(/[\\%_]/g, '\\$&').replace(/\/$/, '') + '/%';
    const rows = await getDbClient().query<{
      workingDir: string | null;
      projectDir: string | null;
      remoteHostId: string | null;
    }>(
      `SELECT DISTINCT working_dir AS workingDir, project_dir AS projectDir, remote_host_id AS remoteHostId
       FROM sessions WHERE coalesce(remote_host_id, '') = ? AND
       (${directorySql} = ? COLLATE ${collation} OR ${directorySql} LIKE ? ESCAPE char(92))
       UNION SELECT path AS workingDir, NULL AS projectDir, NULL AS remoteHostId
       FROM recent_workdirs WHERE ? = '' AND
       (replace(rtrim(path, '/\\'), char(92), '/') = ? COLLATE ${collation}
        OR replace(path, char(92), '/') LIKE ? ESCAPE char(92))`,
      [
        host ?? '',
        directory.replace(/[\\/]+$/, ''),
        prefix,
        host ?? '',
        directory.replace(/[\\/]+$/, ''),
        prefix,
      ],
    );
    assertCurrent();
    const known = rows.some((row) => {
      const directory = sessionProjectDirectory(row);
      return (
        directory &&
        projectKeyComparisonKey(
          projectIdentityKey(
            row.remoteHostId ? 'remote' : 'local',
            collapseWorktreeDirForGrouping(directory),
            row.remoteHostId,
          ),
          process.platform,
        ) === projectKeyComparisonKey(key, process.platform)
      );
    });
    if (!known) return EMPTY;
    cache.invalidateIfChanged();
    const previous = cache.read().entries[key];
    const response = async (entry: Entry): Promise<AutomaticProjectIcon> => {
      const image = entry.icon ? await readProjectIconBytes(entry.icon).catch(() => null) : null;
      assertCurrent();
      return { image, source: entry.source, kind: entry.kind, candidate: entry.candidate };
    };
    if (previous && Date.now() - previous.checkedAt < (previous.icon ? 86400000 : 3600000))
      return response(previous);
    if (active >= 3) await new Promise<void>((resolve) => waiters.push(resolve));
    else active++;
    try {
      assertCurrent();
      const separator = key.startsWith('remote:') ? key.indexOf(':', 7) : -1;
      const host = separator >= 0 ? decodeURIComponent(key.slice(7, separator)) : null;
      const directory = host ? key.slice(separator + 1) : key.slice(6);
      const deadline = Date.now() + 20_000;
      const check = () => {
        assertCurrent();
        if (Date.now() > deadline) throw new Error('Discovery budget exceeded');
      };
      const read = async (relative: string): Promise<Buffer | null> => {
        check();
        if (!localIconPath(relative)) return null;
        if (host) {
          if (!runtime.readRemote) return null;
          const result = await runtime.readRemote(host, directory, relative);
          check();
          return result.eof && result.size <= 1024 * 1024
            ? Buffer.from(result.dataBase64, 'base64')
            : null;
        }
        const root = await fs.realpath(directory),
          file = await fs.realpath(path.join(root, relative));
        if (!file.startsWith(root + path.sep)) return null;
        const handle = await fs.open(file, 'r');
        try {
          const st = await handle.stat();
          if (!st.isFile() || st.size > 1024 * 1024) return null;
          const buffer = Buffer.alloc(st.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          check();
          return bytesRead <= 1024 * 1024 ? buffer.subarray(0, bytesRead) : null;
        } finally {
          await handle.close();
        }
      };
      const fetch = async (raw: string) => {
        let url = safeIconUrl(raw);
        if (!url) return null;
        for (let hop = 0; hop < 4; hop++) {
          check();
          const signal = AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now())));
          const { response: res, release } = await runtime.fetch(
            url,
            {
              method: 'GET',
              redirect: 'manual',
              credentials: 'omit',
              signal,
              headers: { Accept: '*/*', 'User-Agent': 'Cindy-Project-Icon' },
            },
            check,
          );
          try {
            if ([301, 302, 303, 307, 308].includes(res.status)) {
              url = safeIconUrl(res.headers.get('location'), url);
              await res.body?.cancel();
              if (!url) return null;
              continue;
            }
            if (!res.ok) {
              await res.body?.cancel();
              return null;
            }
            const reader = res.body?.getReader();
            if (!reader) return null;
            const chunks: Buffer[] = [];
            let size = 0;
            try {
              for (;;) {
                const r = await reader.read();
                if (r.done) break;
                size += r.value.length;
                if (size > 1024 * 1024) throw new Error('Icon response too large');
                chunks.push(Buffer.from(r.value));
                check();
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            return { bytes: Buffer.concat(chunks), url };
          } finally {
            await release();
          }
        }
        return null;
      };
      let result: Awaited<ReturnType<typeof discoverProjectIcon>> = null;
      try {
        result = await discoverProjectIcon({
          directoryName: path.posix.basename(directory),
          read,
          fetch,
          ...(!host
            ? {
                gitOrigin: async () => {
                  check();
                  const r = await promisify(execFile)(
                    'git',
                    ['-C', directory, 'config', '--local', '--get', 'remote.origin.url'],
                    { timeout: 2000, maxBuffer: 8192 },
                  );
                  return r.stdout.trim();
                },
              }
            : {}),
        });
      } catch {
        /* Keep the last successful cache while offline. */
      }
      assertCurrent();
      return withCrossProcessLock(
        ownerScopedUserDataPath('project-auto-icons-write.lock'),
        { label: 'project-auto-icons', waitMs: 12_000 },
        async (status) => {
          if (!status.held) return previous ? response(previous) : EMPTY;
          assertCurrent();
          cache.invalidateIfChanged();
          const retained = cache.read().entries[key] ?? previous;
          const icon = result
            ? await importProjectIcon(result.image, `auto:${key}`, assertCurrent)
            : (retained?.icon ?? null);
          const entry: Entry = {
            icon,
            source: result?.source ?? retained?.source ?? '',
            kind: result?.kind ?? retained?.kind ?? 'none',
            candidate: result?.candidate ?? retained?.candidate ?? false,
            checkedAt: Date.now(),
          };
          try {
            await cache.updateAtomic((current) => {
              assertCurrent();
              return { entries: { ...current.value.entries, [key]: entry } };
            });
          } catch (error) {
            await releasePreviousProjectImages(
              `auto:${key}`,
              retained?.icon ?? null,
              assertCurrent,
            ).catch(() => {});
            throw error;
          }
          await releasePreviousProjectImages(`auto:${key}`, icon, assertCurrent).catch(() => {});
          return response(entry);
        },
      );
    } finally {
      const resume = waiters.shift();
      if (resume) resume();
      else active--;
    }
  };
  const promise = run().finally(() => pending.delete(id));
  pending.set(id, promise);
  return promise;
}
