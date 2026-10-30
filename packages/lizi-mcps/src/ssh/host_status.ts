/**
 * ssh/host_status.ts — ssh_host_status tool
 *
 * 单主机连接状态快照。ssh_exec 失败后用它诊断（认证失败的 lastError 内含
 * 可操作提示，转告用户即可，不要盲目重试）。
 */

import { z } from 'zod';

import type { SshMcpDeps } from '../types.js';
import type { SshToolRegistry } from './registry.js';
import { errorPayload, hostBrief, okPayload, resolveHost } from './_shared.js';

export function registerSshHostStatusTool(
  registry: SshToolRegistry,
  deps: SshMcpDeps,
): void {
  registry.register({
    name: 'ssh_host_status',
    category: 'ssh',
    description:
      '查看单台已配置 SSH 主机的连接状态（status / 最近错误 / 认证方式）。' +
      'ssh_exec 失败后用于诊断；认证类错误请把提示转告用户，不要重试。',
    inputShape: {
      host: z.string().min(1).describe('主机 alias 或 hostname/IP（须已在设置中配置）'),
    },
    handler: async ({ host }) => {
      try {
        const pool = await deps.getPool();
        const resolved = resolveHost(pool, host, deps);
        if (!resolved.ok) return resolved.result;
        const s = resolved.snapshot;
        return okPayload({
          host: hostBrief(s, deps),
          statusChangedAt: new Date(s.statusChangedAt).toISOString(),
        });
      } catch (err) {
        deps.logger?.error?.(`[cindy_ssh] ssh_host_status failed: ${String(err)}`);
        return errorPayload('INTERNAL', `读取主机状态失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
