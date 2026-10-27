/** Test value: new privileged IPC endpoints must reject untrusted frames and invalid
 * payloads before invoking Git, and never leak credential-bearing Git stderr.
 * No existing handler covers this capability. Minimal inputs: untrusted event,
 * option-shaped ref, credential URL in failure. Tier: unit, injected identity.
 */
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { createBranchSyncHandlers } from '../branchSyncHandlers';
import { GitExecError } from '../gitExec';
const calls = vi.hoisted(() => ({ status: vi.fn(), sync: vi.fn() }));
vi.mock('../branchSync', () => ({ readBranchSyncStatus: calls.status, syncBranch: calls.sync }));
const assertSender = vi.fn();
const remote = vi.fn();
const handlers = createBranchSyncHandlers({
  assertTrustedAppRendererEvent: assertSender,
  isDeviceLinkInvoke: remote,
});
const req = { baseRepo: path.resolve('/repo'), branch: 'main' };
beforeEach(() => {
  vi.resetAllMocks();
  remote.mockReturnValue(false);
});
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
