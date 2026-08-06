import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 副窗口(「在新窗口打开」)与主窗共享同源 localStorage;store 依赖该判定决定
// 是否触碰共享持久化。用可变开关模拟两种窗口环境。
let secondaryWindow = false;
vi.mock('@/lib/secondaryWindow', () => ({
  isSecondaryWindow: () => secondaryWindow,
}));

const storageData = new Map<string, string>();

const storage: Storage = {
  get length() {
    return storageData.size;
  },
  clear: vi.fn(() => storageData.clear()),
  getItem: vi.fn((key: string) => storageData.get(key) ?? null),
  key: vi.fn((index: number) => [...storageData.keys()][index] ?? null),
  removeItem: vi.fn((key: string) => storageData.delete(key)),
  setItem: vi.fn((key: string, value: string) => storageData.set(key, value)),
};

async function loadStore() {
  return import('../splitGroupStore');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  storageData.clear();
  secondaryWindow = false;
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('splitGroupStore', () => {
  it('默认未激活且不写持久化', async () => {
    const { splitGroupStore, SPLIT_GROUP_STORAGE_KEY } = await loadStore();

    expect(splitGroupStore.getSnapshot()).toEqual({ root: null });
    expect(splitGroupStore.isActive()).toBe(false);
    expect(storageData.has(SPLIT_GROUP_STORAGE_KEY)).toBe(false);
  });

  it('首次拖入按落点建立左右或上下分屏并持久化', async () => {
    const { getSplitSessionIds, splitGroupStore, SPLIT_GROUP_STORAGE_KEY } = await loadStore();
    const listener = vi.fn();
    const unsubscribe = splitGroupStore.subscribe(listener);

    splitGroupStore.addSession('session-b', 'session-a', 'left');

    const snapshot = splitGroupStore.getSnapshot();
    expect(snapshot.root).toMatchObject({
      type: 'split',
      direction: 'row',
      fraction: 0.5,
      first: { type: 'pane', sessionId: 'session-b' },
      second: { type: 'pane', sessionId: 'session-a' },
    });
    expect(getSplitSessionIds(snapshot.root)).toEqual(['session-b', 'session-a']);
    expect(splitGroupStore.isActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storageData.get(SPLIT_GROUP_STORAGE_KEY) ?? '{}')).toMatchObject(snapshot);

    unsubscribe();
  });

  it('只拆目标 pane，支持左一右二', async () => {
    const { splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    splitGroupStore.addSession('session-c', 'session-b', 'bottom');

    expect(splitGroupStore.getSnapshot().root).toMatchObject({
      type: 'split',
      direction: 'row',
      first: { type: 'pane', sessionId: 'session-a' },
      second: {
        type: 'split',
        direction: 'column',
        first: { type: 'pane', sessionId: 'session-b' },
        second: { type: 'pane', sessionId: 'session-c' },
      },
    });
  });

  it('继续拆左侧后支持左二右二', async () => {
    const { getSplitSessionIds, splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    splitGroupStore.addSession('session-d', 'session-a', 'bottom');

    const root = splitGroupStore.getSnapshot().root;
    expect(root).toMatchObject({
      type: 'split',
      direction: 'row',
      first: {
        type: 'split',
        direction: 'column',
        first: { type: 'pane', sessionId: 'session-a' },
        second: { type: 'pane', sessionId: 'session-d' },
      },
      second: {
        type: 'split',
        direction: 'column',
        first: { type: 'pane', sessionId: 'session-b' },
        second: { type: 'pane', sessionId: 'session-c' },
      },
    });
    expect(getSplitSessionIds(root)).toEqual(['session-a', 'session-d', 'session-b', 'session-c']);
  });

  it('重复任务、非法 anchor 与上限不会修改状态', async () => {
    const { getSplitPanes, MAX_SPLIT_PANES, splitGroupStore } = await loadStore();
    expect(splitGroupStore.addSession('session-b', 'session-a', 'right')).toBe(true);
    const initial = splitGroupStore.getSnapshot();

    expect(splitGroupStore.addSession('session-b', 'session-a', 'left')).toBe(false);
    expect(splitGroupStore.addSession('session-c', 'missing', 'right')).toBe(false);
    expect(splitGroupStore.getAddBlockReason('session-b', 'session-a')).toBe('duplicate');
    expect(splitGroupStore.getAddBlockReason('session-c', 'missing')).toBe('missing-anchor');
    expect(splitGroupStore.getSnapshot()).toBe(initial);

    for (let index = 3; index <= MAX_SPLIT_PANES; index += 1) {
      expect(splitGroupStore.addSession(`session-${index}`, 'session-b', 'bottom')).toBe(true);
    }
    expect(getSplitPanes(splitGroupStore.getSnapshot().root)).toHaveLength(MAX_SPLIT_PANES);
    const atLimit = splitGroupStore.getSnapshot();
    expect(splitGroupStore.getAddBlockReason('session-over-limit', 'session-b')).toBe(
      'limit-reached',
    );
    expect(splitGroupStore.addSession('session-over-limit', 'session-b', 'right')).toBe(false);
    expect(splitGroupStore.getSnapshot()).toBe(atLimit);
  });

  it('移除 pane 时递归塌缩单子节点，剩单格时退出分屏', async () => {
    const { splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    splitGroupStore.addSession('session-c', 'session-b', 'bottom');

    splitGroupStore.removeSession('session-c');
    expect(splitGroupStore.getSnapshot().root).toMatchObject({
      type: 'split',
      direction: 'row',
      first: { sessionId: 'session-a' },
      second: { sessionId: 'session-b' },
    });

    splitGroupStore.removeSession('session-b');
    expect(splitGroupStore.getSnapshot()).toEqual({ root: null });
  });

  it('替换 session 保留 pane key 和树位置', async () => {
    const { getSplitPanes, splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    const before = getSplitPanes(splitGroupStore.getSnapshot().root);

    splitGroupStore.replaceSession('session-a', 'session-c');

    const after = getSplitPanes(splitGroupStore.getSnapshot().root);
    expect(after.map((pane) => pane.sessionId)).toEqual(['session-c', 'session-b']);
    expect(after[0].key).toBe(before[0].key);
  });

  it('分支比例夹到下限，并仅切换根方向', async () => {
    const { MIN_SPLIT_CHILD_FRACTION, splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    const root = splitGroupStore.getSnapshot().root;
    expect(root?.type).toBe('split');
    if (!root || root.type !== 'split') throw new Error('root split missing');
    const nested = root.second;
    expect(nested.type).toBe('split');
    if (nested.type !== 'split') throw new Error('nested split missing');

    splitGroupStore.setSplitFraction(nested.key, 1);
    splitGroupStore.toggleRootDirection();

    const next = splitGroupStore.getSnapshot().root;
    expect(next).toMatchObject({
      type: 'split',
      direction: 'column',
      second: {
        type: 'split',
        direction: 'column',
        fraction: 1 - MIN_SPLIT_CHILD_FRACTION,
      },
    });
  });

  it('v1 平铺存档自动迁移为同方向递归树并删除旧 key', async () => {
    storageData.set(
      'cc-agent.splitGroup.v1',
      JSON.stringify({
        direction: 'column',
        panes: [
          { key: 'one', sessionId: 'session-a', fraction: 0.25 },
          { key: 'two', sessionId: 'session-b', fraction: 0.25 },
          { key: 'three', sessionId: 'session-c', fraction: 0.5 },
        ],
      }),
    );

    const {
      getSplitSessionIds,
      LEGACY_SPLIT_GROUP_STORAGE_KEY,
      SPLIT_GROUP_STORAGE_KEY,
      splitGroupStore,
    } = await loadStore();
    const snapshot = splitGroupStore.getSnapshot();

    expect(getSplitSessionIds(snapshot.root)).toEqual(['session-a', 'session-b', 'session-c']);
    expect(snapshot.root).toMatchObject({
      type: 'split',
      direction: 'column',
      fraction: 0.25,
      second: { type: 'split', direction: 'column' },
    });
    expect(storageData.has(LEGACY_SPLIT_GROUP_STORAGE_KEY)).toBe(false);
    expect(JSON.parse(storageData.get(SPLIT_GROUP_STORAGE_KEY) ?? '{}')).toEqual(snapshot);
  });

  it('副窗口不读取主窗持久化的分屏布局', async () => {
    storageData.set(
      'cc-agent.splitGroup.v2',
      JSON.stringify({
        root: {
          type: 'split',
          key: 'split-main',
          direction: 'row',
          fraction: 0.5,
          first: { type: 'pane', key: 'pane-a', sessionId: 'session-a' },
          second: { type: 'pane', key: 'pane-b', sessionId: 'session-b' },
        },
      }),
    );
    secondaryWindow = true;

    const { splitGroupStore } = await loadStore();

    expect(splitGroupStore.getSnapshot()).toEqual({ root: null });
    expect(splitGroupStore.isActive()).toBe(false);
  });

  it('副窗口分屏仅存内存，不覆盖主窗共享存储', async () => {
    const mainWindowLayout = JSON.stringify({
      root: {
        type: 'split',
        key: 'split-main',
        direction: 'row',
        fraction: 0.5,
        first: { type: 'pane', key: 'pane-a', sessionId: 'session-a' },
        second: { type: 'pane', key: 'pane-b', sessionId: 'session-b' },
      },
    });
    storageData.set('cc-agent.splitGroup.v2', mainWindowLayout);
    secondaryWindow = true;

    const { getSplitSessionIds, SPLIT_GROUP_STORAGE_KEY, splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-d', 'session-c', 'right');
    expect(getSplitSessionIds(splitGroupStore.getSnapshot().root)).toEqual([
      'session-c',
      'session-d',
    ]);

    splitGroupStore.clear();
    expect(splitGroupStore.getSnapshot()).toEqual({ root: null });
    expect(storageData.get(SPLIT_GROUP_STORAGE_KEY)).toBe(mainWindowLayout);
  });

  it('损坏存档与 localStorage 异常均静默退化为空状态', async () => {
    storageData.set('cc-agent.splitGroup.v2', '{broken');
    let module = await loadStore();
    expect(module.splitGroupStore.getSnapshot()).toEqual({ root: null });

    vi.resetModules();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      removeItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: () => {
        throw new Error('storage unavailable');
      },
    });
    module = await loadStore();
    expect(() =>
      module.splitGroupStore.addSession('session-b', 'session-a', 'right'),
    ).not.toThrow();
    expect(module.getSplitPanes(module.splitGroupStore.getSnapshot().root)).toHaveLength(2);
  });
});
