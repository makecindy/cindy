import { z } from 'zod';
import type { SshMcpDeps } from '../types.js';
import type { SshToolRegistry } from './registry.js';
import { errorPayload, hostBrief, okPayload, splitIpcError } from './_shared.js';

/** Preserve settings errors without returning private paths or raw host exceptions. */
function mutationError(error: unknown) {
  const { code } = splitIpcError(error);
  switch (code) {
    case 'SSH_HOST_NOT_FOUND': return errorPayload('HOST_NOT_FOUND', '主机不存在，请重新查询 SSH 主机列表。');
    case 'SSH_CONFIG_OWNERSHIP_REQUIRED': return errorPayload('SSH_CONFIG_OWNERSHIP_REQUIRED', '该连接不由 Cindy 独占管理；可修改显示名，连接字段请在原 SSH 配置中维护后刷新。');
    case 'PRECONDITION_FAILED': return errorPayload('PRECONDITION_FAILED', 'SSH 配置已变化或主机仍被任务引用；请刷新配置并检查关联任务。显示名可以单独修改。');
    case 'INVALID_PARAMS': return errorPayload('INVALID_ARGS', 'SSH 主机参数不合法，请检查字段和取值。');
    case 'SSH_CONFIG_RELOAD_REQUIRED': return errorPayload('SSH_CONFIG_RELOAD_REQUIRED', '配置可能已保存，请调用 ssh_reload_config 并回读，不要直接重复写入。');
    default: return errorPayload('SSH_CONFIG_WRITE_FAILED', 'SSH 设置未能完整保存，请回读主机状态后再处理。');
  }
}

/** Native management surface; uses the same lifecycle checks as Settings. */
export function registerSshManageHostTools(registry: SshToolRegistry, deps: SshMcpDeps): void {
  if (deps.updateHost) registry.register({
    name: 'ssh_update_host', category: 'ssh',
    description: '编辑本机 Cindy 的 SSH 主机，直接复用设置页，无需操作桌面。先 ssh_list_hosts 获取准确 id。只提交要修改的字段；displayName 只改显示名，不改 SSH alias、连接或已有任务。空显示名恢复使用 alias。连接字段仅可修改 Cindy 管理且无关联任务的主机。省略的字段和私钥配置保持不变。',
    inputShape: {
      id: z.string().trim().min(1), displayName: z.string().max(200).optional(),
      hostname: z.string().trim().min(1).optional(), user: z.string().trim().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      authMethod: z.enum(['agent', 'key']).optional(),
      identityFile: z.string().min(1).optional().describe('仅在明确更换私钥时提供路径；省略保留原配置，不提供密钥正文。'),
    },
    handler: async (input) => {
      if (Object.keys(input).every(key => key === 'id')) return errorPayload('INVALID_ARGS', '请指定需要修改的字段。');
      try { return okPayload({ updated: true, host: hostBrief(await deps.updateHost!(input), deps) }); }
      catch (error) { return mutationError(error); }
    },
  });
  if (deps.removeHost) registry.register({
    name: 'ssh_remove_host', category: 'ssh',
    description: '按用户要求移除本机 Cindy 管理的 SSH 主机配置。先 ssh_list_hosts 核对准确 id；仅移除连接配置，不删除远端文件。沿用设置页对关联任务和 SSH 配置归属的检查。',
    inputShape: { id: z.string().trim().min(1) },
    handler: async ({ id }) => {
      try { await deps.removeHost!(id); return okPayload({ removed: true, id }); }
      catch (error) { return mutationError(error); }
    },
  });
}
