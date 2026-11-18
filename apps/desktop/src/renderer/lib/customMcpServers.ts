/**
 * Native MCP settings save configuration and bearer intent in one Main IPC.
 * Main serializes saves and clears obsolete HTTP credentials before transport changes.
 */

import { customMcpSecretStorageKey } from '@/../shared/providerSecrets';

import type { CustomMcpInput, CustomMcpListResult } from '@/../shared/customMcp';

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
export async function listCustomMcpServers(): Promise<CustomMcpListResult> {
  return window.electronAPI.maker.listCustomMcpServers();
}

/** Main saves credentials and configuration together before publishing either transport. */
export async function createCustomMcpServer(
  config: CustomMcpInput,
  token: string,
): Promise<void> {
  const value = token.trim();
  await window.electronAPI.maker.createCustomMcpServer(config,
    config.transport !== 'stdio' && value ? { action: 'set', value } : { action: 'keep' });
}

/** Empty, untouched fields preserve the saved bearer only for an existing remote transport. */
export async function updateCustomMcpServer(
  config: CustomMcpInput,
  token: string,
  clearToken: boolean,
): Promise<void> {
  const value = token.trim();
  await window.electronAPI.maker.updateCustomMcpServer(config,
    config.transport === 'stdio' ? { action: 'keep' }
      : value ? { action: 'set', value } : { action: clearToken ? 'clear' : 'keep' });
}

/** Main revokes the configuration and cleans its obsolete credential. */
export async function deleteCustomMcpServer(mcpId: string): Promise<void> {
  await window.electronAPI.maker.deleteCustomMcpServer(mcpId);
}
