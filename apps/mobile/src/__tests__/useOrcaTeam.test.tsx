// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';

const pushListeners = new Set<(deviceId: string, leadSessionId: string) => void>();

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  subscribeRemoteOrcaWorkerChanged: (listener: (deviceId: string, leadSessionId: string) => void) => {
    pushListeners.add(listener);
    return () => pushListeners.delete(listener);
  },
}));
vi.mock('@/session/ContextSheetCollabView', () => ({ canSubmitOrcaWorkerForm: () => true }));
vi.mock('@/session/fullAccessConfirmation', () => ({ confirmFullAccessChange: async () => true }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { applySessionPatch: vi.fn() } }));

const { useOrcaTeam } = await import('@/session/useSessionOrcaCollab');

let root: Root;
let host: HTMLDivElement;
let latest: ReturnType<typeof useOrcaTeam> | null = null;

function Probe(props: { maker: MobileMakerTransport; leadSessionId: string | null }) {
  latest = useOrcaTeam({ maker: props.maker, deviceId: 'dev-1', leadSessionId: props.leadSessionId });
  return null;
}

function fakeMaker(listWorkers: ReturnType<typeof vi.fn>): MobileMakerTransport {
  return {
    orca: {
      listWorkers,
      getCollaborationSettings: vi.fn(async () => ({ workerSoftLimit: 2, workerHardLimit: 4 })),
    },
  } as unknown as MobileMakerTransport;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pushListeners.clear();
  latest = null;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

it('loads the Lead team and refreshes only on worker-changed pushes for that Lead and device', async () => {
  const listWorkers = vi.fn(async () => [{ id: 'w-1', sessionId: 's-1', status: 'running' }]);
  const maker = fakeMaker(listWorkers);
  await act(async () => root.render(<Probe maker={maker} leadSessionId="lead-1" />));
  expect(listWorkers).toHaveBeenCalledTimes(1);
  expect(latest?.workers.map((worker) => worker.workerId)).toEqual(['w-1']);
  expect(latest?.settings?.workerHardLimit).toBe(4);

  await act(async () => {
    for (const listener of pushListeners) listener('dev-1', 'other-lead');
    for (const listener of pushListeners) listener('dev-2', 'lead-1');
  });
  expect(listWorkers).toHaveBeenCalledTimes(1);

  await act(async () => {
    for (const listener of pushListeners) listener('dev-1', 'lead-1');
  });
  expect(listWorkers).toHaveBeenCalledTimes(2);
});

it('does not load or subscribe for non-Lead tasks', async () => {
  const listWorkers = vi.fn(async () => []);
  await act(async () => root.render(<Probe maker={fakeMaker(listWorkers)} leadSessionId={null} />));
  expect(listWorkers).not.toHaveBeenCalled();
  expect(pushListeners.size).toBe(0);
  expect(latest?.workers).toEqual([]);
});

it('surfaces load failures without dropping the last known list', async () => {
  const listWorkers = vi.fn()
    .mockResolvedValueOnce([{ id: 'w-1', sessionId: 's-1' }])
    .mockRejectedValueOnce(new Error('[NOT_CONNECTED] offline'));
  await act(async () => root.render(<Probe maker={fakeMaker(listWorkers)} leadSessionId="lead-1" />));
  await act(async () => { await latest?.refresh(); });
  expect(latest?.workers.map((worker) => worker.workerId)).toEqual(['w-1']);
  expect(latest?.error).toBeTruthy();
});

it('looks up the Worker Lead again after reconnecting when the first lookup failed', async () => {
  const { useOrcaWorkerLeadSessionId } = await import('@/session/useSessionOrcaCollab');
  const getTeamByWorkerSession = vi.fn()
    .mockRejectedValueOnce(new Error('[DEVICE_OFFLINE] offline'))
    .mockResolvedValueOnce({ leadSessionId: 'lead-9' });
  const maker = { orca: { getTeamByWorkerSession } } as unknown as MobileMakerTransport;
  let lead: string | null = null;
  function WorkerProbe({ epoch }: { epoch: number }) {
    lead = useOrcaWorkerLeadSessionId({ maker, workerSessionId: 'worker-1', connectionEpoch: epoch });
    return null;
  }
  await act(async () => root.render(<WorkerProbe epoch={1} />));
  expect(lead).toBeNull();
  await act(async () => root.render(<WorkerProbe epoch={2} />));
  expect(lead).toBe('lead-9');
  expect(getTeamByWorkerSession).toHaveBeenCalledTimes(2);
});

it('reloads the team after reconnecting, since pushes may have been missed', async () => {
  const listWorkers = vi.fn(async () => []);
  const maker = fakeMaker(listWorkers);
  function EpochProbe({ epoch }: { epoch: number }) {
    latest = useOrcaTeam({ maker, deviceId: 'dev-1', leadSessionId: 'lead-1', connectionEpoch: epoch });
    return null;
  }
  await act(async () => root.render(<EpochProbe epoch={1} />));
  expect(listWorkers).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<EpochProbe epoch={1} />));
  expect(listWorkers).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<EpochProbe epoch={2} />));
  expect(listWorkers).toHaveBeenCalledTimes(2);
});

it('keeps the last collaboration limits when a later settings read fails', async () => {
  const listWorkers = vi.fn(async () => []);
  const getCollaborationSettings = vi.fn()
    .mockResolvedValueOnce({ workerSoftLimit: 6, workerHardLimit: 10 })
    .mockRejectedValueOnce(new Error('[INVOKE_TIMEOUT] timed out'));
  const maker = { orca: { listWorkers, getCollaborationSettings } } as unknown as MobileMakerTransport;
  await act(async () => root.render(<Probe maker={maker} leadSessionId="lead-1" />));
  expect(latest?.settings?.workerHardLimit).toBe(10);
  await act(async () => { await latest!.refresh(); });
  // 不用默认 5/8 冒充被控端的权威上限。
  expect(latest?.settings?.workerHardLimit).toBe(10);
});

it('leaves limits unknown instead of assuming defaults when they were never read', async () => {
  const maker = {
    orca: {
      listWorkers: vi.fn(async () => []),
      getCollaborationSettings: vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); }),
    },
  } as unknown as MobileMakerTransport;
  await act(async () => root.render(<Probe maker={maker} leadSessionId="lead-1" />));
  expect(latest?.settings).toBeNull();
});
