import { beforeEach, describe, expect, it, vi } from 'vitest';

const origins = new Map<string, string>();
const localSessionIds = new Set<string>();
const sshHosts = new Map<string, string>();
const projectWorkingDirs = new Map<string, string>();
type RemoteSession = {
  id: string;
  remoteHostId?: string | null;
  workingDir?: string | null;
  workspaceKind?: 'project' | 'dialogue';
};
const deviceSessions = new Map<string, RemoteSession[]>();
type BotSession = { id: string; role: 'canonical' | 'history' };
const botSessions = new Map<string, BotSession[]>();
vi.mock('@/features/bots/botStore', () => ({
  getBotProfiles: () => [...botSessions].map(([id, sessions]) => ({ id, sessions })),
  canonicalBotSessionId: (bot: { sessions: BotSession[] }) => {
    const canonical = bot.sessions.filter((row) => row.role === 'canonical');
    return canonical.length === 1 ? canonical[0].id : undefined;
  },
}));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: {
    findById: (id: string) =>
      localSessionIds.has(id)
        ? {
            id,
            remoteHostId: sshHosts.get(id) ?? null,
            workingDir: projectWorkingDirs.get(id) ?? null,
            workspaceKind: projectWorkingDirs.has(id) ? 'project' : 'dialogue',
          }
        : null,
  },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: (id: string) => origins.get(id),
  remoteProjectsStore: {
    getDeviceList: () => [
      { deviceId: 'computer-a', deviceName: 'Computer A', connected: false },
      { deviceId: 'computer-b', deviceName: 'Computer B', connected: true },
    ],
    getMergedRemoteSessions: () => [...deviceSessions.values()].flat(),
    getDeviceSessions: (deviceId: string) => deviceSessions.get(deviceId) ?? [],
  },
}));

import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';
import { makeGenericNewMakerRouteState } from '@/features/cc-agent/lib/genericNewMakerRouteState';
import {
  consumeNewMakerDialogueTargetRequest,
  readNewMakerDialogueTargetRequest,
} from '@/features/cc-agent/lib/newMakerRouteState';

beforeEach(() => {
  origins.clear();
  localSessionIds.clear();
  sshHosts.clear();
  projectWorkingDirs.clear();
  deviceSessions.clear();
  botSessions.clear();
  __resetStickySessionOriginForTest();
});

describe('new task inherits the current task computer', () => {
  it.each([
    '/cc-agent/task-a',
    '/cc-agent/orca/task-a',
    '/cc-agent/files/task-a',
    '/bots/remote/computer-a/bot-a',
  ])('inherits the task computer from %s, including an offline computer', (path) => {
    origins.set('task-a', 'computer-a');
    const state = makeGenericNewMakerRouteState(path);
    expect(state.workspacePrompt).toBe('generic');
    expect(readNewMakerDialogueTargetRequest(state)).toMatchObject({
      deviceId: 'computer-a',
      deviceName: 'Computer A',
      preserveWorkspaceIfSameDevice: true,
    });
  });

  it('follows the newly viewed task instead of the previous draft computer', () => {
    origins.set('task-a', 'computer-a');
    origins.set('task-b', 'computer-b');
    makeGenericNewMakerRouteState('/cc-agent/task-a');
    expect(
      readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState('/cc-agent/task-b')),
    ).toMatchObject({ deviceId: 'computer-b', deviceName: 'Computer B' });
  });

  it('returns to this computer from a local task', () => {
    localSessionIds.add('local-task');
    expect(
      readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState('/cc-agent/local-task')),
    ).toMatchObject({ deviceId: null, deviceName: null, preserveWorkspaceIfSameDevice: true });
  });

  it('shortcut mode inherits the current project and can override a saved draft project', () => {
    localSessionIds.add('project-task');
    projectWorkingDirs.set('project-task', '/workspace/project-a');

    const shortcutState = makeGenericNewMakerRouteState('/cc-agent/project-task', {
      inheritCurrentProject: true,
    });
    expect(readNewMakerDialogueTargetRequest(shortcutState)).toMatchObject({
      projectWorkingDir: '/workspace/project-a',
      preserveWorkspaceIfSameDevice: true,
    });
    expect(
      readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState('/cc-agent/project-task')),
    ).not.toHaveProperty('projectWorkingDir');
  });

  it('uses the newly viewed project rather than a previously selected draft project', () => {
    localSessionIds.add('project-a-task');
    localSessionIds.add('project-b-task');
    projectWorkingDirs.set('project-a-task', '/workspace/project-a');
    projectWorkingDirs.set('project-b-task', '/workspace/project-b');

    const projectA = readNewMakerDialogueTargetRequest(
      makeGenericNewMakerRouteState('/cc-agent/project-a-task', { inheritCurrentProject: true }),
    );
    const projectB = readNewMakerDialogueTargetRequest(
      makeGenericNewMakerRouteState('/cc-agent/project-b-task', { inheritCurrentProject: true }),
    );

    expect(projectA?.projectWorkingDir).toBe('/workspace/project-a');
    expect(projectB?.projectWorkingDir).toBe('/workspace/project-b');
    expect(projectB?.requestId).not.toBe(projectA?.requestId);
  });

  it.each([
    ['/project-a/.cindy-worktrees/task-1', '/project-a'],
    ['/project-a/.xdt-worktrees/task-1/src', '/project-a'],
    ['C:\\project-a\\.cindy-worktrees\\task-1', 'C:/project-a'],
    ['/project-a/', '/project-a'],
    ['/project-a/.worktrees/user-checkout', '/project-a/.worktrees/user-checkout'],
    ['/project-a/.claude/worktrees/user-checkout', '/project-a/.claude/worktrees/user-checkout'],
  ])('uses the draft project entry for a local task at %s', (workingDir, expected) => {
    localSessionIds.add('project-task');
    projectWorkingDirs.set('project-task', workingDir);
    expect(readNewMakerDialogueTargetRequest(
      makeGenericNewMakerRouteState('/cc-agent/project-task', { inheritCurrentProject: true }),
    )?.projectWorkingDir).toBe(expected);
  });

  it('uses the selected remote device project root rather than its managed checkout', () => {
    origins.set('remote-task', 'computer-b');
    deviceSessions.set('computer-b', [{
      id: 'remote-task', workingDir: '/remote/project/.cindy-worktrees/task-1', workspaceKind: 'project',
    }]);
    expect(readNewMakerDialogueTargetRequest(
      makeGenericNewMakerRouteState('/cc-agent/remote-task', { inheritCurrentProject: true }),
    )).toMatchObject({ deviceId: 'computer-b', projectWorkingDir: '/remote/project' });
  });

  it('a known global dialogue explicitly clears the saved draft project', () => {
    localSessionIds.add('dialogue-task');
    const request = readNewMakerDialogueTargetRequest(
      makeGenericNewMakerRouteState('/cc-agent/dialogue-task', { inheritCurrentProject: true }),
    );
    expect(request).toMatchObject({ projectWorkingDir: null });
  });

  it('repeated shortcuts preserve the chosen project while creating distinct requests', () => {
    localSessionIds.add('project-task');
    projectWorkingDirs.set('project-task', '/workspace/project-a');
    const requests = Array.from({ length: 3 }, () =>
      readNewMakerDialogueTargetRequest(
        makeGenericNewMakerRouteState('/cc-agent/project-task', { inheritCurrentProject: true }),
      ),
    );
    expect(requests.map((request) => request?.projectWorkingDir)).toEqual([
      '/workspace/project-a',
      '/workspace/project-a',
      '/workspace/project-a',
    ]);
    expect(new Set(requests.map((request) => request?.requestId)).size).toBe(3);
    const consumed = consumeNewMakerDialogueTargetRequest({
      workspacePrompt: 'generic',
      dialogueTargetRequest: requests[0],
    });
    expect(readNewMakerDialogueTargetRequest(consumed)).toBeNull();
    // Already on the new-task page: retain the user's current draft target.
    expect(makeGenericNewMakerRouteState('/cc-agent/new', { inheritCurrentProject: true })).toEqual(
      { workspacePrompt: 'generic' },
    );
  });

  it('never inherits a stale local project when the remote session projection is unavailable', () => {
    origins.set('task-a', 'computer-a');
    localSessionIds.add('task-a');
    projectWorkingDirs.set('task-a', '/stale/local-project');
    const request = readNewMakerDialogueTargetRequest(
      makeGenericNewMakerRouteState('/cc-agent/task-a', { inheritCurrentProject: true }),
    );
    expect(request?.deviceId).toBe('computer-a');
    expect(request).not.toHaveProperty('projectWorkingDir');
  });

  it('inherits a current project from a device-link task', () => {
    origins.set('remote-project-task', 'computer-a');
    deviceSessions.set('computer-a', [{
      id: 'remote-project-task',
      workingDir: '/remote/project-a',
      workspaceKind: 'project',
    }]);

    expect(
      readNewMakerDialogueTargetRequest(
        makeGenericNewMakerRouteState('/cc-agent/remote-project-task', {
          inheritCurrentProject: true,
        }),
      ),
    ).toMatchObject({
      deviceId: 'computer-a',
      projectWorkingDir: '/remote/project-a',
    });
  });

  it('inherits the selected device project when two devices share a session ID', () => {
    deviceSessions.set('computer-a', [{
      id: 'shared-task', workingDir: '/computer-a/project', workspaceKind: 'project',
    }]);
    deviceSessions.set('computer-b', [{
      id: 'shared-task', workingDir: '/computer-b/project', workspaceKind: 'project',
    }]);
    origins.set('shared-task', 'computer-b');

    expect(readNewMakerDialogueTargetRequest(
      makeGenericNewMakerRouteState('/cc-agent/shared-task', { inheritCurrentProject: true }),
    )).toMatchObject({ deviceId: 'computer-b', projectWorkingDir: '/computer-b/project' });
  });

  it('does not borrow another device project while the sticky device projection is missing', () => {
    origins.set('shared-task', 'computer-b');
    makeGenericNewMakerRouteState('/cc-agent/shared-task');
    origins.clear();
    deviceSessions.set('computer-a', [{
      id: 'shared-task', workingDir: '/computer-a/project', workspaceKind: 'project',
    }]);

    const request = readNewMakerDialogueTargetRequest(
      makeGenericNewMakerRouteState('/cc-agent/shared-task', { inheritCurrentProject: true }),
    );
    expect(request?.deviceId).toBe('computer-b');
    expect(request).not.toHaveProperty('projectWorkingDir');
  });

  it('inherits explicit remote bot ownership before the session list loads', () => {
    expect(
      readNewMakerDialogueTargetRequest(
        makeGenericNewMakerRouteState('/bots/remote/computer-a/bot-a'),
      ),
    ).toMatchObject({ deviceId: 'computer-a' });
  });

  it('follows remote bot, local canonical bot, then local history navigation', () => {
    botSessions.set('bot-local', [
      { id: 'local-task', role: 'canonical' },
      { id: 'old-task', role: 'history' },
    ]);
    expect(
      readNewMakerDialogueTargetRequest(
        makeGenericNewMakerRouteState('/bots/remote/computer-a/bot-a'),
      ),
    ).toMatchObject({ deviceId: 'computer-a' });
    expect(
      readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState('/bots/bot-local')),
    ).toMatchObject({ deviceId: null });
    // Production excludes source=bot from sessionsStore, even after loading.
    expect(localSessionIds.size).toBe(0);
    for (const path of ['/bots/bot-local/session/local-task', '/bots/bot-local/history/old-task']) {
      expect(readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState(path))).toMatchObject({
        deviceId: null,
      });
    }
  });

  it.each(['/cc-agent/task-a', '/cc-agent/orca/task-a', '/cc-agent/files/task-a'])(
    'uses execution provenance rather than cache presence on %s',
    (path) => {
      expect(makeGenericNewMakerRouteState(path)).toEqual({ workspacePrompt: 'generic' });
      // Loaded SSH rows still belong to another host; keep the existing draft.
      localSessionIds.add('task-a');
      sshHosts.set('task-a', 'ssh-a');
      expect(makeGenericNewMakerRouteState(path)).toEqual({ workspacePrompt: 'generic' });
      sshHosts.delete('task-a');
      expect(readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState(path))).toMatchObject({
        deviceId: null,
      });
      // Bot-owned rows come from a separate projection, not the ordinary cache.
      localSessionIds.clear();
      botSessions.set('bot-a', [{ id: 'task-a', role: 'canonical' }]);
      expect(readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState(path))).toMatchObject({
        deviceId: null,
      });
      // Explicit SSH evidence must also win over a lingering Bot projection.
      localSessionIds.add('task-a');
      sshHosts.set('task-a', 'ssh-b');
      expect(makeGenericNewMakerRouteState(path)).toEqual({ workspacePrompt: 'generic' });
    },
  );

  it.each(['session', 'history'])('requires matching Bot ownership on a %s route', (kind) => {
    const path = `/bots/bot-a/${kind}/task-a`;
    localSessionIds.add('task-a');
    origins.set('task-a', 'computer-a');
    botSessions.set('bot-b', [{ id: 'task-a', role: 'canonical' }]);
    botSessions.set('bot-a', []);
    expect(makeGenericNewMakerRouteState(path)).toEqual({ workspacePrompt: 'generic' });
    localSessionIds.clear();
    origins.clear();
    botSessions.set('bot-a', [
      { id: 'task-a', role: kind === 'session' ? 'canonical' : 'history' },
    ]);
    expect(readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState(path))).toMatchObject({
      deviceId: null,
    });
    botSessions.delete('bot-a');
    expect(makeGenericNewMakerRouteState(path)).toEqual({ workspacePrompt: 'generic' });
  });

  it('keeps remote ownership during a reconnect instead of falling back locally', () => {
    origins.set('task-a', 'computer-a');
    makeGenericNewMakerRouteState('/cc-agent/task-a');
    origins.clear();
    expect(
      readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState('/cc-agent/task-a')),
    ).toMatchObject({ deviceId: 'computer-a' });
  });

  it('preserves the draft until a cold-start task origin is known', () => {
    expect(makeGenericNewMakerRouteState('/cc-agent/task-a')).toEqual({
      workspacePrompt: 'generic',
    });
    origins.set('task-a', 'computer-a');
    expect(
      readNewMakerDialogueTargetRequest(makeGenericNewMakerRouteState('/cc-agent/task-a')),
    ).toMatchObject({ deviceId: 'computer-a' });
  });

  it.each([
    '/cc-agent/new',
    '/cc-agent/scheduled',
    '/cc-agent/orca/new',
    '/settings',
    '/plugins',
    '/bots',
    '/bots/roster',
    '/bots/remote',
    '/bots/unknown',
    '/bots/bot-a/direct/thread-a',
  ])('preserves the draft when no task is active at %s', (path) => {
    expect(makeGenericNewMakerRouteState(path)).toEqual({ workspacePrompt: 'generic' });
  });

  it('consumes the inherited target once so history does not override later user choices', () => {
    origins.set('task-a', 'computer-a');
    const state = makeGenericNewMakerRouteState('/cc-agent/task-a');
    expect(consumeNewMakerDialogueTargetRequest(state)).toEqual({ workspacePrompt: 'generic' });
    expect(readNewMakerDialogueTargetRequest(state)).not.toBeNull();
  });
});
