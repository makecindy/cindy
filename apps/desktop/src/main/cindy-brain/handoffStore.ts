import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  GHOST_HANDOFF_QUOTA_BYTES,
  GHOST_HANDOFF_QUOTA_FILES,
  GHOST_HANDOFF_REF_RE,
  GHOST_HANDOFF_RENEW_INTERVAL_MS,
  GHOST_HANDOFF_TTL_MS,
  type GhostHandoffFile,
} from '../../shared/ghost.js';
import { mediaTypeForLibraryPath } from './runtime/ghostFiles.js';
import { readToLength } from '../utils/readBoundedFile.js';

/**
 * Host-owned copies of chat files handed to a plugin (`handoff:<uuid>`).
 * Layout: `<root>/<instance>/<uuid>/{<file name>,.cindy-handoff.json}` so the
 * folder reads like the user's files in Finder / Explorer. Writes land in
 * `<instance>/.tmp/<uuid>` and become visible by one directory rename, so a
 * crash leaves only `.tmp` leftovers for the next sweep. Copies are transient:
 * they expire 7 days after their last use, and an unreadable or expired entry is
 * deleted, never repaired.
 */
const TMP = '.tmp';
const STALE_TMP_MS = 60 * 60_000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
/** Dot-named so Finder / Explorer hide it by default; disk names never start with a dot. */
const META = '.cindy-handoff.json';
const DISK_NAME_CHARS = 64;
const DISK_NAME_BYTES = 200;
// Windows also reserves COM / LPT with superscript digits (`COM¹`).
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;
const TABLE_MIME: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

interface Meta extends Omit<GhostHandoffFile, 'ref'> {
  version: 1;
  id: string;
  /** Name on disk; `name` stays the user's original name for display. */
  file: string;
  /** Last use (or storing); `expiresAt` is this plus the TTL. */
  lastUsedAt: number;
}

export class GhostHandoffQuotaError extends Error {}

export function handoffMimeType(name: string): string {
  return TABLE_MIME[path.extname(name).toLowerCase()] ?? mediaTypeForLibraryPath(name);
}

/** Display names keep the user's file name only: no directories or control characters. */
function displayName(name: string): string {
  const base = [...(name.split(/[\\/]/).pop() ?? '')]
    .filter((char) => char.charCodeAt(0) > 0x1f && char !== '\u007f').join('').trim();
  return (base || 'file').slice(0, 255);
}

/**
 * File name on disk: the display name made creatable everywhere (no reserved
 * characters, leading dots, trailing dots or spaces, Windows device names),
 * at most 64 characters with the extension kept when it has to be shortened.
 */
export function handoffDiskName(name: string): string {
  const base = displayName(name);
  const dot = base.lastIndexOf('.');
  const hasExt = dot > 0 && base.length - dot <= 16 && !/\s/.test(base.slice(dot));
  const clean = (part: string) => part.replace(/[<>:"|?*]/g, '');
  let ext = hasExt ? clean(base.slice(dot)).replace(/[. ]+$/, '') : '';
  if (ext === '.') ext = '';
  let stem = clean(hasExt ? base.slice(0, dot) : base).replace(/^[. ]+/, '');
  // The `_` before a device name counts toward the limits, so a stored name cleans to itself.
  const named = () => (WINDOWS_RESERVED_BASENAME_RE.test(stem + ext) ? '_' : '') + stem + ext;
  const fits = () => [...named()].length <= DISK_NAME_CHARS && Buffer.byteLength(named()) <= DISK_NAME_BYTES;
  while (!fits()) stem = [...stem].slice(0, -1).join('');
  // Stripping only shortens the stem, so a newly needed `_` still fits.
  stem = stem.replace(/[. ]+$/, '') || 'file';
  return named();
}

async function fsyncDir(dir: string): Promise<void> {
  // Windows cannot open directories for fsync; the rename itself stays atomic.
  const handle = await fs.open(dir, 'r').catch(() => null);
  await handle?.sync().catch(() => {});
  await handle?.close().catch(() => {});
}

function toFile(meta: Meta): GhostHandoffFile {
  const { version: _version, id, file: _file, lastUsedAt: _lastUsedAt, ...rest } = meta;
  void _version;
  void _file;
  void _lastUsedAt;
  return { ref: `handoff:${id}`, ...rest };
}

export class GhostHandoffStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly holds = new Map<string, number>();
  private readonly relocating = new Set<string>();

  constructor(private readonly deps: { root(): string; now?(): number; quota?: { files: number; bytes: number } }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private instanceDir(instance: string, root = this.deps.root()): string {
    if (!INSTANCE_RE.test(instance)) throw new Error('invalid plugin instance');
    return path.join(root, instance);
  }

  /** Serialize mutations per instance so quota checks and imports cannot interleave. */
  private exclusive<T>(instance: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(instance) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const settled = run.catch(() => {});
    this.queues.set(instance, settled);
    void settled.then(() => {
      if (this.queues.get(instance) === settled) this.queues.delete(instance);
    });
    return run;
  }

  private async readMeta(dir: string, id: string): Promise<Meta | null> {
    try {
      const entry = await fs.lstat(path.join(dir, id));
      if (!entry.isDirectory()) return null;
      const handle = await fs.open(path.join(dir, id, META), constants.O_RDONLY | NO_FOLLOW);
      let meta: Meta;
      try {
        meta = JSON.parse(await handle.readFile('utf8')) as Meta;
      } finally {
        await handle.close();
      }
      const valid = meta?.version === 1 && meta.id === id && typeof meta.name === 'string' &&
        typeof meta.file === 'string' && meta.file === handoffDiskName(meta.file) &&
        typeof meta.mimeType === 'string' && Number.isSafeInteger(meta.size) && meta.size >= 0 &&
        /^[a-f0-9]{64}$/.test(meta.sha256) && Number.isFinite(meta.createdAt) &&
        Number.isFinite(meta.lastUsedAt) && meta.expiresAt === meta.lastUsedAt + GHOST_HANDOFF_TTL_MS;
      return valid ? meta : null;
    } catch {
      return null;
    }
  }

  /** The file the user may rename, delete or edit in Finder / Explorer; anything else makes the entry unreadable. */
  private async payloadIntact(dir: string, meta: Meta): Promise<boolean> {
    const stat = await fs.lstat(path.join(dir, meta.id, meta.file)).catch(() => null);
    return !!stat?.isFile() && stat.size === meta.size;
  }

  private async remove(dir: string, id: string): Promise<boolean> {
    // Rename first: a crash mid-delete leaves a `.tmp/del-*` entry, not half an entry.
    const doomed = path.join(dir, TMP, `del-${randomUUID()}`);
    try {
      await fs.mkdir(path.join(dir, TMP), { recursive: true, mode: 0o700 });
      await fs.rename(path.join(dir, id), doomed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    await fs.rm(doomed, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  /** Live entries, newest first; expired or unreadable entries are deleted on the way. */
  async list(instance: string): Promise<GhostHandoffFile[]> {
    return this.listDir(this.instanceDir(instance));
  }

  private async listDir(dir: string): Promise<GhostHandoffFile[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const files: GhostHandoffFile[] = [];
    for (const id of names) {
      if (!ID_RE.test(id)) continue;
      const meta = await this.readMeta(dir, id);
      // A payload renamed or deleted in Finder / Explorer must not keep the entry or its quota.
      if (!meta || meta.expiresAt <= this.now() || !(await this.payloadIntact(dir, meta))) {
        await this.remove(dir, id).catch(() => {});
      } else files.push(toFile(meta));
    }
    return files.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Quota check for the confirmation gate; import re-checks inside the instance queue. */
  async assertQuota(instance: string, incoming: readonly number[], dir = this.instanceDir(instance)): Promise<void> {
    const files = await this.listDir(dir);
    const bytes = files.reduce((sum, file) => sum + file.size, 0) + incoming.reduce((sum, size) => sum + size, 0);
    const quota = this.deps.quota ?? { files: GHOST_HANDOFF_QUOTA_FILES, bytes: GHOST_HANDOFF_QUOTA_BYTES };
    if (files.length + incoming.length > quota.files || bytes > quota.bytes) {
      throw new GhostHandoffQuotaError('handoff quota exceeded');
    }
  }

  /**
   * A handoff in flight (stored, not yet delivered) holds its instance so a
   * source change waits instead of moving the copies away from the call.
   * Null while a source change of the instance is in progress.
   */
  hold(instance: string): (() => void) | null {
    if (this.relocating.has(instance)) return null;
    this.holds.set(instance, (this.holds.get(instance) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(instance) ?? 1) - 1;
      if (left > 0) this.holds.set(instance, left);
      else this.holds.delete(instance);
    };
  }

  isBusy(instance: string): boolean {
    return this.holds.has(instance);
  }

  /**
   * Source change: refuse new holds before checking `isBusy`, so no call can
   * store copies between the idle check and the move. Release when it ends.
   */
  blockForRelocation(instances: readonly string[]): () => void {
    const added = [...new Set(instances)].filter((instance) => !this.relocating.has(instance));
    for (const instance of added) this.relocating.add(instance);
    return () => { for (const instance of added) this.relocating.delete(instance); };
  }

  /** Folder the user can open in Finder / Explorer; null until a copy has been stored. */
  async folder(instance: string): Promise<string | null> {
    const dir = this.instanceDir(instance);
    const stat = await fs.lstat(dir).catch(() => null);
    return stat?.isDirectory() ? dir : null;
  }

  /** The owner root now; callers that clean up later keep it so an account switch cannot redirect them. */
  currentRoot(): string {
    return this.deps.root();
  }

  /** Store approved bytes as one batch: either every copy becomes visible or none stays. */
  async import(
    instance: string,
    files: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
    assertCurrent: () => void,
    root = this.deps.root(),
  ): Promise<GhostHandoffFile[]> {
    const dir = this.instanceDir(instance, root);
    return this.exclusive(instance, async () => {
      await this.assertQuota(instance, files.map((file) => file.bytes.byteLength), dir);
      await fs.mkdir(path.join(dir, TMP), { recursive: true, mode: 0o700 });
      const imported: Meta[] = [];
      let staging: string | undefined;
      try {
        for (const file of files) {
          assertCurrent();
          const id = randomUUID();
          staging = path.join(dir, TMP, id);
          await fs.mkdir(staging, { mode: 0o700 });
          const createdAt = this.now();
          const name = displayName(file.name);
          const meta: Meta = {
            version: 1, id, name, file: handoffDiskName(name), mimeType: handoffMimeType(name), size: file.bytes.byteLength,
            sha256: createHash('sha256').update(file.bytes).digest('hex'),
            createdAt, lastUsedAt: createdAt, expiresAt: createdAt + GHOST_HANDOFF_TTL_MS,
          };
          for (const [target, content] of [[meta.file, file.bytes], [META, JSON.stringify(meta)]] as const) {
            const handle = await fs.open(path.join(staging, target), 'wx', 0o600);
            try {
              await handle.writeFile(content);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          await fsyncDir(staging);
          assertCurrent();
          await fs.rename(staging, path.join(dir, id));
          staging = undefined;
          imported.push(meta);
        }
        await fsyncDir(dir);
      } catch (error) {
        // Only a crash leaves staging for the sweep; an ordinary failure cleans up now.
        if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        for (const meta of imported) await this.remove(dir, meta.id).catch(() => {});
        throw error;
      }
      return imported.map(toFile);
    });
  }

  /** Open a live copy without following links; the caller closes the handle. */
  async open(instance: string, ref: string): Promise<{ file: fs.FileHandle; info: GhostHandoffFile } | null> {
    const id = GHOST_HANDOFF_REF_RE.exec(ref)?.[1];
    if (!id) return null;
    const dir = this.instanceDir(instance);
    const meta = await this.readMeta(dir, id);
    if (!meta || meta.expiresAt <= this.now() || !(await this.payloadIntact(dir, meta))) {
      await this.remove(dir, id).catch(() => {});
      return null;
    }
    const blob = path.join(dir, id, meta.file);
    let file: fs.FileHandle;
    try {
      file = await fs.open(blob, constants.O_RDONLY | NO_FOLLOW);
    } catch {
      return null;
    }
    try {
      const opened = await file.stat({ bigint: true });
      const current = await fs.lstat(blob, { bigint: true });
      if (!opened.isFile() || opened.size !== BigInt(meta.size) || !current.isFile() ||
          current.dev !== opened.dev || current.ino !== opened.ino) {
        await file.close();
        return null;
      }
      return { file, info: toFile(meta) };
    } catch {
      await file.close();
      return null;
    }
  }

  /**
   * Bytes of a live copy for upload, never more than its stored size; `changed`
   * when the file on disk was shortened or grown after it was opened.
   */
  async read(instance: string, ref: string): Promise<{ bytes: Buffer; name: string; mimeType: string } | 'changed' | null> {
    const opened = await this.open(instance, ref);
    if (!opened) return null;
    try {
      const bytes = await readToLength(opened.file, opened.info.size);
      const after = await opened.file.stat();
      if (bytes.byteLength !== opened.info.size || after.size !== opened.info.size) return 'changed';
      return { bytes, name: opened.info.name, mimeType: opened.info.mimeType };
    } finally {
      await opened.file.close();
    }
  }

  /** Card page path: issuing a link and the page reading it both count as use. */
  async openForPage(instance: string, ref: string): Promise<{ file: fs.FileHandle; size: number; mimeType: string } | null> {
    const opened = await this.open(instance, ref);
    if (!opened) return null;
    await this.touch(instance, [ref]);
    return { file: opened.file, size: opened.info.size, mimeType: opened.info.mimeType };
  }

  /**
   * A use (link issued to a page, page read, successful upload) slides expiry to
   * now + 7 days. At most one write per copy an hour; skipped silently while a
   * delete or source change is in progress or once the copy is gone, so it never
   * changes the result of the use itself.
   */
  async touch(instance: string, refs: readonly string[]): Promise<void> {
    const release = this.hold(instance);
    if (!release) return;
    try {
      const dir = this.instanceDir(instance);
      await this.exclusive(instance, async () => {
        for (const ref of refs) {
          const id = GHOST_HANDOFF_REF_RE.exec(ref)?.[1];
          const meta = id ? await this.readMeta(dir, id) : null;
          const now = this.now();
          if (!meta || meta.expiresAt <= now || now - meta.lastUsedAt < GHOST_HANDOFF_RENEW_INTERVAL_MS ||
              !(await this.payloadIntact(dir, meta))) continue;
          const next: Meta = { ...meta, lastUsedAt: now, expiresAt: now + GHOST_HANDOFF_TTL_MS };
          // Same directory, then one rename: readers see the old or the new metadata, never half.
          const temp = path.join(dir, meta.id, `${META}.${randomUUID()}.tmp`);
          try {
            const handle = await fs.open(temp, 'wx', 0o600);
            try {
              await handle.writeFile(JSON.stringify(next));
              await handle.sync();
            } finally {
              await handle.close();
            }
            await fs.rename(temp, path.join(dir, meta.id, META));
          } catch {
            await fs.rm(temp, { force: true }).catch(() => {});
          }
        }
      });
    } catch {
      // Renewal is best effort; the use already succeeded.
    } finally {
      release();
    }
  }

  async delete(instance: string, ref: string, root = this.deps.root()): Promise<boolean> {
    const id = GHOST_HANDOFF_REF_RE.exec(ref)?.[1];
    if (!id) return false;
    const dir = this.instanceDir(instance, root);
    return this.exclusive(instance, () => this.remove(dir, id));
  }

  /** Uninstall: every copy of this instance goes; nothing here is user work. */
  async removeInstance(instance: string): Promise<void> {
    const dir = this.instanceDir(instance);
    await this.exclusive(instance, () => fs.rm(dir, { recursive: true, force: true }));
  }

  /** Startup / account-switch sweep: expired entries, stale staging and interrupted deletes. */
  async sweep(): Promise<void> {
    // One root for the whole sweep: an account switch must not redirect it mid-way.
    const root = this.deps.root();
    let instances: string[];
    try {
      instances = await fs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const instance of instances) {
      if (!INSTANCE_RE.test(instance)) continue;
      const dir = this.instanceDir(instance, root);
      await this.exclusive(instance, async () => {
        const tmp = path.join(dir, TMP);
        for (const name of await fs.readdir(tmp).catch(() => [] as string[])) {
          const target = path.join(tmp, name);
          const stat = await fs.lstat(target).catch(() => null);
          if (stat && (name.startsWith('del-') || this.now() - stat.mtimeMs > STALE_TMP_MS)) {
            await fs.rm(target, { recursive: true, force: true }).catch(() => {});
          }
        }
        if ((await this.listDir(dir)).length === 0) {
          await fs.rmdir(tmp).catch(() => {});
          await fs.rmdir(dir).catch(() => {});
        }
      });
    }
  }
}
