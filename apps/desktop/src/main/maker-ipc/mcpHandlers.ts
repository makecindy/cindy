/**
 * mcp:custom:* IPC handlers —— 用户自定义 MCP 服务器**配置** CRUD（配置入 localDb）。
 *
 *   - MCP_CUSTOM_LIST（只读：列出当前账号的自定义 MCP）。
 *   - MCP_CUSTOM_CREATE / UPDATE / DELETE（CRUD）。
 *
 * bearer token 仍由 renderer 走通用 safe-storage IPC；stdio 环境变量与配置在 Main 的
 * 同一 per-MCP mutation queue 内暂存 / 回滚，避免出现已生效配置缺少凭证的半提交状态。
 *
 * 副作用（CRUD 成功后刷新两个 agent 的 mcpProviders 数组 + 广播 MCP_CHANGED）经 deps 注入，
 * handler body 可脱 Electron 用 IpcHarness + 内存 db 直接 invoke 单测（规则 14）。
 */

import { throwIpcError } from '../utils/ipcValidate.js';
import {
  createCustomMcpServer,
  customMcpServerExists,
  deleteCustomMcpServer,
  getCustomMcpServer,
  listCustomMcpServers,
  updateCustomMcpServer,
  validateCustomMcpConfig,
  type CustomMcpConfig,
} from '../maker-host/custom-mcp-store.js';
import { filterCustomMcpEnv } from '../secrets/providerSecretStore.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface McpHandlerDeps {
  /** stdio config can start an arbitrary executable; only the trusted top-level app Renderer may mutate it. */
  assertTrustedSender?(event: unknown): void;
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
  /** Strict secret snapshot + mutation primitives; production uses owner-scoped safeStorage. */
  readCustomMcpEnvForMutation(mcpId: string): string | null;
  writeCustomMcpEnvForMutation(mcpId: string, value: string): boolean;
  removeCustomMcpEnvForMutation(mcpId: string): { success: boolean; error?: string };
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
  function assertTrustedMutationSender(event: unknown): void {
    if (!deps.assertTrustedSender)
      throwIpcError('PERMISSION_DENIED', 'sender trust guard unavailable');
    deps.assertTrustedSender(event);
  }

  const mutationTails = new Map<string, Promise<void>>();
  const withMcpMutation = async <T>(mcpId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = mutationTails.get(mcpId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    mutationTails.set(mcpId, tail);
    try {
      await previous.catch(() => undefined);
      return await operation();
    } finally {
      release();
      if (mutationTails.get(mcpId) === tail) mutationTails.delete(mcpId);
    }
  };

  const parseEnvInput = (value: unknown): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throwIpcError('INVALID_PARAMS', 'stdio env must be an object');
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const filtered = filterCustomMcpEnv(value);
    if (
      entries.length !== Object.keys(filtered).length ||
      entries.some(([key, entryValue]) => filtered[key] !== entryValue)
    ) {
      throwIpcError('INVALID_PARAMS', 'stdio env contains an invalid name or value');
    }
    return filtered;
  };

  const restoreEnv = (mcpId: string, previous: string | null): boolean =>
    previous === null
      ? deps.removeCustomMcpEnvForMutation(mcpId).success
      : deps.writeCustomMcpEnvForMutation(mcpId, previous);

  const stageEnv = (mcpId: string, replacement: string | null): string | null => {
    let previous: string | null;
    try {
      previous = deps.readCustomMcpEnvForMutation(mcpId);
    } catch {
      throwIpcError('INTERNAL', 'failed to read existing custom MCP environment');
    }
    const succeeded =
      replacement === null
        ? deps.removeCustomMcpEnvForMutation(mcpId).success
        : deps.writeCustomMcpEnvForMutation(mcpId, replacement);
    if (succeeded) return previous;
    if (!restoreEnv(mcpId, previous)) {
      throwIpcError(
        'INTERNAL',
        'custom MCP environment update failed and could not be rolled back',
      );
    }
    throwIpcError('INTERNAL', 'failed to update custom MCP environment');
  };

  registry.handle(
    MAKER_INVOKE.MCP_CUSTOM_CREATE,
    async (event, input: unknown, envInput?: unknown) => {
      assertTrustedMutationSender(event);
      const v = validateCustomMcpConfig(input, deps.getReservedMcpIds?.() ?? []);
      if (!v.ok) throwIpcError(v.code, v.message);
      const config = input as CustomMcpConfig;
      const env = parseEnvInput(envInput);
      if (config.transport === 'stdio' && env === undefined) {
        throwIpcError('INVALID_PARAMS', 'stdio env snapshot required');
      }
      if (config.transport !== 'stdio' && env !== undefined) {
        throwIpcError('INVALID_PARAMS', 'stdio env is only valid for stdio transport');
      }
      return withMcpMutation(config.id, async () => {
        if (await customMcpServerExists(config.id)) {
          throwIpcError('ALREADY_EXISTS', `custom mcp '${config.id}' already exists`);
        }
        const envSnapshot =
          config.transport === 'stdio' ? stageEnv(config.id, JSON.stringify(env)) : undefined;
        try {
          await createCustomMcpServer(config);
        } catch (error) {
          if (envSnapshot !== undefined && !restoreEnv(config.id, envSnapshot)) {
            throwIpcError(
              'INTERNAL',
              'custom MCP creation failed and environment could not be rolled back',
            );
          }
          throw error;
        }
        await afterChange();
        return { ok: true };
      });
    },
  );

  registry.handle(
    MAKER_INVOKE.MCP_CUSTOM_UPDATE,
    async (event, input: unknown, envInput?: unknown) => {
      assertTrustedMutationSender(event);
      const v = validateCustomMcpConfig(input, deps.getReservedMcpIds?.() ?? []);
      if (!v.ok) throwIpcError(v.code, v.message);
      const config = input as CustomMcpConfig;
      const env = parseEnvInput(envInput);
      if (config.transport !== 'stdio' && env !== undefined) {
        throwIpcError('INVALID_PARAMS', 'stdio env is only valid for stdio transport');
      }
      return withMcpMutation(config.id, async () => {
        if (!(await getCustomMcpServer(config.id))) {
          throwIpcError('NOT_FOUND', `custom mcp '${config.id}' not found`);
        }
        const envReplacement =
          config.transport === 'stdio'
            ? env === undefined
              ? undefined
              : JSON.stringify(env)
            : null;
        const envSnapshot =
          envReplacement === undefined ? undefined : stageEnv(config.id, envReplacement);
        let updated: CustomMcpConfig | null;
        try {
          updated = await updateCustomMcpServer(config.id, config);
        } catch (error) {
          if (envSnapshot !== undefined && !restoreEnv(config.id, envSnapshot)) {
            throwIpcError(
              'INTERNAL',
              'custom MCP update failed and environment could not be rolled back',
            );
          }
          throw error;
        }
        if (!updated) {
          if (envSnapshot !== undefined && !restoreEnv(config.id, envSnapshot)) {
            throwIpcError(
              'INTERNAL',
              'custom MCP update failed and environment could not be rolled back',
            );
          }
          throwIpcError('NOT_FOUND', `custom mcp '${config.id}' not found`);
        }
        await afterChange();
        return { ok: true };
      });
    },
  );

  registry.handle(MAKER_INVOKE.MCP_CUSTOM_DELETE, async (event, mcpId: unknown) => {
    assertTrustedMutationSender(event);
    if (typeof mcpId !== 'string' || mcpId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'mcpId required');
    }
    return withMcpMutation(mcpId, async () => {
      // Deleting the config must not depend on decrypting its optional env snapshot. If
      // safeStorage is unavailable or the snapshot is unreadable, remove the DB row first
      // and make secret cleanup best-effort; otherwise a broken secret store can strand a
      // user-visible MCP that they can no longer delete.
      await deleteCustomMcpServer(mcpId);
      try {
        deps.removeCustomMcpEnvForMutation(mcpId);
      } catch {
        // Best-effort cleanup: the config is already deleted and there is no safe rollback
        // that can restore a secret whose storage is unavailable.
      }
      await afterChange();
      return { ok: true };
    });
  });

  // token-only 后置刷新：renderer 在 safeStorage write/remove 完成后调用，消除竞态窗口。
  // 无 DB 改动；仅重跑 afterChange()（refreshProviders + broadcastChanged + invalidateCodex）。
  registry.handle(MAKER_INVOKE.MCP_CUSTOM_REFRESH, async (event) => {
    assertTrustedMutationSender(event);
    await afterChange();
    return { ok: true };
  });
}
