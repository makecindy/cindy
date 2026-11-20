import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineStatus } from '@cindy/device-link';
import type { ProcessMetric, Session, WebContents } from 'electron';
import type { ActiveAppSession } from '../../appSessionState.js';

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(),
  pages: vi.fn(),
  machine: vi.fn(),
  sessions: new Map<string, Session>(),
}));
vi.mock('electron', () => ({
  app: { getAppMetrics: mocks.metrics },
  webContents: { getAllWebContents: mocks.pages },
  session: {
    fromPartition: (partition: string) => {
      if (!mocks.sessions.has(partition)) mocks.sessions.set(partition, {} as Session);
      return mocks.sessions.get(partition);
    },
  },
}));
vi.mock('../../machines/localStatus.js', () => ({ readLocalMachineStatus: mocks.machine }));
vi.mock('../../appSessionState.js', () => ({
  dataOwnerStorageKey: (id: string) => `opaque-${id}`,
}));

import { session } from 'electron';
import { createGhostResourceUsageReader } from '../ghostResourceUsage.js';
import { ownerScopedGhostPartitionForInstalledGhost } from '../ghostWebviewPartition.js';

// Test value: #11738 SC1–SC3; invoke the production host-request reader, checking
// the public result, isolation and rejection semantics. No prior reader covers
// these contracts. Minimal failure: A/B concurrent reads and A's duplicate PID.
// Tier: unit, fake clock and in-memory Electron/OS boundaries; no real I/O.
describe('plugin resource-usage host requests', () => {
  type Target = Parameters<typeof ownerScopedGhostPartitionForInstalledGhost>[0] & {
    enabled: boolean;
  };
  let owner: ActiveAppSession;
  const ghostA: Target = { manifest: { id: 'plugin-a' }, namespace: null, enabled: true };
  const ghostB: Target = { manifest: { id: 'plugin-b' }, namespace: null, enabled: true };
  let targets: Record<string, Target>;
  let logicIds: Map<number, string>;
  let machine: MachineStatus;
  let pages: WebContents[];
  let metrics: ProcessMetric[];
  let read: ReturnType<typeof createGhostResourceUsageReader>;
  const current = () => true;
  const metric = (
    pid: number,
    memoryKb: number | null,
    cpu: number | null,
    type = 'Tab',
  ): ProcessMetric =>
    ({
      pid,
      type,
      memory: { workingSetSize: memoryKb },
      cpu: { percentCPUUsage: cpu },
    }) as ProcessMetric;
  function page(
    id: number,
    pid: number,
    ghost: Target,
    pageOwner = owner,
    type = 'webview',
  ): WebContents {
    return {
      id,
      session: session.fromPartition(ownerScopedGhostPartitionForInstalledGhost(ghost, pageOwner)!),
      isDestroyed: () => false,
      getOSProcessId: () => pid,
      getType: () => type,
    } as WebContents;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    vi.clearAllMocks();
    mocks.sessions.clear();
    owner = { mode: 'cloud', dataOwnerId: 'owner-a', generation: 1 };
    targets = { 'plugin-a': { ...ghostA }, 'plugin-b': { ...ghostB } };
    logicIds = new Map([
      [1, 'plugin-a'],
      [3, 'plugin-b'],
      [5, 'plugin-a'],
    ]);
    pages = [
      page(1, 100, ghostA, owner, 'window'),
      page(2, 100, ghostA),
      page(3, 200, ghostB, owner, 'window'),
      page(4, 101, ghostA),
      page(5, 300, ghostA, { ...owner, dataOwnerId: 'owner-b' }, 'window'),
    ];
    metrics = [
      metric(100, 10, 3),
      metric(101, 20, 4),
      metric(200, 99, 50),
      metric(300, 88, 60),
      metric(400, 5, 1, 'GPU'),
    ];
    machine = {
      capturedAt: '2026-11-20T00:00:00Z',
      memory: { totalBytes: 1_000_000, availableBytes: 500_000 },
      cpu: { busyPercent: 25, logicalCores: 8, loadAverage1m: 1.5 },
      disk: null,
      idleSeconds: null,
      onBattery: null,
      runningTasks: null,
    };
    mocks.metrics.mockImplementation(() => metrics);
    mocks.pages.mockImplementation(() => pages);
    mocks.machine.mockImplementation(async () => machine);
    read = createGhostResourceUsageReader({
      findGhost: (id) => targets[id] ?? null,
      readOwner: () => ({ ...owner }),
      ghostIdForLogicWebContents: (id) => logicIds.get(id) ?? null,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('shares in-flight and 1-second samples while keeping interleaved caller totals isolated', async () => {
    let complete!: (status: MachineStatus) => void;
    mocks.machine.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const requests = [
      read('plugin-a', 'resource-usage', current),
      read('plugin-b', 'resource-usage', current),
    ];
    complete(machine);
    const [a, b] = await Promise.all(requests);
    expect(a).toEqual({
      ok: true,
      capturedAt: '2026-11-20T00:00:00.000Z',
      machine: {
        memoryTotalBytes: 1_000_000,
        memoryAvailableBytes: 500_000,
        cpuBusyPercent: 25,
        cpuLogicalCores: 8,
        cpuLoadAverage1m: 1.5,
      },
      plugin: { memoryBytes: 30 * 1024, cpuPercent: 7 },
      gpu: { memoryBytes: 5 * 1024 },
    });
    expect(b.plugin).toEqual({ memoryBytes: 99 * 1024, cpuPercent: 50 });
    vi.advanceTimersByTime(999);
    expect((await read('plugin-a', 'resource-usage', current)).plugin).toEqual(a.plugin);
    expect(mocks.machine).toHaveBeenCalledTimes(1);
    expect(mocks.metrics).toHaveBeenCalledTimes(1);
    expect(mocks.pages).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    metrics = [
      metric(100, 15, 1),
      metric(101, 25, 2),
      metric(200, 99, 50),
      metric(400, 7, 0, 'GPU'),
    ];
    expect((await read('plugin-a', 'resource-usage', current)).plugin).toEqual({
      memoryBytes: 40 * 1024,
      cpuPercent: 3,
    });
    expect(mocks.machine).toHaveBeenCalledTimes(2);
  });

  it('preserves measured zero and makes only incomplete metrics null', async () => {
    machine.cpu = { busyPercent: 0, logicalCores: 8, loadAverage1m: null };
    machine.memory = { totalBytes: 1_000_000, availableBytes: null };
    metrics = [metric(100, 0, 0), metric(101, null, 0), metric(400, 0, 0, 'GPU')];
    const result = await read('plugin-a', 'resource-usage', current);
    expect(result.machine).toEqual({
      memoryTotalBytes: 1_000_000,
      memoryAvailableBytes: null,
      cpuBusyPercent: 0,
      cpuLogicalCores: 8,
      cpuLoadAverage1m: null,
    });
    expect(result.plugin).toEqual({ memoryBytes: null, cpuPercent: 0 });
    expect(result.gpu.memoryBytes).toBe(0);
  });

  it.each(['missing process', 'invalid pid', 'shared foreign pid', 'enumeration error'])(
    'does not approximate unassignable totals: %s',
    async (reason) => {
      if (reason === 'missing process') metrics = metrics.filter((value) => value.pid !== 101);
      if (reason === 'invalid pid') pages.push(page(6, 0, ghostA));
      if (reason === 'shared foreign pid') pages.push(page(6, 100, ghostB));
      if (reason === 'enumeration error')
        mocks.pages.mockImplementation(() => {
          throw new Error('unavailable');
        });
      expect((await read('plugin-a', 'resource-usage', current)).plugin).toEqual({
        memoryBytes: null,
        cpuPercent: null,
      });
    },
  );

  it('isolates failures of machine and process sampling', async () => {
    mocks.machine.mockRejectedValue(new Error('unavailable'));
    const result = await read('plugin-a', 'resource-usage', current);
    expect(Object.values(result.machine)).toEqual([null, null, null, null, null]);
    expect(result.plugin.memoryBytes).toBe(30 * 1024);
    vi.advanceTimersByTime(1000);
    mocks.machine.mockResolvedValue(machine);
    mocks.metrics.mockImplementation(() => {
      throw new Error('unavailable');
    });
    const unavailable = await read('plugin-a', 'resource-usage', current);
    expect(unavailable.machine.cpuBusyPercent).toBe(25);
    expect(unavailable.plugin).toEqual({ memoryBytes: null, cpuPercent: null });
    expect(unavailable.gpu.memoryBytes).toBeNull();
  });

  it('keeps memory available when CPU is missing, rejecting invalid numbers and absent GPU data', async () => {
    metrics = [metric(100, 10, NaN), metric(101, 20, null)];
    const result = await read('plugin-a', 'resource-usage', current);
    expect(result.plugin).toEqual({ memoryBytes: 30 * 1024, cpuPercent: null });
    expect(result.gpu.memoryBytes).toBeNull();
    vi.advanceTimersByTime(1000);
    metrics = [metric(100, -1, 0), metric(101, Infinity, 0)];
    expect((await read('plugin-a', 'resource-usage', current)).plugin).toEqual({
      memoryBytes: null,
      cpuPercent: 0,
    });
  });

  it('does not include a same-name installation in another namespace or receipt', async () => {
    pages.push(page(6, 500, { ...ghostA, namespace: 'company' }));
    const stale = { ...ghostA, approval: { state: 'approved' as const, revision: 'old' } };
    pages.push(page(7, 501, stale));
    metrics.push(metric(500, 70, 70), metric(501, 80, 80));
    expect((await read('plugin-a', 'resource-usage', current)).plugin).toEqual({
      memoryBytes: 30 * 1024,
      cpuPercent: 7,
    });
  });

  it.each(['owner', 'generation', 'installation', 'disabled', 'caller'])(
    'rejects stale replies after %s changes during sampling',
    async (change) => {
      let complete!: (status: MachineStatus) => void;
      mocks.machine.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      let callerCurrent = true;
      const request = read('plugin-a', 'resource-usage', () => callerCurrent);
      const rejected = expect(request).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      if (change === 'owner') owner = { ...owner, dataOwnerId: 'owner-b' };
      if (change === 'generation') owner.generation++;
      if (change === 'installation') targets['plugin-a'] = { ...ghostA, namespace: 'company' };
      if (change === 'disabled') targets['plugin-a'].enabled = false;
      if (change === 'caller') callerCurrent = false;
      complete(machine);
      await rejected;
    },
  );

  it.each(['unknown-kind', undefined, null, {}])(
    'rejects unknown kinds without sampling: %s',
    async (kind) => {
      await expect(read('plugin-a', kind, current)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
      expect(mocks.machine).not.toHaveBeenCalled();
      expect(mocks.metrics).not.toHaveBeenCalled();
    },
  );
});
