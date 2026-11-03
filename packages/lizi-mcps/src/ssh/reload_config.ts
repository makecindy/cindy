/**
 * ssh/reload_config.ts — ssh_reload_config tool
 *
 * 等同设置页「重新读取 ~/.ssh/config」。Agent 手动编辑 SSH 配置后用它让
 * Cindy 立即看到改动，不用请用户去设置里点刷新。
 */

import type { SshMcpDeps } from '../types.js';
import type { SshToolRegistry } from './registry.js';
import { errorPayload, hostBrief, okPayload } from './_shared.js';

export function registerSshReloadConfigTool(
  registry: SshToolRegistry,
  deps: SshMcpDeps,
): void {
  registry.register({
    name: 'ssh_reload_config',
    category: 'ssh',
    description:
      '重新读取这台电脑的 ~/.ssh/config（含 Include），刷新 Cindy 的 SSH 主机列表，等同设置页的刷新按钮。' +
      '手动编辑过 SSH 配置后调用；返回刷新后的主机列表。已打开的设置页不会自动更新，需用户点刷新按钮。',
    inputShape: {},
    handler: async () => {
      try {
        const { diagnostic, warningCount } = await deps.reloadConfig();
        const pool = await deps.getPool();
        return okPayload({
          hosts: pool.list().map((snapshot) => hostBrief(snapshot, deps)),
          ...(warningCount > 0 ? { warningCount } : {}),
          ...(diagnostic
            ? {
                diagnostic,
                hint: 'SSH 配置读取失败，主机列表仍是上次成功读取的结果。请检查 ~/.ssh/config 的语法、权限和 Include 路径。',
              }
            : {}),
        });
      } catch (err) {
        deps.logger?.error?.(`[cindy_ssh] ssh_reload_config failed: ${String(err)}`);
        return errorPayload('INTERNAL', `重新读取 SSH 配置失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
