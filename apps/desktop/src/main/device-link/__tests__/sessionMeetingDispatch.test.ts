import { afterEach, describe, expect, it } from 'vitest';
import { assertSessionMeetingInvoke, assertSessionMeetingReferences, captureSessionMeetingPush, setSessionMeetingQueueReader, type SessionMeetingPeerCapture } from '../sessionMeetingDispatch.js';

function capture(): SessionMeetingPeerCapture {
  return {
    author: { meetingId: 'meeting', sessionId: 'task', memberId: 'member', accountId: 'guest', displayName: 'Guest' },
    isCurrent: () => true,
    authorize: (operation, item) => operation !== 'input.edit' && operation !== 'input.withdraw' || item?.authorAccountId === 'guest',
  };
}
afterEach(() => setSessionMeetingQueueReader(null));
describe('meeting dispatch scope', () => {
  it('reads subagent context only through the shared parent task', () => {
    for (const channel of ['local-db:subagent-runs:list', 'local-db:subagent-runs:detail', 'local-db:subagent-runs:transcript']) {
      const request = { sessionId: 'task', provider: 'pi', runIdOrAlias: 'child' };
      expect(() => assertSessionMeetingInvoke(capture(), { channel, args: [request] })).not.toThrow();
      for (const args of [[{ ...request, sessionId: 'other' }], [{ ...request, path: '/private' }], [request, 'other']]) {
        expect(() => assertSessionMeetingInvoke(capture(), { channel, args })).toThrow();
      }
      expect(() => assertSessionMeetingInvoke({ ...capture(), isCurrent: () => false }, { channel, args: [request] })).toThrow();
    }
  });
  it('allows only existing references from the member own pending row when editing', () => {
    const payload = { channel: 'maker:input:update-content', args: ['task', 'message', { files: [{ path: '/host/cache/a.png' }] }] };
    setSessionMeetingQueueReader((_sid, clientId) => clientId === 'message' ? { sessionId: 'task', authorAccountId: 'guest', state: 'pending', attachments: [{ path: '/host/cache/a.png' }] } : undefined);
    expect(() => assertSessionMeetingInvoke(capture(), payload)).not.toThrow();
    expect(() => assertSessionMeetingInvoke(capture(), { ...payload, args: ['task', 'other', payload.args[2]] })).toThrow();
    expect(() => assertSessionMeetingInvoke(capture(), { ...payload, args: ['task', 'message', { files: [{ path: '/host/private.png' }] }] })).toThrow();
    setSessionMeetingQueueReader(() => ({ sessionId: 'task', authorAccountId: 'owner', state: 'pending', attachments: [{ path: '/host/cache/a.png' }] }));
    expect(() => assertSessionMeetingInvoke(capture(), payload)).toThrow();
  });
  it('never inherits the full-device allowlist or wildcard subscriptions', () => {
    for (const channel of ['maker:create-session', 'maker:set-permission-mode', 'device-link:voice:credential-sync', 'local-db:sessions:list', 'maker:remote-resources:list']) {
      expect(() => assertSessionMeetingInvoke(capture(), { channel, args: ['task'] })).toThrow('PERMISSION_DENIED');
    }
    for (const topics of [['*'], ['sessions'], ['session:other'], ['session:task', 'session:other']]) {
      expect(() => assertSessionMeetingInvoke(capture(), { channel: 'device-link:subscribe', args: [{ topics }] })).toThrow();
    }
    expect(() => assertSessionMeetingInvoke(capture(), { channel: 'device-link:subscribe', args: [{ topics: ['session:task'] }] })).not.toThrow();
  });
  it('allows shared task history and Agent settings, rejecting another task', () => {
    for (const channel of ['local-db:messages:list', 'maker:set-model', 'maker:set-effort', 'maker:input:stop']) {
      expect(() => assertSessionMeetingInvoke(capture(), { channel, args: ['task'] })).not.toThrow();
      expect(() => assertSessionMeetingInvoke(capture(), { channel, args: ['other'] })).toThrow();
    }
  });
  it('accepts media preparation and OSS fallback without granting the file-peer channel', () => {
    for (const prepareOnly of [true, false]) {
      expect(() => assertSessionMeetingInvoke(capture(), {
        channel: 'device-link:media:fetch', args: [{ url: 'xdt-image://task/a.png', prepareOnly }],
      })).not.toThrow();
    }
    expect(() => assertSessionMeetingInvoke(capture(), {
      channel: 'device-link:media:fetch', args: [{ url: 'xdt-image://task/a.png', prepareOnly: true, sessionId: 'other' }],
    })).toThrow();
    expect(() => assertSessionMeetingInvoke(capture(), {
      channel: 'device-link:file-peer', args: [{ action: 'caps' }],
    })).toThrow();
  });
  it('checks nested references in both structured and persisted content before hydration', () => {
    for (const value of [
      { agentReferences: [{ kind: 'message', sessionId: 'other' }] },
      { persistedContent: JSON.stringify({ agentReferences: [{ kind: 'message', sessionId: 'other' }] }) },
      { trustedSessionReferenceContexts: [{ sessionId: 'other' }] },
      { agentReferences: [{ kind: 'bot', botId: 'private-bot' }] },
      { files: [{ path: 'private/other-task.png', pathOrigin: 'desktop-host' }] },
      { persistedContent: JSON.stringify({ images: [{ url: 'cindy-media://blobs/private.png' }] }) },
    ]) expect(() => assertSessionMeetingReferences(value, 'task')).toThrow();
    expect(() => assertSessionMeetingReferences({ agentReferences: [{ kind: 'message', sessionId: 'task' }] }, 'task')).not.toThrow();
  });
  it('reads queue ownership from the host and allows results after successful withdrawal', () => {
    const payload = { channel: 'maker:input:remove', args: ['task', 'message'] };
    expect(() => assertSessionMeetingInvoke(capture(), payload)).toThrow();
    setSessionMeetingQueueReader(() => ({ sessionId: 'task', authorAccountId: 'owner', state: 'pending' }));
    expect(() => assertSessionMeetingInvoke(capture(), payload)).toThrow();
    setSessionMeetingQueueReader(() => ({ sessionId: 'task', authorAccountId: 'guest', state: 'pending' }));
    expect(() => assertSessionMeetingInvoke(capture(), payload)).not.toThrow();
    setSessionMeetingQueueReader(() => undefined);
    expect(() => assertSessionMeetingInvoke(capture(), payload, undefined, 'result')).not.toThrow();
  });
  it('rejects expired captured authorization and unbound meeting pushes without changing same-account traffic', () => {
    expect(() => assertSessionMeetingInvoke({ ...capture(), isCurrent: () => false }, { channel: 'local-db:messages:list', args: ['task'] })).toThrow();
    expect(captureSessionMeetingPush('meeting~m~guest~g~d', 'maker:event', { sessionId: 'task' })).toBeNull();
    expect(captureSessionMeetingPush('my-phone', 'maker:provider:changed', {})?.()).toBe(true);
  });
});
