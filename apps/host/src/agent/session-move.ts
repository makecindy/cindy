import fs from 'node:fs';
import path from 'node:path';
import type { LiveCcSessionBridge } from '../../../desktop/src/main/maker-host/claude-transcript-relocation.ts';
import type { SessionWorktreeBindingLookup } from '../../../desktop/src/main/localDb/ipc/sessionWorkingDirMove.ts';
import { withRehydrateCloseSuppressed } from '../../../desktop/src/main/maker-host/rehydrateCloseSuppression.ts';

/**
 * The Host's ports for the desktop's working-directory move (sessionWorkingDirMove.ts), which
 * /sessions/update runs (session-update.ts).
 */

/** The shared worktree registry (worktree/worktreeStore.ts): `worktrees.json` in the profile root. */
const WORKTREE_REGISTRY_FILE = 'worktrees.json';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A task's live worktree binding, read from the shared registry. Remote creation writes through
 * the same Node-safe store and file shape: `{ "worktrees": { "<sessionId>": { "path": … } } }`.
 * The desktop answers `worktreeStore.get(id)?.path ?? null` (bootstrap-electron.ts) and reads the
 * file on every call, as this does.
 * - No file: no binding (the desktop's store starts from `{ worktrees: {} }`).
 * - A file the desktop cannot read (unreadable, not JSON, not the registry's shape) fails the move: the
 *   desktop's store throws there too, and "no binding" would let a worktree task move out of it.
 */
export function createHostWorktreeBindingLookup(profileDir: string): SessionWorktreeBindingLookup {
  const file = path.join(profileDir, WORKTREE_REGISTRY_FILE);
  return sessionId => {
    if (!sessionId) return null;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const registry: unknown = JSON.parse(text);
    if (!isPlainObject(registry)) throw new Error('invalid worktree registry');
    if (!Object.hasOwn(registry, 'worktrees')) return null;
    const worktrees = registry.worktrees;
    if (!isPlainObject(worktrees)) throw new Error('invalid worktree registry');
    if (!Object.hasOwn(worktrees, sessionId)) return null;
    const entry = worktrees[sessionId];
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error('invalid worktree registry entry');
    }
    return entry.path;
  };
}

/** The desktop's local-db:recent-workdirs:changed (sessions.ts broadcastRecentWorkdirsChanged), a channel its renderer listens on. */
export const RECENT_WORKDIRS_CHANGED_CHANNEL = 'local-db:recent-workdirs:changed';

/**
 * The desktop's recent projects push, with its `{ path }`: the Host's clients take it from the event
 * stream (apps/web/shim.js; the desktop window in client mode, host-delegation.ts), as the desktop's own
 * windows take it from IPC. A move and a send both announce through it.
 */
export function createRecentWorkdirsChangedPush(publish: (event: Record<string, unknown>) => void): (path: string) => void {
  return path => publish({ type: 'plugin_push', channel: RECENT_WORKDIRS_CHANGED_CHANNEL, payload: { path } });
}

interface MoveMaker {
  getSession(sessionId: string): { isTurnRunning(): boolean } | null | undefined;
  listActiveSessions(): readonly { id: string; sdkSessionId?: string | null }[];
  closeSession(sessionId: string): Promise<void>;
}

/**
 * The Host's bindings of the move's ports, as the desktop's composition root binds them
 * (bootstrap-electron.ts closeIdleSessionForMove and lookupSessionWorktreeBinding, register.ts
 * setLiveCcSessionBridge, sessions.ts broadcastRecentWorkdirsChanged).
 */
export function createHostSessionMovePorts(deps: {
  /** The profile root, where the desktop keeps worktrees.json. */
  profileDir: string;
  getMakerIfReady(): MoveMaker | null;
  /** The executor's turn, which stays running while its rows settle after the terminal. */
  isTurnRunning(sessionId: string): boolean;
  /** The executor's close of an idle runtime (turn-executor.mjs closeRuntime). */
  closeRuntime(sessionId: string): Promise<void>;
  publish(event: Record<string, unknown>): void;
}): {
  move: {
    lookupSessionWorktreeBinding: SessionWorktreeBindingLookup;
    closeIdleSessionForMove(sessionId: string, storedAgentKind: string): Promise<boolean>;
    broadcastRecentWorkdirsChanged(path: string): void;
  };
  liveCcSessionBridge: LiveCcSessionBridge;
} {
  return {
    move: {
      lookupSessionWorktreeBinding: createHostWorktreeBindingLookup(deps.profileDir),
      // As bootstrap-electron.ts: a runtime in a turn is not moved; an idle one is closed with its rebuild
      // suppressed. The Host also counts a turn whose rows are still settling (the desktop reads the
      // runtime only): closing then could race those writes. The idle runtime closes through the
      // executor, which lets go of the instance (interactions, binding, environment notes) first.
      closeIdleSessionForMove: async (sessionId, storedAgentKind) => {
        const maker = deps.getMakerIfReady();
        const live = maker?.getSession(sessionId);
        if (deps.isTurnRunning(sessionId) || live?.isTurnRunning()) return false;
        if (maker && storedAgentKind !== 'cc') {
          await withRehydrateCloseSuppressed(sessionId, () => deps.closeRuntime(sessionId));
        }
        return true;
      },
      broadcastRecentWorkdirsChanged: createRecentWorkdirsChangedPush(deps.publish),
    },
    // As register.ts setLiveCcSessionBridge: a Claude task's resume id in memory, and Maker closing its
    // runtime so the old directory's CLI stops writing the transcript being copied. The shared move check has
    // already verified this turn is idle. Keep the handle until relocation reads its live resume id.
    liveCcSessionBridge: {
      resolveSdkSessionId: sessionId =>
        deps.getMakerIfReady()?.listActiveSessions().find(session => session.id === sessionId)?.sdkSessionId ?? null,
      closeSession: async sessionId => {
        await deps.getMakerIfReady()?.closeSession(sessionId);
      },
    },
  };
}
