import { beforeEach, describe, expect, it, vi } from 'vitest';

const origins = new Map<string, string>();
const localSessionIds = new Set<string>();
const sshHosts = new Map<string, string>();
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
      localSessionIds.has(id) ? { id, remoteHostId: sshHosts.get(id) ?? null } : null,
  },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: (id: string) => origins.get(id),
  remoteProjectsStore: {
    getDeviceList: () => [
      { deviceId: 'computer-a', deviceName: 'Computer A', connected: false },
      { deviceId: 'computer-b', deviceName: 'Computer B', connected: true },
    ],
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
