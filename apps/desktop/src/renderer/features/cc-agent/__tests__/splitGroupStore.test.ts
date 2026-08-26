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

  it('移动 pane 时从原位置摘出并插入目标方向，同时保留 pane key', async () => {
    const { getSplitPanes, getSplitSessionIds, splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    const before = getSplitPanes(splitGroupStore.getSnapshot().root);
    const sourceKey = before.find((pane) => pane.sessionId === 'session-c')?.key;

    expect(splitGroupStore.moveSession('session-c', 'session-a', 'left')).toBe(true);
    const next = splitGroupStore.getSnapshot().root;
    expect(getSplitSessionIds(next)).toEqual(['session-c', 'session-a', 'session-b']);
    expect(getSplitPanes(next).find((pane) => pane.sessionId === 'session-c')?.key).toBe(sourceKey);
    expect(next).toMatchObject({
      type: 'split',
      direction: 'row',
      first: {
        type: 'split',
        first: { type: 'pane', sessionId: 'session-c' },
        second: { type: 'pane', sessionId: 'session-a' },
      },
      second: { type: 'pane', sessionId: 'session-b' },
    });
  });

  it('移动嵌套 pane 后会塌缩原分支，并可再次按上下方向插入', async () => {
    const { getSplitPanes, getSplitSessionIds, splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    splitGroupStore.addSession('session-c', 'session-b', 'bottom');

    expect(splitGroupStore.moveSession('session-b', 'session-a', 'bottom')).toBe(true);
    const next = splitGroupStore.getSnapshot().root;
    expect(getSplitSessionIds(next)).toEqual(['session-a', 'session-b', 'session-c']);
    expect(getSplitPanes(next)).toHaveLength(3);
    expect(next).toMatchObject({
      type: 'split',
      direction: 'row',
      first: {
        type: 'split',
        direction: 'column',
        first: { type: 'pane', sessionId: 'session-a' },
        second: { type: 'pane', sessionId: 'session-b' },
      },
      second: { type: 'pane', sessionId: 'session-c' },
    });
  });

  it('非法来源、目标或拖到自身时不改变布局', async () => {
    const { splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    const initial = splitGroupStore.getSnapshot();

    expect(splitGroupStore.moveSession('missing', 'session-a', 'left')).toBe(false);
    expect(splitGroupStore.moveSession('session-a', 'missing', 'left')).toBe(false);
    expect(splitGroupStore.moveSession('session-a', 'session-a', 'left')).toBe(false);
    expect(splitGroupStore.getSnapshot()).toBe(initial);
  });

  it.each(['left', 'right', 'top', 'bottom'] as const)(
    'pane 已位于目标 %s 侧时保持原比例和布局引用',
    async (side) => {
      const { splitGroupStore } = await loadStore();
      splitGroupStore.addSession('session-b', 'session-a', side);
      const root = splitGroupStore.getSnapshot().root;
      if (!root || root.type !== 'split') throw new Error('root split missing');
      splitGroupStore.setSplitFraction(root.key, 0.7);
      const before = splitGroupStore.getSnapshot();

      expect(splitGroupStore.moveSession('session-b', 'session-a', side)).toBe(false);
      expect(splitGroupStore.getSnapshot()).toBe(before);
      expect(splitGroupStore.getSnapshot().root).toMatchObject({ fraction: 0.7 });
    },
  );

  it.each(['left', 'right', 'top', 'bottom'] as const)(
    '同方向嵌套的边缘 pane 已位于目标 %s 侧时保持原比例和布局引用',
    async (side) => {
      const { splitGroupStore } = await loadStore();
      splitGroupStore.addSession('session-b', 'session-a', side);
      splitGroupStore.addSession('session-c', 'session-b', side);

      const root = splitGroupStore.getSnapshot().root;
      if (!root || root.type !== 'split') throw new Error('root split missing');
      const nested = side === 'left' || side === 'top' ? root.first : root.second;
      if (nested.type !== 'split') throw new Error('nested split missing');

      splitGroupStore.setSplitFraction(root.key, 0.7);
      splitGroupStore.setSplitFraction(nested.key, 0.6);
      const before = splitGroupStore.getSnapshot();

      expect(splitGroupStore.moveSession('session-b', 'session-a', side)).toBe(false);
      expect(splitGroupStore.getSnapshot()).toBe(before);
      const next = splitGroupStore.getSnapshot().root;
      if (!next || next.type !== 'split') throw new Error('root split missing');
      expect(next).toMatchObject({ fraction: 0.7 });
      expect(side === 'left' || side === 'top' ? next.first : next.second).toMatchObject({
        type: 'split',
        fraction: 0.6,
      });

      const beforeNonAdjacentMove = splitGroupStore.getSnapshot();
      expect(splitGroupStore.moveSession('session-c', 'session-a', side)).toBe(true);
      expect(splitGroupStore.getSnapshot()).not.toBe(beforeNonAdjacentMove);
    },
  );

  it('仅部分边缘重合时仍按落点重排 pane', async () => {
    const { splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-b', 'session-a', 'right');
    splitGroupStore.addSession('session-c', 'session-b', 'bottom');
    const before = splitGroupStore.getSnapshot();

    expect(splitGroupStore.moveSession('session-b', 'session-a', 'right')).toBe(true);
    expect(splitGroupStore.getSnapshot()).not.toBe(before);
  });

  it('跨正交分支的比例投影被最小尺寸改变时仍按落点重排 pane', async () => {
    const { splitGroupStore } = await loadStore();
    splitGroupStore.addSession('session-c', 'session-a', 'right');
    splitGroupStore.addSession('session-b', 'session-a', 'bottom');
    splitGroupStore.addSession('session-d', 'session-c', 'bottom');
    splitGroupStore.addSession('session-e', 'session-d', 'bottom');
    const before = splitGroupStore.getSnapshot();

    expect(splitGroupStore.moveSession('session-a', 'session-c', 'left')).toBe(true);
    expect(splitGroupStore.getSnapshot()).not.toBe(before);
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
