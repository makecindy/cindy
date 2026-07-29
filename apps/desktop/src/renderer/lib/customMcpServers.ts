/**
 * customMcpServers —— 自定义 MCP「配置 + 可选 bearer token」的 renderer 侧写入编排。
 *
 * 配置走 maker IPC（入 localDb）；token 走通用 safeStorage IPC。stdio 环境变量随配置
 * 一并交给 Main，在同一 mutation queue 内写入 owner-scoped safeStorage 并支持失败回滚。
 *
 * 顺序约定：
 *   - create：先写配置（IPC 在重名 / 非法时 reject，避免误覆盖既有同 id 的 token），成功后存 token。
 *   - update：先写配置，成功后按 clearToken 标志决定 token 处理：
 *       clearToken=true  → 用户明确清空字段 → 移除已存 token（撤销鉴权）。
 *       clearToken=false → 字段为空但尚未加载完成，或用户未动字段 → 保留已存 token（留空不改）。
 *   - delete：先删配置，再清 token（幂等）。
 */

import { customMcpEnvStorageKey, customMcpSecretStorageKey } from '@/../shared/providerSecrets';

import type { CustomMcpConfig } from '@/../shared/customMcp';

/** 读取该 MCP 本机已存的明文 token；无 / 读失败返回 null。用于编辑态回填。 */
export async function readCustomMcpToken(mcpId: string): Promise<string | null> {
  try {
    const v = await window.electronAPI.safeStorageRead(customMcpSecretStorageKey(mcpId));
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** stdio env is encrypted as one JSON document, so values never enter localDb. */
export async function readCustomMcpEnv(mcpId: string): Promise<Record<string, string> | null> {
  try {
    const raw = await window.electronAPI.safeStorageRead(customMcpEnvStorageKey(mcpId));
    if (raw === null) return null;
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  } catch {
    return null;
  }
}

/** 列出全部自定义 MCP。 */
export async function listCustomMcpServers(): Promise<CustomMcpConfig[]> {
  const res = await window.electronAPI.maker.listCustomMcpServers();
  return res.servers;
}

/** 新建：先写配置（reject 时不碰 token），成功后存 token；无 token 时清除同 id 可能遗留的旧 key。 */
export async function createCustomMcpServer(
  config: CustomMcpConfig,
  token: string,
  env: Record<string, string> = {},
): Promise<void> {
  await window.electronAPI.maker.createCustomMcpServer(
    config,
    config.transport === 'stdio' ? env : undefined,
  );
  const t = token.trim();
  if (t) {
    // token 是可选字段：存储失败不阻断 create 事务（配置已入库，用户可在「编辑」里补录）。
    // safeStorageStore 在 safeStorage 不可用时返回 false 而不是 throw，需单独检查。
    try {
      const ok = await window.electronAPI.safeStorageStore(customMcpSecretStorageKey(config.id), t);
      if (!ok)
        console.warn(
          '[customMcpServers] safeStorageStore returned false (safeStorage unavailable) — token not saved',
        );
    } catch (err) {
      console.warn('[customMcpServers] safeStorageStore failed for new MCP token (non-fatal)', err);
    }
  } else {
    try {
      await window.electronAPI.safeStorageRemove(customMcpSecretStorageKey(config.id));
    } catch {
      /* 无旧 token 时 remove 无害 */
    }
  }
  // 远程 token 在配置 IPC 后落盘，需要第二次刷新；stdio env 已在 Main 事务内生效。
  try {
    await window.electronAPI.maker.refreshCustomMcpCodex();
  } catch {
    /* best-effort */
  }
}

/**
 * 编辑：先写配置，成功后处理 token。
 * - token 非空 → 写入新 token。
 * - token 为空 + clearToken=true → 移除已存 token（用户明确清空字段 = 撤销鉴权）。
 * - token 为空 + clearToken=false → 不动 safeStorage（async 回填未完成 / 用户未改）。
 */
export async function updateCustomMcpServer(
  config: CustomMcpConfig,
  token: string,
  clearToken: boolean,
  env?: Record<string, string>,
): Promise<void> {
  await window.electronAPI.maker.updateCustomMcpServer(config, env);
  const t = token.trim();
  let secretChanged = false;
  if (config.transport === 'stdio') {
    try {
      await window.electronAPI.safeStorageRemove(customMcpSecretStorageKey(config.id));
    } catch {
      /* stdio 不读取 bearer token；清理失败不影响配置更新。 */
    }
  } else if (t) {
    // token 是可选字段：存储失败不阻断 update 事务（配置已入库），与 create 路径保持一致。
    // safeStorageStore 在 safeStorage 不可用时返回 false 而不是 throw，需单独检查。
    try {
      const ok = await window.electronAPI.safeStorageStore(customMcpSecretStorageKey(config.id), t);
      if (!ok)
        console.warn(
          '[customMcpServers] safeStorageStore returned false (safeStorage unavailable) — token not saved',
        );
      else secretChanged = true;
    } catch (err) {
      console.warn('[customMcpServers] safeStorageStore failed on update (non-fatal)', err);
    }
  } else if (clearToken) {
    try {
      await window.electronAPI.safeStorageRemove(customMcpSecretStorageKey(config.id));
      secretChanged = true;
    } catch {
      /* 清理失败不影响配置更新 */
    }
  }
  // stdio env 已随配置在 Main 内刷新；这里只为另行落盘的远程 token 再刷新一次。
  if (secretChanged) {
    try {
      await window.electronAPI.maker.refreshCustomMcpCodex();
    } catch {
      /* best-effort */
    }
  }
}

/** 删除：先删配置，再清 token（幂等，失败忽略）。 */
export async function deleteCustomMcpServer(mcpId: string): Promise<void> {
  await window.electronAPI.maker.deleteCustomMcpServer(mcpId);
  try {
    await window.electronAPI.safeStorageRemove(customMcpSecretStorageKey(mcpId));
  } catch {
    /* token 清理失败无害：孤儿 .enc 不会被任何 provider 引用。 */
  }
}
