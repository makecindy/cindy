/**
 * The port bag the Host hands to the shared memory manager factory (maker-core
 * `createMakerMemoryManagerForHost`, desktop counterpart `maker-host/maker-memory-host.ts`).
 *
 * It lives in a .ts file so `explicitPorts` is checked: every optional port of the factory is
 * written out below, bound for real or `undefined` with the reason. memory.mjs only calls it.
 */

import type { MakerMemoryHostContext } from '@cindy/maker-core';

import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';
import { createBetterSqliteDatabase } from '../../../desktop/src/main/localDb/betterSqliteFactory.ts';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.ts';
import { teammateProjectMemoryStorageDir } from '../../../desktop/src/main/maker-ipc/botProjectMemory.ts';
import { explicitPorts } from './explicit-ports.ts';
import { LOGGER } from './runtime.ts';

const sqliteFactory: MakerMemoryHostContext['sqliteFactory'] = (filePath) => {
  const db = createBetterSqliteDatabase(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
};

export interface HostMemoryManagerPortInput {
  userDataDir: string;
  ownerId: string;
  /** Generation of the app session the manager was created in; a later one reads as no owner. */
  generation: number;
  readEnabled: MakerMemoryHostContext['readEnabled'];
  review?: Required<Pick<MakerMemoryHostContext, 'isOneShotRouteDisabled' | 'reviewOneShot'>>;
}

export function hostMemoryManagerPorts({ userDataDir, ownerId, generation, readEnabled, review }: HostMemoryManagerPortInput): MakerMemoryHostContext {
  return explicitPorts<MakerMemoryHostContext>({
    userDataDir,
    readSession: () => {
      const current = getActiveAppSession();
      const invalid = current.dataOwnerId !== ownerId || current.generation !== generation;
      return { dataOwnerId: invalid ? null : ownerId, generation: current.generation,
        mode: current.mode, boundaryPending: invalid || isAppSessionBoundaryPending() };
    },
    ownerSegment: (id) => dataOwnerStorageKey(id),
    readEnabled,
    sqliteFactory,
    logger: LOGGER.child('maker-memory'),
    // Only `bot:` scopes read it (maker-core memory/host-factory.ts:79-80), and only teammate tasks
    // run in those scopes; the Host refuses teammate tasks before a send, steer or restore
    // (send-preflight.ts:19-22, called from turn-executor.mjs).
    botMemoryDir: undefined,
    // Same function as the desktop (maker-host/maker-memory-host.ts:65). It maps a scope that is one
    // of this owner's teammate projects to the project's own memory folder and every other scope to
    // null (the historical place), so both processes sharing the profile put one scope in one place.
    projectMemoryDir: (scopeKey, ownerRoot) => teammateProjectMemoryStorageDir(scopeKey, ownerRoot),
    // Before the runtime binds its auxiliary chain, never fall back to a default agent model.
    isOneShotRouteDisabled: review?.isOneShotRouteDisabled ?? (async () => true),
    reviewOneShot: review?.reviewOneShot,
    reviewAgentOneShot: undefined,
    reviewAgent: 'claude-code',
  });
}
