/**
 * ssh/list_hosts.ts — ssh_list_hosts tool
 *
 * 列出已配置远程主机（来自 desktop 连接池，与「设置 → 远程连接」同源，含
 * 展开 Include 后的 ~/.ssh/config alias 与 Cindy 本地主机）。agent 收到
 * "ssh 到 xxx"时先用它做 HostRef/alias 解析。
 */

import type { SshMcpDeps } from '../types.js';
import type { SshToolRegistry } from './registry.js';
import { errorPayload, hostBrief, okPayload } from './_shared.js';

export function registerSshListHostsTool(
  registry: SshToolRegistry,
  deps: SshMcpDeps,
): void {
  registry.register({
    name: 'ssh_list_hosts',
    category: 'ssh',
    description:
      '列出所有已配置的远程主机（HostRef、SSH alias 或 Cindy profileId、目标地址、认证方式、连接状态）。' +
      '执行或查状态时使用 SSH alias 或完整 HostRef；不会按 IP/hostname/显示名猜测。',
    inputShape: {},
    handler: async () => {
      try {
        const pool = await deps.getPool();
        const hosts = pool.list().map(hostBrief);
        return okPayload({
          hosts,
          ...(hosts.length === 0
            ? {
                hint:
                  '当前没有配置任何 SSH 主机。~/.ssh/config 中的 alias 会自动出现；也可以到「设置 → 远程连接」手动添加一台只属于 Cindy 的主机。',
              }
            : {}),
        });
      } catch (err) {
        deps.logger?.error?.(`[cindy_ssh] ssh_list_hosts failed: ${String(err)}`);
        return errorPayload('INTERNAL', `读取主机列表失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
