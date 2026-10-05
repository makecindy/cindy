import { describe, expect, it } from 'vitest';

import {
  parseAgentIslandRemoteSessions,
  type AgentIslandRemoteSessionInput,
} from '../../../shared/agentIsland.js';
import {
  acknowledgeAgentIslandSessionRead,
  AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS,
  buildAgentIslandDisplayState,
  buildAllSessionActivitySnapshots,
  createAgentIslandState,
  isAgentIslandDeviceSession,
  markAgentIslandSessionAttention,
  pruneAgentIslandSessions,
  setAgentIslandAppFocused,
  setAgentIslandVisibleSession,
  syncAgentIslandDeviceSessions,
} from '../state.js';

function remote(
  phase: AgentIslandRemoteSessionInput['phase'],
  overrides: Partial<AgentIslandRemoteSessionInput> = {},
): AgentIslandRemoteSessionInput {
  return {
    sessionId: 'remote-1',
    deviceId: 'device-a',
    deviceName: 'Studio Mac',
    title: 'Fix login',
    workingDir: '/Users/me/code/cindy',
    workspaceKind: 'project',
    agentKind: 'codex',
    phase,
    detail: '',
    ...overrides,
  };
}

describe('Agent Island device sessions', () => {
  it('shows a first-seen remote task without revealing it or emitting an event', () => {
    const state = createAgentIslandState();
    const result = syncAgentIslandDeviceSessions(state, [remote('completed')], 1_000);

    expect(result.baselineSessionIds).toEqual(['remote-1']);
    expect(result.events).toEqual([]);
    const display = buildAgentIslandDisplayState(state, 1_000);
    expect(display.mode).toBe('compact');
    expect(display.sessions).toEqual([
      expect.objectContaining({
        sessionId: 'remote-1',
        title: 'Fix login',
        projectName: 'cindy · Studio Mac',
        agentKind: 'codex',
        phase: 'completed',
        attention: true,
      }),
    ]);
  });

  it('lists a first-seen waiting remote task without expanding its card', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(
      state,
      [remote('needs-interaction', { interactionKind: 'ask_user_question' })],
      1_000,
    );

    const display = buildAgentIslandDisplayState(state, 1_000);
    expect(display.mode).toBe('compact');
    expect(display.sessions).toEqual([
      expect.objectContaining({ sessionId: 'remote-1', phase: 'needs-interaction', attention: true }),
    ]);
  });

  it('reveals and reports observed transitions', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(state, [remote('running', { detail: 'Reading files' })], 1_000);

    const waiting = syncAgentIslandDeviceSessions(
      state,
      [remote('needs-interaction', { interactionKind: 'permission' })],
      2_000,
    );
    expect(waiting.events).toEqual([
      { sessionId: 'remote-1', title: 'Fix login', deviceName: 'Studio Mac', kind: 'needs-reply' },
    ]);
    const waitingDisplay = buildAgentIslandDisplayState(state, 2_000);
    expect(waitingDisplay.mode).toBe('expanded');
    expect(waitingDisplay.displayPolicy).toBe('blocking');
    // 远程审批不在本机执行,不给允许 / 拒绝按钮。
    expect(waitingDisplay.sessions[0]?.permissionAction).toBeNull();

    syncAgentIslandDeviceSessions(state, [remote('running')], 3_000);
    const done = syncAgentIslandDeviceSessions(state, [remote('completed')], 4_000);
    expect(done.events.map((event) => event.kind)).toEqual(['done']);
    expect(buildAgentIslandDisplayState(state, 4_000)).toEqual(
      expect.objectContaining({ mode: 'expanded', displayPolicy: 'transient' }),
    );

    syncAgentIslandDeviceSessions(state, [remote('running')], 5_000);
    const failed = syncAgentIslandDeviceSessions(
      state,
      [remote('error', { detail: 'Quota exceeded' })],
      6_000,
    );
    expect(failed.events.map((event) => event.kind)).toEqual(['error']);
    expect(buildAgentIslandDisplayState(state, 6_000).sessions[0]).toEqual(
      expect.objectContaining({ phase: 'error', detail: 'Quota exceeded', attention: true }),
    );
  });

  it('does not repeat events for an unchanged phase', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(state, [remote('running')], 1_000);
    syncAgentIslandDeviceSessions(state, [remote('completed')], 2_000);

    const repeated = syncAgentIslandDeviceSessions(state, [remote('completed')], 3_000);
    expect(repeated.events).toEqual([]);
    expect(repeated.changed).toBe(false);
  });

  it('keeps remote tasks out of this machine’s activity snapshots', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(
      state,
      [remote('running'), remote('completed', { sessionId: 'remote-2' })],
      1_000,
    );

    expect(buildAllSessionActivitySnapshots(state)).toEqual([]);
    expect(state.remoteUnreadTerminals.size).toBe(0);
  });

  it('removes tasks that leave the synced list, including when they move devices', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(
      state,
      [remote('running'), remote('running', { sessionId: 'remote-2' })],
      1_000,
    );

    const result = syncAgentIslandDeviceSessions(
      state,
      [remote('running', { deviceId: 'device-b' })],
      2_000,
    );

    expect(result.changed).toBe(true);
    expect(state.sessions.has('remote-2')).toBe(false);
    // 换设备 = 新条目,不沿用旧设备的状态。
    expect(result.baselineSessionIds).toEqual(['remote-1']);
    expect(
      buildAgentIslandDisplayState(state, 2_000).sessions.map((session) => session.sessionId),
    ).toEqual(['remote-1']);
  });

  it('suppresses the reveal when the user is viewing that remote task', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(state, [remote('running')], 1_000);
    setAgentIslandAppFocused(state, true, 1_000);
    setAgentIslandVisibleSession(state, 'remote-1', 1_000);

    syncAgentIslandDeviceSessions(state, [remote('completed')], 2_000);

    const display = buildAgentIslandDisplayState(state, 2_000);
    expect(display.mode).toBe('compact');
    expect(display.sessions[0]?.attention).toBe(false);
  });

  it('keeps a read remote task hidden instead of re-adding it as unread', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(state, [remote('running')], 1_000);
    syncAgentIslandDeviceSessions(state, [remote('completed')], 2_000);

    expect(acknowledgeAgentIslandSessionRead(state, 'remote-1', 20_000)).toBe('cleared');
    expect(isAgentIslandDeviceSession(state, 'remote-1')).toBe(true);

    const result = syncAgentIslandDeviceSessions(state, [remote('completed')], 21_000);
    expect(result.baselineSessionIds).toEqual([]);
    expect(buildAgentIslandDisplayState(state, 21_000).sessions).toEqual([]);
  });

  it('does not prune expired remote tasks or mirror local app-badge attention onto them', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(state, [remote('completed')], 1_000);
    const later = 1_000 + AGENT_ISLAND_UNREAD_TRANSIENT_TTL_MS + 1;

    pruneAgentIslandSessions(state, later);
    expect(state.sessions.has('remote-1')).toBe(true);
    expect(buildAgentIslandDisplayState(state, later).sessions).toEqual([]);

    syncAgentIslandDeviceSessions(state, [remote('running')], later);
    expect(markAgentIslandSessionAttention(state, 'remote-1')).toBe(false);
  });

  it('never overrides a local task with the same id', () => {
    const state = createAgentIslandState();
    syncAgentIslandDeviceSessions(state, [remote('running')], 1_000);
    const local = state.sessions.get('remote-1');
    if (!local) throw new Error('missing session');
    local.sourceDeviceId = null;

    const result = syncAgentIslandDeviceSessions(state, [remote('completed')], 2_000);
    expect(result.events).toEqual([]);
    expect(state.sessions.get('remote-1')?.phase).toBe('running');
  });
});

describe('parseAgentIslandRemoteSessions', () => {
  it('drops invalid entries and duplicate ids', () => {
    expect(
      parseAgentIslandRemoteSessions([
        remote('running'),
        remote('completed'),
        { ...remote('running', { sessionId: 'remote-2' }), phase: 'paused' },
        { ...remote('running', { sessionId: 'remote-3' }), deviceId: '' },
        { ...remote('needs-interaction', { sessionId: 'remote-4' }), interactionKind: 'unknown' },
        null,
      ]),
    ).toEqual([remote('running'), { ...remote('needs-interaction', { sessionId: 'remote-4' }) }]);
  });

  it('rejects non-array and oversized payloads', () => {
    expect(parseAgentIslandRemoteSessions({})).toBeNull();
    expect(
      parseAgentIslandRemoteSessions(Array.from({ length: 501 }, () => remote('running'))),
    ).toBeNull();
  });
});
