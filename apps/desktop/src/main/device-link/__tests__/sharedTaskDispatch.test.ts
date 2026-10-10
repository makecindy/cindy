import { authorizeSharedTaskOperation, sharedTaskGuestPeer } from '@cindy/device-link';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSharedTaskInteractionResolveCurrent, assertSharedTaskInvoke, assertSharedTaskReferences, captureSharedTaskPush, setSharedTaskInteractionReader, setSharedTaskQueueReader, type SharedTaskInteractionCapture, type SharedTaskPeerCapture } from '../sharedTaskDispatch.js';

function capture(): SharedTaskPeerCapture {
  return {
    author: { sharedTaskId: 'sharedTask', sessionId: 'task', memberId: 'member', accountId: 'guest', displayName: 'Guest' },
    isCurrent: () => true,
    authorize: (operation, item) => authorizeSharedTaskOperation({
      sharedTaskId: 'sharedTask', sessionId: 'task', ownerAccountId: 'owner', hostDeviceId: 'host',
      status: 'active', revision: 1,
      guests: [{ memberId: 'member', accountId: 'guest', version: 1, deviceIds: ['phone'] }],
    }, { accountId: 'guest', deviceId: 'phone' }, 'task', operation, item).allowed,
  };
}
afterEach(() => { setSharedTaskQueueReader(null); setSharedTaskInteractionReader(null); });
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
  it('allows shared task history and stopping the Agent, rejecting another task', () => {
    for (const channel of ['local-db:messages:list', 'maker:input:stop']) {
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['task'] })).not.toThrow();
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['other'] })).toThrow();
    }
  });
  it.each([
    ['maker:set-model', ['task', 'gpt-6-sol', 'openai', undefined, { effort: 'high', fastMode: true }]],
    ['maker:set-effort', ['task', 'high']],
    ['maker:set-fast-mode', ['task', true]],
    ['maker:set-thinking-enabled', ['task', true]],
    ['maker:switch-session-agent', ['task', 'codex', 'gpt-6-sol', 'openai']],
  ])('rejects guest model settings through %s before execution or result replay', (channel, args) => {
    for (const phase of ['invoke', 'result'] as const) {
      expect(() => assertSharedTaskInvoke(capture(), { channel, args }, undefined, phase)).toThrow('PERMISSION_DENIED');
    }
  });
  it('allows guests to resolve generic Agent interaction cards for the shared task', () => {
    const permissionSuggestion = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'git status' }] };
    const interactions: Record<string, SharedTaskInteractionCapture> = {
      'permission-1': { sessionId: 'task', kind: 'permission', toolName: 'Bash', suggestions: [permissionSuggestion] },
      'question-1': { sessionId: 'task', kind: 'ask_user_question' },
      'plan-1': { sessionId: 'task', kind: 'plan_review' },
    };
    setSharedTaskInteractionReader((requestId) => interactions[requestId]);
    for (const [requestId, decision] of [
      ['permission-1', { kind: 'permission', behavior: 'allow' }],
      ['question-1', { kind: 'ask_user_question', answers: { choice: 'A' } }],
      ['plan-1', { kind: 'plan_review', behavior: 'deny', reason: 'change scope' }],
    ]) {
      expect(() => assertSharedTaskInvoke(capture(), {
        channel: 'maker:resolve-interaction', args: [requestId, decision],
      })).not.toThrow();
    }
    for (const decision of [
      { kind: 'plugin_setup', action: 'run_action' },
      { kind: 'issue_confirm', behavior: 'allow' },
      { kind: 'permission', behavior: 'maybe' },
    ]) {
      expect(() => assertSharedTaskInvoke(capture(), {
        channel: 'maker:resolve-interaction', args: ['permission-1', decision],
      })).toThrow('PERMISSION_DENIED');
    }
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'maker:resolve-interaction', args: ['other-task', { kind: 'permission', behavior: 'allow' }],
    })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'maker:resolve-interaction',
      args: ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }],
    })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'maker:resolve-interaction',
      args: ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [{ ...permissionSuggestion, rules: [{ toolName: 'Write' }] }] }],
    })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'maker:resolve-interaction',
      args: ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [permissionSuggestion] }],
    })).not.toThrow();
  });
  it.each([{ command: 'different-command' }, {}, null])('rejects guest replacement input %j at admission and consumption', (updatedInput) => {
    setSharedTaskInteractionReader(() => ({ sessionId: 'task', kind: 'permission', toolName: 'Bash' }));
    const args = ['permission-1', { kind: 'permission', behavior: 'allow', updatedInput }];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).toThrow('PERMISSION_DENIED');
  });
  it('accepts the host-provided Codex session approval, but rejects an unsolicited one', () => {
    const update = { type: 'codexSessionApproval', destination: 'session' };
    const request: SharedTaskInteractionCapture = { sessionId: 'task', kind: 'permission', toolName: 'Shell', suggestions: [update] };
    setSharedTaskInteractionReader(() => request);
    const args = ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [update] }];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).not.toThrow();
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).not.toThrow();
    request.suggestions = [];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).toThrow('PERMISSION_DENIED');
  });
  it.each([
    { type: 'codexSessionApproval', destination: 'userSettings' },
    { type: 'codexSessionApproval', destination: 'session', mode: 'bypassPermissions' },
    { type: 'codexSessionApproval', destination: 'session', rules: [{ toolName: 'Write' }] },
    { type: 'setMode', destination: 'session', mode: 'bypassPermissions' },
  ])('rejects unsafe session approval shapes even when suggested: %j', (update) => {
    setSharedTaskInteractionReader(() => ({ sessionId: 'task', kind: 'permission', toolName: 'Shell', suggestions: [update] }));
    const args = ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [update] }];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).toThrow('PERMISSION_DENIED');
  });
  it('rejects a request that disappeared before consumption', () => {
    let active = true;
    setSharedTaskInteractionReader(() => active
      ? { sessionId: 'task', kind: 'permission', toolName: 'Bash' }
      : undefined);
    const args: unknown[] = ['request-1', { kind: 'permission', behavior: 'allow' }];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).not.toThrow();
    active = false;
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).toThrow('PERMISSION_DENIED');
  });
  it.each(['permission', 'ask_user_question', 'plan_review'] as const)('rejects a revoked guest with a still-pending %s request', (kind) => {
    const pending = { sessionId: 'task', kind, toolName: 'Bash' };
    setSharedTaskInteractionReader(() => pending);
    let memberActive = true;
    const peer = { ...capture(), isCurrent: () => memberActive, authorize: () => memberActive };
    const decision = kind === 'ask_user_question'
      ? { kind, answers: { choice: 'A' } } : { kind, behavior: 'allow' };
    const args = ['request-1', decision];
    assertSharedTaskInvoke(peer, { channel: 'maker:resolve-interaction', args });
    memberActive = false;
    expect(() => assertSharedTaskInteractionResolveCurrent(peer, args)).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).not.toThrow();
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
  it('lets guests read and write task files like the owner, but never run export jobs', () => {
    const channel = 'file-browser:remote-op';
    const call = (request: unknown, peer = capture(), extra: unknown[] = []) =>
      () => assertSharedTaskInvoke(peer, { channel, args: [request, ...extra] });
    for (const op of ['caps', 'listDir', 'listAllFiles', 'readFile', 'stat', 'searchCollect', 'thumbnail', 'fileUrl',
      'writeFile', 'createFile', 'createFolder', 'renameEntry', 'deleteEntry']) {
      expect(call({ op, workdir: '/host/task' })).not.toThrow();
    }
    for (const op of ['exportFileStart', 'exportFileStatus', 'exportDirStart', 'exportDirStatus', 'unknown']) {
      expect(call({ op, workdir: '/host/task' })).toThrow('PERMISSION_DENIED');
    }
    expect(call({ op: 'listDir' })).toThrow('PERMISSION_DENIED');
    expect(call({ op: 'listDir', workdir: '/host/task' }, capture(), ['extra'])).toThrow('PERMISSION_DENIED');
    const readOnly: SharedTaskPeerCapture = { ...capture(), authorize: (operation) => operation !== 'file.write' };
    expect(call({ op: 'readFile', workdir: '/host/task' }, readOnly)).not.toThrow();
    expect(call({ op: 'writeFile', workdir: '/host/task' }, readOnly)).toThrow('PERMISSION_DENIED');
    expect(call({ op: 'listDir', workdir: '/host/task' }, { ...capture(), isCurrent: () => false })).toThrow();
  });
  it('subscribes a workdir watch only after async admission, including merged reconnect frames', () => {
    const subscribe = (topics: string[], verified: string[] = [], peer = capture()) =>
      () => assertSharedTaskInvoke(peer, { channel: 'device-link:subscribe', args: [{ topics }] }, undefined, 'invoke', new Set(verified));
    expect(subscribe(['fs-watch:/host/task'])).toThrow('PERMISSION_DENIED');
    expect(subscribe(['fs-watch:/host/task'], ['fs-watch:/host/task'])).not.toThrow();
    expect(subscribe(['session:task', 'fs-watch:/host/task'], ['fs-watch:/host/task'])).not.toThrow();
    expect(subscribe(['session:other', 'fs-watch:/host/task'], ['fs-watch:/host/task'])).toThrow('PERMISSION_DENIED');
    expect(subscribe(['fs-watch:/host/task'], ['fs-watch:/host/task'], { ...capture(), authorize: (operation) => operation !== 'file.read' }))
      .toThrow('PERMISSION_DENIED');
    // Results and unsubscribes carry no file data, so they only re-check access.
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'device-link:subscribe', args: [{ topics: ['fs-watch:/host/task'] }] }, undefined, 'result')).not.toThrow();
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'device-link:unsubscribe', args: [{ topics: ['fs-watch:/host/task'] }] })).not.toThrow();
  });
  it('rejects expired captured authorization and unbound sharedTask pushes without changing same-account traffic', () => {
    expect(() => assertSharedTaskInvoke({ ...capture(), isCurrent: () => false }, { channel: 'local-db:messages:list', args: ['task'] })).toThrow();
    expect(captureSharedTaskPush(sharedTaskGuestPeer('m', 'g', 'd'), 'maker:event', { sessionId: 'task' })).toBeNull();
    expect(captureSharedTaskPush('my-phone', 'maker:provider:changed', {})?.()).toBe(true);
  });
});
