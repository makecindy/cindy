import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { __testing as remoteFence } from '@/lib/remoteDataOwnerPushFence';
import { installProjectMoveFailureToastListener } from '@/lib/projectMoveFailureToast';

const error = vi.hoisted(() => vi.fn());
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/toast', () => ({ toast: { error } }));

type Patch = { sessionId: string; patch: Record<string, unknown> };
let local: (payload: Patch, stamp?: unknown) => void;
let remote: (push: { deviceId: string; channel: string; payload: Patch }, stamp?: unknown) => void;
let dispose: () => void;
const offLocal = vi.fn(),
  offRemote = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  remoteFence.reset();
  setDataOwnerGeneration('owner', 1);
  vi.stubGlobal('window', {
    electronAPI: {
      localDb: {
        sessionsPush: {
          onPatched: (fn: typeof local) => {
            local = fn;
            return offLocal;
          },
        },
      },
      deviceLink: {
        onRemotePush: (fn: typeof remote) => {
          remote = fn;
          return offRemote;
        },
      },
    },
  });
  dispose = installProjectMoveFailureToastListener();
});
afterEach(() => {
  dispose();
  vi.unstubAllGlobals();
});
const payload = {
  sessionId: 'task',
  patch: { projectMoveFailureId: 'failure-1', projectMoveTarget: null },
};

it('shows only one failure for repeated local/remote delivery and stays silent for accepted/completed moves', () => {
  local({ sessionId: 'task', patch: { projectMoveTarget: { workingDir: '/new' } } });
  local({ sessionId: 'task', patch: { projectMoveTarget: null, projectMoveFailureId: null } });
  expect(error).not.toHaveBeenCalled();
  local(payload);
  local(payload);
  remote({ deviceId: 'host', channel: 'local-db:sessions:patched', payload });
  remote({ deviceId: 'host', channel: 'local-db:sessions:patched', payload });
  expect(error).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledWith('taskMove.failed');
});

it('ignores stale owner pushes and resets deduplication after changing account', () => {
  local(payload, { dataOwnerId: 'old', ownerGeneration: 1 });
  remote(
    { deviceId: 'host', channel: 'local-db:sessions:patched', payload },
    { dataOwnerId: 'old', ownerGeneration: 1 },
  );
  expect(error).not.toHaveBeenCalled();
  local(payload);
  setDataOwnerGeneration('new-owner', 2);
  local(payload, { dataOwnerId: 'owner', ownerGeneration: 1 });
  expect(error).toHaveBeenCalledTimes(1);
  local(payload, { dataOwnerId: 'new-owner', ownerGeneration: 2 });
  expect(error).toHaveBeenCalledTimes(2);
});

it('unsubscribes both sources', () => {
  dispose();
  expect(offLocal).toHaveBeenCalledOnce();
  expect(offRemote).toHaveBeenCalledOnce();
});
