import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const ghostBoundary = vi.hoisted(() => ({ stable: false }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `C:/tmp/cindy-${name}`,
  },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn() }),
}));

vi.mock('../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({
    read: () => ({ activeMode: 'signed-out' }),
    writePatch: vi.fn(),
  }),
}));

vi.mock('../authBoundaryQuarantine.js', () => ({
  isGhostSkillProjectionBoundaryStableForOwner: () => ghostBoundary.stable,
}));

import {
  beginAppSessionBoundary,
  commitActiveAppSession,
  commitVolatileAppSession,
  getActiveAppSession,
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  setAppSessionCommitBoundaryHook,
} from '../appSessionState.js';
import {
  captureSessionRuntimeControlOwnerEpoch,
  clearAllSessionRuntimeControlStates,
  sessionRuntimeControlOwnerEpochMatches,
} from '../maker-ipc/sessionRuntimeControl.js';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent, setDataOwnerGeneration } from '../../renderer/contexts/dataOwnerGeneration';

// Execute the actual private auth commit with real session state and an IPC
// queue double, without importing credentials or the full Electron runtime.
const authSource = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(/\r\n/g, '\n');
const commitStart = authSource.indexOf('function commitCloudAppSession(');
const commitSource = authSource.slice(commitStart, authSource.indexOf('\n}\n', commitStart) + 2);
const compiledCommit = ts.transpileModule(commitSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const createCloudCommit = new Function(
  'isPassiveSharedUserDataInstance', 'commitVolatileAppSession', 'commitActiveAppSession', 'notifyRenderer',
  `${compiledCommit}\nreturn commitCloudAppSession;`,
) as (
  passive: () => boolean,
  volatileCommit: typeof commitVolatileAppSession,
  activeCommit: typeof commitActiveAppSession,
  notify: () => void,
) => (ownerId: string, authRealmChanged: boolean) => void;

describe('application session boundary isolation', () => {
  it('does not treat a different durable Ghost projection owner as an App transition', () => {
    ghostBoundary.stable = false;
    expect(isAppSessionBoundaryPending()).toBe(false);
  });

  it('still fails closed during a real process-local App owner transition', () => {
    const release = beginAppSessionBoundary();
    expect(isAppSessionBoundaryPending()).toBe(true);
    release();
    expect(isAppSessionBoundaryPending()).toBe(false);
  });

  it('invalidates in-flight runtime mutations synchronously with the owner commit', () => {
    const captured = captureSessionRuntimeControlOwnerEpoch();
    const observedModes: string[] = [];
    setAppSessionCommitBoundaryHook(() => {
      observedModes.push(getActiveAppSession().mode);
      clearAllSessionRuntimeControlStates();
    });

    try {
      commitActiveAppSession('local');
    } finally {
      setAppSessionCommitBoundaryHook(null);
    }

    expect(observedModes).toEqual(['signed-out']);
    expect(sessionRuntimeControlOwnerEpochMatches(captured)).toBe(false);
  });

  it('keeps the runtime owner epoch across a same-owner generation bump', () => {
    const current = getActiveAppSession();
    const captured = captureSessionRuntimeControlOwnerEpoch();
    const hook = vi.fn();
    setAppSessionCommitBoundaryHook(hook);

    try {
      const bumped = commitActiveAppSession(
        current.mode,
        current.dataOwnerId ?? undefined,
        true,
      );

      expect(bumped.generation).toBe(current.generation + 1);
      expect(hook).not.toHaveBeenCalled();
      expect(sessionRuntimeControlOwnerEpochMatches(captured)).toBe(true);
    } finally {
      setAppSessionCommitBoundaryHook(null);
    }
  });

  it.each([['primary', commitActiveAppSession], ['passive', commitVolatileAppSession]] as const)(
    'invalidates request scopes and queued push stamps on a same-id realm move in %s instances', (_name, commit) => {
      commit('cloud', 'shared-membership-id');
      const oldScope = activeOwnerScopeKey();
      const oldStamp = getActiveDataOwnerPushStamp();
      const hook = vi.fn();
      setAppSessionCommitBoundaryHook(hook);
      try {
        // Auth commits force this bump only when the issuing realm changes.
        commit('cloud', 'shared-membership-id', true);
        expect(activeOwnerScopeKey()).not.toBe(oldScope);
        expect(getActiveDataOwnerPushStamp()).toEqual({
          dataOwnerId: oldStamp.dataOwnerId, ownerGeneration: oldStamp.ownerGeneration + 1,
        });
        const movedScope = activeOwnerScopeKey();
        const movedStamp = getActiveDataOwnerPushStamp();
        setDataOwnerGeneration(movedStamp.dataOwnerId, movedStamp.ownerGeneration);
        expect(isDataOwnerPushCurrent(oldStamp)).toBe(false);
        expect(isDataOwnerPushCurrent(movedStamp)).toBe(true);
        commit('cloud', 'shared-membership-id');
        expect(activeOwnerScopeKey()).toBe(movedScope);
        expect(getActiveDataOwnerPushStamp()).toEqual(movedStamp);
        expect(hook).not.toHaveBeenCalled();
      } finally {
        setAppSessionCommitBoundaryHook(null);
      }
    },
  );

  it('does not create a boundary for a repeated volatile commit to the same owner', () => {
    const current = getActiveAppSession();
    const targetMode = current.mode === 'signed-out' ? 'local' : 'signed-out';
    const hook = vi.fn();
    setAppSessionCommitBoundaryHook(hook);

    try {
      const first = commitVolatileAppSession(targetMode);
      const captured = captureSessionRuntimeControlOwnerEpoch();
      const repeated = commitVolatileAppSession(targetMode);

      expect(hook).toHaveBeenCalledTimes(1);
      expect(repeated).toEqual(first);
      expect(sessionRuntimeControlOwnerEpochMatches(captured)).toBe(true);
    } finally {
      setAppSessionCommitBoundaryHook(null);
    }
  });
});

describe('cloud session realm publication', () => {
  it.each([false, true])('publishes a realm generation before yielding to post-commit work (passive=%s)', async (passive) => {
    commitActiveAppSession('cloud', 'shared-membership-id');
    const previous = getActiveAppSession();
    setDataOwnerGeneration(previous.dataOwnerId, previous.generation);
    const oldRendererOwner = getDataOwnerGeneration();
    const frames: ReturnType<typeof getActiveAppSession>[] = [];
    const commit = createCloudCommit(
      () => passive, commitVolatileAppSession, commitActiveAppSession,
      () => { frames.push(getActiveAppSession()); },
    );
    let finishMigration!: () => void;
    const migration = new Promise<void>((resolve) => { finishMigration = resolve; });
    const transition = (async () => {
      commit('shared-membership-id', true);
      await migration;
    })();
    // No process-local boundary is needed on the stable same-owner fast path.
    // The auth frame must already precede any response to a new-realm read.
    expect(isAppSessionBoundaryPending()).toBe(false);
    expect(frames).toEqual([{ ...previous, generation: previous.generation + 1 }]);
    for (const frame of frames) setDataOwnerGeneration(frame.dataOwnerId, frame.generation);
    expect(isDataOwnerGenerationCurrent(oldRendererOwner)).toBe(false);
    const current = getActiveAppSession();
    frames.length = 0;
    commit('shared-membership-id', false);
    expect(getActiveAppSession()).toEqual(current);
    expect(frames).toEqual([]);
    finishMigration();
    await transition;
  });

});
