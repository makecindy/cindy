// unit: new host status boundary, previously uncovered. Minimal failures: another
// instance replies, owner/revision changes, malformed text or a missing reply.
import { afterEach, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost';
import type { GhostTaskStatusRequest } from '../../../shared/ghostTaskStatus';
import { createGhostTaskStatusHandler, GhostTaskStatusSlot } from '../taskStatusSlot';
import type { IpcMainInvokeEvent } from 'electron';

function setup() {
  const ghost = {
    manifest: { taskView: { html: 'task.html', statusBar: true } },
    enabled: true,
    approval: { state: 'approved', revision: 'one' },
  } as InstalledGhost;
  let owner = 'owner';
  let allowed = true;
  let request!: GhostTaskStatusRequest;
  const wake = vi.fn(async () => true);
  const send = vi.fn((_id: string, value: GhostTaskStatusRequest) => {
    request = value;
    return true;
  });
  const slot = new GhostTaskStatusSlot({
    getGhost: () => ghost,
    ownerScope: () => owner,
    wake,
    send,
  });
  const query = () => slot.query('local-demo', 'task', () => allowed);
  return {
    slot,
    ghost,
    wake,
    send,
    query,
    request: () => request,
    changeOwner: () => {
      owner = 'other';
    },
    revoke: () => {
      allowed = false;
    },
  };
}
afterEach(() => vi.useRealTimers());

it('accepts sanitized text from the actual instance once', async () => {
  const s = setup();
  const result = s.query();
  await Promise.resolve();
  expect(s.request()).toMatchObject({ type: 'task-status', sessionId: 'task' });
  const reply = {
    requestId: s.request().requestId,
    label: '  quota   50%  ',
    tooltip: 'Remaining quota',
  };
  expect(s.slot.reply('other-instance', reply)).toEqual({ ok: false });
  expect(s.slot.reply('local-demo', reply)).toEqual({ ok: true });
  expect(await result).toMatchObject({ label: 'quota 50%', tooltip: 'Remaining quota' });
  expect(s.slot.reply('local-demo', reply)).toEqual({ ok: false });
});

it.each(['owner', 'revision', 'disabled', 'workdir'] as const)(
  'drops replies after %s changes',
  async (change) => {
    vi.useFakeTimers();
    const s = setup();
    const result = s.query();
    await Promise.resolve();
    if (change === 'owner') s.changeOwner();
    if (change === 'revision') s.ghost.approval = { state: 'approved', revision: 'two' };
    if (change === 'disabled') s.ghost.enabled = false;
    if (change === 'workdir') s.revoke();
    expect(
      s.slot.reply('local-demo', { requestId: s.request().requestId, label: 'stale' }),
    ).toEqual({ ok: false });
    await vi.runAllTimersAsync();
    expect(await result).toBeNull();
  },
);

it('does not wake plugins without an approved explicit status launcher', async () => {
  const s = setup();
  delete s.ghost.manifest.taskView!.statusBar;
  expect(await s.query()).toBeNull();
  expect(s.wake).not.toHaveBeenCalled();
  s.ghost.manifest.taskView!.statusBar = true;
  s.ghost.approval = { state: 'legacy-unapproved' };
  expect(await s.query()).toBeNull();
  expect(s.wake).not.toHaveBeenCalled();
});

it('coalesces windows watching the same task and cancels replies from stopped runtimes', async () => {
  const s = setup();
  const one = s.query();
  const two = s.query();
  await Promise.resolve();
  expect(s.send).toHaveBeenCalledTimes(1);
  const reply = { requestId: s.request().requestId, label: 'late' };
  s.slot.cancel('local-demo');
  expect(await one).toBeNull();
  expect(await two).toBeNull();
  expect(s.slot.reply('local-demo', reply)).toEqual({ ok: false });
});

it('rejects oversized data and releases failed or timed-out requests', async () => {
  vi.useFakeTimers();
  const s = setup();
  const invalid = s.query();
  await Promise.resolve();
  expect(
    s.slot.reply('local-demo', { requestId: s.request().requestId, label: 'x'.repeat(81) }),
  ).toEqual({ ok: false });
  expect(await invalid).toBeNull();
  const timeout = s.query();
  await vi.runAllTimersAsync();
  expect(await timeout).toBeNull();
  s.wake.mockResolvedValue(false);
  expect(await s.query()).toBeNull();
});

// IPC handler boundary (unit): reject untrusted callers before wake; suppress
// status when directory policy, task existence or owner changes during the read.
it('authorizes before reading and rechecks task/workdir/owner after asynchronous status', async () => {
  const s = setup();
  Object.assign(s.ghost.manifest, { id: 'local-demo', name: 'Demo' });
  const authorize = vi.fn();
  let owner: string | null = 'owner';
  let disabled = false;
  let session: { workingDir: string; remoteHostId: string | null } | null = {
    workingDir: '/project',
    remoteHostId: null,
  };
  const read = vi.fn(async () => session);
  const query = vi.spyOn(s.slot, 'query').mockResolvedValue({ requestId: 'reply', label: '50%' });
  const handler = createGhostTaskStatusHandler({
    authorize,
    scope: () => owner,
    session: read,
    list: () => [s.ghost],
    disabled: () => disabled,
    slot: s.slot,
  });
  const event = {} as IpcMainInvokeEvent;
  expect(await handler(event, 'task')).toEqual([
    { instanceId: 'local-demo', name: 'Demo', label: '50%' },
  ]);
  disabled = true;
  query.mockClear();
  expect(await handler(event, 'task')).toEqual([]);
  expect(query).not.toHaveBeenCalled();
  disabled = false;
  query.mockImplementationOnce(async () => {
    s.ghost.approval = { state: 'approved', revision: 'replacement' };
    return { requestId: 'reply', label: 'old installation' };
  });
  expect(await handler(event, 'task')).toEqual([]);
  query.mockImplementationOnce(async () => {
    owner = null;
    return { requestId: 'reply', label: 'old' };
  });
  expect(await handler(event, 'task')).toEqual([]);
  owner = 'owner';
  query.mockImplementationOnce(async () => {
    session = null;
    return { requestId: 'reply', label: 'deleted' };
  });
  expect(await handler(event, 'task')).toEqual([]);
  await expect(handler(event, '')).rejects.toThrow('INVALID_PARAMS');
  authorize.mockImplementationOnce(() => {
    throw new Error('untrusted');
  });
  read.mockClear();
  await expect(handler(event, 'task')).rejects.toThrow('untrusted');
  expect(read).not.toHaveBeenCalled();
});
