import { sharedTaskGuestPeer } from '@cindy/device-link';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSharedTaskInvoke, assertSharedTaskReferences, captureSharedTaskPush, setSharedTaskQueueReader, type SharedTaskPeerCapture } from '../sharedTaskDispatch.js';

function capture(): SharedTaskPeerCapture {
  return {
    author: { sharedTaskId: 'sharedTask', sessionId: 'task', memberId: 'member', accountId: 'guest', displayName: 'Guest' },
    isCurrent: () => true,
    authorize: (operation, item) => operation !== 'input.edit' && operation !== 'input.withdraw' || item?.authorAccountId === 'guest',
  };
}
afterEach(() => setSharedTaskQueueReader(null));
describe('sharedTask dispatch scope', () => {
  it('reads subagent context only through the shared parent task', () => {
    for (const channel of ['local-db:subagent-runs:list', 'local-db:subagent-runs:detail', 'local-db:subagent-runs:transcript']) {
      const request = { sessionId: 'task', provider: 'pi', runIdOrAlias: 'child' };
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: [request] })).not.toThrow();
      for (const args of [[{ ...request, sessionId: 'other' }], [{ ...request, path: '/private' }], [request, 'other']]) {
        expect(() => assertSharedTaskInvoke(capture(), { channel, args })).toThrow();
      }
      expect(() => assertSharedTaskInvoke({ ...capture(), isCurrent: () => false }, { channel, args: [request] })).toThrow();
    }
  });
  it('allows only existing references from the member own pending row when editing', () => {
    const payload = { channel: 'maker:input:update-content', args: ['task', 'message', { files: [{ path: '/host/cache/a.png' }] }] };
    setSharedTaskQueueReader((_sid, clientId) => clientId === 'message' ? { sessionId: 'task', authorAccountId: 'guest', state: 'pending', attachments: [{ path: '/host/cache/a.png' }] } : undefined);
    expect(() => assertSharedTaskInvoke(capture(), payload)).not.toThrow();
    expect(() => assertSharedTaskInvoke(capture(), { ...payload, args: ['task', 'other', payload.args[2]] })).toThrow();
    expect(() => assertSharedTaskInvoke(capture(), { ...payload, args: ['task', 'message', { files: [{ path: '/host/private.png' }] }] })).toThrow();
    setSharedTaskQueueReader(() => ({ sessionId: 'task', authorAccountId: 'owner', state: 'pending', attachments: [{ path: '/host/cache/a.png' }] }));
    expect(() => assertSharedTaskInvoke(capture(), payload)).toThrow();
  });
  it('never inherits the full-device allowlist or wildcard subscriptions', () => {
    for (const channel of ['maker:create-session', 'maker:set-permission-mode', 'device-link:voice:credential-sync', 'local-db:sessions:list', 'maker:remote-resources:list']) {
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['task'] })).toThrow('PERMISSION_DENIED');
    }
    for (const topics of [['*'], ['sessions'], ['session:other'], ['session:task', 'session:other']]) {
      expect(() => assertSharedTaskInvoke(capture(), { channel: 'device-link:subscribe', args: [{ topics }] })).toThrow();
    }
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'device-link:subscribe', args: [{ topics: ['session:task'] }] })).not.toThrow();
  });
  it('allows shared task history and Agent settings, rejecting another task', () => {
    for (const channel of ['local-db:messages:list', 'maker:set-model', 'maker:set-effort', 'maker:input:stop']) {
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['task'] })).not.toThrow();
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['other'] })).toThrow();
    }
  });
  it('lets a guest read running command output only for the shared task, under history.read', () => {
    const channel = 'maker:background-task:output-tail';
    expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['task', 'bash-1'] })).not.toThrow();
    expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['other', 'bash-1'] })).toThrow();
    const noHistory: SharedTaskPeerCapture = { ...capture(), authorize: (operation) => operation !== 'history.read' };
    expect(() => assertSharedTaskInvoke(noHistory, { channel, args: ['task', 'bash-1'] })).toThrow();
  });
  it('accepts media preparation and OSS fallback without granting the file-peer channel', () => {
    for (const prepareOnly of [true, false]) {
      expect(() => assertSharedTaskInvoke(capture(), {
        channel: 'device-link:media:fetch', args: [{ url: 'xdt-image://task/a.png', prepareOnly }],
      })).not.toThrow();
    }
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'device-link:media:fetch', args: [{ url: 'xdt-image://task/a.png', prepareOnly: true, sessionId: 'other' }],
    })).toThrow();
    expect(() => assertSharedTaskInvoke(capture(), {
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
    ]) expect(() => assertSharedTaskReferences(value, 'task')).toThrow();
    expect(() => assertSharedTaskReferences({ agentReferences: [{ kind: 'message', sessionId: 'task' }] }, 'task')).not.toThrow();
  });
  it('reads queue ownership from the host and allows results after successful withdrawal', () => {
    const payload = { channel: 'maker:input:remove', args: ['task', 'message'] };
    expect(() => assertSharedTaskInvoke(capture(), payload)).toThrow();
    setSharedTaskQueueReader(() => ({ sessionId: 'task', authorAccountId: 'owner', state: 'pending' }));
    expect(() => assertSharedTaskInvoke(capture(), payload)).toThrow();
    setSharedTaskQueueReader(() => ({ sessionId: 'task', authorAccountId: 'guest', state: 'pending' }));
    expect(() => assertSharedTaskInvoke(capture(), payload)).not.toThrow();
    setSharedTaskQueueReader(() => undefined);
    expect(() => assertSharedTaskInvoke(capture(), payload, undefined, 'result')).not.toThrow();
  });
  it('rejects expired captured authorization and unbound sharedTask pushes without changing same-account traffic', () => {
    expect(() => assertSharedTaskInvoke({ ...capture(), isCurrent: () => false }, { channel: 'local-db:messages:list', args: ['task'] })).toThrow();
    expect(captureSharedTaskPush(sharedTaskGuestPeer('m', 'g', 'd'), 'maker:event', { sessionId: 'task' })).toBeNull();
    expect(captureSharedTaskPush('my-phone', 'maker:provider:changed', {})?.()).toBe(true);
  });
});
