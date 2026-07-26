/**
 * custom-mcp-registry —— 把「用户自定义 MCP(localDb)」动态注入到 agent 的
 * `mcpProviders` 数组。
 *
 * 背景:ClaudeCodeAgent / CodexAgent 的 `mcpProviders` 数组在 maker-host 启动时
 * **构建一次**并存进 agent 实例;两处消费点(claude buildMcpServers / codex
 * codexEnvironment)每次 startSession 时**重新遍历该数组**。因此只要**原地**改这两个
 * 数组的内容(不换引用),下一次新建会话就会看到最新的自定义 MCP;进行中的会话不受影响
 * (与内置 plugin 的 mtime-cached 语义一致)。
 *
 * 用法:maker-host 构造两个 agent 后,把它们各自的 mcpProviders 数组注册进来
 * (`registerCustomMcpArrays`),再在启动时与每次 CRUD 后调 `refreshCustomMcpProviders`。
 * refresh 会把数组里旧的 CustomMcpProvider 全部移除、按当前 DB 重新追加。
 */

import { createLogger } from '../logger.js';
import type { McpProvider } from '@cindy/maker-core';

import { listCustomMcpServers } from '../maker-host/custom-mcp-store.js';
import { readCustomMcpToken } from '../secrets/providerSecretStore.js';
import { CustomMcpProvider } from './custom-mcp-provider.js';

const log = createLogger('custom-mcp-registry');

/** 被注入的 agent mcpProviders 数组(原地 mutate 的目标)。 */
const registeredArrays: McpProvider[][] = [];

/**
 * 注册一个 agent 的 mcpProviders 数组,后续 refresh 会原地更新它。
 * 传入的必须是 agent 实例实际持有的那个数组引用(不能是 spread 拷贝)。
 */
export function registerCustomMcpArrays(...arrays: McpProvider[][]): void {
  for (const arr of arrays) {
    if (!registeredArrays.includes(arr)) registeredArrays.push(arr);
  }
}

/** 清空注册表（切账号 / resetMaker 时调用，防止旧数组引用残留）。 */
export function resetCustomMcpRegistry(): void {
  registeredArrays.length = 0;
}

/**
 * 当前内置（非用户自定义）MCP server 名 —— 自定义 MCP 的保留名清单。
 *
 * 从已注册数组里实际存在的 provider 派生，而不是硬编码一份名单：内置 provider 增删
 * 时这里自动跟上，不会漏掉新 server 而让保留名校验形同虚设。
 */
export function getBuiltinMcpServerNames(): string[] {
  const names = new Set<string>();
  for (const arr of registeredArrays) {
    for (const provider of arr) {
      if (provider instanceof CustomMcpProvider) continue;
      names.add(provider.name);
    }
  }
  return [...names];
}

/** @deprecated 测试别名，直接用 resetCustomMcpRegistry。 */
export const __resetCustomMcpRegistryForTest = resetCustomMcpRegistry;

/**
 * 读 DB → 重建 CustomMcpProvider[] → 原地更新每个已注册数组
 * (移除旧 CustomMcpProvider,追加新的)。任何一步失败只 warn,不抛。
 */
export async function refreshCustomMcpProviders(): Promise<void> {
  let providers: CustomMcpProvider[] = [];
  try {
    const configs = await listCustomMcpServers();
    providers = configs.map((c) => new CustomMcpProvider(c, readCustomMcpToken));
  } catch (err) {
    log.warn('list custom mcp servers failed; leaving providers unchanged', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  // 按名字去重统计：同一个撞名配置会在每个已注册数组各命中一次，累加会虚报。
  const skippedNames = new Set<string>();
  for (const arr of registeredArrays) {
    // 原地移除旧的 custom provider,再追加新的一批(不换数组引用)。
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] instanceof CustomMcpProvider) arr.splice(i, 1);
    }
    // 此刻数组里只剩内置 provider —— 用它们的名字当保留名。自定义 MCP 一旦与内置
    // 撞名，装配层(claude buildMcpServers / codex codexEnvironment)会按 key 覆盖，
    // 于是一个第三方远程端点顶替内置 server，还顺带继承审批策略里对该 server 名的
    // 信任(策略只看 serverName)。这里直接不装它，撞名的自定义 MCP 视为无效配置。
    const builtinNames = new Set(arr.map((p) => p.name));
    for (const provider of providers) {
      if (builtinNames.has(provider.name)) {
        if (!skippedNames.has(provider.name)) {
          log.warn('skipping custom MCP that collides with a builtin server name', {
            serverName: provider.name,
          });
        }
        skippedNames.add(provider.name);
        continue;
      }
      arr.push(provider);
    }
  }
  log.info('custom mcp providers refreshed', {
    count: providers.length,
    skipped: skippedNames.size,
    arrays: registeredArrays.length,
  });
}
