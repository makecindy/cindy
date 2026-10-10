import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', owner: 'owner-a', generation: 1, pending: false }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  getActiveDataOwnerPushStamp: () => ({
    dataOwnerId: state.owner,
    ownerGeneration: state.generation,
  }),
  isAppSessionBoundaryPending: () => state.pending,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(state.root, state.owner, ...parts),
}));

import { captureDeferredProjectMoveScope } from '../deferredProjectMoveJournal.js';
import type { DeferredProjectMoveIntent } from '../deferredProjectMove.js';

const intent = (): DeferredProjectMoveIntent => ({
  id: 'intent-1',
  sessionId: 'task-1',
  source: { workingDir: path.resolve('source'), workspaceKind: 'project' },
  target: { workingDir: path.resolve('target'), workspaceKind: 'project' },
});

describe('deferred project move journal', () => {
  beforeEach(() => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-deferred-project-move-'));
    state.owner = 'owner-a';
    state.generation = 1;
    state.pending = false;
  });
  afterEach(() => {
    fs.rmSync(state.root, { recursive: true, force: true });
  });

  it('persists choices across scope recreation and clears only the matching request', () => {
    const scope = captureDeferredProjectMoveScope();
    expect(scope.list()).toEqual([]);
    const request = intent();
    scope.save(request);
    const restarted = captureDeferredProjectMoveScope();
    expect(restarted.read('task-1')).toEqual(request);
    expect(restarted.list()).toEqual([request]);
    expect(restarted.remove('task-1', 'stale-id')).toBe(false);
    expect(restarted.read('task-1')).toEqual(request);
    expect(restarted.remove('task-1', request.id)).toBe(true);
    expect(captureDeferredProjectMoveScope().list()).toEqual([]);
  });

  it('isolates owners and fences returning to the same owner in a newer generation', () => {
    const first = captureDeferredProjectMoveScope();
    first.save(intent());
    state.owner = 'owner-b';
    state.generation += 1;
    expect(captureDeferredProjectMoveScope().list()).toEqual([]);
    expect(() => first.remove('task-1', 'intent-1')).toThrow('PROJECT_MOVE_OWNER_CHANGED');
    state.owner = 'owner-a';
    state.generation += 1;
    expect(() => first.save(intent())).toThrow('PROJECT_MOVE_OWNER_CHANGED');
    expect(captureDeferredProjectMoveScope().read('task-1')).toEqual(intent());
  });

  it('rejects all operations during an account boundary', () => {
    const scope = captureDeferredProjectMoveScope();
    state.pending = true;
    expect(() => scope.read('task-1')).toThrow('PROJECT_MOVE_OWNER_CHANGED');
    expect(() => scope.save(intent())).toThrow('PROJECT_MOVE_OWNER_CHANGED');
    expect(() => captureDeferredProjectMoveScope()).toThrow('PROJECT_MOVE_OWNER_CHANGED');
  });

  it('rejects unsafe record IDs and malformed destination paths', () => {
    const scope = captureDeferredProjectMoveScope();
    expect(() => scope.read('../escape')).toThrow('PROJECT_MOVE_INVALID_SESSION_ID');
    expect(() => scope.save({ ...intent(), sessionId: '../escape' })).toThrow(
      'PROJECT_MOVE_INVALID_SESSION_ID',
    );
    expect(() =>
      scope.save({ ...intent(), target: { workingDir: 'relative', workspaceKind: 'project' } }),
    ).toThrow('PROJECT_MOVE_JOURNAL_INVALID');
    expect(() =>
      scope.save({ ...intent(), target: { workingDir: null, workspaceKind: 'project' } }),
    ).toThrow('PROJECT_MOVE_JOURNAL_INVALID');
  });

  it('keeps a legacy empty source directory and accepts dialogue membership', () => {
    const scope = captureDeferredProjectMoveScope();
    const request = {
      ...intent(),
      source: { workingDir: null, workspaceKind: 'project' as const },
      target: { workingDir: null, workspaceKind: 'dialogue' as const },
    };
    scope.save(request);
    expect(scope.read('task-1')).toEqual(request);
  });

  it('recovers a sole Windows backup during startup enumeration', () => {
    const scope = captureDeferredProjectMoveScope();
    scope.save(intent());
    const file = path.join(state.root, state.owner, 'deferred-project-moves', 'task-1.json');
    fs.renameSync(file, `${file}.bak`);
    expect(captureDeferredProjectMoveScope().list()).toEqual([intent()]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('preserves a damaged request and still enumerates other healthy requests', () => {
    const scope = captureDeferredProjectMoveScope();
    scope.save(intent());
    const file = path.join(state.root, state.owner, 'deferred-project-moves', 'task-1.json');
    fs.writeFileSync(file, JSON.stringify({ ...intent(), sessionId: 'another-task' }));
    scope.save({ ...intent(), sessionId: 'task-2' });
    expect(() => scope.read('task-1')).toThrow('PROJECT_MOVE_JOURNAL_INVALID');
    expect(scope.list()).toEqual([{ ...intent(), sessionId: 'task-2' }]);
    expect(fs.existsSync(file)).toBe(true);
  });
});
