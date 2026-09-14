/**
 * ssh/list_hosts.ts — ssh_list_hosts tool
 *
 * 列出已配置 SSH 主机（来自 desktop 连接池，与「设置 → 远程连接」同源，含
 * ~/.ssh/config 手写 alias）。agent 收到"ssh 到 xxx"时先用它做名字解析。
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
      '列出所有已配置的 SSH 主机（alias、hostname、端口、用户、认证方式、连接状态）。' +
      '用户要求 ssh 到某台机器时，先用本工具确认目标主机的 alias / IP 是否已配置。',
    inputShape: {},
    handler: async () => {
      try {
        const pool = await deps.getPool();
        const hosts = pool.list().map((snapshot) => hostBrief(snapshot, deps));
        return okPayload({
          hosts,
          ...(hosts.length === 0
            ? {
                hint:
                  '当前没有配置任何 SSH 主机。请告知用户到「设置 → 远程连接」添加主机（支持 ~/.ssh/config 已有 alias 自动导入）。',
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
