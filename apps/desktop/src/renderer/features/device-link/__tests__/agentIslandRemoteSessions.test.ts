import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import { buildAgentIslandRemoteSessionInputs } from '../agentIslandRemoteSessions';
import { applyRemoteSessionActivity, clearRemoteSessionActivity, getRemoteSessionActivity, type RemoteSessionActivity } from '../remoteSessionActivityStore';
import { parseAgentIslandRemoteSessions } from '../../../../shared/agentIsland';
import { agentIslandCompletionToken, buildAgentIslandDisplayState, createAgentIslandState, syncAgentIslandDeviceSessions } from '../../../../main/agent-island/state';
import { normalizeActivityText } from '../../../../main/agent-island/activityTextStream';
import { SessionActivityRelay } from '../../../../main/agent-island/sessionActivityRelay';
import { MACHINE_ALL, MACHINE_LOCAL } from '../selectedMachineStore';

function remoteSession(id: string, deviceId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Task ${id}`,
    workingDir: '/Users/me/code/cindy',
    workspaceKind: 'project',
    agentKind: 'cc',
    deviceLinkDeviceId: deviceId,
    deviceLinkDeviceName: `Mac ${deviceId}`,
    deviceLinkConnectionStatus: 'connected',
    ...overrides,
  } as Session;
}

const activities = new Map<string, RemoteSessionActivity>([
  [
    'a-1',
    {
      sessionId: 'a-1',
      phase: 'running',
      compactDetail: 'Reading files',
      workingPhase: 'reading-file',
      attention: false,
    },
  ],
  [
    'b-1',
    {
      sessionId: 'b-1',
      phase: 'needs-interaction',
      compactDetail: '',
      interactionKind: 'permission',
      attention: true,
    },
  ],
  ['b-2', { sessionId: 'b-2', phase: 'completed', compactDetail: '', attention: true }],
]);
const readActivity = (sessionId: string): RemoteSessionActivity | undefined =>
  activities.get(sessionId);

describe('buildAgentIslandRemoteSessionInputs', () => {
  // Unit regression #7972: the selected project must survive renderer -> IPC
  // parsing -> island state, including a later explicit move clearing membership.
  it('carries project membership through the complete remote island projection', () => {
    const state = createAgentIslandState();
    const session = remoteSession('a-1', 'device-a', {
      projectDir: '/products/Chosen', workingDir: '/tmp/checkout',
    });
    const sync = () => syncAgentIslandDeviceSessions(state, parseAgentIslandRemoteSessions(
      buildAgentIslandRemoteSessionInputs([session], MACHINE_ALL, readActivity),
    )!, 2000);
    sync();
    expect(buildAgentIslandDisplayState(state, 2000).sessions[0]?.projectName).toBe('Chosen · Mac device-a');
    session.projectDir = null;
    session.workingDir = '/products/Moved';
    sync();
    expect(buildAgentIslandDisplayState(state, 2000).sessions[0]?.projectName).toBe('Moved · Mac device-a');
  });

  // #7566 review, unit: new host plain text survives the complete transport chain;
  // an old/unknown format still uses Markdown compatibility on the same text.
  it('preserves literal code through relay, store, IPC and running/completed cards', () => {
    clearRemoteSessionActivity();
    const state = createAgentIslandState();
    const relay = new SessionActivityRelay(payload => {
      applyRemoteSessionActivity('device-a', payload);
      const inputs = buildAgentIslandRemoteSessionInputs([remoteSession('a-1', 'device-a')], MACHINE_ALL, getRemoteSessionActivity);
      syncAgentIslandDeviceSessions(state, parseAgentIslandRemoteSessions(inputs)!, 2000);
    }, { minIntervalMs: 0 });
    const plain = normalizeActivityText('`foo_bar **literal**`');
    const activity = { sessionId: 'a-1', phase: 'running' as const, recordStatus: 'active',
      compactDetail: plain, summaryFormat: 'plain-text' as const,
      startedAtMs: 1, lastActivityAtMs: 1, currentActionSummary: plain,
      attention: true, workflow: null, turnGeneration: null, gracefulStopState: 'none', source: 'live' } as const;
    try {
      for (const phase of ['running', 'completed'] as const) {
        relay.publish([{ ...activity, phase }]);
        expect(buildAgentIslandDisplayState(state, 2000).sessions[0]?.compactDetail).toBe(plain);
      }
      // The text itself does not change: format changes must invalidate relay/store signatures.
      relay.publish([{ ...activity, phase: 'completed', summaryFormat: undefined }]);
      expect(buildAgentIslandDisplayState(state, 2000).sessions[0]?.compactDetail).toBe('foo_bar literal');
      relay.publish([{ ...activity, phase: 'completed' }]);
      expect(buildAgentIslandDisplayState(state, 2000).sessions[0]?.compactDetail).toBe(plain);
    } finally {
      relay.dispose();
      clearRemoteSessionActivity();
    }
  });
  // Full production projection chain: a second completion with identical text
  // must replace the owner token, while an old host must not gain swipe actions.
  it('preserves completion identity through relay, store, parser and native projection', () => {
    clearRemoteSessionActivity();
    const state = createAgentIslandState();
    const relay = new SessionActivityRelay(payload => {
      applyRemoteSessionActivity('device-a', payload);
      const inputs = buildAgentIslandRemoteSessionInputs([remoteSession('a-1', 'device-a')], MACHINE_ALL, getRemoteSessionActivity);
      syncAgentIslandDeviceSessions(state, parseAgentIslandRemoteSessions(inputs)!, 2000);
    }, { minIntervalMs: 0 });
    const completion = { sessionId: 'a-1', phase: 'completed' as const, recordStatus: 'active',
      compactDetail: 'Done', startedAtMs: 1, lastActivityAtMs: 1, currentActionSummary: 'Done',
      attention: true, workflow: null, turnGeneration: null, gracefulStopState: 'none', source: 'live' } as const;
    try {
      relay.publish([{ ...completion, completionToken: 'owner:1' }]);
      expect(agentIslandCompletionToken(state.sessions.get('a-1')!)).toBe('owner:1');
      relay.publish([{ ...completion, completionToken: 'owner:2' }]);
      expect(agentIslandCompletionToken(state.sessions.get('a-1')!)).toBe('owner:2');
      relay.publish([completion]);
      expect(agentIslandCompletionToken(state.sessions.get('a-1')!)).toBeUndefined();
    } finally {
      relay.dispose();
      clearRemoteSessionActivity();
    }
  });
  const sessions = [
    remoteSession('a-1', 'device-a'),
    remoteSession('a-idle', 'device-a'),
    remoteSession('b-1', 'device-b'),
    remoteSession('b-2', 'device-b', { title: '  ' }),
  ];

  it.each([true, false])('carries host notification ownership through relay, store, IPC parsing and remote events (%s)', async handled => {
    clearRemoteSessionActivity();
    let resolve!: (handled: boolean) => void;
    const state = createAgentIslandState();
    const events: string[] = [];
    const relay = new SessionActivityRelay(payload => {
      applyRemoteSessionActivity('device-a', payload);
      const inputs = buildAgentIslandRemoteSessionInputs([remoteSession('a-1', 'device-a')], MACHINE_ALL, getRemoteSessionActivity);
      const parsed = parseAgentIslandRemoteSessions(inputs);
      expect(parsed).not.toBeNull();
      events.push(...syncAgentIslandDeviceSessions(state, parsed!, 2_000).events.map(event => event.kind));
    }, { isCompletionHandledByTeammate: () => new Promise<boolean>(r => { resolve = r; }) });
    const activity = { sessionId: 'a-1', phase: 'running' as const, recordStatus: 'active', compactDetail: 'Working', startedAtMs: 1, lastActivityAtMs: 1, currentActionSummary: 'Working', attention: false, workflow: null, turnGeneration: null, gracefulStopState: 'none', source: 'live' } as const;
    relay.publish([activity]);
    relay.publish([{ ...activity, phase: 'completed', attention: true, compactDetail: 'Final result' }]);
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(getRemoteSessionActivity('a-1', 'device-a')).toMatchObject({ phase: 'completed', attention: true, compactDetail: 'Final result' });
    resolve(handled);
    await relay.waitForCompletionNotification('a-1');
    expect(events).toEqual(handled ? [] : ['done']);
    relay.replay([{ ...activity, phase: 'completed', attention: true }]);
    expect(events).toEqual(handled ? [] : ['done']);
    expect(state.sessions.get('a-1')).toMatchObject({ phase: 'completed', unread: true });
    relay.dispose(); clearRemoteSessionActivity();
  });

  it('carries silence through relay, store and IPC without losing unread or suppressing later errors', () => {
    clearRemoteSessionActivity();
    const state = createAgentIslandState();
    const events: string[] = [];
    const relay = new SessionActivityRelay(payload => {
      applyRemoteSessionActivity('device-a', payload);
      const inputs = buildAgentIslandRemoteSessionInputs([remoteSession('a-1', 'device-a')], MACHINE_ALL, getRemoteSessionActivity);
      const parsed = parseAgentIslandRemoteSessions(inputs);
      expect(parsed).not.toBeNull();
      events.push(...syncAgentIslandDeviceSessions(state, parsed!, 2_000).events.map(event => event.kind));
    }, { minIntervalMs: 0 });
    const activity = { sessionId: 'a-1', phase: 'running', recordStatus: 'active', compactDetail: 'Working', startedAtMs: 1, lastActivityAtMs: 1, currentActionSummary: 'Working', attention: true, workflow: null, turnGeneration: null, gracefulStopState: 'none', source: 'live' } as const;
    try {
      relay.publish([activity]);
      const silent = { ...activity, phase: 'completed' as const, completionNotification: 'silent' as const };
      relay.publish([silent]);
      relay.replay([silent]);
      expect(events).toEqual([]);
      expect(state.sessions.get('a-1')).toMatchObject({ phase: 'completed', unread: true, completionNotification: 'silent' });
      expect(state.activeTransientSessionId).toBeNull();
      relay.publish([activity]);
      relay.publish([{ ...activity, phase: 'error' }]);
      expect(events).toEqual(['error']);
    } finally {
      relay.dispose();
      clearRemoteSessionActivity();
    }
  });

  it('includes every remote task with live activity under the "all" scope', () => {
    expect(buildAgentIslandRemoteSessionInputs(sessions, MACHINE_ALL, readActivity)).toEqual([
      {
        sessionId: 'a-1',
        deviceId: 'device-a',
        deviceName: 'Mac device-a',
        title: 'Task a-1',
        workingDir: '/Users/me/code/cindy',
        workspaceKind: 'project',
        agentKind: 'cc',
        phase: 'running',
        detail: 'Reading files',
        workingPhase: 'reading-file',
      },
      expect.objectContaining({
        sessionId: 'b-1',
        phase: 'needs-interaction',
        interactionKind: 'permission',
      }),
      expect.objectContaining({ sessionId: 'b-2', phase: 'completed', title: null }),
    ]);
  });

  it('follows the sidebar task scope', () => {
    expect(
      buildAgentIslandRemoteSessionInputs(sessions, ['device-b'], readActivity).map(
        (input) => input.sessionId,
      ),
    ).toEqual(['b-1', 'b-2']);
    expect(buildAgentIslandRemoteSessionInputs(sessions, [MACHINE_LOCAL], readActivity)).toEqual(
      [],
    );
  });

  // A companion whose main computer is another device never reached the island: its chat is a
  // hidden Bot Session, skipped with the task list. It is account-wide, so the task scope does not apply.
  it('shows a remote companion chat as the companion, whatever the task scope', () => {
    const bot = {
      id: 'opus', deviceId: 'device-a', deviceName: 'Mac Studio', name: 'Opus',
      avatar: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png', avatarColor: 'teal',
      description: '', preview: '', activityAt: 1, sessionId: 'a-1', online: true,
    };
    const offline = { ...bot, id: 'away', sessionId: 'b-2', online: false };
    const inputs = buildAgentIslandRemoteSessionInputs(
      [remoteSession('a-1', 'device-a', { source: 'bot' })], [MACHINE_LOCAL], readActivity, [bot, offline],
    );
    // A local path is not a companion avatar value: it never reaches main.
    const parsed = parseAgentIslandRemoteSessions([
      ...inputs,
      { ...inputs[0], sessionId: 'x-1', companion: { name: 'X', avatar: '/etc/passwd', avatarColor: 'red' } },
      // Oversized values are dropped before any trimming or grapheme parsing.
      { ...inputs[0], sessionId: 'x-2', companion: { name: 'Y', avatar: '🦊'.repeat(3_000_000), avatarColor: 'red' } },
    ]);
    expect(parsed?.[0]).toMatchObject({
      sessionId: 'a-1', deviceId: 'device-a', title: 'Opus', phase: 'running', detail: 'Reading files',
      companion: { name: 'Opus', avatar: bot.avatar, avatarColor: 'teal' },
    });
    expect(parsed?.map((input) => input.sessionId)).toEqual(['a-1', 'x-1', 'x-2']);
    expect(parsed?.[1]?.companion?.avatar).toBe('');
    expect(parsed?.[2]?.companion?.avatar).toBe('');

    const state = createAgentIslandState();
    const companion = { name: 'Opus', hue: 'teal' as const, glyph: 'O', glyphIsInitial: true };
    syncAgentIslandDeviceSessions(state, parsed!.slice(0, 1), 2_000, (input) => (input.companion ? companion : null));
    expect(state.sessions.get('a-1')).toMatchObject({ companion, title: 'Opus', projectName: 'Mac Studio' });
  });

  // Review of #6436: companions are prepended, so near the parser cap one extra entry voided the whole payload.
  it('never exceeds the IPC cap, trimming tasks before companions', () => {
    const many = Array.from({ length: 600 }, (_, index) => remoteSession(`t-${index}`, 'device-a'));
    const everyActivity = (sessionId: string): RemoteSessionActivity => ({ sessionId, phase: 'running', compactDetail: '', attention: false });
    const bot = { id: 'opus', deviceId: 'device-a', deviceName: 'Mac', name: 'Opus', avatar: '', avatarColor: '', description: '', preview: '', activityAt: 1, sessionId: 'bot-s', online: true };
    const inputs = buildAgentIslandRemoteSessionInputs(many, MACHINE_ALL, everyActivity, [bot]);
    expect(inputs).toHaveLength(500);
    expect(inputs[0]?.sessionId).toBe('bot-s');
    expect(parseAgentIslandRemoteSessions(inputs)).not.toBeNull();
  });

  it('skips Bot tasks and disconnected devices', () => {
    expect(
      buildAgentIslandRemoteSessionInputs(
        [
          remoteSession('a-1', 'device-a', { source: 'bot' }),
          remoteSession('b-1', 'device-b', { deviceLinkConnectionStatus: 'disconnected' }),
        ],
        MACHINE_ALL,
        readActivity,
      ),
    ).toEqual([]);
  });
});
