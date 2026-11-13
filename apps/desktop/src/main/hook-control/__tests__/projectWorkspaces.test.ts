/**
 * 官方 IM 机器人可选的项目 = 侧栏的本机项目。
 *
 * 测试价值
 * - 生产入口与可观察结果: planProjectWorkspaces / lookupWorkspaces / retiredAliasPairs 与
 *   createProjectWorkspaceSync().run() —— 落进连接配置的「名称 -> 目录」就是 hello 与 IM 里
 *   /project 列出的清单, retired 决定旧名称的派发与偏好还找不找得到目录。
 * - 规则依据: docs/dev-rules/im-turn-flow.md「官方机器人的项目清单」(2026-11-13 Dash 裁决:
 *   侧栏的项目就是 IM 机器人用的项目, 不另设目录映射)。
 * - 现有覆盖缺口: 此前清单由设置页手填, 没有「按项目列表生成名称」这一步。
 * - 最小失败输入: 见各用例(升级前手填的别名、侧栏改名、同名项目、移除、账号切换)。
 * - tier: unit(纯函数 + 注入依赖, 无 Electron / 数据库 / 文件)。
 */

import { describe, expect, it, vi } from 'vitest';

import { HOOK_WORKSPACE_ALIAS_RE } from '../../../shared/hookControlIpc';
import {
  lookupWorkspaces,
  planProjectWorkspaces,
  retiredAliasPairs,
} from '../projectWorkspaces';
import { createProjectWorkspaceSync, type ProjectCatalogSnapshot } from '../projectWorkspaceSync';
import type { SlackHookConfigState, SlackHookStore } from '../store';

const plan = (
  current: Record<string, string>,
  projects: Array<{ path: string; name: string }>,
  retired: Record<string, string> = {},
) => planProjectWorkspaces({ current, retired, projects, platform: 'darwin' });

describe('planProjectWorkspaces', () => {
  it('清单就是侧栏项目: 名称用侧栏的名字(可以是中文), 顺序按最近使用', () => {
    const result = plan({}, [
      { path: '/code/周报', name: '周报整理' },
      { path: '/code/cindy', name: 'cindy' },
    ]);
    expect(Object.entries(result.workspaces)).toEqual([
      ['周报整理', '/code/周报'],
      ['cindy', '/code/cindy'],
    ]);
    expect(result.renames).toEqual([]);
    expect(result.mappingChanged).toBe(true);
    for (const name of Object.keys(result.workspaces)) expect(name).toMatch(HOOK_WORKSPACE_ALIAS_RE);
  });

  it('升级前手填的别名改成侧栏名字, 旧别名留作查找; 再跑一次不再变化', () => {
    const first = plan({ xdmaker: '/code/cindy' }, [{ path: '/code/cindy', name: 'cindy' }]);
    expect(first.workspaces).toEqual({ cindy: '/code/cindy' });
    expect(first.retired).toEqual({ xdmaker: '/code/cindy' });
    expect(first.renames).toEqual([{ from: 'xdmaker', to: 'cindy' }]);

    const second = plan(first.workspaces, [{ path: '/code/cindy', name: 'cindy' }], first.retired);
    expect(second.changed).toBe(false);
    expect(second.renames).toEqual([]);
    // 旧名称仍能找到同一个目录, 且「按目录找名称」先得到现用名称。
    expect(Object.entries(lookupWorkspaces(second.workspaces, second.retired))).toEqual([
      ['cindy', '/code/cindy'],
      ['xdmaker', '/code/cindy'],
    ]);
    expect(retiredAliasPairs(second.workspaces, second.retired, 'darwin')).toEqual([
      { from: 'xdmaker', to: 'cindy' },
    ]);
  });

  it('侧栏里改名: 名称跟着改; 新来的同名项目不抢走旧项目的名字', () => {
    const renamed = plan({ cindy: '/code/cindy' }, [{ path: '/code/cindy', name: '主仓库' }]);
    expect(renamed.workspaces).toEqual({ 主仓库: '/code/cindy' });
    expect(renamed.retired).toEqual({ cindy: '/code/cindy' });

    // 新项目排在最前(最近使用), 但 /a/app 已经叫 app, 新来的退到「上级目录/目录名」。
    const collided = plan({ app: '/a/app' }, [
      { path: '/b/app', name: 'app' },
      { path: '/a/app', name: 'app' },
    ]);
    expect(collided.workspaces).toEqual({ 'b/app': '/b/app', app: '/a/app' });
    expect(collided.renames).toEqual([]);
  });

  it('同名且上级目录也相同时用序号; 保留名与像路径的名字不直接用', () => {
    const result = plan({}, [
      { path: '/a/x/app', name: '报表' },
      { path: '/b/x/app2', name: '报表' },
      { path: '/c/chat', name: 'chat' },
      { path: '/d/e', name: '/etc/passwd' },
    ]);
    expect(Object.keys(result.workspaces)).toEqual(['报表', 'x/报表', 'c/chat', 'etc/passwd']);
    const again = plan(result.workspaces, [
      { path: '/a/x/app', name: '报表' },
      { path: '/b/x/app2', name: '报表' },
      { path: '/z/x/app3', name: '报表' },
    ]);
    expect(Object.keys(again.workspaces)).toEqual(['报表', 'x/报表', '报表 2']);
  });

  it('侧栏里移除的项目退出清单, 它的旧名称一并丢掉; 只换顺序不算名称变化', () => {
    const removed = plan(
      { cindy: '/code/cindy', docs: '/code/docs' },
      [{ path: '/code/docs', name: 'docs' }],
      { xdmaker: '/code/cindy' },
    );
    expect(removed.workspaces).toEqual({ docs: '/code/docs' });
    expect(removed.retired).toEqual({});
    expect(removed.mappingChanged).toBe(true);

    const reordered = plan({ a: '/a', b: '/b' }, [
      { path: '/b', name: 'b' },
      { path: '/a', name: 'a' },
    ]);
    expect(reordered.changed).toBe(true);
    expect(reordered.mappingChanged).toBe(false);
  });
});

function memoryStore(initial: Partial<SlackHookConfigState>) {
  let state = { workspaces: {}, ...initial } as SlackHookConfigState;
  const store = {
    get: () => state,
    applyProjectWorkspaces: (next: { workspaces: Record<string, string>; retired: Record<string, string> }) => {
      state = { ...state, workspaces: next.workspaces, retiredWorkspaces: next.retired };
      return state;
    },
    markProjectCatalogMigrated: () => {
      state = { ...state, projectCatalogMigrated: true };
      return state;
    },
  } as unknown as SlackHookStore;
  return { store, state: () => state };
}

describe('createProjectWorkspaceSync', () => {
  it('升级后第一次: 把手动配置过的目录登记成项目, 之后只按项目列表整理', async () => {
    const mem = memoryStore({ workspaces: { xdmaker: '/code/cindy' } });
    const registered: string[] = [];
    const catalog: ProjectCatalogSnapshot = {
      projects: [],
      isCurrent: () => true,
      isRemoved: () => false,
    };
    const onSynced = vi.fn();
    const sync = createProjectWorkspaceSync({
      getStore: () => mem.store,
      loadCatalog: async () => catalog,
      registerDirectory: async (directory) => {
        registered.push(directory);
        catalog.projects = [{ path: directory, name: 'cindy' }];
      },
      onSynced,
      log: { warn: () => {} },
    });

    await sync.run();
    expect(registered).toEqual(['/code/cindy']);
    expect(mem.state()).toMatchObject({
      projectCatalogMigrated: true,
      workspaces: { cindy: '/code/cindy' },
      retiredWorkspaces: { xdmaker: '/code/cindy' },
    });
    expect(onSynced).toHaveBeenLastCalledWith({ changed: true, mappingChanged: true });

    await sync.run();
    expect(registered).toEqual(['/code/cindy']);
    expect(onSynced).toHaveBeenLastCalledWith({ changed: false, mappingChanged: false });
  });

  it('项目存储没就绪或读取期间换了账号: 不动现有清单, 也不记成已迁移', async () => {
    const mem = memoryStore({ workspaces: { cindy: '/code/cindy' } });
    let snapshot: ProjectCatalogSnapshot | null = null;
    const onSynced = vi.fn();
    const sync = createProjectWorkspaceSync({
      getStore: () => mem.store,
      loadCatalog: async () => snapshot,
      registerDirectory: async () => {},
      onSynced,
      log: { warn: () => {} },
    });

    await sync.run();
    snapshot = { projects: [], isCurrent: () => false, isRemoved: () => false };
    await sync.run();

    expect(mem.state().workspaces).toEqual({ cindy: '/code/cindy' });
    expect(mem.state().projectCatalogMigrated).toBeUndefined();
    expect(onSynced).not.toHaveBeenCalled();
  });
});
