/** Test value: new privileged IPC endpoints must reject untrusted frames and invalid
 * payloads before invoking Git, and never leak credential-bearing Git stderr.
 * No existing handler covers this capability. Minimal inputs: untrusted event,
 * option-shaped ref, credential URL in failure. Tier: unit, injected identity.
 */
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBranchSyncHandlers } from '../branchSyncHandlers';
import { GitExecError } from '../gitExec';
const calls = vi.hoisted(() => ({ status: vi.fn(), sync: vi.fn() }));
vi.mock('../branchSync', () => ({ readBranchSyncStatus: calls.status, syncBranch: calls.sync }));
const assertSender = vi.fn();
const remote = vi.fn();
const scope = vi.fn(() => 'owner:1:device-a');
const handlers = createBranchSyncHandlers({
  assertTrustedAppRendererEvent: assertSender,
  isDeviceLinkInvoke: remote,
  getCallerScope: scope,
});
const req = { baseRepo: path.resolve('/repo'), branch: 'main' };
beforeEach(() => {
  vi.resetAllMocks();
  remote.mockReturnValue(false);
  scope.mockReturnValue('owner:1:device-a');
});
afterEach(() => vi.useRealTimers());
it('rejects an untrusted frame before reading or mutating any repository', () => {
  assertSender.mockImplementation(() => {
    throw new Error('[PERMISSION_DENIED] Untrusted frame');
  });
  for (const handler of [handlers.status, handlers.sync])
    expect(() => handler({}, req)).toThrow('PERMISSION_DENIED');
  expect(calls.status).not.toHaveBeenCalled();
  expect(calls.sync).not.toHaveBeenCalled();
});
it.each([
  { baseRepo: 'relative', branch: 'main' },
  { ...req, branch: '--help' },
  { ...req, branch: 'main:other' },
  null,
])('rejects malformed payloads without side effects: %j', (body) => {
  expect(() => handlers.sync({}, body)).toThrow('INVALID_PARAMS');
  expect(calls.sync).not.toHaveBeenCalled();
});
it('accepts the authenticated device-link context without treating its synthetic event as a local frame', async () => {
  remote.mockReturnValue(true);
  calls.sync.mockResolvedValue({ updated: 2 });
  expect(await handlers.sync({}, req)).toEqual({ updated: 2 });
  expect(assertSender).not.toHaveBeenCalled();
  expect(calls.sync).toHaveBeenCalledWith(req);
});
it('returns a readable reason without leaking Git credentials or output', async () => {
  calls.sync.mockRejectedValue(
    new GitExecError({
      args: ['fetch'],
      exitCode: 128,
      stdout: '',
      stderr: 'Authentication failed for https://name:secret@example.com/repo',
    }),
  );
  await expect(handlers.sync({}, req)).rejects.toThrow('branch-sync:auth');
  await expect(handlers.sync({}, req)).rejects.not.toThrow('secret');
});

// Regression: a healthy download outlives the 90s device-link invoke. Exercise
// the real IPC handlers with fake time; previous cases only await final replies.
// Minimum input: one pending sync and continuations from two controller scopes.
it('waits across multiple bounded replies without rerunning Git, scoped to owner, device and repository', async () => {
  vi.useFakeTimers();
  let finish!: (value: { updated: number }) => void;
  calls.sync.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const initial = handlers.sync({}, { ...req, waitForResult: true });
  await vi.advanceTimersByTimeAsync(10_000);
  const pending = await initial;
  expect(pending).toMatchObject({ pending: true });
  if (!('operationId' in pending)) throw new Error('expected continuation');
  const continuation = { ...req, waitForResult: true, operationId: pending.operationId };
  for (const other of ['owner:1:device-b', 'owner:2:device-a']) {
    scope.mockReturnValue(other);
    expect(() => handlers.sync({}, continuation)).toThrow('branch-sync:changed');
  }
  scope.mockReturnValue('owner:1:device-a');
  expect(() => handlers.sync({}, { ...continuation, branch: 'other' })).toThrow(
    'branch-sync:changed',
  );
  for (let i = 0; i < 10; i++) {
    const next = handlers.sync({}, continuation);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await next).toEqual(pending);
  }
  finish({ updated: 2 });
  expect(await handlers.sync({}, continuation)).toEqual({ updated: 2 });
  expect(calls.sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(() => handlers.sync({}, continuation)).toThrow('branch-sync:changed');
  expect(calls.sync).toHaveBeenCalledTimes(1);
});

it('retains a sanitized failure for continuations without unhandled rejections or a second fetch', async () => {
  vi.useFakeTimers();
  let fail!: (error: Error) => void;
  calls.sync.mockReturnValue(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  const initial = handlers.sync({}, { ...req, waitForResult: true });
  await vi.advanceTimersByTimeAsync(10_000);
  const pending = await initial;
  if (!('operationId' in pending)) throw new Error('expected continuation');
  fail(
    new GitExecError({
      args: ['fetch'],
      exitCode: null,
      stdout: '',
      stderr: 'secret',
      timedOut: true,
    }),
  );
  await expect(
    handlers.sync({}, { ...req, waitForResult: true, operationId: pending.operationId }),
  ).rejects.toThrow('branch-sync:timeout');
  expect(calls.sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
});

// PR #7464: completed results consumed the active-operation quota. Unit tier:
// keep one real handler operation pending while 65 others finish (including
// failures); completed cache pressure must neither block starts nor evict it.
it('does not let retained terminal results block new work or evict an active operation', async () => {
  vi.useFakeTimers();
  let finish!: (value: { updated: number }) => void;
  calls.sync.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const waiting = handlers.sync({}, { ...req, waitForResult: true });
  await vi.advanceTimersByTimeAsync(10_000);
  const pending = await waiting;
  if (!('operationId' in pending)) throw new Error('expected continuation');
  for (let i = 0; i < 65; i++) {
    if (i % 2) {
      calls.sync.mockRejectedValueOnce(new Error('failed'));
      await expect(handlers.sync({}, { ...req, waitForResult: true })).rejects.toThrow('branch-sync:git');
    } else {
      calls.sync.mockResolvedValueOnce({ updated: 1 });
      expect(await handlers.sync({}, { ...req, waitForResult: true })).toEqual({ updated: 1 });
    }
  }
  finish({ updated: 3 });
  expect(await handlers.sync({}, { ...req, waitForResult: true, operationId: pending.operationId })).toEqual({ updated: 3 });
  expect(calls.sync).toHaveBeenCalledTimes(66);
  expect(vi.getTimerCount()).toBe(64);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(vi.getTimerCount()).toBe(0);
});

it('still bounds active work and releases its quota when the operations finish', async () => {
  vi.useFakeTimers();
  let finish!: (value: { updated: number }) => void;
  calls.sync.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const requests = Array.from({ length: 64 }, () => handlers.sync({}, { ...req, waitForResult: true }));
  expect(() => handlers.sync({}, { ...req, waitForResult: true })).toThrow('branch-sync:busy');
  finish({ updated: 1 });
  await Promise.all(requests);
  expect(await handlers.sync({}, { ...req, waitForResult: true })).toEqual({ updated: 1 });
  expect(calls.sync).toHaveBeenCalledTimes(65);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(vi.getTimerCount()).toBe(0);
});
