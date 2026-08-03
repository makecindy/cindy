/**
 * 计算当前新 Codex 任务是否能取得 cindy_contacts。
 *
 * contacts 设置与插件有效开关都必须开启；applied 快照只解释当前 owner 的长活
 * app-server。没有当前 owner 快照时，下一次 lazy spawn 会按 live 有效开关重建。
 */
export function resolveCodexContactsMcpReady(input: {
  contactsEnabled: boolean;
  pluginEnabled: boolean;
  activeOwnerScope: string;
  appliedOwnerScope: string | null;
  appliedEnabled: boolean | null;
}): boolean {
  if (!input.contactsEnabled || !input.pluginEnabled) return false;
  if (input.appliedOwnerScope !== input.activeOwnerScope) return true;
  return input.appliedEnabled !== false;
}
