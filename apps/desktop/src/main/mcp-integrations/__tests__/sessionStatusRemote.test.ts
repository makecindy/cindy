import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import { createRemoteSessionsStatusSetter } from '../sessionStatusRemote.js';
import { createDeviceUnresponsiveError } from '../../device-link/responsivenessTracker.js';
import { admitTaskAction } from '../../maker-ipc/taskActionAuthorization.js';

const request = { deviceId: 'studio', sessionIds: ['s1', 's2', 's3'], status: 'active' as const };
const row = (id: string) => ({ ok: true as const, result: { id, status: 'active', title: 'remote title', workingDir: null } });
function setup(outcome: InvokeResultPayload | Error) {
  const invoke = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { invoke, setStatus: createRemoteSessionsStatusSetter({ invoke, captureAccess: () => () => {} }) };
}

describe('remote session archive status', () => {
  // #6399, unit: invocation admission precedes transport queue/connection waits.
  // Exercise its actual preSend callback, preserving earlier receipts on rejection.
  it.each(['active', 'archived'] as const)('rechecks %s action at the final transport send', async status => {
    let current = true;
    const check = () => { if (!current) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED'); };
    const decision = await admitTaskAction(
      { server: 'cindy_helper', tool: status === 'active' ? 'unarchive_sessions' : 'archive_sessions', sessionId: 'caller', args: {} },
      { key: 'input', ownerInput: true, delegated: false, assertCurrent: async () => check(), assertCurrentSync: check },
    );
    if (!decision.ok || !decision.run) throw new Error('Expected admission');
    const send = vi.fn();
    const setStatus = createRemoteSessionsStatusSetter({
      captureAccess: () => () => {},
      invoke: async (_device, _channel, args, options) => {
        if (args[0] === 's2') current = false; // connection wait completed after input replacement
        options?.preSend?.();
        send(args[0]);
        return { ok: true, result: { id: args[0], status, title: 'private title' } };
      },
    });
    expect(await decision.run(() => setStatus({ ...request, status }))).toMatchObject({
      ok: false, errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED',
      changed: [{ sessionId: 's1', status, title: null }],
      failedSessionId: 's2', remainingSessionIds: ['s3'],
    });
    expect(send.mock.calls).toEqual([['s1']]);
  });

  // #6399, unit: account-only guards missed input replacement between remote
  // batch items. Preserve the first receipt while refusing later invocations.
  it('stops a batch when input authorization expires after the first receipt', async () => {
    let current = true;
    const decision = await admitTaskAction(
      { server: 'cindy_helper', tool: 'unarchive_sessions', sessionId: 'caller', args: {} },
      { key: 'input', ownerInput: true, delegated: false, assertCurrent: async () => {
        if (!current) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      } },
    );
    if (!decision.ok || !decision.run) throw new Error('Expected admission');
    const s = setup(row('s2'));
    s.invoke.mockImplementationOnce(async () => { current = false; return row('s1'); });
    expect(await decision.run(() => s.setStatus(request))).toMatchObject({
      ok: false, errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED',
      changed: [{ sessionId: 's1', status: 'active' }],
      failedSessionId: 's2', remainingSessionIds: ['s3'],
    });
    expect(s.invoke).toHaveBeenCalledOnce();
  });

  it('uses only the existing patch-meta channel with the stripped id and status', async () => {
    const s = setup(row('s1'));
    expect(await s.setStatus({ ...request, sessionIds: ['s1'] })).toEqual({ ok: true, changed: [
      { sessionId: 's1', status: 'active', title: 'remote title', workingDir: null },
    ] });
    expect(s.invoke).toHaveBeenCalledExactlyOnceWith('studio', 'local-db:sessions:patch-meta', ['s1', { status: 'active' }], { preSend: expect.any(Function) });
  });

  it.each([
    ['DEVICE_OFFLINE', '', 'REMOTE_DEVICE_OFFLINE'],
    ['REMOTE_DISABLED', '', 'REMOTE_DISABLED'],
    ['ACCESS_REVOKED', '', 'REMOTE_ACCESS_REVOKED'],
    ['CHANNEL_NOT_ALLOWED', '', 'REMOTE_UNSUPPORTED'],
    ['VERSION_MISMATCH', '', 'REMOTE_UNSUPPORTED'],
    ['NOT_CONNECTED', '', 'REMOTE_UNAVAILABLE'],
    ['BACKPRESSURE', 'db worker RPC queue overloaded', 'REMOTE_RESULT_UNKNOWN'],
    ['IPC_ERROR', '[BACKPRESSURE] db worker RPC queue overloaded', 'REMOTE_RESULT_UNKNOWN'],
    ['IPC_ERROR', '[DEVICE_LINK_CONTROL_DISABLED] off', 'REMOTE_DISABLED'],
    ['IPC_ERROR', '[PRECONDITION_FAILED] 已删除的任务不能恢复或归档', 'PRECONDITION_FAILED'],
    ['IPC_ERROR', '[PRECONDITION_FAILED] Bot task lifecycle is managed by teammate recovery and history controls', 'PRECONDITION_FAILED'],
    ['IPC_ERROR', '[PRECONDITION_FAILED] Worktree is busy or its recovery record could not be saved', 'REMOTE_RESULT_UNKNOWN'],
    ['IPC_ERROR', '[NOT_FOUND] Session 不存在', 'NOT_FOUND'],
    ['IPC_ERROR', '[NOT_FOUND] Session does not exist', 'REMOTE_RESULT_UNKNOWN'],
    ['IPC_ERROR', '[INTERNAL] failure after write', 'REMOTE_RESULT_UNKNOWN'],
    ['INVOKE_TIMEOUT', '', 'REMOTE_RESULT_UNKNOWN'],
  ] as const)('classifies %s / %s without retry or local fallback', async (code, message, expected) => {
    const s = setup({ ok: false, error: { code, message } });
    expect(await s.setStatus(request)).toMatchObject({ ok: false, errorCode: expected, changed: [], failedSessionId: 's1', remainingSessionIds: ['s2', 's3'] });
    expect(s.invoke).toHaveBeenCalledOnce();
  });

  it('classifies the local responsiveness breaker rejection without sending another item', async () => {
    const s = setup(createDeviceUnresponsiveError('studio'));
    expect(await s.setStatus(request)).toMatchObject({
      ok: false, errorCode: 'REMOTE_UNAVAILABLE', changed: [],
      failedSessionId: 's1', remainingSessionIds: ['s2', 's3'],
    });
    expect(s.invoke).toHaveBeenCalledOnce();
  });

  it.each([false, true])('distinguishes local backpressure with inFlight=%s', async (inFlight) => {
    const s = setup(Object.assign(new DeviceLinkError('BACKPRESSURE', 'queue full'), { inFlight }));
    expect(await s.setStatus(request)).toMatchObject({
      ok: false, errorCode: inFlight ? 'REMOTE_RESULT_UNKNOWN' : 'REMOTE_UNAVAILABLE',
      changed: [], failedSessionId: 's1', remainingSessionIds: ['s2', 's3'],
    });
    expect(s.invoke).toHaveBeenCalledOnce();
  });

  it('keeps a timeout/disconnect after sending uncertain even when its code looks like a rejection', async () => {
    const s = setup(Object.assign(new DeviceLinkError('NOT_CONNECTED', ''), { inFlight: true }));
    expect(await s.setStatus(request)).toMatchObject({ errorCode: 'REMOTE_RESULT_UNKNOWN' });
    expect(s.invoke).toHaveBeenCalledOnce();
  });

  it('stops at the first failure, retains successful receipts, and never rolls them back', async () => {
    const s = setup({ ok: false, error: { code: 'DEVICE_OFFLINE', message: '' } });
    s.invoke.mockResolvedValueOnce(row('s1'));
    expect(await s.setStatus(request)).toMatchObject({ ok: false, errorCode: 'REMOTE_DEVICE_OFFLINE',
      changed: [{ sessionId: 's1', status: 'active' }], failedSessionId: 's2', remainingSessionIds: ['s3'],
    });
    expect(s.invoke).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { id: 's1', status: 'archived' }, { id: 'other', status: 'active' }])('rejects an untrusted success receipt %j', async (result) => {
    const s = setup({ ok: true, result });
    expect(await s.setStatus(request)).toMatchObject({ errorCode: 'REMOTE_RESULT_UNKNOWN', changed: [] });
  });

  it('checks the same account snapshot before every send and after every receipt', async () => {
    let current = true;
    const check = vi.fn(() => { if (!current) throw new Error('owner changed'); });
    const captureAccess = vi.fn(() => check);
    const invoke = vi.fn(async (_device: string, _channel: string, args: unknown[], options?: { preSend?: () => void }) => {
      options?.preSend?.();
      if (args[0] === 's2') current = false;
      return row(String(args[0]));
    });
    const setStatus = createRemoteSessionsStatusSetter({ invoke, captureAccess });
    const result = await setStatus(request);
    expect(result).toMatchObject({ ok: false, errorCode: 'REMOTE_RESULT_UNKNOWN', failedSessionId: 's2', remainingSessionIds: ['s3'],
      changed: [{ sessionId: 's1', title: null, workingDir: null }],
    });
    expect(captureAccess).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('remote title');
  });

  it('does not send while the account boundary is unavailable', async () => {
    const invoke = vi.fn();
    const setStatus = createRemoteSessionsStatusSetter({ invoke, captureAccess: () => { throw new Error('switching'); } });
    expect(await setStatus(request)).toMatchObject({ errorCode: 'HOST_NOT_READY', changed: [] });
    expect(invoke).not.toHaveBeenCalled();
  });
});
