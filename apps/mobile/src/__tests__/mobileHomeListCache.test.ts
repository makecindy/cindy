import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSession } from '@/session/types';

// 内存版 AsyncStorage:覆盖 getItem/setItem/removeItem,贴近真实 RN API(与 mobileSessionMessageCache.test 同套路)。
const store = vi.hoisted(() => new Map<string, string>());
const USER_ID = 'user-1';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) store.delete(key);
    }),
  },
}));

function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function makeSession(
  id: string,
  deviceId: string,
  overrides: Partial<RemoteSession> & Record<string, unknown> = {},
): RemoteSession {
  return {
    id,
    userId: 'user-1',
    title: `会话 ${id}`,
    workingDir: '/repo/demo',
    workspaceKind: 'project',
    model: 'claude-sonnet',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: isoAt(1),
    updatedAt: isoAt(1),
    deviceLinkDeviceId: deviceId,
    deviceLinkDeviceName: `电脑 ${deviceId}`,
    preview: '上次的回复预览',
    ...overrides,
  } as RemoteSession;
}

describe('mobileHomeListCache', () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a grouped device snapshot from a flat stamped session list', async () => {
    const { cacheHomeListSnapshot, getCachedHomeListSnapshot } = await import('@/session/mobileHomeListCache');

    await cacheHomeListSnapshot(USER_ID, [
      makeSession('s-a1', 'dev-a', { updatedAt: isoAt(3) }),
      makeSession('s-a2', 'dev-a', { updatedAt: isoAt(5) }),
      makeSession('s-b1', 'dev-b', { updatedAt: isoAt(4) }),
    ]);

    const snapshot = await getCachedHomeListSnapshot(USER_ID);
    expect(snapshot.map((d) => d.deviceId)).toEqual(['dev-a', 'dev-b']);
    expect(snapshot[0].deviceName).toBe('电脑 dev-a');
    // 设备内会话按最近活动降序;字段瘦身后仍保留渲染必需的字段。
    expect(snapshot[0].sessions.map((s) => s.id)).toEqual(['s-a2', 's-a1']);
    expect(snapshot[0].sessions[0].title).toBe('会话 s-a2');
    expect(snapshot[0].sessions[0].preview).toBe('上次的回复预览');
    expect(snapshot[0].sessions[0].workingDir).toBe('/repo/demo');
    expect(snapshot[1].sessions.map((s) => s.id)).toEqual(['s-b1']);
  });

  it('returns [] for missing cache, corrupt JSON, or wrong shapes', async () => {
    const { __testing, getCachedHomeListSnapshot } = await import('@/session/mobileHomeListCache');

    await expect(getCachedHomeListSnapshot(USER_ID)).resolves.toEqual([]);

    store.set(__testing.storageKeyForUser(USER_ID), 'not-json{{');
    await expect(getCachedHomeListSnapshot(USER_ID)).resolves.toEqual([]);

    store.set(__testing.storageKeyForUser(USER_ID), JSON.stringify(42));
    await expect(getCachedHomeListSnapshot(USER_ID)).resolves.toEqual([]);

    store.set(__testing.storageKeyForUser(USER_ID), JSON.stringify({ version: 1, devices: 'nope' }));
    await expect(getCachedHomeListSnapshot(USER_ID)).resolves.toEqual([]);

    // devices 数组里混入损坏条目:静默丢弃坏条目,好条目照常返回。
    store.set(__testing.storageKeyForUser(USER_ID), JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      devices: [
        null,
        { deviceId: '', sessions: [makeSession('s-x', 'dev-x')] },
        { deviceId: 'dev-ok', deviceName: 'OK 机', sessions: [makeSession('s-ok', 'dev-ok'), { broken: true }] },
      ],
    }));
    const snapshot = await getCachedHomeListSnapshot(USER_ID);
    expect(snapshot.map((d) => d.deviceId)).toEqual(['dev-ok']);
    expect(snapshot[0].sessions.map((s) => s.id)).toEqual(['s-ok']);
  });

  it('keeps only the whitelisted slim fields and drops live-only / heavy fields', async () => {
    const { cacheHomeListSnapshot, getCachedHomeListSnapshot } = await import('@/session/mobileHomeListCache');

    await cacheHomeListSnapshot(USER_ID, [
      makeSession('s-1', 'dev-a', {
        _count: { messages: 42 },
        sdkSessionId: 'sdk-1',
        extraDirs: ['/a', '/b'],
        providerId: 'anthropic',
        totalTokenUsage: 99999,
        messageSyncToken: { epoch: 'epoch-1', revision: 8 },
        attached: true,
        deviceLinkAttached: true,
        hasDraft: true,
        hasPausedQueue: true,
        pinnedAt: isoAt(2),
        source: 'scheduler',
        orcaRole: 'lead',
        worktreePath: '/repo/demo/.claude/worktrees/x',
      }),
    ]);

    const cached = (await getCachedHomeListSnapshot(USER_ID))[0].sessions[0] as unknown as Record<string, unknown>;
    // 渲染必需字段保留。
    expect(cached.pinnedAt).toBe(isoAt(2));
    expect(cached.source).toBe('scheduler');
    expect(cached.orcaRole).toBe('lead');
    expect(cached.worktreePath).toBe('/repo/demo/.claude/worktrees/x');
    expect(cached.hasDraft).toBe(true);
    expect(cached.hasPausedQueue).toBe(true);
    expect(cached.messageSyncToken).toEqual({ epoch: 'epoch-1', revision: 8 });
    // live-only / 大字段被剥除:缓存的设备不是 live 设备,不缓存在线态;统计字段列表行不消费。
    expect(cached.attached).toBeUndefined();
    expect(cached.deviceLinkAttached).toBeUndefined();
    expect(cached._count).toBeUndefined();
    expect(cached.sdkSessionId).toBeUndefined();
    expect(cached.extraDirs).toBeUndefined();
    expect(cached.providerId).toBeUndefined();
    expect(cached.totalTokenUsage).toBeUndefined();
  });

  it('drops orca worker sessions, deleted sessions and unstamped sessions', async () => {
    const { cacheHomeListSnapshot, getCachedHomeListSnapshot } = await import('@/session/mobileHomeListCache');

    await cacheHomeListSnapshot(USER_ID, [
      makeSession('s-keep', 'dev-a'),
      makeSession('s-worker', 'dev-a', { orcaRole: 'worker' }),
      makeSession('s-deleted', 'dev-a', { status: 'deleted' }),
      makeSession('s-nodev', '', {}),
    ]);

    const snapshot = await getCachedHomeListSnapshot(USER_ID);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].sessions.map((s) => s.id)).toEqual(['s-keep']);
  });

  it('caps sessions per device to the newest MAX_CACHED_HOME_SESSIONS_PER_DEVICE', async () => {
    const { MAX_CACHED_HOME_SESSIONS_PER_DEVICE, cacheHomeListSnapshot, getCachedHomeListSnapshot } =
      await import('@/session/mobileHomeListCache');

    const total = MAX_CACHED_HOME_SESSIONS_PER_DEVICE + 7;
    await cacheHomeListSnapshot(USER_ID, Array.from({ length: total }, (_, index) =>
      makeSession(`s-${index}`, 'dev-a', { updatedAt: isoAt(index), createdAt: isoAt(index) })));

    const snapshot = await getCachedHomeListSnapshot(USER_ID);
    expect(snapshot[0].sessions).toHaveLength(MAX_CACHED_HOME_SESSIONS_PER_DEVICE);
    // 保留最新的 N 条(降序排列,最旧的被裁掉)。
    expect(snapshot[0].sessions[0].id).toBe(`s-${total - 1}`);
    expect(snapshot[0].sessions.some((s) => s.id === 's-0')).toBe(false);
  });

  it('caps devices to the most recently active MAX_CACHED_HOME_DEVICES', async () => {
    const { MAX_CACHED_HOME_DEVICES, cacheHomeListSnapshot, getCachedHomeListSnapshot } =
      await import('@/session/mobileHomeListCache');

    const total = MAX_CACHED_HOME_DEVICES + 3;
    const sessions = Array.from({ length: total }, (_, index) =>
      makeSession(`s-${index}`, `dev-${index}`, { updatedAt: isoAt(index), createdAt: isoAt(index) }));
    await cacheHomeListSnapshot(USER_ID, sessions);

    const snapshot = await getCachedHomeListSnapshot(USER_ID);
    expect(snapshot).toHaveLength(MAX_CACHED_HOME_DEVICES);
    // 按各设备最新活动降序保留,最不活跃的设备被裁掉。
    expect(snapshot[0].deviceId).toBe(`dev-${total - 1}`);
    expect(snapshot.some((d) => d.deviceId === 'dev-0')).toBe(false);
  });

  it('truncates oversized text fields', async () => {
    const { MAX_CACHED_HOME_TEXT_CHARS, cacheHomeListSnapshot, getCachedHomeListSnapshot } =
      await import('@/session/mobileHomeListCache');

    await cacheHomeListSnapshot(USER_ID, [
      makeSession('s-long', 'dev-a', {
        title: 'T'.repeat(MAX_CACHED_HOME_TEXT_CHARS * 3),
        preview: 'P'.repeat(MAX_CACHED_HOME_TEXT_CHARS * 3),
        workingDir: `/repo/${'d'.repeat(MAX_CACHED_HOME_TEXT_CHARS * 3)}`,
      }),
    ]);

    const cached = (await getCachedHomeListSnapshot(USER_ID))[0].sessions[0];
    expect(cached.title).toHaveLength(MAX_CACHED_HOME_TEXT_CHARS);
    expect(cached.preview).toHaveLength(MAX_CACHED_HOME_TEXT_CHARS);
    expect(cached.workingDir).toHaveLength(MAX_CACHED_HOME_TEXT_CHARS);
  });

  it('shrinks per-device session count when the serialized payload exceeds the byte cap', async () => {
    const {
      MAX_CACHED_HOME_DEVICES,
      MAX_CACHED_HOME_LIST_BYTES,
      MAX_CACHED_HOME_SESSIONS_PER_DEVICE,
      MAX_CACHED_HOME_TEXT_CHARS,
      __testing,
      cacheHomeListSnapshot,
      getCachedHomeListSnapshot,
    } = await import('@/session/mobileHomeListCache');

    // 8 台设备 × 100 条会话 × 顶格长文本字段 ≈ 880KB,超过 512KB 上限 → 逐级缩小每设备条数。
    const fat = (index: number, deviceId: string) => makeSession(`s-${deviceId}-${index}`, deviceId, {
      title: 'T'.repeat(MAX_CACHED_HOME_TEXT_CHARS),
      preview: 'P'.repeat(MAX_CACHED_HOME_TEXT_CHARS),
      workingDir: '/'.padEnd(MAX_CACHED_HOME_TEXT_CHARS, 'w'),
      worktreePath: '/'.padEnd(MAX_CACHED_HOME_TEXT_CHARS, 'x'),
      updatedAt: isoAt(index),
      createdAt: isoAt(index),
    });
    const sessions: RemoteSession[] = [];
    for (let d = 0; d < MAX_CACHED_HOME_DEVICES; d += 1) {
      for (let i = 0; i < MAX_CACHED_HOME_SESSIONS_PER_DEVICE; i += 1) sessions.push(fat(i, `dev-${d}`));
    }
    await cacheHomeListSnapshot(USER_ID, sessions);

    const raw = store.get(__testing.storageKeyForUser(USER_ID));
    expect(raw).toBeDefined();
    expect(raw!.length).toBeLessThanOrEqual(MAX_CACHED_HOME_LIST_BYTES);
    const snapshot = await getCachedHomeListSnapshot(USER_ID);
    expect(snapshot).toHaveLength(MAX_CACHED_HOME_DEVICES);
    expect(snapshot[0].sessions.length).toBeLessThan(MAX_CACHED_HOME_SESSIONS_PER_DEVICE);
    expect(snapshot[0].sessions.length).toBeGreaterThan(0);
  });

  it('writing an empty snapshot clears the cache entry', async () => {
    const { cacheHomeListSnapshot, getCachedHomeListSnapshot } = await import('@/session/mobileHomeListCache');

    await cacheHomeListSnapshot(USER_ID, [makeSession('s-1', 'dev-a')]);
    expect(store.size).toBe(1);
    await cacheHomeListSnapshot(USER_ID, []);
    expect(store.size).toBe(0);
    await expect(getCachedHomeListSnapshot(USER_ID)).resolves.toEqual([]);
  });

  it('debounces scheduled persists and writes only the latest snapshot', async () => {
    const { __testing, scheduleHomeListSnapshotPersist } = await import('@/session/mobileHomeListCache');

    vi.useFakeTimers();
    const firstCollect = vi.fn(() => [makeSession('s-old', 'dev-a')]);
    const secondCollect = vi.fn(() => [makeSession('s-new', 'dev-a')]);
    scheduleHomeListSnapshotPersist(USER_ID, firstCollect, 50);
    scheduleHomeListSnapshotPersist(USER_ID, secondCollect, 50);

    await vi.advanceTimersByTimeAsync(40);
    // 去抖窗口内不落盘,较早的 collect 被后来者顶掉、根本不执行。
    expect(store.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstCollect).not.toHaveBeenCalled();
    expect(secondCollect).toHaveBeenCalledTimes(1);
    const raw = store.get(__testing.storageKeyForUser(USER_ID));
    expect(raw).toBeDefined();
    expect(raw!.includes('s-new')).toBe(true);
    expect(raw!.includes('s-old')).toBe(false);
  });

  it('clearCachedHomeListSnapshot removes the entry and cancels pending persists', async () => {
    const { __testing, cacheHomeListSnapshot, clearCachedHomeListSnapshot, scheduleHomeListSnapshotPersist } =
      await import('@/session/mobileHomeListCache');

    await cacheHomeListSnapshot(USER_ID, [makeSession('s-1', 'dev-a')]);
    expect(store.has(__testing.storageKeyForUser(USER_ID))).toBe(true);

    vi.useFakeTimers();
    // 登出场景:先 schedule 回写、再 clear——pending 定时器必须被取消,否则会把上一账号数据写回。
    scheduleHomeListSnapshotPersist(USER_ID, () => [makeSession('s-leak', 'dev-a')], 50);
    await clearCachedHomeListSnapshot();
    await vi.advanceTimersByTimeAsync(120);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.has(__testing.storageKeyForUser(USER_ID))).toBe(false);
  });

  it('scopes the cache per user: another account never reads a previous account snapshot', async () => {
    const { cacheHomeListSnapshot, getCachedHomeListSnapshot } = await import('@/session/mobileHomeListCache');

    // 401 掉线换号场景:user-1 的快照留在盘上(refresh() 失效路径不清缓存),
    // user-2 登录后按自己的 key 读——必须是空,不能闪出 user-1 的设备/会话。
    await cacheHomeListSnapshot(USER_ID, [makeSession('s-private', 'dev-a')]);
    await expect(getCachedHomeListSnapshot('user-2')).resolves.toEqual([]);
    // user-1 自己(同账号重登)仍能命中缓存。
    const own = await getCachedHomeListSnapshot(USER_ID);
    expect(own[0].sessions.map((s) => s.id)).toEqual(['s-private']);
    // userId 缺失(防御性):读空、写 no-op。
    await expect(getCachedHomeListSnapshot('')).resolves.toEqual([]);
    const sizeBefore = store.size;
    await cacheHomeListSnapshot('', [makeSession('s-noop', 'dev-a')]);
    expect(store.size).toBe(sizeBefore);
  });

  it('clears every account key plus the deprecated v1 global key on logout', async () => {
    const { __testing, cacheHomeListSnapshot, clearCachedHomeListSnapshot, getCachedHomeListSnapshot } =
      await import('@/session/mobileHomeListCache');

    await cacheHomeListSnapshot(USER_ID, [makeSession('s-1', 'dev-a')]);
    await cacheHomeListSnapshot('user-2', [makeSession('s-2', 'dev-b')]);
    store.set(__testing.legacyStorageKey, JSON.stringify({ version: 1, devices: [] }));

    await clearCachedHomeListSnapshot();
    expect(store.size).toBe(0);

    // 废弃 v1 key 也会在读路径被顺带清掉(fire-and-forget)。
    store.set(__testing.legacyStorageKey, 'stale');
    await getCachedHomeListSnapshot(USER_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.has(__testing.legacyStorageKey)).toBe(false);
  });

  it('hydrateDeviceSessionsIfEmpty seeds an absent shard and never clobbers fresh data', async () => {
    const { remoteSessionStore } = await import('@/session/remoteSessionStore');
    const { cacheHomeListSnapshot, getCachedHomeListSnapshot } = await import('@/session/mobileHomeListCache');

    remoteSessionStore.clear();
    await cacheHomeListSnapshot(USER_ID, [makeSession('s-cached', 'dev-a', { updatedAt: isoAt(2) })]);
    const snapshot = await getCachedHomeListSnapshot(USER_ID);

    // 冷启动:store 为空,缓存种入并被重新 stamp;种入行打 cacheSeeded 标——瘦身/截断
    // 字段不能作为发送参数,会话页据此在 fresh 元数据到达前禁发(codex review R15)。
    remoteSessionStore.hydrateDeviceSessionsIfEmpty('dev-a', '电脑 dev-a', snapshot[0].sessions);
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s-cached']);
    expect(remoteSessionStore.getSessions()[0].deviceLinkDeviceId).toBe('dev-a');
    expect(remoteSessionStore.getSessions()[0].cacheSeeded).toBe(true);

    // fresh 数据先到时:shard 已存在,缓存种入必须是 no-op(if-absent 不变量)。
    remoteSessionStore.clear();
    remoteSessionStore.setDeviceSessions('dev-a', '电脑 dev-a', [makeSession('s-fresh', 'dev-a')]);
    remoteSessionStore.hydrateDeviceSessionsIfEmpty('dev-a', '电脑 dev-a', snapshot[0].sessions);
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s-fresh']);

    // fresh 数据后到时:setDeviceSessions 正常对账覆盖缓存快照,cacheSeeded 随旧对象消失。
    remoteSessionStore.clear();
    remoteSessionStore.hydrateDeviceSessionsIfEmpty('dev-a', '电脑 dev-a', snapshot[0].sessions);
    remoteSessionStore.setDeviceSessions('dev-a', '电脑 dev-a', [makeSession('s-fresh-2', 'dev-a')]);
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s-fresh-2']);
    expect(remoteSessionStore.getSessions()[0].cacheSeeded).toBeUndefined();
    remoteSessionStore.clear();
  });
});

describe('utf8ByteLength', () => {
  it('按 UTF-8 编码宽度计字节:ASCII=1、中文=3、emoji(代理对)=4', async () => {
    const { utf8ByteLength } = await import('@/session/mobileHomeListCache');
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('会话')).toBe(6);
    expect(utf8ByteLength('\u00e9')).toBe(2); // e 上加重音
    expect(utf8ByteLength('\ud83d\ude00')).toBe(4); // emoji surrogate pair
    expect(utf8ByteLength('')).toBe(0);
  });
});
