/**
 * mcp:custom:* IPC handlers —— 用户自定义 MCP 服务器**配置** CRUD（配置入 localDb）。
 *
 *   - MCP_CUSTOM_LIST（只读：列出当前账号的自定义 MCP）。
 *   - MCP_CUSTOM_CREATE / UPDATE / DELETE（CRUD）。
 *
 * bearer token **不经这些 handler**：renderer 用通用 safe-storage IPC 写 `mcp_token_<id>`，
 * delete 时同样由 renderer 经通用 safe-storage-remove 清 token。
 *
 * 副作用（CRUD 成功后刷新两个 agent 的 mcpProviders 数组 + 广播 MCP_CHANGED）经 deps 注入，
 * handler body 可脱 Electron 用 IpcHarness + 内存 db 直接 invoke 单测（规则 14）。
 */

import { throwIpcError } from '../utils/ipcValidate.js';
import {
  createCustomMcpServer,
  customMcpServerExists,
  deleteCustomMcpServer,
  listCustomMcpServers,
  updateCustomMcpServer,
  validateCustomMcpConfig,
  type CustomMcpConfig,
} from '../maker-host/custom-mcp-store.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface McpHandlerDeps {
  /** CRUD 成功后刷新 agent mcpProviders 数组（生产 = refreshCustomMcpProviders）。 */
  refreshProviders(): Promise<void>;
  /** CRUD 成功后广播变更（生产 = 向所有窗口 send MCP_CHANGED）。 */
  broadcastChanged(): void;
  /**
   * 失效 Codex 本地 app-server 使新 MCP 配置对下个 codex 会话生效（可选，生产注入）。
   *
   * refreshProviders 只更新内存 mcpProviders 数组；Claude 每个会话重新 buildMcpServers 即时生效，
   * 但 Codex 的 extraArgs/extraEnv 在 codexEnvironment 的模块级 `cached` 里被冻住，后续会话复用旧
   * spawn 配置——不失效则新增 server 不出现、删除 / 换 token 仍残留，直到重启 app。生产实现清
   * codexEnvironment 缓存 + dispose app-server（与 slack 变更同款,best-effort，busy 会话软重启失败
   * 只告警不阻塞 CRUD）。测试可省略。
   */
  invalidateCodex?(): Promise<void>;
  /**
   * 内置 MCP server 名（生产 = getBuiltinMcpServerNames）。自定义 MCP 撞上这些名字时
   * 会在装配层顶替内置 server 并继承其审批信任，因此创建 / 更新阶段直接拒收。
   * 省略时不做保留名校验（测试便利）。
   */
  getReservedMcpIds?(): string[];
}

export function registerMcpHandlers(registry: IpcHandlerRegistry, deps: McpHandlerDeps): void {
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_LIST, async () => {
    const servers = await listCustomMcpServers();
    return { servers };
  });

  // CRUD 成功后统一收尾：刷新 provider 数组 + 广播 + 失效 Codex app-server。
  async function afterChange(): Promise<void> {
    await deps.refreshProviders();
    deps.broadcastChanged();
    // Codex 失效放最后：即使它慢 / 抛错(busy 会话),UI 列表与 Claude 侧已即时生效。
    // 生产实现自身 best-effort;这里再包一层,保证 CRUD 结果不被 Codex 重启失败带崩。
    try {
      await deps.invalidateCodex?.();
    } catch {
      /* best-effort:Codex 失效失败不影响 CRUD 已落库的结果 */
    }
  }

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_CREATE, async (_event, input: unknown) => {
    const v = validateCustomMcpConfig(input, deps.getReservedMcpIds?.() ?? []);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomMcpConfig;
    if (await customMcpServerExists(config.id)) {
      throwIpcError('ALREADY_EXISTS', `custom mcp '${config.id}' already exists`);
    }
    await createCustomMcpServer(config);
    await afterChange();
    return { ok: true };
  });

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_UPDATE, async (_event, input: unknown) => {
    const v = validateCustomMcpConfig(input, deps.getReservedMcpIds?.() ?? []);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomMcpConfig;
    const updated = await updateCustomMcpServer(config.id, config);
    if (!updated) throwIpcError('NOT_FOUND', `custom mcp '${config.id}' not found`);
    await afterChange();
    return { ok: true };
  });

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_DELETE, async (_event, mcpId: unknown) => {
    if (typeof mcpId !== 'string' || mcpId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'mcpId required');
    }
    await deleteCustomMcpServer(mcpId);
    await afterChange();
    return { ok: true };
  });

  // token-only 后置刷新：renderer 在 safeStorage write/remove 完成后调用，消除竞态窗口。
  // 无 DB 改动；仅重跑 afterChange()（refreshProviders + broadcastChanged + invalidateCodex）。
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_REFRESH, async () => {
    await afterChange();
    return { ok: true };
  });
}
