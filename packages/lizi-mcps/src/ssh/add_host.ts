/**
 * ssh/add_host.ts — ssh_add_host tool
 *
 * 用户能在「设置 → 远程连接」添加主机，Agent 也能（agent-user-parity）。
 * 写入流程、校验与连接池刷新全部复用 desktop 设置页的同一实现（deps.addHost），
 * 这里只负责参数、错误分类，以及添加后试连一次让 Agent 知道认证是否可用。
 */

import { z } from 'zod';

import type { SshMcpDeps } from '../types.js';
import type { SshToolRegistry } from './registry.js';
import {
  PASSWORD_LOGIN_HINT,
  classifySshError,
  errorPayload,
  hostBrief,
  okPayload,
  splitIpcError,
} from './_shared.js';

export function registerSshAddHostTool(
  registry: SshToolRegistry,
  deps: SshMcpDeps,
): void {
  registry.register({
    name: 'ssh_add_host',
    category: 'ssh',
    description:
      '把一台 SSH 主机添加到这台电脑的「设置 → 远程连接」（写入本机 ~/.ssh/cindy.conf，终端 `ssh <alias>` 同样可用），' +
      '添加后自动试连一次并返回结果；之后 ssh_exec 和 SSH 远程任务都能使用它。' +
      '认证只支持 ssh-agent（默认）或未加密的私钥文件，Cindy 不保存密码。' +
      PASSWORD_LOGIN_HINT,
    inputShape: {
      alias: z.string().trim().min(1).describe('主机别名（SSH Host 名），不能含空格或通配符，例如 "nas"'),
      hostname: z.string().trim().min(1).describe('IP 或域名'),
      user: z.string().trim().min(1).describe('登录用户名'),
      port: z.number().int().min(1).max(65535).optional().describe('端口，默认 22'),
      authMethod: z
        .enum(['agent', 'key'])
        .optional()
        .describe('agent（默认）：用本机 ssh-agent 里的密钥；key：直接读取 identityFile 指定的未加密私钥'),
      identityFile: z
        .string()
        .min(1)
        .optional()
        .describe('私钥路径，支持 ~。authMethod=key 时必填；agent 时可选，用于只使用这把密钥'),
      displayName: z.string().min(1).optional().describe('设置页显示的名称，默认同 alias'),
    },
    handler: async ({ alias, hostname, user, port, authMethod, identityFile, displayName }) => {
      // 主机已写入、仅本地显示名／Agent Proxy 偏好没存上：主机可用，按已添加处理，不能让 Agent 重试。
      let prefsWarning: string | undefined;
      try {
        await deps.addHost({
          id: alias,
          hostname,
          user,
          ...(port !== undefined ? { port } : {}),
          ...(authMethod ? { authMethod } : {}),
          ...(identityFile ? { identityFile } : {}),
          ...(displayName ? { displayName } : {}),
        });
      } catch (err) {
        const { code, detail } = splitIpcError(err);
        deps.logger?.warn?.(`[cindy_ssh] ssh_add_host "${alias}" failed: ${code ?? 'UNKNOWN'}`);
        switch (code) {
          case 'ALREADY_EXISTS':
            return errorPayload('HOST_ALREADY_EXISTS', `别名 "${alias}" 已存在。用 ssh_list_hosts 查看，或换一个别名。`);
          case 'INVALID_PARAMS':
            return errorPayload('INVALID_ARGS', `参数不合法：${detail}`);
          case 'SSH_HOST_PREFS_WRITE_FAILED':
            prefsWarning = '主机已添加，但显示名未能保存（检查本地存储权限）；无需重试添加。';
            break;
          case 'SSH_CONFIG_RELOAD_REQUIRED':
            return errorPayload(
              'SSH_CONFIG_RELOAD_REQUIRED',
              '主机已写入 SSH 配置，但 Cindy 刷新连接池失败。调用 ssh_reload_config 重新读取后再用。',
            );
          default:
            return errorPayload('SSH_CONFIG_WRITE_FAILED', `添加主机失败：${detail}`);
        }
      }
      const extra = prefsWarning ? { warning: prefsWarning } : {};

      let pool;
      try {
        pool = await deps.getPool();
      } catch (err) {
        return errorPayload('INTERNAL', `主机已添加，但读取连接池失败：${err instanceof Error ? err.message : String(err)}`);
      }
      const added = () => pool.list().find((s) => s.config.id === alias);
      const before = added();
      if (!before) {
        return errorPayload('SSH_CONFIG_RELOAD_REQUIRED', '主机已写入 SSH 配置，但连接池里还没有它。调用 ssh_reload_config 后再试。');
      }
      try {
        await deps.ensureReady(alias);
        return okPayload({ added: true, connected: true, host: hostBrief(added() ?? before, deps), ...extra });
      } catch (err) {
        // 主机已保存（与设置页一致：连不上也保留），把试连结果交给 Agent 决定下一步。
        const classified = classifySshError(err, deps, added() ?? before);
        return okPayload({
          added: true,
          ...extra,
          connected: false,
          host: hostBrief(added() ?? before, deps),
          connectError: { errorCode: classified.errorCode, hint: classified.hint },
        });
      }
    },
  });
}
