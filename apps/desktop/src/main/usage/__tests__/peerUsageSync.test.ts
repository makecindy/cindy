/** 测试价值
 * - 生产入口与可观察结果：readUsageDeviceRows / decodeUsageDeviceRowsResponse / createUsageTaskDeltaCache
 *   与 createPeerUsageSync；跨设备同步用量行与任务元数据时保持结果一致，增量同步只传变更/删除的任务元数据。
 * - Bug／规则依据：docs/dev-rules/protocol-compatibility/usage-history-cross-device-merge.md；
 *   2026-11-24 线上回归中每 60 秒增量同步重传全部历史任务元数据（272 KB gzip），堵死慢网回程 44.7 秒。
 * - 现有覆盖缺口：原测试只覆盖每次全量返回 tasks，未覆盖 tasksBase/tasksDelta 增量合并、混合版本回退与跨账号缓存隔离。
 * - 最小失败输入：200 条历史任务仅 1 条更新、1 条删除时二次增量同步，以及不同账号复用同一 tasksBase 令牌。
 * - tier：unit（内存依赖与真实 gzip 编解码，无磁盘/网络 I/O）。
 * - 实测耗时：0.97s（pnpm --dir apps/desktop exec vitest run src/main/usage/__tests__/peerUsageSync.test.ts）
 */
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
  createUsageTaskDeltaCache,
  decodeUsageDeviceRowsResponse,
  isUnixMs,
  parseUsageDeviceRowsRequest,
  readUsageDeviceRows,
  sanitizeUsageDeviceRows,
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
  it('preserves media fees with zero tokens across devices', async () => {
    const rows = rowsFor(['2026-10-15'], 0);
    rows.modelRows[0].agentKind = 'media';
    const decoded = await decodeUsageDeviceRowsResponse(await hostResponse(rows, '2026-10-15', null));
    expect(decoded?.kind).toBe('rows');
    if (decoded?.kind !== 'rows') throw new Error('expected rows');
    expect(decoded.rows.modelRows[0]).toMatchObject({ agentKind: 'media', money: usd(1), inputTokens: 0 });
  });

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

  it('rejects timestamps outside the Date range from peers and the disk cache', () => {
    const rows = sanitizeUsageDeviceRows({
      spendDays: [],
      modelRows: [],
      sessionRows: [],
      tasks: [
        { sessionId: 'far', title: 't', model: 'm', lastActiveAt: 1e17 },
        { sessionId: 'ok', title: 't', model: 'm', lastActiveAt: 1_790_000_000_000 },
      ],
    });
    expect(rows?.tasks.map((task) => [task.sessionId, task.lastActiveAt])).toEqual([
      ['far', 0],
      ['ok', 1_790_000_000_000],
    ]);
    expect(isUnixMs(8.64e15)).toBe(true);
    expect(isUnixMs(8.64e15 + 1)).toBe(false);
  });

  it('round-trips optional task sources without dropping legacy tasks or usage', async () => {
    const sourceRows = rowsFor(['2026-09-26']);
    const tasks = ['cindy-make', 'cindy-make-merge', null, undefined].map((source, index) => ({
      sessionId: 'task-' + index,
      title: 'Task ' + index,
      model: 'gpt-5.5',
      providerId: null,
      source,
      contextTokens: 0,
      contextWindow: 0,
      lastActiveAt: 1,
    }));
    const sessionRows = tasks.map((entry) => ({ day: '2026-09-26', sessionId: entry.sessionId, tokens: 5 }));
    const decoded = await decodeUsageDeviceRowsResponse(
      await readUsageDeviceRows(
        {
          getAllSpendDays: async () => sourceRows.spendDays,
          getModelUsageSince: async () => sourceRows.modelRows,
          getSessionUsageSince: async () => ({ rows: sessionRows, tasks }),
          remoteVisibleTaskIds: async (ids) => new Set(ids),
          todayKey: () => '2026-09-26',
        },
        { sinceDay: null },
      ),
    );
    if (decoded?.kind !== 'rows') throw new Error('expected rows');
    expect(decoded.rows.tasks.map((entry) => [entry.sessionId, entry.source])).toEqual([
      ['task-0', 'cindy-make'],
      ['task-1', 'cindy-make-merge'],
      ['task-2', null],
      ['task-3', null],
    ]);
    expect(decoded.rows.sessionRows).toEqual(sessionRows);
    expect(decoded.rows.spendDays).toEqual(sourceRows.spendDays);
    expect(decoded.rows.modelRows).toEqual(sourceRows.modelRows);
  });

  it('drops malformed task sources while retaining task metadata', () => {
    const rows = sanitizeUsageDeviceRows({
      ...rowsFor([]),
      tasks: [
        { sessionId: 'number', source: 1 },
        { sessionId: 'long', source: 'x'.repeat(257) },
      ],
    });
    expect(rows?.tasks.map((entry) => [entry.sessionId, entry.source])).toEqual([
      ['number', null],
      ['long', null],
    ]);
  });

  it('drops a cached peer whose sync time is outside the Date range', async () => {
    const h = harness({
      readCache: async () =>
        JSON.stringify({
          version: 2,
          peers: {
            laptop: {
              name: 'L',
              platform: 'darwin',
              syncedAt: 1e17,
              todayKey: '2026-09-26',
              rows: rowsFor(['2026-09-26']),
            },
          },
        }),
    });
    expect((await createPeerUsageSync(h.deps).snapshot()).peerRows.size).toBe(0);
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

it('preserves auxiliary receipts and the task token split through the cross-device sanitizer', () => {
  const row = { day: '2026-11-17', agentKind: 'auxiliary', source: 'title', providerId: 'saved-provider',
    requestCount: 2, model: 'helper', money: { amount: 0, currency: 'USD', approximate: false, kind: 'actual-cost' },
    inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreateTokens: 0 };
  const parsed = sanitizeUsageDeviceRows({ spendDays: [], modelRows: [row], tasks: [],
    sessionRows: [{ day: '2026-11-17', sessionId: 'task', tokens: 20, auxiliaryTokens: 15 }] });
  expect(parsed?.modelRows).toEqual([row]);
  expect(parsed?.sessionRows[0]).toMatchObject({ tokens: 20, auxiliaryTokens: 15 });
});

describe('incremental task metadata delta sync', () => {
  it('sends only changed and removed tasks on incremental sync, isolates account scopes, and stays compatible with older peers', async () => {
    const taskDeltaCache = createUsageTaskDeltaCache();
    let hostScope = 'user-a';
    const historicalTasks = Array.from({ length: 200 }, (_, index) => ({
      sessionId: `task-${index}`,
      title: `Historical task title number ${index} with realistic summary text`,
      model: 'claude-opus-4-6',
      providerId: 'anthropic',
      source: 'cindy',
      contextTokens: 40_000 + index,
      contextWindow: 200_000,
      lastActiveAt: 1_790_000_000_000 + index,
    }));
    let liveTasks = [...historicalTasks];
    let liveSessionRows = historicalTasks.map((task, index) => ({
      day: index === 0 ? '2026-11-24' : '2026-10-01',
      sessionId: task.sessionId,
      tokens: 1_000 + index,
    }));
    const wireSizes: number[] = [];
    const seenRequests: unknown[] = [];

    const readFromHost = async (rawRequest: unknown) => {
      const parsed = parseUsageDeviceRowsRequest(rawRequest);
      if (!parsed) throw new Error('invalid request');
      const response = await readUsageDeviceRows(
        {
          getAllSpendDays: async () => [{ day: '2026-11-24', monies: [usd(2)] }],
          getModelUsageSince: async (since) =>
            rowsFor(['2026-10-01', '2026-11-24']).modelRows.filter((row) => row.day >= since),
          getSessionUsageSince: async (since) => ({
            rows: liveSessionRows.filter((row) => row.day >= since),
            tasks: liveTasks,
          }),
          remoteVisibleTaskIds: async (ids) => new Set(ids),
          todayKey: () => '2026-11-24',
          taskDeltaCache,
          scopeKey: () => hostScope,
        },
        parsed,
      );
      if ('rowsGz' in response) wireSizes.push(Buffer.byteLength(response.rowsGz, 'utf8'));
      return response;
    };

    const h = harness({
      listDevices: async () => ({ devices: [device({ deviceId: 'studio', name: 'Studio' })] }),
      invoke: async (_id, _channel, args) => {
        seenRequests.push(args[0]);
        return { ok: true as const, result: await readFromHost(args[0]) };
      },
    });
    const sync = createPeerUsageSync(h.deps);

    await sync.sync();
    expect(seenRequests[0]).toEqual({});
    const initialSize = wireSizes[0];
    expect((await sync.snapshot()).peerRows.get('studio')?.tasks).toHaveLength(200);

    // Next 60s tick: 1 active task updated, 1 old task deleted, 1 new task added; 198 historical tasks unchanged.
    liveTasks = [
      { ...historicalTasks[0], title: 'Renamed active task', contextTokens: 95_000 },
      ...historicalTasks.slice(2),
      {
        sessionId: 'task-new',
        title: 'Fresh task',
        model: 'gpt-5.5',
        providerId: 'openai',
        source: 'cindy',
        contextTokens: 1_200,
        contextWindow: 200_000,
        lastActiveAt: 1_790_000_999_000,
      },
    ];
    liveSessionRows = [
      { day: '2026-11-24', sessionId: 'task-0', tokens: 2_500 },
      ...liveSessionRows.slice(1),
      { day: '2026-11-24', sessionId: 'task-new', tokens: 800 },
    ];
    h.advance(61_000);
    await sync.sync();

    expect(seenRequests[1]).toMatchObject({
      sinceDay: '2026-11-23',
      tasksBase: expect.any(String),
    });
    expect(wireSizes[1]).toBeLessThan(initialSize / 4);
    const merged = (await sync.snapshot()).peerRows.get('studio')!;
    expect(merged.tasks).toHaveLength(200);
    expect(merged.tasks.find((t) => t.sessionId === 'task-0')?.title).toBe('Renamed active task');
    expect(merged.tasks.find((t) => t.sessionId === 'task-1')).toBeUndefined();
    expect(merged.sessionRows.find((r) => r.sessionId === 'task-1')).toBeUndefined();
    expect(merged.sessionRows.find((r) => r.sessionId === 'task-199')?.tokens).toBe(1_199);
    expect(merged.tasks.find((t) => t.sessionId === 'task-new')?.title).toBe('Fresh task');

    // Old controller omitting tasksBase still receives full tasks without tasksDelta.
    const legacyDecoded = await decodeUsageDeviceRowsResponse(await readFromHost({ sinceDay: '2026-11-23' }));
    expect(legacyDecoded).toMatchObject({ kind: 'rows' });
    if (legacyDecoded?.kind !== 'rows') throw new Error('expected rows');
    expect(legacyDecoded.tasksDelta).toBeUndefined();
    expect(legacyDecoded.rows.tasks).toHaveLength(200);

    // Cross-account scope boundary: another account presenting user-a's tasksBase never hits user-a's snapshot.
    const userAToken = (seenRequests[1] as { tasksBase: string }).tasksBase;
    hostScope = 'user-b';
    liveTasks = [historicalTasks[5]];
    const crossAccountDecoded = await decodeUsageDeviceRowsResponse(
      await readFromHost({ sinceDay: '2026-11-23', tasksBase: userAToken }),
    );
    if (crossAccountDecoded?.kind !== 'rows') throw new Error('expected rows');
    expect(crossAccountDecoded.tasksDelta).toBeUndefined();
    expect(crossAccountDecoded.rows.tasks.map((t) => t.sessionId)).toEqual(['task-5']);

    // Rotating owner generations evict old scope snapshots completely once maxSnapshots is exceeded.
    const boundedCache = createUsageTaskDeltaCache(3);
    const scopeTokens: string[] = [];
    for (let gen = 0; gen < 5; gen += 1) {
      const encoded = boundedCache.encode(`user-a#gen-${gen}`, null, [historicalTasks[gen]]);
      scopeTokens.push(encoded.tasksToken);
    }
    // Generation 0 and 1 were evicted completely (neither entries nor any secondary per-scope map retains them).
    const evictedGen0 = boundedCache.encode('user-a#gen-0', scopeTokens[0], [historicalTasks[0]]);
    expect(evictedGen0.tasksDelta).toBeUndefined();
    expect(evictedGen0.tasksToken).not.toBe(scopeTokens[0]);
    // Recent generation still in the bounded window reuses its token and returns an empty delta when unchanged.
    const retainedGen4 = boundedCache.encode('user-a#gen-4', scopeTokens[4], [historicalTasks[4]]);
    expect(retainedGen4.tasksToken).toBe(scopeTokens[4]);
    expect(retainedGen4.tasks).toEqual([]);
    expect(retainedGen4.tasksDelta).toEqual({ removedTaskIds: [] });
  });
});
