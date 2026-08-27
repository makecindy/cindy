import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../im/ownerScopedStorage.js', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => path.join(tmp.dir, ...parts),
}));

import {
  applyIncomingServerWorkspacePrefs,
  getWorkspacePref,
  reconcileWorkspacePrefsForMirror,
  setWorkspacePref,
} from '../workspacePrefsStore.js';
import {
  createWorkspacePrefsMirror,
  type WorkspacePrefsMirrorDeps,
} from '../workspacePrefsMirror.js';

describe('workspacePrefsMirror', () => {
  beforeEach(() => {
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wprefs-mirror-'));
  });

  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('不把 prefs.get 刚导入的 clean server 行回写', async () => {
    reconcileWorkspacePrefsForMirror('slack', []);
    const setRemotePrefs = vi.fn();
    const mirror = createWorkspacePrefsMirror({
      isLiveBound: () => true,
      getRemoteSnapshotGeneration: () => 0,
      getRemotePrefs: async () => ({
        bound: true,
        prefs: [
          {
            workspace: 'repo',
            model: 'from-model-command',
            effort: 'high',
            agentKind: 'claude-code',
            permissionMode: 'ask',
            teamId: 'T1',
          },
        ],
      }),
      setRemotePrefs,
      onLocalPrefsChanged: vi.fn(),
      onError: vi.fn(),
    });

    await mirror('slack');

    expect(getWorkspacePref('slack', 'T1', 'repo').model).toBe('from-model-command');
    expect(setRemotePrefs).not.toHaveBeenCalled();
  });

  it('逐行镜像期间本地更新了后续候选时跳过旧候选', async () => {
    reconcileWorkspacePrefsForMirror('slack', []);
    setWorkspacePref('slack', null, 'chat', {
      model: 'local-chat',
      agentKind: 'claude-code',
    });
    setWorkspacePref('slack', 'T1', 'repo', {
      model: 'old-local-repo',
      agentKind: 'claude-code',
    });

    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const setRemotePrefs = vi.fn<WorkspacePrefsMirrorDeps['setRemotePrefs']>(async () => {
      if (setRemotePrefs.mock.calls.length === 1) await firstWrite;
    });
    const onError = vi.fn();
    const mirror = createWorkspacePrefsMirror({
      isLiveBound: () => true,
      getRemoteSnapshotGeneration: () => 0,
      getRemotePrefs: async () => ({ bound: true, prefs: [] }),
      setRemotePrefs,
      onLocalPrefsChanged: vi.fn(),
      onError,
    });

    const flight = mirror('slack');
    await vi.waitFor(() => expect(setRemotePrefs).toHaveBeenCalledTimes(1));
    expect(setRemotePrefs.mock.calls[0]?.[1]).toBe('chat');

    setWorkspacePref('slack', 'T1', 'repo', {
      model: 'newer-local-repo',
      effort: 'high',
      agentKind: 'codex',
      permissionMode: 'ask',
    });
    releaseFirstWrite();
    await flight;

    expect(setRemotePrefs).toHaveBeenCalledTimes(1);
    expect(setRemotePrefs).toHaveBeenCalledWith(
      'slack',
      'chat',
      {
        model: 'local-chat',
        effort: null,
        agentKind: 'claude-code',
        permissionMode: null,
      },
      null,
    );
    expect(getWorkspacePref('slack', 'T1', 'repo')).toMatchObject({
      model: 'newer-local-repo',
      effort: 'high',
      agentKind: 'codex',
      permissionMode: 'ask',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('同一渠道的并发触发复用 single-flight，并补跑最新触发', async () => {
    let releaseGet!: () => void;
    const getPending = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const getRemotePrefs = vi.fn(async () => {
      await getPending;
      return { bound: true, prefs: [] };
    });
    const onLocalPrefsChanged = vi.fn();
    const mirror = createWorkspacePrefsMirror({
      isLiveBound: () => true,
      getRemoteSnapshotGeneration: () => 0,
      getRemotePrefs,
      setRemotePrefs: vi.fn(),
      onLocalPrefsChanged,
      onError: vi.fn(),
    });

    const first = mirror('slack');
    const second = mirror('slack');
    expect(second).toBe(first);
    expect(getRemotePrefs).toHaveBeenCalledTimes(1);

    releaseGet();
    await Promise.all([first, second]);
    expect(getRemotePrefs).toHaveBeenCalledTimes(2);
    expect(onLocalPrefsChanged).toHaveBeenCalledTimes(1);
  });

  it('prefs.get 在途期间收到主动快照时丢弃旧响应并重新拉取', async () => {
    reconcileWorkspacePrefsForMirror('slack', []);

    let generation = 0;
    let releaseFirstGet!: () => void;
    const firstGetPending = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    const oldSnapshot = {
      bound: true,
      prefs: [
        {
          workspace: 'repo',
          model: 'old-model',
          effort: null,
          agentKind: 'claude-code',
          permissionMode: null,
          teamId: 'T1',
        },
      ],
    };
    const newSnapshot = {
      bound: true,
      prefs: [
        {
          workspace: 'repo',
          model: 'new-model',
          effort: 'high',
          agentKind: 'codex',
          permissionMode: 'ask',
          teamId: 'T1',
        },
      ],
    };
    const getRemotePrefs = vi.fn(async () => {
      if (getRemotePrefs.mock.calls.length === 1) {
        await firstGetPending;
        return oldSnapshot;
      }
      return newSnapshot;
    });
    const setRemotePrefs = vi.fn();
    const mirror = createWorkspacePrefsMirror({
      isLiveBound: () => true,
      getRemoteSnapshotGeneration: () => generation,
      getRemotePrefs,
      setRemotePrefs,
      onLocalPrefsChanged: vi.fn(),
      onError: vi.fn(),
    });

    const flight = mirror('slack');
    await vi.waitFor(() => expect(getRemotePrefs).toHaveBeenCalledTimes(1));

    applyIncomingServerWorkspacePrefs('slack', newSnapshot.prefs);
    generation += 1;
    releaseFirstGet();
    await flight;

    expect(getRemotePrefs).toHaveBeenCalledTimes(2);
    expect(getWorkspacePref('slack', 'T1', 'repo')).toMatchObject({
      model: 'new-model',
      effort: 'high',
      agentKind: 'codex',
      permissionMode: 'ask',
    });
    expect(setRemotePrefs).not.toHaveBeenCalled();
  });
});
