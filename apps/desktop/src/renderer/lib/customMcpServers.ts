/** Credentials are sent once to trusted Main; no generic safeStorage readback. */
import type { CustomMcpMutation, CustomMcpSummary } from '@/../shared/mcpSetup';

export async function listCustomMcpServers(): Promise<CustomMcpSummary[]> {
  const result = await window.electronAPI.maker.listCustomMcpServers();
  return result.servers as CustomMcpSummary[];
}
export async function createCustomMcpServer(config: CustomMcpMutation, token: string): Promise<void> {
  await window.electronAPI.maker.createCustomMcpServer({ ...config, token, tokenAction: 'replace' });
}
export async function updateCustomMcpServer(config: CustomMcpMutation, token: string, clearToken: boolean): Promise<void> {
  await window.electronAPI.maker.updateCustomMcpServer({ ...config, token, tokenAction: clearToken ? 'clear' : token ? 'replace' : 'keep' });
}
export async function deleteCustomMcpServer(mcpId: string): Promise<void> {
  await window.electronAPI.maker.deleteCustomMcpServer(mcpId);
}
