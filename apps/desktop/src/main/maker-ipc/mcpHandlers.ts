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

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { CustomMcpListContext } from '../../shared/customMcp.js';
import { BOT_MODEL_CHAIN_MAX, type BotModelRoute } from '../../shared/botModelChain.js';
import type { BotProfileRuntimeDeps } from './botProfileRuntime.js';
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
  /** Same registered runtime catalog used by Bot capability tools and hydration. */
  listMcpServers(context: { agentKind: CustomMcpListContext['agentKind']; remoteHostId?: string }): ReturnType<NonNullable<BotProfileRuntimeDeps['listMcpServers']>>;
  resolveBotContext(sessionId: string, chain?: BotModelRoute[]): Promise<{
    agentKind: CustomMcpListContext['agentKind']; remoteHostId?: string;
  } | null>;
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
   * 登记空闲重试而不阻塞 CRUD）。测试可省略。
   */
  invalidateCodex?(): Promise<void>;
  /**
   * 内置 MCP server 名（生产 = getBuiltinMcpServerNames）。自定义 MCP 撞上这些名字时
   * 会在装配层顶替内置 server 并继承其审批信任，因此创建 / 更新阶段直接拒收。
   * 省略时不做保留名校验（测试便利）。
   */
  getReservedMcpIds?(): string[];
  /** Stable config + credential commit, used by original-task runtime reload. */
  runtimeChanged?(): void;
  ownerKey?(): string;
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
  const saves = new Map<string, {
    id: string; owner: string; done: Promise<void>; release(): void;
    write?: () => Promise<void>;
    committing?: boolean;
    operation?: Promise<{ ok: true }>;
    commitDecision?: boolean;
    preserveFailure: boolean;
  }>();
  const completed = new Map<string, string>();
  const failed = new Set<string>();
  const ownerKey = () => deps.ownerKey?.() ?? 'local';
  const key = (id: string) => JSON.stringify([ownerKey(), id]);
  function begin(id: string, event: unknown, preserveFailure: boolean) {
    if ([...saves.values()].some(save => save.id === id && save.owner === ownerKey())) {
      throwIpcError('PRECONDITION_FAILED', 'MCP configuration is already being saved');
    }
    const saveId = randomUUID();
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const save = { id, owner: ownerKey(), done, release, committing: false, preserveFailure };
    saves.set(saveId, save);
    const sender = (event as { sender?: {
      once?(name: string, callback: () => void): unknown;
      removeListener?(name: string, callback: () => void): unknown;
    } } | null)?.sender;
    if (sender?.once) {
      const destroyed = () => {
        if (saves.get(saveId) !== save || save.committing) return;
        if (save.preserveFailure) failed.add(JSON.stringify([save.owner, id]));
        saves.delete(saveId);
        save.release();
      };
      sender.once('destroyed', destroyed);
      save.release = () => { sender.removeListener?.('destroyed', destroyed); release(); };
    }
    return saveId;
  }
  const saveOptions = z.object({ deferRuntimeRefresh: z.literal(true) }).strict();
  async function persist(id: string, options: unknown, write: () => Promise<void>, event: unknown,
    preserveFailure = true) {
    const saveId = begin(id, event, preserveFailure);
    const save = saves.get(saveId)!;
    if (options !== undefined) {
      // Stage config in main until the existing encrypted secret IPC completes.
      // A rejected secure write must not leave a half-installed DB row behind.
      save.write = write;
      return { ok: true as const, saveId };
    }
    save.committing = true;
    let persisted = false;
    try {
      await write();
      persisted = true;
      if (save.owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
      await afterChange();
      failed.delete(key(id));
      return { ok: true as const };
    } catch (error) {
      if (persisted) failed.add(JSON.stringify([save.owner, id]));
      saves.delete(saveId);
      save.release();
      throw error;
    } finally {
      if (options === undefined) { saves.delete(saveId); save.release(); }
    }
  }
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_LIST, async (_event, context: unknown) => {
    const parsed = context === undefined ? undefined : listContextSchema.safeParse(context);
    if (parsed && !parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid MCP catalog context');
    const input = parsed?.data;
    const runtime = input?.botSessionId
      ? await deps.resolveBotContext(input.botSessionId, input.modelChain)
      : input ? { agentKind: input.agentKind } : undefined;
    if (input?.botSessionId && !runtime) throwIpcError('NOT_FOUND', 'Canonical Bot task not found');
    const servers = await listCustomMcpServers();
    if (!runtime) return { servers };
    const { agentKind } = runtime;
    const catalog = await deps.listMcpServers(runtime);
    const available = new Set(catalog
      .filter((entry) => entry.source === 'custom' && entry.available !== false)
      .map((entry) => entry.name));
    return { agentKind, servers: servers.map((server) => ({ ...server, available: available.has(server.id) })) };
  });

  // CRUD 成功后统一收尾：刷新 provider 数组 + 广播 + 失效 Codex app-server。
  async function afterChange(): Promise<void> {
    const owner = ownerKey();
    await deps.refreshProviders();
    if (owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
    deps.broadcastChanged();
    // Codex 失效放最后：即使它慢 / 抛错(busy 会话),UI 列表与 Claude 侧已即时生效。
    // 生产实现自身 best-effort;这里再包一层,保证 CRUD 结果不被 Codex 重启失败带崩。
    try {
      await deps.invalidateCodex?.();
    } catch {
      /* best-effort:Codex 失效失败不影响 CRUD 已落库的结果 */
    }
    if (owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
    deps.runtimeChanged?.();
  }

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_CREATE, async (_event, input: unknown, options: unknown) => {
    const owner = ownerKey();
    if (options !== undefined && !saveOptions.safeParse(options).success) throwIpcError('INVALID_PARAMS', 'Invalid MCP save options');
    const v = validateCustomMcpConfig(input, deps.getReservedMcpIds?.() ?? []);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomMcpConfig;
    if (await customMcpServerExists(config.id)) {
      throwIpcError('ALREADY_EXISTS', `custom mcp '${config.id}' already exists`);
    }
    if (owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
    return persist(config.id, options, async () => { await createCustomMcpServer(config); }, _event, false);
  });

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_UPDATE, async (_event, input: unknown, options: unknown) => {
    const owner = ownerKey();
    if (options !== undefined && !saveOptions.safeParse(options).success) throwIpcError('INVALID_PARAMS', 'Invalid MCP save options');
    const v = validateCustomMcpConfig(input, deps.getReservedMcpIds?.() ?? []);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomMcpConfig;
    if (!await customMcpServerExists(config.id)) throwIpcError('NOT_FOUND', `custom mcp '${config.id}' not found`);
    if (owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
    return persist(config.id, options, async () => {
      const updated = await updateCustomMcpServer(config.id, config);
      if (!updated) throwIpcError('NOT_FOUND', `custom mcp '${config.id}' not found`);
    }, _event);
  });

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_DELETE, async (_event, mcpId: unknown) => {
    if (typeof mcpId !== 'string' || mcpId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'mcpId required');
    }
    return persist(mcpId, undefined, async () => { await deleteCustomMcpServer(mcpId); }, _event);
  });

  // A modern receipt commits staged configuration after the encrypted secret write.
  // Older callers omit it and retain the existing token-only refresh behavior.
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_REFRESH, async (_event, input: unknown) => {
    if (input !== undefined) {
      const parsed = z.object({ saveId: z.string().uuid(), committed: z.boolean() }).strict().safeParse(input);
      if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid MCP save receipt');
      if (completed.get(parsed.data.saveId) === ownerKey() && parsed.data.committed) return { ok: true };
      const save = saves.get(parsed.data.saveId);
      if (!save || save.owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP save belongs to an inactive owner');
      if (save.operation) {
        if (save.commitDecision !== parsed.data.committed) throwIpcError('PRECONDITION_FAILED', 'MCP save is already finalizing');
        return save.operation;
      }
      save.commitDecision = parsed.data.committed;
      const operation = Promise.resolve().then(async (): Promise<{ ok: true }> => {
        try {
          if (saves.get(parsed.data.saveId) !== save || save.owner !== ownerKey()) {
            throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
          }
          if (!parsed.data.committed) {
            throwIpcError('PRECONDITION_FAILED', 'MCP credential save failed');
          }
          save.committing = true;
          // Once a config write starts, its outcome may be uncertain. Existing
          // endpoints also need recovery after credential changes. A new MCP
          // abandoned before any config write cannot affect healthy runtimes.
          save.preserveFailure = true;
          await save.write?.();
          if (save.owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
          await afterChange();
          if (save.owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
          failed.delete(key(save.id));
          completed.set(parsed.data.saveId, save.owner);
          if (completed.size > 256) completed.delete(completed.keys().next().value!);
          return { ok: true };
        } catch (error) {
          if (save.preserveFailure) failed.add(JSON.stringify([save.owner, save.id]));
          throw error;
        } finally {
          saves.delete(parsed.data.saveId);
          save.release();
        }
      });
      save.operation = operation;
      return operation;
    }
    await afterChange();
    return { ok: true };
  });
  return {
    hasPendingSave(): boolean { return [...saves.values()].some(save => save.owner === ownerKey()); },
    async waitForStableConfiguration(): Promise<void> {
      const owner = ownerKey();
      for (;;) {
        const pending = [...saves.values()].filter(save => save.owner === owner);
        if (!pending.length) break;
        await Promise.all(pending.map(save => save.done));
        if (owner !== ownerKey()) throwIpcError('PRECONDITION_FAILED', 'MCP configuration owner changed');
      }
      if ([...failed].some(value => JSON.parse(value)[0] === owner)) {
        throwIpcError('PRECONDITION_FAILED', 'MCP configuration save failed; save the configuration again');
      }
    },
    dispose() { saves.forEach(save => save.release()); saves.clear(); failed.clear(); completed.clear(); },
  };
}
