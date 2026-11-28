/** Node-safe profile JSON binding of the shared Worktree registry. */

import path from 'node:path';

import { getUserDataDir } from '../userDataPath.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import {
  configureWorktreeStorePorts,
  type SafeDirectoryCleanupStoreBackend,
  type WorktreesStoreBackend,
} from './worktreeStoreCore.js';
import type { WorktreeMeta } from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Synchronous atomic JSON, matching the store API used by the registry locks. */
class ProfileJsonStore {
  constructor(private readonly file: string, private readonly clearInvalidConfig: boolean) {}

  private read(): Record<string, unknown> {
    // Also restores a .bak left by an interrupted Windows replacement.
    const text = readAtomicFileSync(this.file);
    if (text === null) return {};
    try {
      const value: unknown = JSON.parse(text);
      if (!isObject(value)) throw new Error('invalid JSON store');
      return value;
    } catch (error) {
      if (this.clearInvalidConfig) return {};
      throw error;
    }
  }

  protected getValue(key: string, defaultValue: unknown): unknown {
    const value = this.read();
    return Object.hasOwn(value, key) ? value[key] : defaultValue;
  }

  protected setValue(key: string, value: unknown): void {
    const current = this.read();
    current[key] = value;
    // Shared helper: retries transient Windows locks and never drops the previous file.
    atomicWriteFileSync(this.file, `${JSON.stringify(current, null, 2)}\n`);
  }
}

class JsonWorktreesStore extends ProfileJsonStore implements WorktreesStoreBackend {
  get(_key: 'worktrees', defaultValue: Record<string, WorktreeMeta>): Record<string, WorktreeMeta> {
    return this.getValue('worktrees', defaultValue) as Record<string, WorktreeMeta>;
  }

  set(key: 'worktrees', value: Record<string, WorktreeMeta>): void {
    this.setValue(key, value);
  }
}

class JsonCleanupStore extends ProfileJsonStore implements SafeDirectoryCleanupStoreBackend {
  get(_key: 'pending', defaultValue: string[]): string[] {
    return this.getValue('pending', defaultValue) as string[];
  }

  set(key: 'pending', value: string[]): void {
    this.setValue(key, value);
  }
}

let storeOverride: WorktreesStoreBackend | null = null;
let registry: JsonWorktreesStore | null = null;
let cleanup: JsonCleanupStore | null = null;
let registryProfile = '';
let cleanupProfile = '';

function getStore(): WorktreesStoreBackend {
  if (storeOverride) return storeOverride;
  const profile = getUserDataDir();
  if (!registry || registryProfile !== profile) {
    registry = new JsonWorktreesStore(path.join(profile, 'worktrees.json'), false);
    registryProfile = profile;
  }
  return registry;
}

function getCleanupStore(): SafeDirectoryCleanupStoreBackend {
  const profile = getUserDataDir();
  if (!cleanup || cleanupProfile !== profile) {
    cleanup = new JsonCleanupStore(path.join(profile, 'worktree-safe-directory-cleanup.json'), true);
    cleanupProfile = profile;
  }
  return cleanup;
}

configureWorktreeStorePorts({ getStore, getCleanupStore });

/** Existing Desktop test hook; production uses the profile-root JSON file. */
export function _setStoreForTests(store: WorktreesStoreBackend | null): void {
  storeOverride = store;
}

export {
  addPendingSafeDirectoryCleanups,
  del,
  get,
  getAll,
  getAllPaths,
  getPendingSafeDirectoryCleanups,
  removePendingSafeDirectoryCleanups,
  replace,
  set,
} from './worktreeStoreCore.js';
