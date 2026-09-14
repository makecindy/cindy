import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { withCrossProcessLock } from '../device-link/crossProcessLock';
import { createLogger } from '../logger';
import { skillInstallLockKey } from './installLock';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile';

const log = createLogger('skillhub:shared-mutation');
export type SkillMutationRelease = (() => Promise<void>) & {
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** Keep conflicting writers out after releasing the process lease. */
  retainUntilComplete(token: string): void;
  complete(token: string): void;
};

export function skillMutationNames(names: readonly string[]): string[] {
  return [...new Set(names.map(skillInstallLockKey))].sort();
}

export function isSkillMutationToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}

interface PendingMutation { token: string; keys: string[] }
interface MutationContext {
  names: string[];
  active(): boolean;
  run<T>(operation: () => Promise<T>): Promise<T>;
}
const mutationContext = new AsyncLocalStorage<MutationContext[]>();

/** Nested projections reuse only leases in their own async call chain. */
export async function withSkillMutation<T>(names: readonly string[], operation: () => Promise<T>): Promise<T | undefined> {
  const requested = skillMutationNames(names);
  const held = (mutationContext.getStore() ?? []).filter((lease) => lease.active()
    && requested.some((name) => lease.names.includes(name)));
  const missing = requested.filter((name) => !held.some((lease) => lease.names.includes(name)));
  // Borrowing pins the underlying lease until the child finishes, even if its
  // caller starts releasing the lease without awaiting that child.
  const run = held.reduceRight<() => Promise<T>>((next, lease) => () => lease.run(next), operation);
  if (!missing.length) return run();
  const lease = await acquireSharedSkillMutationLease(missing);
  if (!lease) return undefined;
  try { return await lease.run(run); }
  finally { await lease(); }
}

function readPending(root: string, keys: string[]): PendingMutation[] {
  // Read only the held resource names: a damaged receipt must not block unrelated Skills.
  return keys.flatMap((key) => {
    const dir = path.join(root, 'pending', key);
    let files: string[];
    try { files = fs.readdirSync(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return [...new Set(files.filter((file) => /\.json(?:\.bak)?$/.test(file))
      .map((file) => file.replace(/\.bak$/, '')))].flatMap((file) => {
      const raw = readAtomicFileSync(path.join(dir, file));
      if (raw === null) return [];
      const value = JSON.parse(raw) as PendingMutation;
      if (!isSkillMutationToken(value.token) || file !== `${value.token}.json`
        || !Array.isArray(value.keys) || !value.keys.includes(key)
        || value.keys.some((item) => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))) {
        throw new Error('Invalid pending Skill mutation');
      }
      return [value];
    });
  });
}

/**
 * All Desktop profiles share native Skill directories. Keep the lease root
 * outside profile-specific userData. Names conservatively serialize the same
 * final basename across every install location, like the in-process lock.
 * Import aliases and rename operations acquire all affected names in order.
 */
export async function acquireSharedSkillMutationLease(
  names: readonly string[],
  pendingToken?: string,
): Promise<SkillMutationRelease | null> {
  let root: string;
  try {
    root = path.join(app.getPath('appData'), 'Cindy', 'shared-skill-mutation-locks');
    fs.mkdirSync(root, { recursive: true });
  } catch {
    log.warn('Skill mutation lock directory is unavailable');
    return null;
  }
  const keys = skillMutationNames(names).map((name) => createHash('sha256').update(name).digest('hex'));
  if (keys.length === 0 || (pendingToken !== undefined && !isSkillMutationToken(pendingToken))) return null;
  let enter!: (release: SkillMutationRelease | null) => void;
  const entered = new Promise<SkillMutationRelease | null>((resolve) => { enter = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let finished: Promise<void>;
  const acquire = async (index: number): Promise<void> => {
    if (index === keys.length) {
      const matchesKeys = (record: PendingMutation) =>
        record.keys.length === keys.length && record.keys.every((key) => keys.includes(key));
      if (readPending(root, keys).some((record) => record.keys.some((key) => keys.includes(key))
        && !(record.token === pendingToken && matchesKeys(record)))) return;
      let active = true;
      let closing = false;
      let borrowers = 0;
      let drained: (() => void) | undefined;
      const context: MutationContext = {
        names: skillMutationNames(names),
        active: () => active && !closing,
        async run<T>(operation: () => Promise<T>): Promise<T> {
          if (!context.active()) throw new Error('Skill mutation lease is no longer held');
          borrowers++;
          try {
            const inherited = mutationContext.getStore() ?? [];
            return await mutationContext.run(inherited.includes(context) ? inherited : [...inherited, context], operation);
          } finally {
            if (--borrowers === 0) drained?.();
          }
        },
      };
      const assertActive = (token: string) => {
        if (!context.active() || !isSkillMutationToken(token)) throw new Error('Skill mutation lease is no longer held');
      };
      let releasePromise: Promise<void> | undefined;
      const leased = Object.assign(() => {
        if (!releasePromise) releasePromise = (async () => {
          closing = true;
          if (borrowers > 0) await new Promise<void>((resolve) => { drained = resolve; });
          active = false;
          release();
          await finished;
        })();
        return releasePromise;
      }, {
        run: context.run,
        retainUntilComplete(token: string) {
          assertActive(token);
          const existing = readPending(root, keys).filter((record) => record.token === token);
          if (existing.some((record) => !matchesKeys(record))) throw new Error('Skill mutation resources changed');
          for (const key of keys) {
            atomicWriteFileSync(path.join(root, 'pending', key, `${token}.json`), JSON.stringify({ token, keys }));
          }
        },
        complete(token: string) {
          assertActive(token);
          const existing = readPending(root, keys).find((record) => record.token === token);
          if (!existing) return;
          if (!matchesKeys(existing)) throw new Error('Skill mutation resources changed');
          for (const key of keys) {
            for (const suffix of ['.json.bak', '.json']) {
              try { fs.unlinkSync(path.join(root, 'pending', key, `${token}${suffix}`)); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
          }
        },
      });
      enter(leased);
      await released;
      return;
    }
    const key = keys[index]!;
    await withCrossProcessLock(path.join(root, `${key}.lock`),
      { label: 'skill-mutation', waitMs: 0 }, async (status) => {
        if (status.held) await acquire(index + 1);
      });
  };
  finished = acquire(0).catch(() => {
    log.warn('Skill mutation lock could not be acquired or released');
  }).finally(() => { enter(null); });
  return entered;
}
