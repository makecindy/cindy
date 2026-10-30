/**
 * ssh/exec.ts — ssh_exec tool
 *
 * 在已配置主机上执行一次性命令：resolveHost → ensureReady（自动连接，幂等）
 * → RemoteHost.exec。认证 / 转义 / 连接管理全部走 desktop 已有的 SSH 能力，
 * agent 不需要（也不应该）手拼 ssh 命令行。
 *
 * 红线：error payload / 日志一律不携带 command 原文（可能内联密钥），
 * exec 侧用 label 提供上下文。
 */

import { z } from 'zod';

import type { SshMcpDeps } from '../types.js';
import type { SshToolRegistry } from './registry.js';
import {
  classifySshError,
  errorPayload,
  okPayload,
  resolveHost,
  truncateOutput,
  wrapCwd,
} from './_shared.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
/**
 * 源头字节上限（per-stream，传给 RemoteHost.exec 边读边生效）：越界即终止
 * 远端命令，防止 `cat 多 GB 文件` 之类把 main 进程内存攒爆——_shared 的
 * truncateOutput 是 await 之后的字符级二次截断，管不住内存。512KB 远大于
 * 32k 字符的最终展示上限，正常输出不受影响。
 */
const MAX_OUTPUT_BYTES = 512 * 1024;

export function registerSshExecTool(
  registry: SshToolRegistry,
  deps: SshMcpDeps,
): void {
  registry.register({
    name: 'ssh_exec',
    category: 'ssh',
    description:
      '在已配置的 SSH 主机上执行一条命令并返回 {stdout, stderr, exitCode}。' +
      '自动使用已配置的认证方式（ssh-agent / key），命令按原样在远端 shell 执行，无需本地转义。' +
      '注意：当前为直连，不支持 ~/.ssh/config 的 ProxyJump/ProxyCommand 跳板——仅跳板可达的主机会连接失败。' +
      'exitCode 非 0 会如实返回（不算工具错误），由你判断语义。' +
      `默认超时 ${DEFAULT_TIMEOUT_MS / 1000}s（可调，上限 ${MAX_TIMEOUT_MS / 1000}s）；` +
      '更长的任务请 `nohup <cmd> > /tmp/task.log 2>&1 &` 后台跑，再用本工具轮询日志。',
    inputShape: {
      host: z.string().min(1).describe('主机 alias 或 hostname/IP（须已在设置中配置，可用 ssh_list_hosts 查看）'),
      command: z.string().min(1).describe('要在远端执行的命令（原样传入远端 shell，不要做本地 shell 转义）'),
      cwd: z.string().min(1).optional().describe('远端工作目录（绝对路径）；引号安全包装由工具负责'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}`),
      input: z.string().optional().describe('写入远端命令 stdin 的内容（可选）'),
    },
    handler: async ({ host, command, cwd, timeoutMs, input }) => {
      let pool;
      try {
        pool = await deps.getPool();
      } catch (err) {
        deps.logger?.error?.(`[cindy_ssh] getPool failed: ${String(err)}`);
        return errorPayload('INTERNAL', `SSH 连接池不可用：${err instanceof Error ? err.message : String(err)}`);
      }

      const resolved = resolveHost(pool, host, deps);
      if (!resolved.ok) return resolved.result;
      const hostId = resolved.snapshot.config.id;

      try {
        await deps.ensureReady(hostId);
        const remote = pool.get(hostId);
        if (!remote) {
          return errorPayload('HOST_NOT_FOUND', `主机 "${hostId}" 已从连接池移除，用 ssh_list_hosts 重新确认。`);
        }
        const result = await remote.exec(wrapCwd(command, cwd), {
          input,
          timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
          label: `cindy_ssh:ssh_exec(${hostId})`,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        });
        const stdout = truncateOutput(result.stdout);
        const stderr = truncateOutput(result.stderr);
        return okPayload({
          host: hostId,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: stdout.text,
          stderr: stderr.text,
          ...(stdout.truncated ? { stdoutTruncated: true } : {}),
          ...(stderr.truncated ? { stderrTruncated: true } : {}),
          // 源头字节 cap 生效 = 命令被提前终止,输出不完整,exitCode 不可信。
          ...(result.truncated
            ? {
                remoteOutputCapped: true,
                hint: '输出超过单流 512KB 上限,远端命令已被提前终止,exitCode 不代表命令真实结果。请改用过滤(grep / tail / head)缩小输出后重试。',
              }
            : {}),
        });
      } catch (err) {
        // 不回显 command 原文，只落 host + 分类结果。
        const classified = classifySshError(err, deps, resolved.snapshot);
        deps.logger?.warn?.(
          `[cindy_ssh] ssh_exec on "${hostId}" failed: ${classified.errorCode}`,
        );
        return errorPayload(classified.errorCode, classified.hint, { host: hostId });
      }
    },
  });
}
