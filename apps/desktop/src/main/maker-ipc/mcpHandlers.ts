/**
 * mcp:custom:* IPC handlers —— 用户自定义 MCP 服务器**配置** CRUD（配置入 localDb）。
 *
 *   - MCP_CUSTOM_LIST（只读：列出当前账号的自定义 MCP）。
 *   - MCP_CUSTOM_CREATE / UPDATE / DELETE（CRUD）。
 *
 * bearer token 随原生表单意图交 Main 保存，不进配置列表和回执。
 * 配置和凭证串行更新完成后才发布，stdio 切换不会继承旧 HTTP token。
 *
 * 副作用（CRUD 成功后刷新两个 agent 的 mcpProviders 数组 + 广播 MCP_CHANGED）经 deps 注入，
 * handler body 可脱 Electron 用 IpcHarness + 内存 db 直接 invoke 单测（规则 14）。
 */

import { z } from 'zod';
import { extractIpcError } from '../../shared/ipcError.js';
import type { IpcErrorCode } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import type { CustomMcpListContext, CustomMcpListEntry, CustomMcpInput, CustomMcpTokenChange } from '../../shared/customMcp.js';
import type { McpDuplicateChoice, McpDuplicateReport } from '../../shared/customMcp.js';
import { BOT_MODEL_CHAIN_MAX, type BotModelRoute } from '../../shared/botModelChain.js';
import type { BotProfileRuntimeDeps } from './botProfileRuntime.js';
import {
  createCustomMcpServer,
  deleteCustomMcpServer,
  readCustomMcpServers,
  listCustomMcpRuntimeGenerations,
  updateCustomMcpServer,
  validateCustomMcpInput,
  type CustomMcpConfig,
} from '../maker-host/custom-mcp-store.desktop.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-settings');

export interface McpHandlerDeps {
  listDuplicates?(): Promise<McpDuplicateReport>;
  chooseDuplicate?(id: string, choice: McpDuplicateChoice | null): Promise<boolean>;
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
   * 内置 MCP server 名（生产 = getBuiltinMcpServerNames）。自定义 MCP 撞上这些名字时
   * 会在装配层顶替内置 server 并继承其审批信任，因此创建 / 更新阶段直接拒收。
   * 省略时不做保留名校验（测试便利）。
   */
  getReservedMcpIds?(): string[];
  /** Main-only token write for new-computer setup (production = safeStorage, same key as Settings). */
  storeMcpToken?(mcpId: string, token: string): boolean;
  /** False means the obsolete credential may still exist: do not publish a new transport. */
  removeMcpToken(mcpId: string): boolean;
}

const tokenChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z.object({ action: z.literal('set'), value: z.string().trim().min(1) }).strict(),
]);

function parseTokenChange(input: unknown): CustomMcpTokenChange {
  if (input === undefined) return { action: 'keep' };
  const parsed = tokenChangeSchema.safeParse(input);
  if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid MCP token change');
  return parsed.data;
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

/** Internal receipt only; never returned by the public MCP create IPC. */
export interface SetupMcpCreateReceipt {
  configurationSaved: true;
  token: 'not-requested' | 'saved' | 'failed';
  refreshError: IpcErrorCode | null;
}
let mainProcessMcpSetupCreate: ((input: unknown, token: string | null) => Promise<SetupMcpCreateReceipt>) | null = null;

export function createCustomMcpServerForSetup(input: unknown, token: string | null): Promise<SetupMcpCreateReceipt> {
  if (!mainProcessMcpSetupCreate) throw new Error('MCP handlers are not registered');
  return mainProcessMcpSetupCreate(input, token);
}

let mainProcessMcpCreate: ((input: unknown, token: string | null) => Promise<void>) | null = null;

/**
 * New-computer setup (docs/product-rules/new-device-setup-migration.md) creates a server together
 * with the access token copied from the other computer: same validation and refresh as the
 * settings page, and the token goes straight to this computer's secure storage.
 */
export function createCustomMcpServerFromMain(input: unknown, token: string | null): Promise<void> {
  if (!mainProcessMcpCreate) throw new Error('MCP handlers are not registered');
  return mainProcessMcpCreate(input, token);
}

export function registerMcpHandlers(registry: IpcHandlerRegistry, deps: McpHandlerDeps): void {
  // A late token write from one save must never attach to the next save's transport.
  // Capture the owner before queuing so an account switch cannot redirect pending writes.
  let mutations: Promise<unknown> = Promise.resolve();
  function mutate<T>(operation: (assertOwner: () => void) => Promise<T>): Promise<T> {
    const owner = getCurrentDbClientSnapshot();
    const assertOwner = () => {
      if (!owner || getCurrentDbClientSnapshot() !== owner) throwIpcError('PERMISSION_DENIED', 'MCP settings owner changed');
    };
    const result = mutations.then(() => { assertOwner(); return operation(assertOwner); });
    mutations = result.catch(() => {});
    return result;
  }
  function clearBearer(id: string): void {
    let removed = false;
    try { removed = deps.removeMcpToken(id); } catch { /* Never return a credential storage exception. */ }
    if (!removed) throwIpcError('INTERNAL', 'Could not clear the previous MCP credential');
  }
  function saveBearer(id: string, token: string): boolean {
    let saved = false;
    try { saved = deps.storeMcpToken?.(id, token) === true; } catch { /* Never log credential exceptions. */ }
    if (!saved) log.warn('MCP configuration saved but its optional bearer credential could not be saved');
    return saved;
  }
  registry.handle(MAKER_INVOKE.MCP_DUPLICATES_LIST, async (event) => {
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    return deps.listDuplicates?.() ?? { connections: [], complete: false };
  });
  registry.handle(MAKER_INVOKE.MCP_DUPLICATES_CHOOSE, async (event, input: unknown) => {
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    const parsed = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/),
      choice: z.enum(['cindy', 'claude', 'both']).nullable() }).strict().safeParse(input);
    if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid MCP duplicate choice');
    if (!await deps.chooseDuplicate?.(parsed.data.id, parsed.data.choice)) {
      throwIpcError('NOT_FOUND', 'MCP connections changed; check the current connections');
    }
    deps.broadcastChanged();
    return { ok: true };
  });
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_LIST, async (event, context: unknown) => {
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    const parsed = context === undefined ? undefined : listContextSchema.safeParse(context);
    if (parsed && !parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid MCP catalog context');
    const input = parsed?.data;
    const runtime = input?.botSessionId
      ? await deps.resolveBotContext(input.botSessionId, input.modelChain)
      : input ? { agentKind: input.agentKind } : undefined;
    if (input?.botSessionId && !runtime) throwIpcError('NOT_FOUND', 'Canonical Bot task not found');
    const result = await readCustomMcpServers();
    const unreadable = result.unreadableServers.length > 0 ? { unreadableServers: result.unreadableServers } : {};
    const servers: CustomMcpListEntry[] = result.servers.map(config => {
      if (config.transport !== 'stdio') return config;
      const { env, ...publicConfig } = config;
      return { ...publicConfig, envKeys: Object.keys(env).sort() };
    });
    if (!runtime) return { servers, ...unreadable };
    const { agentKind } = runtime;
    const catalog = await deps.listMcpServers(runtime);
    const available = new Set(catalog
      .filter((entry) => entry.source === 'custom' && entry.available !== false)
      .map((entry) => entry.name));
    return { agentKind, servers: servers.map((server) => ({ ...server, available: available.has(server.id) })), ...unreadable };
  });

  // 保存设置只发布配置，不关闭现有会话或重建其共享运行环境。
  async function afterChange(): Promise<void> {
    await deps.refreshProviders();
    deps.broadcastChanged();
  }

  async function createConfiguration(input: unknown, assertOwner: () => void): Promise<CustomMcpConfig> {
    const v = validateCustomMcpInput(input, deps.getReservedMcpIds?.() ?? []);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomMcpInput;
    if ((await listCustomMcpRuntimeGenerations()).some(row => row.id === config.id)) {
      throwIpcError('ALREADY_EXISTS', `custom mcp '${config.id}' already exists`);
    }
    assertOwner();
    if (config.transport !== 'stdio') clearBearer(config.id);
    const created = await createCustomMcpServer(config);
    assertOwner();
    if (config.transport === 'stdio') {
      try { deps.removeMcpToken(config.id); } catch { /* unused by stdio; checked again when leaving it */ }
    }
    return created;
  }

  async function createServer(input: unknown, token: string | null, assertOwner: () => void): Promise<void> {
    const config = await createConfiguration(input, assertOwner);
    assertOwner();
    // Like the settings page: a token that cannot be stored leaves the server to be completed there
    // (the one-time checklist keeps it until a token is saved).
    if (token && config.transport !== 'stdio') saveBearer(config.id, token);
    await afterChange();
  }

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_CREATE, async (event, input: unknown, tokenInput: unknown) => {
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    const change = parseTokenChange(tokenInput);
    await mutate(assertOwner => createServer(input, change.action === 'set' ? change.value : null, assertOwner));
    return { ok: true };
  });
  mainProcessMcpCreate = (input, token) => mutate(assertOwner => createServer(input, token, assertOwner));
  mainProcessMcpSetupCreate = (input, token) => mutate(async assertOwner => {
    const config = await createConfiguration(input, assertOwner);
    assertOwner();
    let tokenResult: SetupMcpCreateReceipt['token'] = 'not-requested';
    if (token && config.transport !== 'stdio') tokenResult = saveBearer(config.id, token) ? 'saved' : 'failed';
    let refreshError: IpcErrorCode | null = null;
    try {
      await afterChange();
    } catch (error) {
      // Return only a registered code, never an exception message or credential value.
      refreshError = extractIpcError(error)?.code ?? 'INTERNAL';
    }
    return { configurationSaved: true, token: tokenResult, refreshError };
  });

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_UPDATE, async (event, input: unknown, tokenInput: unknown) => {
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    const v = validateCustomMcpInput(input, deps.getReservedMcpIds?.() ?? []);
    if (!v.ok) throwIpcError(v.code, v.message);
    const config = input as CustomMcpInput;
    const change = parseTokenChange(tokenInput);
    await mutate(async assertOwner => {
      const previous = (await listCustomMcpRuntimeGenerations()).find(row => row.id === config.id);
      if (!previous) throwIpcError('NOT_FOUND', `custom mcp '${config.id}' not found`);
      assertOwner();
      // A failed conversion into stdio must retain the working remote credential.
      // Leaving stdio is different: its old bearer must be gone before any remote URL is stored.
      if (previous.transport === 'stdio' && config.transport !== 'stdio') clearBearer(config.id);
      const updated = await updateCustomMcpServer(config.id, config);
      if (!updated) throwIpcError('NOT_FOUND', `custom mcp '${config.id}' not found`);
      assertOwner();
      if (config.transport === 'stdio' && previous.transport !== 'stdio') {
        try { deps.removeMcpToken(config.id); } catch { /* unused by stdio; checked again when leaving it */ }
      } else if (config.transport !== 'stdio') {
        if (change.action === 'clear') clearBearer(config.id);
        else if (change.action === 'set') saveBearer(config.id, change.value);
      }
      await afterChange();
    });
    return { ok: true };
  });

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_DELETE, async (event, mcpId: unknown) => {
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    if (typeof mcpId !== 'string' || mcpId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'mcpId required');
    }
    await mutate(async assertOwner => {
      await deleteCustomMcpServer(mcpId);
      assertOwner();
      // Deletion must revoke the server even if orphan cleanup fails. Creation always clears it first.
      try { deps.removeMcpToken(mcpId); } catch { /* best-effort orphan cleanup */ }
      await afterChange();
    });
    return { ok: true };
  });

  // 兼容旧 token-only 调用方；原生设置已通过单次保存 IPC 处理凭证和发布。
  // 无 DB 改动；仅重跑 afterChange()（refreshProviders + broadcastChanged）。
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_REFRESH, async (event) => {
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    await mutate(() => afterChange());
    return { ok: true };
  });
}
