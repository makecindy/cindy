/**
 * customMcpServers —— 自定义 MCP「配置 + 可选 bearer token」的 renderer 侧写入编排。
 *
 * 配置走 maker IPC（入 localDb）；token 走通用 safeStorage IPC（`mcp_token_<id>`，本地加密；
 * main 的 CustomMcpProvider resolve 时读出，Claude 合成 Authorization 头 / Codex 注入 env）。
 *
 * create/update 先由 main 校验并暂存配置，处理完 safeStorage 后再提交配置与刷新。
 * clearToken=true 表示明确移除密钥；空值且 clearToken=false 保留原密钥。
 * delete 先删配置，再清 token（幂等）。
 */

import { i18n } from '@/i18n';
import { customMcpSecretStorageKey } from '@/../shared/providerSecrets';

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

/** 列出全部自定义 MCP。 */
export async function listCustomMcpServers(): Promise<CustomMcpConfig[]> {
  const res = await window.electronAPI.maker.listCustomMcpServers();
  return res.servers;
}

/** Configuration stays behind a main-owned save receipt until credentials are
 * persisted. The existing secret IPC retains its encrypted device-link route. */
async function saveWithCredential(
  config: CustomMcpConfig,
  token: string,
  clearToken: boolean,
  create: boolean,
): Promise<void> {
  const maker = window.electronAPI.maker;
  const receipt = await (create ? maker.createCustomMcpServer : maker.updateCustomMcpServer)(
    config, { deferRuntimeRefresh: true },
  );
  let credentialComplete = false;
  try {
    const value = token.trim();
    if (value) {
      if (!await window.electronAPI.safeStorageStore(customMcpSecretStorageKey(config.id), value)) {
        throw new Error(i18n.t('settings.mcp.toast.credentialSaveFailed'));
      }
    } else if (clearToken || create) {
      const removed = await window.electronAPI.safeStorageRemove(customMcpSecretStorageKey(config.id));
      if (!removed.success) throw new Error(i18n.t('settings.mcp.toast.credentialSaveFailed'));
    }
    credentialComplete = true;
    await maker.refreshCustomMcpCodex(receipt.saveId ? { saveId: receipt.saveId, committed: true } : undefined);
  } catch {
    if (receipt.saveId) {
      await maker.refreshCustomMcpCodex({ saveId: receipt.saveId, committed: false }).catch(() => undefined);
    }
    throw new Error(i18n.t(credentialComplete ? 'settings.mcp.toast.saveFailed' : 'settings.mcp.toast.credentialSaveFailed'));
  }
}

export async function createCustomMcpServer(config: CustomMcpConfig, token: string): Promise<void> {
  return saveWithCredential(config, token, true, true);
}

export async function updateCustomMcpServer(
  config: CustomMcpConfig, token: string, clearToken: boolean,
): Promise<void> {
  return saveWithCredential(config, token, clearToken, false);
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
