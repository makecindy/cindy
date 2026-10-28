/**
 * mcp:custom:* IPC handlers —— 用户自定义 MCP 服务器**配置** CRUD（配置入 localDb）。
 *
 *   - MCP_CUSTOM_LIST（只读：列出当前账号的自定义 MCP）。
 *   - MCP_CUSTOM_CREATE / UPDATE / DELETE（CRUD）。
 *
 * 凭证仅经本机可信 Renderer 的窄 IPC 交给 Main；加密完成后再原子保存配置引用。
 * 列表只返回存在性与请求头名称，通用 safe-storage IPC 不开放 MCP 凭证。
 *
 * 副作用（CRUD 成功后刷新两个 agent 的 mcpProviders 数组 + 广播 MCP_CHANGED）经 deps 注入，
 * handler body 可脱 Electron 用 IpcHarness + 内存 db 直接 invoke 单测（规则 14）。
 */

import { z } from 'zod';
import { deleteMcpConfig, listMcpSummaries, saveMcpConfig } from '../maker-host/custom-mcp-config-service.js';
import type { CustomMcpMutation } from '../../shared/mcpSetup.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { CustomMcpListContext } from '../../shared/customMcp.js';
import { BOT_MODEL_CHAIN_MAX, type BotModelRoute } from '../../shared/botModelChain.js';
import type { BotProfileRuntimeDeps } from './botProfileRuntime.js';
import {
  customMcpServerExists,
  validateCustomMcpConfig,
} from '../maker-host/custom-mcp-store.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface McpHandlerDeps {
  assertLocal?(event: unknown): void;
  /** Same registered runtime catalog used by Bot capability tools and hydration. */
  listMcpServers(context: { agentKind: CustomMcpListContext['agentKind']; remoteHostId?: string }): ReturnType<NonNullable<BotProfileRuntimeDeps['listMcpServers']>>;
  resolveBotContext(sessionId: string, chain?: BotModelRoute[]): Promise<{
    agentKind: CustomMcpListContext['agentKind']; remoteHostId?: string;
  } | null>;
  /** CRUD 成功后刷新 agent mcpProviders 数组（生产 = refreshCustomMcpProviders）。 */
  refreshProviders(): Promise<void | boolean>;
  /** CRUD 成功后广播变更（生产 = 向所有窗口 send MCP_CHANGED）。 */
  broadcastChanged(): void;
  /**
   * 失效 Codex 本地 app-server 使新 MCP 配置对下个 codex 会话生效（可选，生产注入）。
   *
   * refreshProviders 只更新内存 mcpProviders 数组；Claude 每个会话重新 buildMcpServers 即时生效，
   * 但 Codex 的 extraArgs/extraEnv 在 codexEnvironment 的模块级 `cached` 里被冻住，后续会话复用旧
   * spawn 配置——不失效则新增 server 不出现、删除 / 换 token 仍残留，直到重启 app。生产实现清
   * codexEnvironment 缓存 + dispose app-server（与 slack 变更同款,best-effort，busy 会话软重启失败
   * 登记空闲重试而不阻塞 CRUD）。测试可省略。
   */
  invalidateCodex?(): Promise<void | boolean | 'deferred'>;
  /**
   * 内置 MCP server 名（生产 = getBuiltinMcpServerNames）。自定义 MCP 撞上这些名字时
   * 会在装配层顶替内置 server 并继承其审批信任，因此创建 / 更新阶段直接拒收。
   * 省略时不做保留名校验（测试便利）。
   */
  getReservedMcpIds?(): string[];
}

const listContextSchema = z.object({
  agentKind: z.enum(['claude-code', 'codex', 'pi']),
  botSessionId: z.string().min(1).optional(),
  modelChain: z.array(z.object({
    harness: z.enum(['claude', 'codex', 'pi']),
    agentDeviceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).nullable().optional(),
    model: z.string().trim().min(1),
    providerId: z.string().nullable(),
    effort: z.string(),
    fastMode: z.union([z.boolean(), z.literal('ultrafast')]),
  })).min(1).max(BOT_MODEL_CHAIN_MAX).optional(),
}).refine((value) => value.modelChain === undefined || value.botSessionId !== undefined);

export function registerMcpHandlers(registry: IpcHandlerRegistry, deps: McpHandlerDeps) {
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_LIST, async (_event, context: unknown) => {
    const parsed = context === undefined ? undefined : listContextSchema.safeParse(context);
    if (parsed && !parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid MCP catalog context');
    const input = parsed?.data;
    const runtime = input?.botSessionId
      ? await deps.resolveBotContext(input.botSessionId, input.modelChain)
      : input ? { agentKind: input.agentKind } : undefined;
    if (input?.botSessionId && !runtime) throwIpcError('NOT_FOUND', 'Canonical Bot task not found');
    const servers = await listMcpSummaries();
    if (!runtime) return { servers };
    const { agentKind } = runtime;
    const catalog = await deps.listMcpServers(runtime);
    const available = new Set(catalog
      .filter((entry) => entry.source === 'custom' && entry.available !== false)
      .map((entry) => entry.name));
    return { agentKind, servers: servers.map((server) => ({ ...server, available: available.has(server.id) })) };
  });

  // CRUD 成功后统一收尾：刷新 provider 数组 + 广播 + 失效 Codex app-server。
  async function afterChange(): Promise<boolean | 'deferred'> {
    const scope = activeOwnerScopeKey();
    let refreshed = await deps.refreshProviders() !== false;
    if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) return false;
    deps.broadcastChanged();
    // Codex 失效放最后：即使它慢 / 抛错(busy 会话),UI 列表与 Claude 侧已即时生效。
    // 生产实现自身 best-effort;这里再包一层,保证 CRUD 结果不被 Codex 重启失败带崩。
    try {
      const activation = await deps.invalidateCodex?.();
      if (activation === false) refreshed = false;
      if (refreshed && activation === 'deferred') return 'deferred';
    } catch {
      refreshed = false;
      /* best-effort:Codex 失效失败不影响 CRUD 已落库的结果 */
    }
    return refreshed;
  }

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_CREATE, async (_event, input: unknown) => {
    deps.assertLocal?.(_event);
    const v = validateCustomMcpConfig(input, deps.getReservedMcpIds?.() ?? []);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomMcpMutation;
    if (await customMcpServerExists(config.id)) {
      throwIpcError('ALREADY_EXISTS', `custom mcp '${config.id}' already exists`);
    }
    await saveMcpConfig(config, true, { reservedIds: deps.getReservedMcpIds?.() });
    await afterChange();
    return { ok: true };
  });

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_UPDATE, async (_event, input: unknown) => {
    deps.assertLocal?.(_event);
    const v = validateCustomMcpConfig(input, deps.getReservedMcpIds?.() ?? []);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomMcpMutation;
    if (!await customMcpServerExists(config.id)) throwIpcError('NOT_FOUND', 'Custom MCP not found');
    await saveMcpConfig(config, false, { reservedIds: deps.getReservedMcpIds?.() });
    await afterChange();
    return { ok: true };
  });

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_DELETE, async (_event, mcpId: unknown) => {
    deps.assertLocal?.(_event);
    if (typeof mcpId !== 'string' || mcpId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'mcpId required');
    }
    await deleteMcpConfig(mcpId);
    await afterChange();
    return { ok: true };
  });

  // token-only 后置刷新：renderer 在 safeStorage write/remove 完成后调用，消除竞态窗口。
  // 无 DB 改动；仅重跑 afterChange()（refreshProviders + broadcastChanged + invalidateCodex）。
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_REFRESH, async () => {
    await afterChange();
    return { ok: true };
  });
  return afterChange;
}
