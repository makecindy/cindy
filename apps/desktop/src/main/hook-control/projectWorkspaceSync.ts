/**
 * hook-control/projectWorkspaceSync.ts
 * ---------------------------------------------------------------------------
 * 让官方 IM 机器人的可选项目跟着侧栏项目走: 读项目列表 -> 规划名称(projectWorkspaces.ts)
 * -> 落进连接配置。依赖全部注入, 单测不需要 Electron / 数据库。
 *
 * 串行执行; 项目存储没就绪或账号正在切换时什么也不做, 等下一次触发。
 */

import type { ProjectCatalogEntry } from './projectWorkspaces.js';
import { planProjectWorkspaces, releasedProjectNames } from './projectWorkspaces.js';
import type { SlackHookStore } from './store.js';

export interface ProjectCatalogSnapshot {
  projects: ProjectCatalogEntry[];
  /** 读取之后账号 / 数据库是否仍是同一个。 */
  isCurrent(): boolean;
  /** 该目录是否是侧栏里已移除的项目。 */
  isRemoved(directory: string): boolean;
}

export interface ProjectWorkspaceSyncDeps {
  /** 当前账号的连接配置; 账号边界重置后返回新实例或 null。 */
  getStore(): SlackHookStore | null;
  /** 侧栏的本机项目(最近使用在前); null = 还读不了。 */
  loadCatalog(): Promise<ProjectCatalogSnapshot | null>;
  /**
   * 把升级前手动配置的目录登记成项目(已移除的恢复显示)。不能当项目的目录自行跳过并正常返回;
   * 其余失败须 reject —— 本次迁移不算完成, 下次整理重试。
   */
  registerDirectory(directory: string): Promise<void>;
  /** 一次整理结束(无论有没有变化)。 */
  onSynced(result: {
    changed: boolean;
    mappingChanged: boolean;
    /** 不再指着原来那个目录的名称(项目被移除, 或名称转给了别的目录)。 */
    releasedNames: string[];
  }): void;
  debounceMs?: number;
  log: { warn(msg: string): void };
}

export interface ProjectWorkspaceSync {
  /** 立即整理一次; 返回的 Promise 不会 reject。 */
  run(): Promise<void>;
  /** 合并短时间内的多次变化后整理。 */
  schedule(): void;
  dispose(): void;
}

export function createProjectWorkspaceSync(deps: ProjectWorkspaceSyncDeps): ProjectWorkspaceSync {
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  async function syncOnce(): Promise<void> {
    const store = deps.getStore();
    if (!store) return;
    if (store.get().projectCatalogMigrated !== true) {
      const ready = await deps.loadCatalog();
      if (!ready || !ready.isCurrent() || deps.getStore() !== store) return;
      let failed = false;
      for (const directory of Object.values(store.get().workspaces)) {
        // 逐个登记之间可能换了账号: 目录来自旧账号的配置, 不能登记进新账号的项目列表。
        if (!ready.isCurrent() || deps.getStore() !== store) return;
        try {
          await deps.registerDirectory(directory);
        } catch (err) {
          failed = true;
          deps.log.warn(
            `project registration for a configured IM directory failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // 有目录没登记上: 保持原清单不动, 不记成已迁移, 下次整理重试。继续往下走会按项目列表
      // 重排清单, 没登记上的目录就从机器人那里消失, 而且再也不会重试。
      if (failed) return;
      if (!ready.isCurrent() || deps.getStore() !== store) return;
      store.markProjectCatalogMigrated();
    }
    const catalog = await deps.loadCatalog();
    if (!catalog || !catalog.isCurrent() || deps.getStore() !== store) return;
    const state = store.get();
    const plan = planProjectWorkspaces({
      current: state.workspaces,
      retired: state.retiredWorkspaces ?? {},
      projects: catalog.projects,
    });
    const releasedNames = plan.changed
      ? releasedProjectNames(
          { workspaces: state.workspaces, retired: state.retiredWorkspaces ?? {} },
          { workspaces: plan.workspaces, retired: plan.retired },
        )
      : [];
    if (plan.changed) store.applyProjectWorkspaces(plan);
    deps.onSynced({ changed: plan.changed, mappingChanged: plan.mappingChanged, releasedNames });
  }

  function run(): Promise<void> {
    const next = chain.then(async () => {
      if (disposed) return;
      try {
        await syncOnce();
      } catch (err) {
        deps.log.warn(
          `project list sync for IM bots failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    chain = next;
    return next;
  }

  return {
    run,
    schedule() {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, deps.debounceMs ?? 400);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
