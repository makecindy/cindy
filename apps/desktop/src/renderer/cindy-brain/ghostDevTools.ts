import type { InstalledGhost } from '../../shared/ghost';

/**
 * 意识仓库 dev 调试工具—— dev UI 的黑盒验证通道。
 *
 * dev 构建下往 window 挂 `__cindyGhosts`,QA 在 DevTools console 里调用:
 *
 *   __cindyGhosts.list()                     已装意识清单
 *   await __cindyGhosts.install('<路径>')     装入一个本地 .cindy 文件(绝对路径)
 *   await __cindyGhosts.uninstall('<id>')     按 id 卸下
 *
 * 运行时(芯片型意识沙箱进程 QA):
 *   await __cindyGhosts.runtime()            全部意识的运行时状态
 *   await __cindyGhosts.spawn('<id>')         拉起沙箱(off/crashed → running)
 *   await __cindyGhosts.stopRun('<id>')       熄灯(→ off)
 *   await __cindyGhosts.crash('<id>')         强崩沙箱进程(验证崩溃隔离与熔断)
 *
 * 生产构建(import.meta.env.DEV = false)完全不挂载,零暴露。
 * 读写全部走 electronAPI.ghosts(main 侧 GhostManager 严格校验),
 * 本工具不绕过任何校验 —— 坏文件 / 重复装入会被 main 拒绝,这也是验证点。
 */

interface GhostDevToolsApi {
  list: () => InstalledGhost[];
  install: (lizFilePath: string) => Promise<InstalledGhost>;
  uninstall: (id: string) => Promise<string>;
  runtime: () => Promise<Record<string, string>>;
  spawn: (id: string) => Promise<string>;
  stopRun: (id: string) => Promise<string>;
  crash: (id: string) => Promise<string>;
}

declare global {
  interface Window {
    /** dev-only 意识调试入口;生产构建不存在。 */
    __cindyGhosts?: GhostDevToolsApi;
  }
}

/** 挂载 dev 调试入口(幂等;仅 dev 构建生效)。由 LayoutRoot 调用。 */
export function installGhostDevTools(): void {
  if (!import.meta.env.DEV) return;
  if (window.__cindyGhosts) return;
  window.__cindyGhosts = {
    list: () => window.electronAPI.ghosts.listSync().ghosts,
    install: async (lizFilePath: string) => {
      const inspected = await window.electronAPI.ghosts.inspect(lizFilePath);
      const result = await window.electronAPI.ghosts.install(lizFilePath, {
        expectedPackageSha256: inspected.packageSha256,
      });
      return result.ghost;
    },
    uninstall: async (id: string) => {
      await window.electronAPI.ghosts.uninstall(id);
      return `已卸下 ${id};userData/brain/${id} 目录应已消失`;
    },
    runtime: async () => {
      const { states } = await window.electronAPI.ghosts.devRuntime('status');
      return states ?? {};
    },
    spawn: async (id: string) => {
      const { state } = await window.electronAPI.ghosts.devRuntime('spawn', id);
      return `意识 ${id} 运行时状态:${state}`;
    },
    stopRun: async (id: string) => {
      const { state } = await window.electronAPI.ghosts.devRuntime('stop', id);
      return `意识 ${id} 运行时状态:${state}`;
    },
    crash: async (id: string) => {
      await window.electronAPI.ghosts.devRuntime('crash', id);
      return `已强崩 ${id} 的沙箱进程;稍后用 runtime() 查看 crashed/fused 状态`;
    },
  };
}
