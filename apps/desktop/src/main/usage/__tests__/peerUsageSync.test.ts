import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import type { RegionalMoney } from '../../../shared/regionalMoney';
import {
  createPeerUsageSync,
  mergeIncrementalRows,
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
  };
}

function device(over: Partial<DeviceLinkDeviceView> & { deviceId: string }): DeviceLinkDeviceView {
  return {
    name: over.deviceId,
    platform: 'darwin',
    appVersion: null,
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

  it('discards results that arrive after an account switch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      invoke: async () => {
        await gate;
        return {
          ok: true as const,
          result: await hostResponse(rowsFor(['2026-09-26']), '2026-09-26', null),
        };
      },
      listDevices: async () => ({ devices: [device({ deviceId: 'laptop' })] }),
    });
    const sync = createPeerUsageSync(h.deps);
    const pending = sync.sync();
    await vi.waitFor(() => expect(sync.isSyncing()).toBe(true));
    h.setUser('user-b');
    release();
    await pending;

    expect((await sync.snapshot()).peerRows.size).toBe(0);
    expect(h.written.has('user-b')).toBe(false);
  });
});
