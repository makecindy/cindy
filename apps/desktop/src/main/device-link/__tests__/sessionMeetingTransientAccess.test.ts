import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, SESSION_MEETING_CAPABILITY, type SessionMeetingDetail } from '@cindy/device-link';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/cindy-test/app', getPath: () => '/tmp/cindy-test', getVersion: () => 'test' },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../settings-store', () => ({
  readDeviceLinkSettings: () => ({ remoteControlEnabled: true, revokedControllers: [] }),
}));

import { __testing, runInvoke, wireInboundDispatch } from '../dispatch';
import { __testing as registry } from '../invoke-registry';
import { SessionMeetingHost } from '../sessionMeetingHost';
import { setSessionMeetingDispatchHost } from '../sessionMeetingDispatch';
import type { SessionMeetingJournalEntry } from '../../localDb/sessionMeetings';

const peer = 'meeting~meeting~guest~member~phone';
const read = { channel: 'local-db:messages:list', args: ['task'] };
const subscribe = { channel: 'device-link:subscribe', args: [{ topics: ['session:task'] }] };
let detail: SessionMeetingDetail;
let host: SessionMeetingHost;
const api = { create: vi.fn(), list: vi.fn(), get: vi.fn(), invite: vi.fn(), join: vi.fn(), remove: vi.fn(), leave: vi.fn(), close: vi.fn() };

function client() {
  return {
    getStatus: vi.fn(() => 'online'), getConnectionEpoch: vi.fn(() => 1), getPeerLinkGeneration: vi.fn(() => 1),
    getReliableSendQueueDepth: vi.fn(() => 0), canSendPush: vi.fn(() => true), sendPush: vi.fn(),
    sendInvokeResult: vi.fn(), sendLinkAccept: vi.fn(), closeLink: vi.fn(), onFrame: vi.fn(),
  };
}

beforeEach(async () => {
  __testing.reset();
  registry.reset();
  for (const fn of Object.values(api)) fn.mockReset();
  detail = {
    meetingId: 'meeting', sessionId: 'task', ownerAccountId: 'owner', hostDeviceId: 'desktop',
    revision: 1, status: 'active', title: 'Task',
    guests: [{ memberId: 'member', accountId: 'guest', deviceIds: ['phone'], version: 1 }], memberLabels: [],
  };
  api.get.mockImplementation(async () => structuredClone(detail));
  let entry: SessionMeetingJournalEntry | undefined;
  host = new SessionMeetingHost({
    api, ownerAccountId: 'owner', hostDeviceId: 'desktop', isCurrent: () => true,
    readSession: async (id) => ({ id, title: 'Task', status: 'active' }), revoke: vi.fn(), changed: vi.fn(),
    journal: {
      latest: async () => entry ? [entry] : [],
      recordAuthority: async (snapshot) => {
        entry = { meetingId: 'meeting', sessionId: 'task', terminal: snapshot.status === 'closed', snapshot };
        return true;
      },
      close: async () => { entry = { meetingId: 'meeting', sessionId: 'task', terminal: true, snapshot: null }; },
    },
  });
  setSessionMeetingDispatchHost(host);
  await host.refresh('meeting');
});
afterEach(() => {
  __testing.reset(); registry.reset(); setSessionMeetingDispatchHost(null);
});

describe('shared task temporary authority fences preserve membership', () => {
  it.each(['suspended', 'revoked'] as const)('gates admission, subscription, link-open and final send while %s', async (state) => {
    let rejectRemove!: (error: Error) => void;
    let removal: Promise<void> | undefined;
    if (state === 'suspended') {
      api.remove.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectRemove = reject; }));
      removal = host.remove('meeting', 'member');
      await vi.waitFor(() => expect(rejectRemove).toBeTypeOf('function'));
    } else {
      detail = { ...detail, revision: 2, guests: [] };
      await host.refresh('meeting');
    }
    const code = state === 'suspended' ? 'NOT_CONNECTED' : 'ACCESS_REVOKED';
    expect(host.peerStatus(peer)).toBe(state === 'suspended' ? 'unavailable' : 'revoked');
    expect(host.capturePeer(peer)).toBeNull();
    expect(__testing.handleSubscriptionFrame(peer, subscribe)).toMatchObject({ ok: false, error: { code } });
    const transport = client();
    __testing.setActiveClient(transport as never);
    __testing.handleLinkOpen(transport as never, peer, 'open', {
      controllerName: 'Guest', protocolVersion: PROTOCOL_VERSION, appVersion: 'test', capabilities: [SESSION_MEETING_CAPABILITY],
    }, 0, true);
    expect(transport.closeLink).toHaveBeenCalledWith(peer, state === 'suspended' ? 'transport-timeout' : 'revoked', 'inbound');
    expect(transport.sendLinkAccept).not.toHaveBeenCalled();
    __testing.sendInvokeResultSafe(transport as never, peer, 'late', { ok: true, result: 'private data' }, read.channel, read.args);
    expect(transport.sendInvokeResult).toHaveBeenLastCalledWith(peer, 'late', expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) }));
    const handler = vi.fn(() => []);
    registry.register(read.channel, handler);
    wireInboundDispatch(transport as never);
    transport.onFrame.mock.calls[0][0]({ v: PROTOCOL_VERSION, kind: 'invoke', src: peer, id: 'new', payload: read });
    await vi.waitFor(() => expect(transport.sendInvokeResult).toHaveBeenCalledWith(peer, 'new', expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })));
    expect(handler).not.toHaveBeenCalled();
    if (removal) {
      const failed = expect(removal).rejects.toThrow('offline');
      rejectRemove(new Error('offline'));
      await failed;
      expect(host.peerStatus(peer)).toBe('available');
      expect(__testing.handleSubscriptionFrame(peer, subscribe).ok).toBe(true);
      expect((await runInvoke(peer, read)).ok).toBe(true);
    }
  });

  it.each(['device-added', 'member-removed'] as const)('fences an in-flight read after %s without confusing stale capture with revocation', async (change) => {
    let finish!: (value: unknown) => void;
    registry.register(read.channel, () => new Promise((resolve) => { finish = resolve; }));
    const result = runInvoke(peer, read);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    detail = { ...detail, revision: 2, guests: change === 'device-added'
      ? [{ ...detail.guests[0], version: 2, deviceIds: ['phone', 'second-phone'] }] : [] };
    await host.refresh('meeting');
    finish([{ content: 'private data' }]);
    expect(await result).toMatchObject({ ok: false, error: { code: change === 'device-added' ? 'NOT_CONNECTED' : 'ACCESS_REVOKED' } });
    if (change === 'device-added') {
      expect(host.capturePeer(peer)?.isCurrent()).toBe(true);
      registry.register(read.channel, () => []);
      expect((await runInvoke(peer, read)).ok).toBe(true);
    }
  });

  it('denies an out-of-scope request without revoking an otherwise valid member', async () => {
    expect(await runInvoke(peer, { ...read, args: ['another-task'] }))
      .toMatchObject({ ok: false, error: { code: 'IPC_ERROR', message: expect.stringContaining('PERMISSION_DENIED') } });
    expect(host.peerStatus(peer)).toBe('available');
    expect(__testing.handleSubscriptionFrame(peer, subscribe).ok).toBe(true);
  });

  it('treats unrestored or replaced host authority as unavailable rather than revoked', async () => {
    expect(host.peerStatus('meeting~unknown~guest~member~phone')).toBe('unavailable');
    setSessionMeetingDispatchHost(null);
    expect(await runInvoke(peer, read)).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED' } });
  });
});
