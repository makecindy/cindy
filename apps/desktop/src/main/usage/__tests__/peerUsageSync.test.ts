import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import type { RegionalMoney } from '../../../shared/regionalMoney';
import {
  createPeerUsageSync,
  mayServeBackgroundRead,
  mergeIncrementalRows,
  withPeerUsageAccessGate,
  type PeerUsageSyncDeps,
} from '../peerUsageSync';
import {
  decodeUsageDeviceRowsResponse,
  parseUsageDeviceRowsRequest,
  readUsageDeviceRows,
  type UsageDeviceRows,
} from '../usageDeviceRows';

const usd = (amount: number): RegionalMoney => ({
  amount,
  currency: 'USD',
  approximate: false,
  kind: 'actual-cost',
});

function rowsFor(days: string[], tokens = 10): UsageDeviceRows {
  return {
    spendDays: days.map((day) => ({ day, monies: [usd(1)] })),
    modelRows: days.map((day) => ({
      day,
      agentKind: 'codex' as const,
      model: 'gpt-5.5',
      money: usd(1),
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    })),
    sessionRows: [],
    tasks: [],
  };
}

function device(over: Partial<DeviceLinkDeviceView> & { deviceId: string }): DeviceLinkDeviceView {
  return {
    name: over.deviceId,
    platform: 'darwin',
    appVersion: '0.1.94',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...over,
  };
}

async function hostResponse(rows: UsageDeviceRows, todayKey: string, sinceDay: string | null) {
  return readUsageDeviceRows(
    {
      getAllSpendDays: async () => rows.spendDays,
      getModelUsageSince: async (since) => rows.modelRows.filter((row) => row.day >= since),
      getSessionUsageSince: async () => ({ rows: [], tasks: [] }),
      remoteVisibleTaskIds: async (ids) => new Set(ids),
      todayKey: () => todayKey,
    },
    { sinceDay },
  );
}

function harness(over: Partial<PeerUsageSyncDeps> = {}) {
  let now = 1_000_000;
  let userId: string | null = 'user-a';
  const written = new Map<string, string>();
  const deps: PeerUsageSyncDeps = {
    userId: () => userId,
    selfDeviceId: () => 'self',
    listDevices: async () => ({ devices: [device({ deviceId: 'self', isSelf: true })] }),
    invoke: vi.fn(async () => ({ ok: false as const, error: { code: 'TIMEOUT', message: 'x' } })),
    readCache: async (id) => written.get(id) ?? null,
    writeCache: async (id, contents) => {
      written.set(id, contents);
    },
    now: () => now,
    ...over,
  };
  return {
    deps,
    written,
    advance: (ms: number) => {
      now += ms;
    },
    setUser: (id: string | null) => {
      userId = id;
    },
  };
}

describe('usage device rows wire format', () => {
  it('round-trips rows, filters by sinceDay and validates requests', async () => {
    const rows = rowsFor(['2026-09-24', '2026-09-25', '2026-09-26']);
    const decoded = await decodeUsageDeviceRowsResponse(
      await hostResponse(rows, '2026-09-26', '2026-09-25'),
    );
    expect(decoded).toMatchObject({ kind: 'rows', todayKey: '2026-09-26', sinceDay: '2026-09-25' });
    if (decoded?.kind !== 'rows') throw new Error('expected rows');
    expect(decoded.rows.spendDays.map((row) => row.day)).toEqual(['2026-09-25', '2026-09-26']);
    expect(decoded.rows.modelRows.map((row) => row.day)).toEqual(['2026-09-25', '2026-09-26']);

    expect(parseUsageDeviceRowsRequest(undefined)).toEqual({ sinceDay: null });
    expect(parseUsageDeviceRowsRequest({ sinceDay: '2026-09-25' })).toEqual({
      sinceDay: '2026-09-25',
    });
    expect(parseUsageDeviceRowsRequest({ sinceDay: 'yesterday' })).toBeNull();
    expect(parseUsageDeviceRowsRequest('2026-09-25')).toBeNull();
  });

  it('rejects malformed responses and drops malformed rows', async () => {
    expect(await decodeUsageDeviceRowsResponse(null)).toBeNull();
    expect(await decodeUsageDeviceRowsResponse({ format: 'other' })).toBeNull();
    expect(
      await decodeUsageDeviceRowsResponse({
        format: 'usage-device-rows-v1',
        todayKey: '2026-09-26',
        sinceDay: null,
        rowsGz: 'not-gzip',
      }),
    ).toBeNull();
    expect(
      await decodeUsageDeviceRowsResponse({ format: 'usage-device-rows-v1', oversize: true }),
    ).toEqual({
      kind: 'oversize',
    });

    const bad = {
      spendDays: [{ day: 'bad', monies: [usd(1)] }],
      modelRows: [
        { ...rowsFor(['2026-09-26']).modelRows[0], agentKind: 'other' },
        { ...rowsFor(['2026-09-26']).modelRows[0], inputTokens: -5 },
      ],
    };
    const decoded = await decodeUsageDeviceRowsResponse(
      await readUsageDeviceRows(
        {
          getAllSpendDays: async () => bad.spendDays,
          getModelUsageSince: async () => bad.modelRows as never,
          getSessionUsageSince: async () => ({ rows: [], tasks: [] }),
          remoteVisibleTaskIds: async (ids) => new Set(ids),
          todayKey: () => '2026-09-26',
        },
        { sinceDay: null },
      ),
    );
    if (decoded?.kind !== 'rows') throw new Error('expected rows');
    expect(decoded.rows.spendDays).toEqual([]);
    expect(decoded.rows.modelRows).toHaveLength(1);
    expect(decoded.rows.modelRows[0].inputTokens).toBe(0);
  });

  it('sends only remotely visible tasks and their rows', async () => {
    const task = (sessionId: string) => ({
      sessionId,
      title: sessionId,
      model: 'm',
      providerId: null,
      contextTokens: 0,
      contextWindow: 0,
      lastActiveAt: 1,
    });
    const decoded = await decodeUsageDeviceRowsResponse(
      await readUsageDeviceRows(
        {
          getAllSpendDays: async () => [],
          getModelUsageSince: async () => [],
          getSessionUsageSince: async () => ({
            rows: [
              { day: '2026-09-26', sessionId: 'ordinary', tokens: 3 },
              { day: '2026-09-26', sessionId: 'hidden-bot', tokens: 4 },
            ],
            tasks: [task('ordinary'), task('hidden-bot')],
          }),
          remoteVisibleTaskIds: async () => new Set(['ordinary']),
          todayKey: () => '2026-09-26',
        },
        { sinceDay: null },
      ),
    );
    if (decoded?.kind !== 'rows') throw new Error('expected rows');
    expect(decoded.rows.tasks.map((row) => row.sessionId)).toEqual(['ordinary']);
    expect(decoded.rows.sessionRows.map((row) => row.sessionId)).toEqual(['ordinary']);
  });

  it('replaces task metadata wholesale and drops rows of tasks that disappeared', () => {
    const task = (sessionId: string, title: string) => ({
      sessionId,
      title,
      model: 'm',
      providerId: null,
      contextTokens: 0,
      contextWindow: 0,
      lastActiveAt: 1,
    });
    const cached: UsageDeviceRows = {
      ...rowsFor(['2026-09-20']),
      sessionRows: [
        { day: '2026-09-20', sessionId: 'renamed', tokens: 1 },
        { day: '2026-09-20', sessionId: 'deleted', tokens: 2 },
      ],
      tasks: [task('renamed', 'Old'), task('deleted', 'Gone')],
    };
    // 两个任务在增量区间内都没有新用量;被控端返回的是全部任务的当前元数据。
    const merged = mergeIncrementalRows(cached, '2026-09-25', {
      ...rowsFor(['2026-09-25']),
      tasks: [task('renamed', 'New')],
    });
    expect(merged.tasks.map((row) => [row.sessionId, row.title])).toEqual([['renamed', 'New']]);
    expect(merged.sessionRows.map((row) => row.sessionId)).toEqual(['renamed']);
  });

  it('replaces only the incremental window when merging', () => {
    const cached = rowsFor(['2026-09-24', '2026-09-25'], 1);
    const merged = mergeIncrementalRows(
      cached,
      '2026-09-25',
      rowsFor(['2026-09-25', '2026-09-26'], 9),
    );
    expect(merged.modelRows.map((row) => [row.day, row.inputTokens])).toEqual([
      ['2026-09-24', 1],
      ['2026-09-25', 9],
      ['2026-09-26', 9],
    ]);
    expect(mergeIncrementalRows(cached, null, rowsFor(['2026-09-26']))).toEqual(
      rowsFor(['2026-09-26']),
    );
  });
});

describe('createPeerUsageSync', () => {
  it('reads online permitted computers, skips phones and reports why others are missing', async () => {
    const invoke = vi.fn(async (deviceId: string) => {
      if (deviceId === 'old')
        return { ok: false as const, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'x' } };
      return {
        ok: true as const,
        result: await hostResponse(rowsFor(['2026-09-26']), '2026-09-26', null),
      };
    });
    const h = harness({
      invoke,
      listDevices: async () => ({
        devices: [
          device({ deviceId: 'self', isSelf: true, name: 'Studio' }),
          device({ deviceId: 'laptop', name: 'Laptop' }),
          device({ deviceId: 'phone', platform: 'ios' }),
          device({ deviceId: 'sleeping', online: false }),
          device({ deviceId: 'locked', remoteControlEnabled: false }),
          device({ deviceId: 'old' }),
        ],
      }),
    });
    const sync = createPeerUsageSync(h.deps);

    await sync.sync();

    expect(invoke.mock.calls.map((call) => call[0]).sort()).toEqual(['laptop', 'old']);
    expect(invoke).toHaveBeenCalledWith('laptop', 'maker:usage:device-rows', [{}]);
    const snapshot = await sync.snapshot();
    expect(snapshot.devices.map((d) => [d.deviceId, d.status])).toEqual([
      ['self', 'ok'],
      ['laptop', 'ok'],
      ['sleeping', 'offline'],
      ['locked', 'remote-disabled'],
      ['old', 'unsupported'],
    ]);
    expect([...snapshot.peerRows.keys()]).toEqual(['laptop']);
    expect(JSON.parse(h.written.get('user-a') ?? '{}').peers.laptop.name).toBe('Laptop');
  });

  it('never connects released versions without background links and retries unsupported ones only after an update', async () => {
    const invoke = vi.fn<PeerUsageSyncDeps['invoke']>(async () => ({
      ok: false as const,
      error: { code: 'UNSUPPORTED_CAPABILITY', message: 'x' },
    }));
    let candidateVersion = '0.1.94';
    const h = harness({
      invoke,
      listDevices: async () => ({
        devices: [
          device({ deviceId: 'self', isSelf: true }),
          device({ deviceId: 'released', appVersion: '0.1.93' }),
          device({ deviceId: 'beta', appVersion: '0.1.93-beta' }),
          device({ deviceId: 'unknown', appVersion: null }),
          device({ deviceId: 'candidate', appVersion: candidateVersion }),
        ],
      }),
    });
    const sync = createPeerUsageSync(h.deps);

    await sync.sync();
    // 旧正式版 / 版本未知:连都不连(建链就会让对方显示受控);只尝试更新的版本。
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['candidate']);
    expect((await sync.snapshot()).devices.map((d) => [d.deviceId, d.status])).toEqual([
      ['self', 'ok'],
      ['released', 'unsupported'],
      ['beta', 'unsupported'],
      ['unknown', 'unsupported'],
      ['candidate', 'unsupported'],
    ]);

    // 同一版本不再重试;对方更新后再试一次。
    h.advance(61_000);
    await sync.sync();
    expect(invoke).toHaveBeenCalledTimes(1);
    candidateVersion = '0.1.95';
    h.advance(61_000);
    await sync.sync();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('allows local development builds through to the link capability check', () => {
    expect(mayServeBackgroundRead('0.0.0')).toBe(true);
    expect(mayServeBackgroundRead('0.1.94')).toBe(true);
    expect(mayServeBackgroundRead('0.1.93')).toBe(false);
    expect(mayServeBackgroundRead(null)).toBe(false);
  });

  it('throttles, then syncs incrementally from the day before the cached day', async () => {
    const invoke = vi.fn(async (_id: string, _channel: string, args: unknown[]) => {
      const sinceDay = (args[0] as { sinceDay?: string }).sinceDay ?? null;
      const rows = sinceDay
        ? rowsFor(['2026-09-26', '2026-09-27'], 5)
        : rowsFor(['2026-09-25', '2026-09-26'], 1);
      return {
        ok: true as const,
        result: await hostResponse(rows, sinceDay ? '2026-09-27' : '2026-09-26', sinceDay),
      };
    });
    const h = harness({
      invoke,
      listDevices: async () => ({ devices: [device({ deviceId: 'laptop' })] }),
    });
    const sync = createPeerUsageSync(h.deps);

    await sync.sync();
    await sync.sync();
    expect(invoke).toHaveBeenCalledTimes(1);

    h.advance(61_000);
    await sync.sync();
    expect(invoke).toHaveBeenLastCalledWith('laptop', 'maker:usage:device-rows', [
      { sinceDay: '2026-09-25' },
    ]);
    const rows = (await sync.snapshot()).peerRows.get('laptop');
    expect(rows?.modelRows.map((row) => [row.day, row.inputTokens])).toEqual([
      ['2026-09-26', 5],
      ['2026-09-27', 5],
    ]);
  });

  it('keeps cached rows when a later read fails, and forgets removed devices', async () => {
    let fail = false;
    let listed = true;
    const h = harness({
      invoke: async () =>
        fail
          ? { ok: false as const, error: { code: 'TIMEOUT', message: 'x' } }
          : {
              ok: true as const,
              result: await hostResponse(rowsFor(['2026-09-26']), '2026-09-26', null),
            },
      listDevices: async () => ({ devices: listed ? [device({ deviceId: 'laptop' })] : [] }),
    });
    const sync = createPeerUsageSync(h.deps);
    await sync.sync();

    fail = true;
    h.advance(61_000);
    await sync.sync();
    let snapshot = await sync.snapshot();
    expect(snapshot.devices[0]).toMatchObject({
      deviceId: 'laptop',
      status: 'offline',
      syncedAt: 1_000_000,
    });
    expect(snapshot.peerRows.has('laptop')).toBe(true);

    // 新进程从磁盘缓存恢复, 目录读到之前照常参与合并。
    const restored = createPeerUsageSync({
      ...h.deps,
      listDevices: async () => Promise.reject(new Error('offline')),
    });
    expect((await restored.snapshot()).peerRows.has('laptop')).toBe(true);

    listed = false;
    h.advance(61_000);
    await sync.sync();
    snapshot = await sync.snapshot();
    expect(snapshot.devices).toEqual([]);
    expect(snapshot.peerRows.size).toBe(0);
  });

  it('marks previously read computers unreadable when the device directory fails', async () => {
    let directoryFails = false;
    const h = harness({
      invoke: async () => ({
        ok: true as const,
        result: await hostResponse(rowsFor(['2026-09-26']), '2026-09-26', null),
      }),
      listDevices: async () => {
        if (directoryFails) throw new Error('offline');
        return { devices: [device({ deviceId: 'laptop' })] };
      },
    });
    const sync = createPeerUsageSync(h.deps);
    await sync.sync();
    expect((await sync.snapshot()).devices[0].status).toBe('ok');

    directoryFails = true;
    h.advance(61_000);
    const before = sync.version();
    await sync.sync();
    const snapshot = await sync.snapshot();
    expect(snapshot.devices[0]).toMatchObject({
      deviceId: 'laptop',
      status: 'error',
      syncedAt: 1_000_000,
    });
    expect(snapshot.peerRows.has('laptop')).toBe(true);
    // 用量行没变:聚合版本不动,读取失败的状态作为展示元数据在读取时附上。
    expect(sync.version()).toBe(before);
  });

  it('starts a fresh sync for a new account instead of waiting on the old one, and drops late old writes', async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let userForListing = 'user-a';
    const invoked: string[] = [];
    const h = harness({
      invoke: async (deviceId) => {
        invoked.push(deviceId);
        if (deviceId === 'laptop-a') {
          await oldGate;
          return { ok: false as const, error: { code: 'TIMEOUT', message: 'late' } };
        }
        return {
          ok: true as const,
          result: await hostResponse(rowsFor(['2026-09-26']), '2026-09-26', null),
        };
      },
      listDevices: async () => ({
        devices: [device({ deviceId: userForListing === 'user-a' ? 'laptop-a' : 'laptop-b' })],
      }),
    });
    const sync = createPeerUsageSync(h.deps);
    const oldRun = sync.sync();
    await vi.waitFor(() => expect(invoked).toContain('laptop-a'));

    h.setUser('user-b');
    userForListing = 'user-b';
    await sync.sync();
    expect(invoked).toContain('laptop-b');
    expect([...(await sync.snapshot()).peerRows.keys()]).toEqual(['laptop-b']);

    releaseOld();
    await oldRun;
    const snapshot = await sync.snapshot();
    expect(snapshot.devices.map((d) => [d.deviceId, d.status])).toEqual([['laptop-b', 'ok']]);
    expect(h.written.has('user-a')).toBe(false);
  });

  it('keeps the data version stable when a sync changes nothing (no other computers)', async () => {
    const h = harness({
      listDevices: async () => ({ devices: [device({ deviceId: 'self', isSelf: true })] }),
    });
    const sync = createPeerUsageSync(h.deps);
    await sync.sync();
    const settled = sync.version();
    for (let i = 0; i < 3; i += 1) {
      h.advance(61_000);
      await sync.sync();
    }
    expect(sync.version()).toBe(settled);
  });

  it('does not list devices or invoke peers while Device Link access is denied', async () => {
    let allowed = true;
    const listDevices = vi.fn(async () => ({ devices: [device({ deviceId: 'laptop' })] }));
    const invoke = vi.fn(async () => ({
      ok: true as const,
      result: await hostResponse(rowsFor(['2026-09-26']), '2026-09-26', null),
    }));
    const h = harness({ listDevices, invoke });
    const sync = createPeerUsageSync(
      withPeerUsageAccessGate(() => {
        if (!allowed) throw new Error('[PERMISSION_DENIED] Device Link requires a Cindy account.');
      }, h.deps),
    );
    await sync.sync();
    expect(invoke).toHaveBeenCalledTimes(1);

    allowed = false;
    h.advance(61_000);
    await sync.sync();
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    const snapshot = await sync.snapshot();
    expect(snapshot.devices[0]).toMatchObject({ deviceId: 'laptop', status: 'error' });
    expect(snapshot.peerRows.has('laptop')).toBe(true);
  });

  it('drops a disk cache that finishes loading after the account changed', async () => {
    let releaseCache!: (raw: string) => void;
    const cacheGate = new Promise<string>((resolve) => {
      releaseCache = resolve;
    });
    const h = harness();
    const oldCache = JSON.stringify({
      version: 2,
      peers: {
        laptop: {
          name: 'Old account laptop',
          platform: 'darwin',
          syncedAt: 1,
          todayKey: '2026-09-26',
          rows: rowsFor(['2026-09-26']),
        },
      },
    });
    const sync = createPeerUsageSync({
      ...h.deps,
      readCache: (id) => (id === 'user-a' ? cacheGate : Promise.resolve(null)),
    });
    const pending = sync.snapshot();
    // 读缓存期间切换账号,且在缓存返回前没有其它调用触发 reset。
    h.setUser('user-b');
    releaseCache(oldCache);
    const snapshot = await pending;
    expect(snapshot.peerRows.size).toBe(0);
    expect(snapshot.devices).toEqual([]);
    expect((await sync.snapshot()).peerRows.size).toBe(0);
  });
});
