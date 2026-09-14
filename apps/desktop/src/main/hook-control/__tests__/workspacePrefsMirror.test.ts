import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookWorkspacePrefs } from '../../../shared/hookControlIpc.js';

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
      getLiveBindingKey: () => 'slack:T1',
      isMirrorTargetCurrent: () => true,
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
      getLiveBindingKey: () => 'slack:T1',
      isMirrorTargetCurrent: () => true,
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
      getLiveBindingKey: () => 'slack:T1',
      isMirrorTargetCurrent: () => true,
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

  it('账号边界切换会失效旧 flight，并允许相同 binding key 的新 owner 立即镜像', async () => {
    reconcileWorkspacePrefsForMirror('slack', []);

    let owner: 'old' | 'new' = 'old';
    let releaseOldGet!: () => void;
    const oldGetPending = new Promise<void>((resolve) => {
      releaseOldGet = resolve;
    });
    const getRemotePrefs = vi.fn(async () => {
      const requestedOwner = owner;
      if (requestedOwner === 'old') await oldGetPending;
      return {
        bound: true,
        prefs: [
          {
            workspace: 'repo',
            model: `${requestedOwner}-owner-model`,
            effort: null,
            agentKind: 'claude-code',
            permissionMode: null,
            teamId: 'T1',
          },
        ],
      };
    });
    const onLocalPrefsChanged = vi.fn();
    const mirror = createWorkspacePrefsMirror({
      getLiveBindingKey: () => 'slack:T1',
      isMirrorTargetCurrent: () => true,
      getRemoteSnapshotGeneration: () => 0,
      getRemotePrefs,
      setRemotePrefs: vi.fn(),
      onLocalPrefsChanged,
      onError: vi.fn(),
    });

    const oldFlight = mirror('slack');
    await vi.waitFor(() => expect(getRemotePrefs).toHaveBeenCalledTimes(1));

    mirror.invalidateOwnerBoundary();
    owner = 'new';
    const newFlight = mirror('slack');
    await vi.waitFor(() => expect(getRemotePrefs).toHaveBeenCalledTimes(2));
    await newFlight;
    expect(getWorkspacePref('slack', 'T1', 'repo').model).toBe('new-owner-model');

    releaseOldGet();
    await oldFlight;

    expect(getRemotePrefs).toHaveBeenCalledTimes(2);
    expect(getWorkspacePref('slack', 'T1', 'repo').model).toBe('new-owner-model');
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
      getLiveBindingKey: () => 'slack:T1',
      isMirrorTargetCurrent: () => true,
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

  it('逐行写回期间收到主动快照时重新拉取并发送最新候选', async () => {
    reconcileWorkspacePrefsForMirror('slack', []);
    setWorkspacePref('slack', null, 'chat', { model: 'local-chat' });
    setWorkspacePref('slack', null, 'repo', { model: 'local-repo' });

    let generation = 0;
    let releaseFirstWrite!: () => void;
    const firstWritePending = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const latestSnapshot = {
      bound: true,
      prefs: [
        {
          workspace: 'chat',
          model: 'remote-chat',
          effort: 'high',
          agentKind: 'claude-code',
          permissionMode: 'ask',
          teamId: null,
        },
        {
          workspace: 'repo',
          model: 'remote-repo',
          effort: 'medium',
          agentKind: 'codex',
          permissionMode: 'full',
          teamId: null,
        },
      ],
    };
    let remotePrefs: HookWorkspacePrefs[] = [];
    const getRemotePrefs = vi.fn(async () => ({ bound: true, prefs: remotePrefs }));
    const setRemotePrefs = vi.fn<WorkspacePrefsMirrorDeps['setRemotePrefs']>(async (
      _channel,
      workspace,
      patch,
      teamId,
    ) => {
      if (setRemotePrefs.mock.calls.length === 1) await firstWritePending;
      const current = remotePrefs.find(
        (row) => row.workspace === workspace && (row.teamId ?? null) === teamId,
      );
      const next = {
        workspace,
        model: patch.model ?? null,
        effort: patch.effort ?? null,
        agentKind: patch.agentKind ?? null,
        permissionMode: patch.permissionMode ?? null,
        teamId,
      };
      remotePrefs = [...remotePrefs.filter((row) => row !== current), next];
    });
    const mirror = createWorkspacePrefsMirror({
      getLiveBindingKey: () => 'slack:T1',
      isMirrorTargetCurrent: () => true,
      getRemoteSnapshotGeneration: () => generation,
      getRemotePrefs,
      setRemotePrefs,
      onLocalPrefsChanged: vi.fn(),
      onError: vi.fn(),
    });

    const flight = mirror('slack');
    await vi.waitFor(() => expect(setRemotePrefs).toHaveBeenCalledTimes(1));

    applyIncomingServerWorkspacePrefs('slack', latestSnapshot.prefs);
    remotePrefs = latestSnapshot.prefs;
    generation += 1;
    releaseFirstWrite();
    await flight;

    expect(getRemotePrefs).toHaveBeenCalledTimes(2);
    expect(setRemotePrefs).toHaveBeenCalledTimes(3);
    expect(setRemotePrefs).toHaveBeenNthCalledWith(
      2,
      'slack',
      'chat',
      {
        model: 'local-chat',
        effort: 'high',
        agentKind: 'claude-code',
        permissionMode: 'ask',
      },
      null,
    );
    expect(setRemotePrefs).toHaveBeenNthCalledWith(
      3,
      'slack',
      'repo',
      {
        model: 'local-repo',
        effort: 'medium',
        agentKind: 'codex',
        permissionMode: 'full',
      },
      null,
    );
  });

  it('首次快照到达前的 partial patch 会先补齐远端未改字段再镜像', async () => {
    setWorkspacePref('slack', 'T1', 'repo', { model: 'new-local-model' });
    const setRemotePrefs = vi.fn();
    const mirror = createWorkspacePrefsMirror({
      getLiveBindingKey: () => 'slack:T1',
      isMirrorTargetCurrent: () => true,
      getRemoteSnapshotGeneration: () => 0,
      getRemotePrefs: async () => ({
        bound: true,
        prefs: [
          {
            workspace: 'repo',
            model: 'old-remote-model',
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

    expect(setRemotePrefs).toHaveBeenCalledWith(
      'slack',
      'repo',
      {
        model: 'new-local-model',
        effort: 'high',
        agentKind: 'claude-code',
        permissionMode: 'ask',
      },
      'T1',
    );
    expect(getWorkspacePref('slack', 'T1', 'repo')).toMatchObject({
      model: 'new-local-model',
      effort: 'high',
      agentKind: 'claude-code',
      permissionMode: 'ask',
    });
  });

  it('multi-team 镜像保留完整快照中的非当前 team 偏好，但不向它写回', async () => {
    reconcileWorkspacePrefsForMirror('slack', [
      {
        workspace: 'repo',
        model: 'team-one-model',
        effort: 'high',
        agentKind: 'claude-code',
        permissionMode: 'ask',
        teamId: 'T1',
      },
    ]);
    const setRemotePrefs = vi.fn();
    const mirror = createWorkspacePrefsMirror({
      getLiveBindingKey: () => 'slack:T2',
      isMirrorTargetCurrent: (_channel, teamId) => teamId === null || teamId === 'T2',
      getRemoteSnapshotGeneration: () => 0,
      getRemotePrefs: async () => ({
        bound: true,
        prefs: [
          {
            workspace: 'repo',
            model: 'stale-team-one-model',
            effort: 'low',
            agentKind: 'codex',
            permissionMode: 'full',
            teamId: 'T1',
          },
        ],
      }),
      setRemotePrefs,
      onLocalPrefsChanged: vi.fn(),
      onError: vi.fn(),
    });

    await mirror('slack');

    expect(getWorkspacePref('slack', 'T1', 'repo')).toMatchObject({
      model: 'team-one-model',
      effort: 'high',
      agentKind: 'claude-code',
      permissionMode: 'ask',
    });
    expect(setRemotePrefs).not.toHaveBeenCalled();
  });

  it('prefs.get 在途时绑定集合变化会丢弃旧快照，且不再写已解绑 team', async () => {
    setWorkspacePref('slack', 'T1', 'repo', { model: 'local-team-one' });
    let bindingKey = 'slack:T1,T2';
    let releaseFirstGet!: () => void;
    const firstGetPending = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    const getRemotePrefs = vi.fn(async () => {
      if (getRemotePrefs.mock.calls.length === 1) {
        await firstGetPending;
        return {
          bound: true,
          prefs: [
            {
              workspace: 'repo',
              model: 'stale-team-one',
              effort: 'high',
              agentKind: 'codex',
              permissionMode: 'ask',
              teamId: 'T1',
            },
          ],
        };
      }
      return {
        bound: true,
        prefs: [
          {
            workspace: 'chat',
            model: 'stale-team-one-only',
            effort: null,
            agentKind: 'claude-code',
            permissionMode: null,
            teamId: 'T1',
          },
        ],
      };
    });
    const setRemotePrefs = vi.fn();
    const mirror = createWorkspacePrefsMirror({
      getLiveBindingKey: () => bindingKey,
      isMirrorTargetCurrent: (_channel, teamId) => teamId === null || teamId === 'T2',
      getRemoteSnapshotGeneration: () => 0,
      getRemotePrefs,
      setRemotePrefs,
      onLocalPrefsChanged: vi.fn(),
      onError: vi.fn(),
    });

    const flight = mirror('slack');
    await vi.waitFor(() => expect(getRemotePrefs).toHaveBeenCalledTimes(1));
    bindingKey = 'slack:T2';
    releaseFirstGet();
    await flight;

    expect(getRemotePrefs).toHaveBeenCalledTimes(2);
    expect(setRemotePrefs).not.toHaveBeenCalled();
    expect(getWorkspacePref('slack', 'T1', 'repo').model).toBe('local-team-one');
    expect(getWorkspacePref('slack', 'T1', 'chat').model).toBeNull();
  });
});
