import { beforeEach, describe, expect, it, vi } from 'vitest';

const origins = new Map<string, string>();
const localSessionIds = new Set<string>();
const sshHosts = new Map<string, string>();
type BotSession = { id: string; role: 'canonical' | 'history' };
const botSessions = new Map<string, BotSession[]>();
type ModelFields = Record<string, unknown>;
const localModels = new Map<string, ModelFields>();
const remoteSessions = new Map<string, Array<{ id: string } & ModelFields>>();
const intents = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/agentSwitchIntentReader', () => ({
  readAgentSwitchIntent: (id: string) => intents.get(id) ?? null,
}));
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
        ? { id, remoteHostId: sshHosts.get(id) ?? null, ...localModels.get(id) }
        : null,
  },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: (id: string) => origins.get(id),
  remoteProjectsStore: {
    getDeviceSessions: (deviceId: string) => remoteSessions.get(deviceId) ?? [],
    getMergedRemoteSessions: () => [...remoteSessions.values()].flat(),
    getDeviceList: () => [
      { deviceId: 'computer-a', deviceName: 'Computer A', connected: false },
      { deviceId: 'computer-b', deviceName: 'Computer B', connected: true },
    ],
  },
}));

import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';
import { makeGenericNewMakerRouteState } from '@/features/cc-agent/lib/genericNewMakerRouteState';
import { publishComposerOptimisticSelection } from '@/lib/composerOptimisticSelection';
import {
  consumeNewMakerDialogueTargetRequest,
  consumeNewMakerModelInheritanceRequest,
  readNewMakerDialogueTargetRequest,
  readNewMakerModelInheritanceRequest,
} from '@/features/cc-agent/lib/newMakerRouteState';

beforeEach(() => {
  origins.clear();
  localSessionIds.clear();
  sshHosts.clear();
  botSessions.clear();
  localModels.clear();
  remoteSessions.clear();
  intents.clear();
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

describe('new task inherits the current task model', () => {
  const opus = {
    agentKind: 'cc',
    model: 'claude-opus-4',
    providerId: 'anthropic',
    effort: 'high',
    fastMode: false,
  };

  it('carries the local task model, provider, effort, fast and agent computer', () => {
    localSessionIds.add('local-task');
    localModels.set('local-task', { ...opus, fastMode: 'ultrafast', agentDeviceId: 'computer-b' });
    expect(
      readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState('/cc-agent/local-task')),
    ).toMatchObject({
      vendor: 'cc',
      model: 'claude-opus-4',
      providerId: 'anthropic',
      effort: 'high',
      fastMode: 'ultrafast',
      agentDeviceId: 'computer-b',
      taskDeviceId: null,
      remoteHostId: null,
    });
  });

  it('shows what the task composer shows: pending switch intent over the running route', () => {
    localSessionIds.add('local-task');
    localModels.set('local-task', {
      ...opus,
      runtimeEffective: {
        agentKind: 'claude-code',
        model: 'claude-sonnet-4',
        providerId: 'xd',
        effort: 'low',
        fastMode: false,
      },
    });
    expect(
      readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState('/cc-agent/local-task')),
    ).toMatchObject({ vendor: 'cc', model: 'claude-sonnet-4', providerId: 'xd', effort: 'low' });

    intents.set('local-task', {
      target: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'medium',
      fastMode: true,
      agentDeviceId: null,
    });
    expect(
      readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState('/cc-agent/local-task')),
    ).toMatchObject({
      vendor: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'medium',
      fastMode: true,
      agentDeviceId: null,
    });
  });

  it('tags a remote-computer task with its computer so only that computer applies it', () => {
    origins.set('task-a', 'computer-a');
    remoteSessions.set('computer-a', [{ id: 'task-a', ...opus, agentKind: 'pi', effort: '' }]);
    const state = makeGenericNewMakerRouteState('/cc-agent/task-a');
    expect(readNewMakerDialogueTargetRequest(state)).toMatchObject({ deviceId: 'computer-a' });
    expect(readNewMakerModelInheritanceRequest(state)).toMatchObject({
      vendor: 'pi',
      model: 'claude-opus-4',
      effort: null,
      taskDeviceId: 'computer-a',
      remoteHostId: null,
    });
  });

  it('carries the optimistic remote switch the composer shows before the mirror catches up', () => {
    origins.set('task-a', 'computer-a');
    remoteSessions.set('computer-a', [{ id: 'task-a', ...opus }]);
    const optimistic = {
      model: 'claude-sonnet-4',
      providerId: 'xd',
      effort: 'low' as const,
      fastMode: true,
    };
    const unpublish = publishComposerOptimisticSelection('task-a', optimistic);
    expect(
      readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState('/cc-agent/task-a')),
    ).toMatchObject({ vendor: 'cc', ...optimistic, taskDeviceId: 'computer-a' });
    // 新登记覆盖后，旧登记的撤销不能误删新的那份。
    const newer = { ...optimistic, model: 'claude-haiku-4' };
    const unpublishNewer = publishComposerOptimisticSelection('task-a', newer);
    unpublish();
    expect(
      readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState('/cc-agent/task-a')),
    ).toMatchObject({ model: 'claude-haiku-4' });
    // 回流后撤销：回到镜像里的模型。
    unpublishNewer();
    expect(
      readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState('/cc-agent/task-a')),
    ).toMatchObject({ model: 'claude-opus-4', providerId: 'anthropic', effort: 'high' });
  });

  it('tags an SSH task with its host and ignores controller-local switch intents', () => {
    localSessionIds.add('ssh-task');
    sshHosts.set('ssh-task', 'ssh-a');
    localModels.set('ssh-task', { ...opus, agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' });
    intents.set('ssh-task', { target: 'claude-code', model: 'other', providerId: null });
    const state = makeGenericNewMakerRouteState('/cc-agent/ssh-task');
    // The draft keeps its SSH workspace; only the model is carried.
    expect(readNewMakerDialogueTargetRequest(state)).toBeNull();
    expect(readNewMakerModelInheritanceRequest(state)).toMatchObject({
      vendor: 'codex',
      model: 'gpt-5.5',
      agentDeviceId: null,
      taskDeviceId: null,
      remoteHostId: 'ssh-a',
    });
  });

  it.each(['/cc-agent/new', '/bots/bot-a/session/task-a', '/settings'])(
    'carries no model from %s',
    (path) => {
      localSessionIds.add('task-a');
      localModels.set('task-a', opus);
      botSessions.set('bot-a', [{ id: 'task-a', role: 'canonical' }]);
      expect(readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState(path))).toBeNull();
    },
  );

  it('carries no model until the task row is known, and consumes it once', () => {
    origins.set('task-a', 'computer-a');
    expect(
      readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState('/cc-agent/task-a')),
    ).toBeNull();
    remoteSessions.set('computer-a', [{ id: 'task-a', ...opus }]);
    const state = makeGenericNewMakerRouteState('/cc-agent/task-a');
    const consumed = consumeNewMakerModelInheritanceRequest(state);
    expect(readNewMakerModelInheritanceRequest(consumed)).toBeNull();
    expect(readNewMakerDialogueTargetRequest(consumed)).not.toBeNull();
    expect(
      readNewMakerModelInheritanceRequest(makeGenericNewMakerRouteState('/cc-agent/task-a'))
        ?.requestId,
    ).not.toBe(readNewMakerModelInheritanceRequest(state)?.requestId);
  });
});
