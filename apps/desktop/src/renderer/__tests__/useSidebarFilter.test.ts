/**
 * useSidebarFilter — vitest unit tests (F-PJ-10 V0.5.1)
 * ---------------------------------------------------------------------------
 * vitest 在 node 环境下运行（apps/desktop/vitest.config.ts environment: 'node'），
 * 项目未引入 jsdom / @testing-library/react，因此本测试覆盖 hook 的"纯函数核心"
 * （helpers/sidebarFilterCore.ts），策略与 projectGrouping.test.ts 一致。
 *
 * 测试矩阵：
 *   1. loadStatus / loadProjects / loadGroupBy / loadLastActivity / loadSortBy 默认 + 持久化 + 异常容错
 *   2. nextProjectsAfterToggle 五条路径（'all' → [wd]、加新、取消其一、0 选回退、未变化）
 *   3. gcProjectsAgainstActive：'all' 直返、无变化、剔除后空回退、保留剩余
 *   4. persist 往返：status / projects / groupBy / lastActivity / sortBy
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  STATUS_KEY,
  PROJECTS_KEY,
  GROUP_BY_KEY,
  LAST_ACTIVITY_KEY,
  SORT_BY_KEY,
  TASK_INFO_KEY,
  MANUAL_PROJECT_ORDER_KEY,
  DIALOGUE_GROUP_COLLAPSED_KEY,
  DIALOGUE_GROUP_ALL_KEY,
  loadStatus,
  loadProjects,
  loadGroupBy,
  loadLastActivity,
  loadSortBy,
  loadTaskInfoFields,
  loadManualProjectOrder,
  loadDialogueGroupCollapsedKeys,
  persistDialogueGroupCollapsedKeys,
  persistStatus,
  persistProjects,
  persistGroupBy,
  persistLastActivity,
  persistSortBy,
  persistTaskInfoFields,
  nextTaskInfoAfterToggle,
  persistManualProjectOrder,
  DIALOGUE_FILTER_KEY,
  nextProjectsAfterToggle,
  nextSortByAfterGroupByChange,
  includeProjectInFilter,
  removeProjectsFromFilter,
  gcProjectsAgainstActive,
  normalizeManualProjectOrder,
  moveManualProjectOrder,
  normalizeManualPinnedOrder,
  mergeVisibleReorder,
  type FilterProjects,
} from '@/features/cc-agent/hooks/helpers/sidebarFilterCore';
import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';

const OWNER_ID = 'owner-a';

function ownerKey(baseKey: string): string {
  return sidebarOwnerStorageKey(baseKey, OWNER_ID);
}

/* ------------ in-memory localStorage shim ------------ */

interface MemStorage {
  store: Map<string, string>;
}

function installMemoryLocalStorage(): MemStorage {
  const mem: MemStorage = { store: new Map() };
  const fakeStorage: Storage = {
    get length() {
      return mem.store.size;
    },
    clear() {
      mem.store.clear();
    },
    getItem(key: string) {
      return mem.store.has(key) ? (mem.store.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      mem.store.set(key, String(value));
    },
    removeItem(key: string) {
      mem.store.delete(key);
    },
    key(idx: number) {
      return Array.from(mem.store.keys())[idx] ?? null;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = fakeStorage;
  return mem;
}

function uninstallLocalStorage(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).localStorage;
}

/* ============================== load* ============================== */

describe('loadStatus', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it("defaults to 'active' when storage is empty", () => {
    expect(loadStatus()).toBe('active');
  });

  it("returns 'archived' / 'all' when persisted", () => {
    localStorage.setItem(STATUS_KEY, 'archived');
    expect(loadStatus()).toBe('archived');
    localStorage.setItem(STATUS_KEY, 'all');
    expect(loadStatus()).toBe('all');
  });

  it("falls back to 'active' on illegal value", () => {
    localStorage.setItem(STATUS_KEY, 'bogus');
    expect(loadStatus()).toBe('active');
  });

  it("returns 'active' when localStorage is unavailable", () => {
    uninstallLocalStorage();
    expect(loadStatus()).toBe('active');
  });
});

describe('loadProjects', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it("defaults to 'all' when storage is empty", () => {
    expect(loadProjects(OWNER_ID)).toBe('all');
  });

  it("returns 'all' when persisted as the literal 'all'", () => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify('all'));
    expect(loadProjects(OWNER_ID)).toBe('all');
  });

  it('returns the persisted array', () => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(['/a/b', '/c/d']));
    expect(loadProjects(OWNER_ID)).toEqual(['local:/a/b', 'local:/c/d']);
  });

  it("falls back to 'all' on empty array", () => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify([]));
    expect(loadProjects(OWNER_ID)).toBe('all');
  });

  it('preserves the dialogue sentinel in persisted project filters', () => {
    persistProjects([DIALOGUE_FILTER_KEY, '/a/b'], OWNER_ID);
    expect(loadProjects(OWNER_ID)).toEqual([DIALOGUE_FILTER_KEY, 'local:/a/b']);
  });

  it('cleans non-string entries from a mixed array', () => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(['/a/b', 42, null, '/c/d', '']));
    expect(loadProjects(OWNER_ID)).toEqual(['local:/a/b', 'local:/c/d']);
  });

  it("falls back to 'all' on broken JSON", () => {
    localStorage.setItem(PROJECTS_KEY, '{not-json');
    expect(loadProjects(OWNER_ID)).toBe('all');
  });

  it("falls back to 'all' on shape mismatch (object instead of array)", () => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify({ foo: 'bar' }));
    expect(loadProjects(OWNER_ID)).toBe('all');
  });

  it("returns 'all' when localStorage is unavailable", () => {
    uninstallLocalStorage();
    expect(loadProjects(OWNER_ID)).toBe('all');
  });
});

describe('loadGroupBy', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it("defaults to 'project' when storage is empty", () => {
    expect(loadGroupBy()).toBe('project');
  });

  it("returns 'flat' / 'project' when persisted", () => {
    localStorage.setItem(GROUP_BY_KEY, 'flat');
    expect(loadGroupBy()).toBe('flat');
    localStorage.setItem(GROUP_BY_KEY, 'project');
    expect(loadGroupBy()).toBe('project');
  });

  it("falls back to 'project' on illegal value", () => {
    localStorage.setItem(GROUP_BY_KEY, 'environment');
    expect(loadGroupBy()).toBe('project');
  });

  it("returns 'project' when localStorage is unavailable", () => {
    uninstallLocalStorage();
    expect(loadGroupBy()).toBe('project');
  });

  // 侧边栏重设计 D 期:按日期分组已删除;老用户存量 'date' 静默回退默认。
  it("falls back to 'project' on the removed 'date' legacy value", () => {
    localStorage.setItem(GROUP_BY_KEY, 'date');
    expect(loadGroupBy()).toBe('project');
  });
});

describe('loadLastActivity', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it("defaults to 'all' when storage is empty", () => {
    expect(loadLastActivity()).toBe('all');
  });

  it('returns persisted activity ranges', () => {
    localStorage.setItem(LAST_ACTIVITY_KEY, '1d');
    expect(loadLastActivity()).toBe('1d');
    localStorage.setItem(LAST_ACTIVITY_KEY, '30d');
    expect(loadLastActivity()).toBe('30d');
  });

  it("falls back to 'all' on illegal value", () => {
    localStorage.setItem(LAST_ACTIVITY_KEY, '90d');
    expect(loadLastActivity()).toBe('all');
  });

  it("returns 'all' when localStorage is unavailable", () => {
    uninstallLocalStorage();
    expect(loadLastActivity()).toBe('all');
  });
});

describe('loadSortBy', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it("defaults to 'recency' when storage is empty", () => {
    expect(loadSortBy()).toBe('recency');
  });

  it('returns persisted sort modes', () => {
    localStorage.setItem(SORT_BY_KEY, 'priority');
    expect(loadSortBy()).toBe('priority');
    localStorage.setItem(SORT_BY_KEY, 'manual');
    expect(loadSortBy()).toBe('manual');
    localStorage.setItem(SORT_BY_KEY, 'recency');
    expect(loadSortBy()).toBe('recency');
  });

  it("falls back to 'recency' on illegal value", () => {
    localStorage.setItem(SORT_BY_KEY, 'project');
    expect(loadSortBy()).toBe('recency');
  });

  it("falls back to 'recency' on the removed 'alphabetic' legacy value", () => {
    // 侧边栏重设计裁决:按名称排序已删除;老用户存量值静默回退默认。
    localStorage.setItem(SORT_BY_KEY, 'alphabetic');
    expect(loadSortBy()).toBe('recency');
  });

  it("falls back to 'recency' on the removed 'time' (oldest-first) legacy value", () => {
    // 2026-08-12 用户裁决:「最早优先」删除,时间排序只保留最近活动在前一档;
    // 存量值静默回退到 recency(菜单文案「按时间排序」)。
    localStorage.setItem(SORT_BY_KEY, 'time');
    expect(loadSortBy()).toBe('recency');
  });

  it("returns 'recency' when localStorage is unavailable", () => {
    uninstallLocalStorage();
    expect(loadSortBy()).toBe('recency');
  });
});

describe('nextSortByAfterGroupByChange', () => {
  it('flat + manual 回落到 recency;其它组合保持', () => {
    expect(nextSortByAfterGroupByChange('flat', 'manual')).toBe('recency');
    expect(nextSortByAfterGroupByChange('flat', 'priority')).toBe('priority');
    expect(nextSortByAfterGroupByChange('flat', 'recency')).toBe('recency');
    expect(nextSortByAfterGroupByChange('project', 'manual')).toBe('manual');
  });
});

describe('taskInfoFields（任务行右侧信息复选）', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it("defaults to ['time'] when storage is empty", () => {
    expect(loadTaskInfoFields()).toEqual(['time']);
  });

  it('空数组是合法状态（用户显式全不选），不回落默认', () => {
    persistTaskInfoFields([]);
    expect(loadTaskInfoFields()).toEqual([]);
  });

  it('persist → load round-trips and drops illegal / duplicate entries', () => {
    persistTaskInfoFields(['pr', 'tokens', 'cost', 'time']);
    expect(loadTaskInfoFields()).toEqual(['pr', 'tokens', 'cost', 'time']);
    localStorage.setItem(TASK_INFO_KEY, JSON.stringify(['time', 'bogus', 'time', 42, 'cost']));
    expect(loadTaskInfoFields()).toEqual(['time', 'cost']);
  });

  it('falls back to default on broken JSON or shape mismatch', () => {
    localStorage.setItem(TASK_INFO_KEY, '{not-json');
    expect(loadTaskInfoFields()).toEqual(['time']);
    localStorage.setItem(TASK_INFO_KEY, JSON.stringify({ fields: ['time'] }));
    expect(loadTaskInfoFields()).toEqual(['time']);
  });

  it('nextTaskInfoAfterToggle toggles membership and allows empty', () => {
    expect(nextTaskInfoAfterToggle(['time'], 'cost')).toEqual(['time', 'cost']);
    expect(nextTaskInfoAfterToggle(['time', 'cost'], 'time')).toEqual(['cost']);
    expect(nextTaskInfoAfterToggle(['cost'], 'cost')).toEqual([]);
    expect(nextTaskInfoAfterToggle([], 'pr')).toEqual(['pr']);
  });
});

describe('dialogueGroupCollapsedKeys（对话组按分组 key 独立折叠）', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it('defaults to empty set when storage is empty', () => {
    expect([...loadDialogueGroupCollapsedKeys()]).toEqual([]);
  });

  it("migrates legacy boolean: 'true' → [DIALOGUE_GROUP_ALL_KEY], 'false' → empty", () => {
    localStorage.setItem(DIALOGUE_GROUP_COLLAPSED_KEY, 'true');
    expect([...loadDialogueGroupCollapsedKeys()]).toEqual([DIALOGUE_GROUP_ALL_KEY]);
    localStorage.setItem(DIALOGUE_GROUP_COLLAPSED_KEY, 'false');
    expect([...loadDialogueGroupCollapsedKeys()]).toEqual([]);
  });

  it('persist → load round-trips per-device keys independently', () => {
    persistDialogueGroupCollapsedKeys(new Set(['local', 'device-1']));
    const keys = loadDialogueGroupCollapsedKeys();
    expect(keys.has('local')).toBe(true);
    expect(keys.has('device-1')).toBe(true);
    expect(keys.has('device-2')).toBe(false);
  });

  it('falls back to empty on broken JSON / shape mismatch and drops non-string entries', () => {
    localStorage.setItem(DIALOGUE_GROUP_COLLAPSED_KEY, '{not-json');
    expect([...loadDialogueGroupCollapsedKeys()]).toEqual([]);
    localStorage.setItem(DIALOGUE_GROUP_COLLAPSED_KEY, JSON.stringify({ all: true }));
    expect([...loadDialogueGroupCollapsedKeys()]).toEqual([]);
    localStorage.setItem(DIALOGUE_GROUP_COLLAPSED_KEY, JSON.stringify(['local', 42, 'device-1']));
    expect([...loadDialogueGroupCollapsedKeys()]).toEqual(['local', 'device-1']);
  });
});

describe('loadManualProjectOrder', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it('defaults to an empty array when storage is empty', () => {
    expect(loadManualProjectOrder(OWNER_ID)).toEqual([]);
  });

  it('returns a cleaned unique order array', () => {
    localStorage.setItem(
      MANUAL_PROJECT_ORDER_KEY,
      JSON.stringify(['local:/b', 42, 'local:/a', 'local:/b', '', null]),
    );
    expect(loadManualProjectOrder(OWNER_ID)).toEqual(['local:/b', 'local:/a']);
  });

  it('falls back to an empty array on broken JSON or shape mismatch', () => {
    localStorage.setItem(MANUAL_PROJECT_ORDER_KEY, '{not-json');
    expect(loadManualProjectOrder(OWNER_ID)).toEqual([]);
    localStorage.setItem(MANUAL_PROJECT_ORDER_KEY, JSON.stringify({ order: ['local:/a'] }));
    expect(loadManualProjectOrder(OWNER_ID)).toEqual([]);
  });
});

/* ============================== persist round-trip ============================== */

describe('persist round-trip', () => {
  beforeEach(() => installMemoryLocalStorage());
  afterEach(() => uninstallLocalStorage());

  it('persistStatus → loadStatus returns the same value', () => {
    persistStatus('archived');
    expect(loadStatus()).toBe('archived');
    persistStatus('all');
    expect(loadStatus()).toBe('all');
    persistStatus('active');
    expect(loadStatus()).toBe('active');
  });

  it("persistProjects('all') → loadProjects() returns 'all'", () => {
    persistProjects('all', OWNER_ID);
    expect(loadProjects(OWNER_ID)).toBe('all');
  });

  it('persistProjects([…]) → loadProjects() returns the array', () => {
    persistProjects(['local:/foo', 'local:/bar'], OWNER_ID);
    expect(loadProjects(OWNER_ID)).toEqual(['local:/foo', 'local:/bar']);
    expect(localStorage.getItem(ownerKey(PROJECTS_KEY))).toBe(
      JSON.stringify(['local:/foo', 'local:/bar']),
    );
    expect(loadProjects('owner-b')).toBe('all');
  });

  it('persistGroupBy → loadGroupBy returns the same value', () => {
    persistGroupBy('flat');
    expect(loadGroupBy()).toBe('flat');
    persistGroupBy('project');
    expect(loadGroupBy()).toBe('project');
  });

  it('persistLastActivity → loadLastActivity returns the same value', () => {
    persistLastActivity('7d');
    expect(loadLastActivity()).toBe('7d');
    persistLastActivity('all');
    expect(loadLastActivity()).toBe('all');
  });

  it('persistSortBy → loadSortBy returns the same value', () => {
    persistSortBy('priority');
    expect(loadSortBy()).toBe('priority');
    persistSortBy('manual');
    expect(loadSortBy()).toBe('manual');
    persistSortBy('recency');
    expect(loadSortBy()).toBe('recency');
  });

  it('persistManualProjectOrder → loadManualProjectOrder returns the same order', () => {
    persistManualProjectOrder(['local:/b', 'local:/a'], OWNER_ID);
    expect(loadManualProjectOrder(OWNER_ID)).toEqual(['local:/b', 'local:/a']);
    expect(localStorage.getItem(ownerKey(MANUAL_PROJECT_ORDER_KEY))).toBe(
      JSON.stringify(['local:/b', 'local:/a']),
    );
  });
});

/* ============================== nextProjectsAfterToggle ============================== */

describe('nextProjectsAfterToggle', () => {
  it("'all' → toggle one wd → [wd]", () => {
    expect(nextProjectsAfterToggle('all', 'local:/proj-a')).toEqual(['local:/proj-a']);
  });

  it('append new wd to existing array', () => {
    const prev: FilterProjects = ['local:/proj-a'];
    const next = nextProjectsAfterToggle(prev, 'local:/proj-b');
    expect(next).toEqual(['local:/proj-a', 'local:/proj-b']);
  });

  it('removing one of multiple keeps order of the remaining', () => {
    const prev: FilterProjects = ['local:/proj-a', 'local:/proj-b', 'local:/proj-c'];
    expect(nextProjectsAfterToggle(prev, 'local:/proj-b')).toEqual([
      'local:/proj-a',
      'local:/proj-c',
    ]);
  });

  it("removing the last entry falls back to 'all'", () => {
    const prev: FilterProjects = ['local:/proj-a'];
    expect(nextProjectsAfterToggle(prev, 'local:/proj-a')).toBe('all');
  });

  it('does not mutate the input array', () => {
    const prev: FilterProjects = ['local:/proj-a', 'local:/proj-b'];
    const snapshot = [...prev];
    nextProjectsAfterToggle(prev, 'local:/proj-c');
    expect(prev).toEqual(snapshot);
  });

  it("toggles the dialogue sentinel without treating it as a project path", () => {
    expect(nextProjectsAfterToggle('all', DIALOGUE_FILTER_KEY)).toEqual([DIALOGUE_FILTER_KEY]);
    expect(nextProjectsAfterToggle([DIALOGUE_FILTER_KEY], 'local:/proj-a')).toEqual([
      DIALOGUE_FILTER_KEY,
      'local:/proj-a',
    ]);
    expect(nextProjectsAfterToggle([DIALOGUE_FILTER_KEY, 'local:/proj-a'], DIALOGUE_FILTER_KEY)).toEqual([
      'local:/proj-a',
    ]);
  });
});

describe('includeProjectInFilter', () => {
  it("keeps 'all' unchanged", () => {
    const prev: FilterProjects = 'all';
    expect(includeProjectInFilter(prev, 'local:/a')).toBe(prev);
  });

  it('appends a missing normalized project', () => {
    const prev: FilterProjects = ['local:/b'];
    expect(includeProjectInFilter(prev, '/a')).toEqual(['local:/b', 'local:/a']);
  });

  it('is idempotent when the project is already included', () => {
    const prev: FilterProjects = ['local:/a', 'local:/b'];
    expect(includeProjectInFilter(prev, '/a')).toBe(prev);
  });
});

describe('removeProjectsFromFilter', () => {
  it("keeps 'all' unchanged", () => {
    const prev: FilterProjects = 'all';
    expect(removeProjectsFromFilter(prev, new Set(['local:/a']), 'linux')).toBe(prev);
  });

  it('removes hidden projects while preserving the remaining order', () => {
    const prev: FilterProjects = ['local:/a', 'local:/b'];
    expect(removeProjectsFromFilter(prev, new Set(['/a']), 'linux')).toEqual(['local:/b']);
  });

  it('matches Windows local paths case-insensitively without folding remote, device, or POSIX keys', () => {
    const prev: FilterProjects = [
      'local:C:/Repo',
      'remote:host-a:C:/Repo',
      'device:device-a:C:/Repo',
      'local:/Users/Lee/Repo',
    ];

    expect(
      removeProjectsFromFilter(
        prev,
        new Set([
          'local:c:/repo',
          'remote:host-a:c:/repo',
          'device:device-a:c:/repo',
          'local:/users/lee/repo',
        ]),
        'win32',
      ),
    ).toEqual(['remote:host-a:C:/Repo', 'device:device-a:C:/Repo', 'local:/Users/Lee/Repo']);
  });

  it('keeps a different-cased POSIX double-slash project in the filter', () => {
    const prev: FilterProjects = ['local://mnt/Repo', 'local://mnt/repo'];

    expect(removeProjectsFromFilter(prev, new Set(['local://mnt/Repo']), 'linux')).toEqual([
      'local://mnt/repo',
    ]);
  });

  it("falls back to 'all' after removing the final explicit project", () => {
    const prev: FilterProjects = ['local:/a'];
    expect(removeProjectsFromFilter(prev, new Set(['local:/a']), 'linux')).toBe('all');
  });

  it('keeps the dialogue sentinel when hidden-project snapshots arrive', () => {
    const prev: FilterProjects = [DIALOGUE_FILTER_KEY, 'local:/a'];
    expect(removeProjectsFromFilter(prev, new Set(['local:/a']), 'linux')).toEqual([
      DIALOGUE_FILTER_KEY,
    ]);
  });

  it('is idempotent for unrelated and repeated hidden snapshots', () => {
    const unrelated: FilterProjects = ['local:/b'];
    expect(removeProjectsFromFilter(unrelated, new Set(['local:/a']), 'linux')).toBe(unrelated);

    const afterFirstRemoval = removeProjectsFromFilter(
      ['local:/a', 'local:/b'],
      new Set(['local:/a']),
      'linux',
    );
    expect(afterFirstRemoval).toEqual(['local:/b']);
    expect(removeProjectsFromFilter(afterFirstRemoval, new Set(['local:/a']), 'linux')).toBe(
      afterFirstRemoval,
    );
  });
});

/* ============================== gcProjectsAgainstActive ============================== */

describe('gcProjectsAgainstActive', () => {
  it("'all' → returns 'all' unchanged", () => {
    const prev: FilterProjects = 'all';
    expect(gcProjectsAgainstActive(prev, ['local:/x'])).toBe(prev);
  });

  it('all entries still active → returns the same reference (no churn)', () => {
    const prev: FilterProjects = ['local:/a', 'local:/b'];
    expect(gcProjectsAgainstActive(prev, ['local:/a', 'local:/b', '/c'])).toBe(prev);
  });

  it('normalizes legacy local project keys while keeping active entries', () => {
    const prev: FilterProjects = ['/a', 'remote:host:/b'];
    expect(gcProjectsAgainstActive(prev, ['local:/a', 'remote:host:/b'])).toEqual([
      'local:/a',
      'remote:host:/b',
    ]);
  });

  it('drops missing entries, keeps remaining', () => {
    const prev: FilterProjects = ['local:/a', 'remote:host:/b', 'local:/c'];
    expect(gcProjectsAgainstActive(prev, ['local:/a', '/c'])).toEqual(['local:/a', 'local:/c']);
  });

  it("after gc empties the array → falls back to 'all'", () => {
    const prev: FilterProjects = ['local:/gone-a', 'local:/gone-b'];
    expect(gcProjectsAgainstActive(prev, ['local:/x', 'local:/y'])).toBe('all');
  });

  it('with empty active list → falls back to "all"', () => {
    const prev: FilterProjects = ['local:/a'];
    expect(gcProjectsAgainstActive(prev, [])).toBe('all');
  });

  it('keeps the dialogue sentinel when GC drops stale projects', () => {
    const prev: FilterProjects = [DIALOGUE_FILTER_KEY, 'local:/gone'];
    expect(gcProjectsAgainstActive(prev, ['local:/a'])).toEqual([DIALOGUE_FILTER_KEY]);
  });

  it('keeps dialogue-only filters even when no projects remain', () => {
    expect(gcProjectsAgainstActive([DIALOGUE_FILTER_KEY], [])).toEqual([DIALOGUE_FILTER_KEY]);
  });
});

describe('manual project ordering', () => {
  it('normalizes by removing stale entries and appending new active dirs', () => {
    expect(
      normalizeManualProjectOrder(
        ['local:/b', 'local:/stale', 'local:/a'],
        ['local:/a', 'local:/b', '/c'],
      ),
    ).toEqual(['local:/b', 'local:/a', 'local:/c']);
  });

  it('moves a project before a target', () => {
    expect(
      moveManualProjectOrder(
        ['local:/a', 'local:/b', '/c'],
        ['local:/a', 'local:/b', '/c'],
        'local:/c',
        'local:/a',
        'before',
      ),
    ).toEqual(['local:/c', 'local:/a', 'local:/b']);
  });

  it('moves a project after a target, seeding from active dirs when no order exists', () => {
    expect(
      moveManualProjectOrder([], ['local:/a', 'local:/b', '/c'], 'local:/a', 'local:/c', 'after'),
    ).toEqual(['local:/b', 'local:/c', 'local:/a']);
  });

  it('keeps the order unchanged for an adjacent no-op drop', () => {
    expect(
      moveManualProjectOrder(
        ['local:/a', 'local:/b', '/c'],
        ['local:/a', 'local:/b', '/c'],
        'local:/a',
        'local:/b',
        'before',
      ),
    ).toEqual(['local:/a', 'local:/b', 'local:/c']);
  });
});

describe('mergeVisibleReorder（机器/vendor 过滤下拖拽:可见项原位重排,不可见项保位;置顶 / 项目共用）', () => {
  it('未过滤(可见 == 全量)→ 恒等,等于 visibleNewOrder', () => {
    const full = ['a', 'b', 'c'];
    expect(mergeVisibleReorder(full, ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('过滤到 X 机器(可见 a,c;隐藏 b)拖成 [c,a] → b 原位保留', () => {
    // 完整顺序 [a, b, c],可见的是 a 和 c(b 属其它机器,被过滤掉不可见)。
    // 用户把可见段拖成 [c, a]:a 的槽位填 c、c 的槽位填 a,b 不动。
    expect(mergeVisibleReorder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'b', 'a']);
  });

  it('隐藏项夹在中间也保位(完整 [x1,h,x2],可见 [x1,x2] 拖成 [x2,x1])', () => {
    expect(mergeVisibleReorder(['x1', 'h', 'x2'], ['x2', 'x1'])).toEqual(['x2', 'h', 'x1']);
  });

  it('visibleNewOrder 含新置顶 id(不在完整顺序里)→ 追加末尾', () => {
    expect(mergeVisibleReorder(['a', 'b'], ['b', 'a', 'new'])).toEqual(['b', 'a', 'new']);
  });

  it('空完整顺序 → 直接用 visibleNewOrder(全是新置顶)', () => {
    expect(mergeVisibleReorder([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('与 normalizeManualPinnedOrder 串联:过滤拖拽后其它机器置顶项不丢、保位', () => {
    // 全量活跃置顶 = [a(X), b(Y), c(X)];manualOrder 已是 [a,b,c]。过滤到 X 机器,可见 [a,c],
    // 拖成 [c,a]。期望持久化结果仍含 b 且在原位 → [c, b, a],b(其它机器)未丢失、未挪末尾。
    const fullActive = ['a', 'b', 'c'];
    const currentFull = normalizeManualPinnedOrder(['a', 'b', 'c'], fullActive);
    expect(mergeVisibleReorder(currentFull, ['c', 'a'])).toEqual(['c', 'b', 'a']);
  });
});

describe('项目拖拽(机器过滤态):mergeVisibleReorder + normalizeManualProjectOrder 原位保位', () => {
  it('过滤到部分项目拖动时,被过滤掉的项目原位保留,不被甩到末尾(对齐置顶「保留原位」)', () => {
    // 全量项目(交错):p1 · h1 · p2 · h2。h* = 其它机器 / 被过滤,当前不可见。
    const p1 = 'local:/p1';
    const p2 = 'local:/p2';
    const h1 = 'local:/h1';
    const h2 = 'local:/h2';
    const all = [p1, h1, p2, h2];
    const fullOrder = normalizeManualProjectOrder([p1, h1, p2, h2], all);
    // 可见 [p1, p2] 拖成 [p2, p1];h1 / h2 不可见,必须保位(不追加到末尾)。
    const merged = mergeVisibleReorder(fullOrder, [p2, p1]);
    expect(merged).toEqual([p2, h1, p1, h2]);
    // setManualProjectOrder 内部会再归一化一次 → 必须幂等(不追加、不打乱)。
    expect(normalizeManualProjectOrder(merged, all)).toEqual([p2, h1, p1, h2]);
  });
});
