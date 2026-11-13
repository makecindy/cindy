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

  // PR #10291 review(第九轮): 升级前的配置允许同一个目录有两个别名, 默认项目可能用其中任意
  // 一个; 改名只记第一个时, 用另一个别名的默认项目会被清掉。
  it('同一个目录的多个旧别名都记成改名', () => {
    const result = plan({ a1: '/code/cindy', a2: '/code/cindy' }, [{ path: '/code/cindy', name: 'cindy' }]);
    expect(result.workspaces).toEqual({ cindy: '/code/cindy' });
    expect(result.renames).toEqual([
      { from: 'a1', to: 'cindy' },
      { from: 'a2', to: 'cindy' },
    ]);
    expect(result.retired).toEqual({ a1: '/code/cindy', a2: '/code/cindy' });
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

  // PR #10291 review: 项目 A 从 app 改名后, 别的项目拿走 app, 服务端仍按 app 记着的会话
  // 就会落进另一个目录。最小失败输入: A 改名的同一次整理里 B 也叫 app; 以及之后才来的 B。
  it('还指着某个项目的旧名称不让给别的项目; 项目自己可以改回原名', () => {
    const sameRun = plan({ app: '/a/app' }, [
      { path: '/a/app', name: 'main' },
      { path: '/b/app', name: 'app' },
    ]);
    expect(sameRun.workspaces).toEqual({ main: '/a/app', 'b/app': '/b/app' });
    expect(sameRun.retired).toEqual({ app: '/a/app' });

    const later = plan(
      { main: '/a/app' },
      [
        { path: '/a/app', name: 'main' },
        { path: '/c/x', name: 'app' },
      ],
      { app: '/a/app' },
    );
    expect(later.workspaces).toEqual({ main: '/a/app', 'c/app': '/c/x' });
    expect(lookupWorkspaces(later.workspaces, later.retired).app).toBe('/a/app');

    const back = plan({ main: '/a/app' }, [{ path: '/a/app', name: 'app' }], { app: '/a/app' });
    expect(back.workspaces).toEqual({ app: '/a/app' });
    expect(back.retired).toEqual({ main: '/a/app' });
  });

  // PR #10291 review(第四、五轮): 清单按「最近的前 64 个」截取时, 项目随使用顺序进出清单,
  // 名称会被同名项目拿走、默认项目被清掉、按名称存的权限档对不上; 旧名称表按条数截断同理。
  // 现在清单是全部项目, 旧名称不按条数丢弃。最小失败输入: 65 个项目且最后一个与新来的同名;
  // 一个项目攒了 70 个旧名称。
  it('项目再多也全部进清单, 名称不随使用顺序易主; 旧名称不按条数丢弃', () => {
    const filler = Array.from({ length: 64 }, (_, index) => ({ path: `/f/p${index}`, name: `p${index}` }));
    const old = { path: '/a/app', name: 'app' };
    const result = plan({ app: '/a/app' }, [{ path: '/b/app', name: 'app' }, ...filler, old]);
    expect(Object.keys(result.workspaces)).toHaveLength(66);
    expect(result.workspaces.app).toBe('/a/app');
    expect(result.workspaces['b/app']).toBe('/b/app');
    expect(result.retired).toEqual({});

    const many = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`old${index}`, '/a/app']));
    const kept = plan({ app: '/a/app' }, [old, { path: '/c/x', name: 'old0' }], many);
    expect(Object.keys(kept.retired)).toHaveLength(70);
    expect(kept.workspaces['c/old0']).toBe('/c/x');
  });

  // PR #10291 review: 纯数字的旧名称(如 2025)原先被排除在查找之外, 服务端按它派发就被拒。
  // PR #10291 review(第六轮): 纯数字的键在对象里恒排最前, 会打乱清单的最近使用顺序。
  it('纯数字的项目名不当现用名称, 清单顺序不被打乱', () => {
    const result = plan({ '123': '/work/123' }, [
      { path: '/code/recent', name: 'recent' },
      { path: '/work/123', name: '123' },
    ]);
    expect(Object.keys(result.workspaces)).toEqual(['recent', 'work/123']);
    expect(result.retired).toEqual({ '123': '/work/123' });
  });

  it('纯数字的旧名称照样能找到目录', () => {
    const result = plan({ '2025': '/code/reports' }, [{ path: '/code/reports', name: 'reports' }]);
    expect(lookupWorkspaces(result.workspaces, result.retired)).toEqual({
      '2025': '/code/reports',
      reports: '/code/reports',
    });
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

    // 排到最前、服务端选择卡会列出来的那一批换了成员: 要告诉服务端, 否则卡上一直是旧的那批。
    const many = Array.from({ length: 30 }, (_, index) => ({ path: `/p/${index}`, name: `p${index}` }));
    const before = plan({}, many).workspaces;
    const promoted = plan(before, [many[29]!, ...many.slice(0, 29)]);
    expect(promoted.mappingChanged).toBe(true);
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
    // 改名不算把名称让出去: 旧名称仍指着同一个目录。
    expect(onSynced).toHaveBeenLastCalledWith({ changed: true, mappingChanged: true, releasedNames: [] });

    await sync.run();
    expect(registered).toEqual(['/code/cindy']);
    expect(onSynced).toHaveBeenLastCalledWith({ changed: false, mappingChanged: false, releasedNames: [] });
  });

  // 规则(2026-11-13 用户裁决): 项目从侧栏移除后, 按它的名称存的模型 / 权限要清掉, 否则日后同名的
  // 新项目会悄悄继承上一个项目的权限档(评审指出)。这里锁住「哪些名称算让出去了」:
  // 移除的项目(含它留作查找的旧名称)、以及同一次整理里转给另一个目录的名称; 仍在的项目不算。
  // 最小失败输入: 一个改过名的项目被移除, 同时来了一个与它同名的新项目。tier: unit。
  it('项目移除或名称转给别的目录时, 把这些名称报给调用方去清配置', async () => {
    const mem = memoryStore({
      projectCatalogMigrated: true,
      workspaces: { app: '/code/app', docs: '/code/docs' },
      retiredWorkspaces: { 'old-app': '/code/app' },
    });
    const onSynced = vi.fn();
    const sync = createProjectWorkspaceSync({
      getStore: () => mem.store,
      // /code/app 被移除; 另一个目录也叫 app。
      loadCatalog: async () => ({
        projects: [
          { path: '/code/docs', name: 'docs' },
          { path: '/work/app', name: 'app' },
        ],
        isCurrent: () => true,
        isRemoved: () => false,
      }),
      registerDirectory: async () => {},
      onSynced,
      log: { warn: () => {} },
    });

    await sync.run();
    expect(mem.state().workspaces).toMatchObject({ app: '/work/app', docs: '/code/docs' });
    const released = onSynced.mock.lastCall?.[0].releasedNames as string[];
    expect([...released].sort()).toEqual(['app', 'old-app']);
  });

  // PR #10291 review: 登记失败被吞掉后迁移照样记成完成, 清单随即按项目列表重排, 没登记上的
  // 目录从机器人那里永久消失且不再重试。最小失败输入: 第一次登记抛错, 第二次成功。
  it('升级迁移有目录没登记上: 原清单不动、不记成已迁移, 下次整理重试', async () => {
    const mem = memoryStore({ workspaces: { xdmaker: '/code/cindy' } });
    const catalog: ProjectCatalogSnapshot = { projects: [], isCurrent: () => true, isRemoved: () => false };
    let attempts = 0;
    const onSynced = vi.fn();
    const sync = createProjectWorkspaceSync({
      getStore: () => mem.store,
      loadCatalog: async () => catalog,
      registerDirectory: async (directory) => {
        attempts += 1;
        if (attempts === 1) throw new Error('INTERNAL: write failed');
        catalog.projects = [{ path: directory, name: 'cindy' }];
      },
      onSynced,
      log: { warn: () => {} },
    });

    await sync.run();
    expect(mem.state().workspaces).toEqual({ xdmaker: '/code/cindy' });
    expect(mem.state().projectCatalogMigrated).toBeUndefined();
    expect(onSynced).not.toHaveBeenCalled();

    await sync.run();
    expect(mem.state()).toMatchObject({
      projectCatalogMigrated: true,
      workspaces: { cindy: '/code/cindy' },
    });
  });

  // PR #10291 review(第九轮): 迁移逐个登记目录的途中换了账号, 后面的目录会登记进新账号。
  it('升级迁移途中换了账号: 立刻停下, 剩下的目录不再登记', async () => {
    const mem = memoryStore({ workspaces: { a: '/code/a', b: '/code/b' } });
    let current = true;
    const registered: string[] = [];
    const sync = createProjectWorkspaceSync({
      getStore: () => mem.store,
      loadCatalog: async () => ({ projects: [], isCurrent: () => current, isRemoved: () => false }),
      registerDirectory: async (directory) => {
        registered.push(directory);
        current = false;
      },
      onSynced: vi.fn(),
      log: { warn: () => {} },
    });

    await sync.run();
    expect(registered).toEqual(['/code/a']);
    expect(mem.state().projectCatalogMigrated).toBeUndefined();
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
