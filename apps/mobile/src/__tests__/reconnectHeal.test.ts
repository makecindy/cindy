import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rehydrateDeviceLinkTopics } from '@/device-link/rehydrate';
import { DeviceLinkTopicRegistry } from '@/device-link/topicRegistry';
import { buildQueuedTextMessage } from '@/session/inputProjection';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { InputProjection, PendingInteraction, RemoteMessage, RemoteSession } from '@/session/types';

const DEVICE_ID = 'dev-1';
const SESSION_ID = 's1';

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: SESSION_ID,
    userId: 'user-1',
    title: 'Remote session',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function message(id: string, createdAt: string): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId: SESSION_ID,
    role: 'assistant',
    content: id,
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

function projection(paused: boolean): InputProjection {
  return {
    sessionId: SESSION_ID,
    pendingQueue: paused
      ? [buildQueuedTextMessage(session(), 'resume after reconnect', new Date('2026-01-01T00:00:05.000Z'), 'q-1')]
      : [],
    steeringQueueClientIds: [],
    queuePaused: paused,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    errorRetryText: null,
    credentialSwitchWait: null,
  };
}

describe('reconnect host-authoritative healing', () => {
  beforeEach(() => {
    remoteSessionStore.clear();
  });

  it('reopens tracked links and rebuilds session snapshots after a lost-push reconnect gap', async () => {
    const registry = new DeviceLinkTopicRegistry();
    registry.trackOpenLink(DEVICE_ID);
    registry.trackSubscribe(`session:${SESSION_ID}`, DEVICE_ID, ['sessions', `session:${SESSION_ID}`]);

    remoteSessionStore.setDeviceSessions(DEVICE_ID, 'Mac', [session()]);
    remoteSessionStore.setMessages(SESSION_ID, [
      message('m1', '2026-01-01T00:00:01.000Z'),
      message('m2', '2026-01-01T00:00:02.000Z'),
    ]);

    const lostPushes: string[] = [];
    const hostHistory = [
      message('m1', '2026-01-01T00:00:01.000Z'),
      message('m2', '2026-01-01T00:00:02.000Z'),
      message('m3', '2026-01-01T00:00:03.000Z'),
      message('m4', '2026-01-01T00:00:04.000Z'),
    ];
    const hostPending: PendingInteraction[] = [{
      persistId: 'ask-1',
      request: { kind: 'ask_user_question', requestId: 'ask-1' },
    }];
    const hostProjection = projection(true);
    const requestSessionsReseed = vi.fn();

    lostPushes.push('m3', 'm4');
    expect(remoteSessionStore.getMessages(SESSION_ID).map((item) => item.id)).toEqual(['m1', 'm2']);

    await rehydrateDeviceLinkTopics(registry.snapshot(), {
      capturePresenceEpoch: vi.fn(() => 0),
      captureResponseEvidenceEpoch: vi.fn(() => 0),
      isPresenceEpochCurrent: vi.fn(() => true),
      isResponseEvidenceEpochCurrent: vi.fn(() => true),
      createDeviceSendCohort: vi.fn(() => 1),
      openLink: vi.fn(() => ({
        capturedPresenceEpoch: 0,
        capturedResponseEvidenceEpoch: 0,
        request: Promise.resolve(),
      })),
      subscribe: vi.fn(async () => undefined),
      requestSessionsReseed,
      rebuildSessionSnapshot: vi.fn(async (_deviceId, sessionId) => {
        remoteSessionStore.mergeMessages(sessionId, hostHistory);
        remoteSessionStore.setPendingInteractions(sessionId, hostPending);
        remoteSessionStore.setInputProjection(sessionId, hostProjection);
      }),
    });

    expect(lostPushes).toEqual(['m3', 'm4']);
    expect(remoteSessionStore.getMessages(SESSION_ID).map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(remoteSessionStore.getPendingInteractions(SESSION_ID)).toEqual(hostPending);
    expect(remoteSessionStore.getInputProjection(SESSION_ID)).toMatchObject({
      queuePaused: true,
      pendingQueue: [{ clientId: 'q-1', text: 'resume after reconnect' }],
    });
    expect(requestSessionsReseed).toHaveBeenCalledWith(DEVICE_ID);
  });
});
