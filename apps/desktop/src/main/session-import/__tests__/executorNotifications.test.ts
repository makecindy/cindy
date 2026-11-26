/**
 * 测试价值
 * - 生产入口与可观察结果：startImport / cancelImport；真实 sessions:created 协议在任务可见后通知本机和设备互联。
 * - Bug：PR #9997 discussion_r4541187195，未打开设置页时引导导入完成却不刷新列表。
 * - 覆盖缺口：适配器测试只读来源，设置页测试只验证扫描；均未运行批次收尾与真实广播出口。
 * - 最小输入：内存来源的一条消息，控制读取暂停以覆盖取消、失败和换号；不挂载任何页面。
 * - tier：unit，I/O 和数据库端口用内存 fake；执行器与通知出口真实运行。独立文件隔离主进程生命周期。
 * - 实测耗时：见 PR 描述。
 */
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImportJobView, NormalizedMessage, SourceSession } from '../types';
import { cancelImport, onImportProgress, startImport } from '../executor';
import { createSessionImportRemoteProvider } from '../remoteResource';

const h = vi.hoisted(() => ({
  owner: 'owner-a',
  epoch: 1,
  sources: new Map<string, SourceSession>(),
  visible: new Set<string>(),
  visibleAtNotification: [] as Array<{ sessionId: string; visible: string[] }>,
  send: vi.fn(),
  tap: vi.fn(),
  read: vi.fn<(source: SourceSession) => AsyncIterable<NormalizedMessage>>(),
  settled: () => {},
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.send } }] } }));
vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn() }, promises: { stat: async () => null } }));
vi.mock('../../utils/atomicWriteFile.js', () => ({ atomicWriteFileSync: vi.fn(), readAtomicFileSync: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: h.owner, ownerGeneration: h.epoch }),
  ownerScopedUserDataPath: () => 'unused-memory-receipts',
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => ({ clientEpoch: h.epoch, userId: h.owner }),
  getDbClient: () => ({ queryOne: async () => null }),
}));
vi.mock('../../device-link/broadcast-tap', () => ({ tapWindowBroadcast: h.tap }));
vi.mock('../../localDb/provisionalSessions', () => ({ isProvisionalSession: () => false }));
vi.mock('../../git-context/prRefsStore.js', () => ({ recordPrRefsForImportedMessages: async () => {} }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({
  warn: vi.fn(),
  info: (message: string) => {
    // 账号变化没有终态进度；日志端口只用于等待 detached runJob 确实退出，不参与协议断言。
    if (message === 'session import job finished' || message === 'session import paused by account change') h.settled();
  },
}) }));
vi.mock('../../maker-host/model-route-guard-live.js', () => ({
  resolveDefaultScheduleRoute: async () => null,
  resolveNewTaskDefaultModelRoute: async () => null,
}));
vi.mock('../../maker-host/newMakerDefaultsCache.js', () => ({
  getSelectedNewMakerRoute: () => null,
  getRemoteNewMakerDefaults: () => ({}),
  getNewMakerModelTuning: () => ({}),
}));
vi.mock('../scan.js', () => ({
  resolveSourceSessions: async () => new Map(h.sources),
  invalidateImportScan: vi.fn(),
  scanImportSources: async () => ({
    candidates: [...h.sources].map(([key, source]) => ({
      ...source, key, groupKey: 'dialogue', groupName: '', hidden: null, missingDir: false,
    })),
    hiddenCounts: { cindy: 0, temp: 0, internal: 0, imported: 0 },
  }),
}));
vi.mock('../sources/index.js', () => ({ adapterFor: () => ({ label: 'Example', read: h.read }) }));
vi.mock('../handoff.js', () => ({ buildImportHandoffMarker: async () => undefined }));
vi.mock('../writer.js', () => ({
  runImportTx: async (args: { action: string; sessionId?: string; unhide?: boolean }) => {
    if (args.action === 'commit' && args.unhide && args.sessionId) h.visible.add(args.sessionId);
  },
  writeImportCards: async () => {},
  createMessageSink: () => ({
    written: 0, firstCreatedAt: 1, lastCreatedAt: 1,
    async push() { this.written++; },
    async flush() {},
  }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function source(id: string, project = false, sourceId: SourceSession['source'] = 'cursor'): string {
  const key = `${sourceId}:${id}`;
  h.sources.set(key, {
    source: sourceId, sourceSessionId: id, title: id, cwd: project ? path.resolve('missing-project') : null,
    dialogue: !project, createdAt: 1, updatedAt: 2, archived: false, sizeBytes: 10, locator: id,
  });
  return key;
}

beforeEach(() => {
  h.owner = 'owner-a'; h.epoch++;
  h.sources.clear(); h.visible.clear();
  h.visibleAtNotification.length = 0;
  h.send.mockReset(); h.tap.mockReset();
  h.read.mockReset().mockImplementation(async function* () {
    yield { key: 'one', role: 'user', content: 'hello', createdAt: 1 };
  });
  // 广播时所有成功项必须已提交可见，不能在 start() 受理时抢先通知。
  h.send.mockImplementation((channel: string, payload: { sessionId: string }) => {
    if (channel === 'local-db:sessions:created') h.visibleAtNotification.push({ sessionId: payload.sessionId, visible: [...h.visible] });
  });
});

function notifications() {
  return h.send.mock.calls.filter(([channel]) => channel === 'local-db:sessions:created');
}

describe('import completion notifications without an import page', () => {
  // Older controllers index source marks by a closed list. The production
  // resource must hide unknown rows in both scan and jobs while preserving other sources.
  it('shows and imports Antigravity on a capable controller without exposing its rows to old controllers', async () => {
    const done = deferred(); h.settled = done.resolve;
    const cursorKey = source('cursor-history');
    const antigravityKey = source('antigravity-history', false, 'antigravity');
    const provider = createSessionImportRemoteProvider();
    const context = { controllerDeviceId: 'phone' };
    const oldClient = { protocolVersion: 1, primitives: ['session-import'] };
    const newClient = { protocolVersion: 1, primitives: ['session-import', 'session-import-antigravity'] };
    const collectionId = 'session-import';
    const get = async (id: string, client: typeof oldClient) => {
      const resource = await provider.get!(context, { client, ref: { collectionId, kind: 'import', id } });
      return resource.blocks?.[0]?.data;
    };

    expect(await get('scan', oldClient)).toMatchObject({ total: 1, candidates: [{ key: cursorKey }] });
    expect(await get('scan', newClient)).toMatchObject({ total: 2, candidates: expect.arrayContaining([expect.objectContaining({ key: antigravityKey, source: 'antigravity' })]) });
    const response = await provider.invoke!(context, { client: newClient, collectionId, actionId: 'import', input: { keys: [antigravityKey] } });
    const { requestId } = response.result as { requestId: string };
    await done.promise;

    expect(await get(`job:${requestId}`, newClient)).toMatchObject({
      items: [{ key: antigravityKey, status: 'ready', mode: 'handoff', sessionId: expect.any(String) }],
    });
    expect(await get('job:latest', oldClient)).toMatchObject({ status: 'missing', items: [] });
  });

  it('notifies once after a batch with ready and missing-directory tasks becomes visible', async () => {
    const done = deferred(); h.settled = done.resolve;
    const job = await startImport([source('ready'), source('needs-folder', true)]);
    await done.promise;
    expect(job.items.map((item) => item.status)).toEqual(['ready', 'action']);
    expect(h.visible.size).toBe(2);
    expect(notifications()).toHaveLength(1);
    expect(h.visibleAtNotification).toEqual([{ sessionId: notifications()[0]![1].sessionId, visible: [...h.visible] }]);
    expect(h.visible.has(h.visibleAtNotification[0]!.sessionId)).toBe(true);
    expect(h.tap.mock.calls).toEqual(notifications());
  });

  it('still notifies for successful tasks when the rest of the batch is cancelled', async () => {
    const reading = deferred(); const release = deferred(); const ready = deferred(); const done = deferred();
    h.settled = done.resolve;
    const good = source('kept'); const slow = source('cancelled');
    h.read.mockImplementation(async function* (item) {
      if (item.sourceSessionId === 'cancelled') { reading.resolve(); await release.promise; }
      yield { key: 'one', role: 'user', content: 'hello', createdAt: 1 };
    });
    const off = onImportProgress((view) => { if (view.items.some((item) => item.status === 'ready')) ready.resolve(); });
    try {
      const job = await startImport([good, slow]);
      await Promise.all([reading.promise, ready.promise]);
      expect(notifications()).toHaveLength(0);
      cancelImport(job.requestId); release.resolve();
      await done.promise;
      expect(job.status).toBe('cancelled');
      expect(h.visible.size).toBe(1);
      expect(notifications()).toHaveLength(1);
      expect(h.tap.mock.calls).toEqual(notifications());
    } finally { off(); release.resolve(); }
  });

  it.each([false, true])('notifies only if a task became visible when another source fails (success=%s)', async (success) => {
    const done = deferred(); h.settled = done.resolve;
    h.read.mockImplementation(async function* (item) {
      if (item.sourceSessionId === 'broken') throw new Error('unreadable source');
      yield { key: 'one', role: 'user', content: 'hello', createdAt: 1 };
    });
    const keys = [source('broken')];
    if (success) keys.push(source('valid'));
    await startImport(keys); await done.promise;
    expect(notifications()).toHaveLength(success ? 1 : 0);
    expect(h.tap.mock.calls).toEqual(notifications());
  });

  it('does not send the previous account completion to a new account', async () => {
    const done = deferred(); h.settled = done.resolve;
    const off = onImportProgress((view: ImportJobView) => {
      if (view.items.some((item) => item.status === 'ready')) { h.owner = 'owner-b'; h.epoch++; }
    });
    try {
      await startImport([source('previous-owner')]); await done.promise;
      expect(h.visible.size).toBe(1);
      expect(notifications()).toHaveLength(0);
      expect(h.tap).not.toHaveBeenCalled();
    } finally { off(); }
  });
});
