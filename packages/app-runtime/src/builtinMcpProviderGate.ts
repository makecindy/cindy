import type {McpProvider,McpProviderContext} from '@cindy/maker-core';
import type {PluginRegistry} from './builtin-tools/plugin-registry.js';
import {pluginIdForProviderName} from './builtinPluginIds.js';
import {GLOBAL_PLUGIN_IDS} from './builtin-tools/types.js';
import {isFrozenBuiltinPluginAllowed} from '@cindy/mcps/host/codexBuiltinToolPolicy';
/** Freeze and gate builtins through the same registered policy on every host. */
export function gateBuiltinMcpProviders<T extends McpProvider>(providers:readonly T[],pluginRegistry:Pick<PluginRegistry,'getPlugins'|'isEnabled'>):T[] {
  return providers.map((p) => {
    const originalIsEnabled = p.isEnabled;
    const pluginId = pluginIdForProviderName(p.name);
    const declaration = pluginRegistry.getPlugins().find((entry) => entry.id === pluginId);
    return {
      ...p,
      capability: {
        title: declaration?.name ?? p.name,
        description: declaration?.description ?? '',
        source: 'builtin' as const,
      },
      isEnabled: (ctx: McpProviderContext) => {
        // Codex 与 Pi 的共享 app-server / bridge 在还没有 thread/workdir 的阶段构建
        // MCP 工具清单。普通工具必须先全部注册，真正调用时由 HTTP bridge 按新会话
        // 冻结的策略阻断；否则某个用户默认会错误地影响所有项目（空 workdir 快照被缓存后，
        // 全局启用但项目停用的工具仍暴露、反向配置则永久缺席，codex review）。机器级工具
        // 仍沿用现有 spawn-time gate + 环境重建语义。
        const deferOrdinaryGate =
          (ctx.agentKind === 'codex' || ctx.agentKind === 'pi')
          && !ctx.workingDir
          && !GLOBAL_PLUGIN_IDS.has(pluginId);
        // Orca 工具面必须在会话生命周期内保持稳定：Claude query 不会在项目策略
        // 动态启用后重建 MCP。创建入口仍由 Main 按调用时的项目策略 fail closed。
        const keepOrcaProviderStable = pluginId === 'collab';
        // Stable providers may ignore a live global/project toggle so an
        // already-running ordinary task can recover, but a Bot Profile is an
        // immutable per-runtime capability boundary and must always win.
        if (!isFrozenBuiltinPluginAllowed(ctx.vendorOptions, pluginId)) {
          return false;
        }
        // Plugin gate：registry 负责 essential / machine / project / user / default 判定。
        if (
          !keepOrcaProviderStable &&
          !deferOrdinaryGate &&
          !pluginRegistry.isEnabled(pluginId, ctx.workingDir)
        ) {
          return false;
        }
        // 继续走原 provider gate，例如 memory manager check、feishu bot source check。
        return originalIsEnabled?.(ctx) ?? true;
      },
    };
  });
}
