/**
 * remote-workdir-guard —— 远程新建会话的 workingDir 收敛(被控端)。
 *
 * 背景(安全):dispatch 把控制端传来的 `args` 原样喂给本机 handler;
 * `maker:create-session` 的 `workingDir` 决定 agent 在哪个目录起进程(可读写 / 执行 shell)。
 * allowlist 只挡 channel、不挡 args,故此处对 workingDir 收敛,挡掉「不存在 / 非目录」的
 * 伪造或笔误路径。
 *
 * 放行判据:路径必须**当前在被控端真实存在、且是一个目录**。
 *
 * 本地目录探测是必须的:本版本开放了远程文件浏览(AddRemoteProjectDialog + fs:* 隧道),
 * 控制端可浏览 / 新建被控端任意目录并在其下建首个会话,但目录的历史记录不能证明它
 * 当前仍可访问。尤其是断线 UNC/SMB,必须走受控异步探测。
 * 阈值仍有意义:remoteControlEnabled 已开 + 文件浏览已开时,控制端本就能驱动 agent 读写
 * 任意目录,故「限定到已存在目录」是此处剩余的、成本极低的越权兜底(挡掉不存在路径 /
 * 把文件当目录),并非完全放开。
 *
 * 路径比较复用 normalizeWorkingDirForStorage,只做路径形态归一。SSH endpoint 的
 * 归属由 file-browser 在本地探测后单独解析;create-session / worktree:create / 远程
 * `/cmd` 不得借 SSH 会话记录绕过本地目录校验。空 / 非法 / 不存在 / 非目录路径仍拒绝。
 */

import type { IpcErrorCode } from '../../shared/ipc-errors';

import { normalizeWorkingDirForStorage } from '../../shared/workingDir';
import { workdirProbeHostClient } from '../workdir-probe-host/index.js';

/** 网络目录探测不能占满 device-link 默认 invoke 的整个等待窗口。 */
export const REMOTE_WORKDIR_PROBE_TIMEOUT_MS = 5_000;

interface DirectoryStatLike {
  isDirectory(): boolean;
}

export type RemoteDirectoryStat = (dir: string) => Promise<DirectoryStatLike>;

export type RemoteWorkingDirRejectionReason =
  'invalid' | 'not-found' | 'not-directory' | 'unavailable' | 'timeout';

export type RemoteWorkingDirCheckResult =
  | { allowed: true; source: 'filesystem' }
  | { allowed: false; reason: RemoteWorkingDirRejectionReason };

export interface RemoteDirectoryProbeOptions {
  stat?: RemoteDirectoryStat;
  timeoutMs?: number;
}

function classifyStatError(err: unknown): RemoteWorkingDirRejectionReason {
  const code =
    err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : '';
  if (code === 'ENOENT') return 'not-found';
  if (code === 'ENOTDIR') return 'not-directory';
  if (code === 'EINVAL' || code === 'ENAMETOOLONG' || code.startsWith('ERR_INVALID_ARG_')) {
    return 'invalid';
  }
  return 'unavailable';
}

/**
 * 生产探测在有界 utility-process 池中执行。`fs.stat` 不支持 AbortSignal,
 * 因此超时会终止对应 host,释放其 libuv 状态并让等待请求获得槽位。
 * `options.stat` 仅为单元测试注入,同样保留业务超时语义。
 */
export async function probeRemoteDirectory(
  dir: string,
  options: RemoteDirectoryProbeOptions = {},
): Promise<RemoteWorkingDirCheckResult> {
  const timeoutMs = options.timeoutMs ?? REMOTE_WORKDIR_PROBE_TIMEOUT_MS;
  const normalized = normalizeWorkingDirForStorage(dir);
  if (!normalized) return { allowed: false, reason: 'invalid' };
  if (!options.stat) {
    try {
      const result = await workdirProbeHostClient.probe(dir, normalized, timeoutMs);
      if (!result.ok) return { allowed: false, reason: classifyStatError({ code: result.code }) };
      return result.isDirectory
        ? { allowed: true, source: 'filesystem' }
        : { allowed: false, reason: 'not-directory' };
    } catch (err) {
      const code =
        err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : '';
      return {
        allowed: false,
        reason: code === 'WORKDIR_PROBE_TIMEOUT' ? 'timeout' : 'unavailable',
      };
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const rawProbe = Promise.resolve().then(() => options.stat!(dir));
  const probe = rawProbe.then<RemoteWorkingDirCheckResult, RemoteWorkingDirCheckResult>(
    (entry) =>
      entry.isDirectory()
        ? { allowed: true, source: 'filesystem' }
        : { allowed: false, reason: 'not-directory' },
    (err) => ({ allowed: false, reason: classifyStatError(err) }),
  );
  const timeout = new Promise<RemoteWorkingDirCheckResult>((resolve) => {
    timer = setTimeout(() => resolve({ allowed: false, reason: 'timeout' }), timeoutMs);
    timer.unref?.();
  });
  return await Promise.race([probe, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 该 workingDir 是否在被控端本地真实存在。SSH 端点由 file-browser 单独解析。 */
export async function checkRemoteWorkingDir(
  dir: string,
  probeOptions: RemoteDirectoryProbeOptions = {},
): Promise<RemoteWorkingDirCheckResult> {
  if (!normalizeWorkingDirForStorage(dir)) return { allowed: false, reason: 'invalid' };
  // 所有本地目录都必须确认当前仍可访问,避免历史记录让断线网络盘绕过超时。
  return await probeRemoteDirectory(dir, probeOptions);
}

/** 旧布尔调用方的兼容包装;需要结构化错误的边界应直接调用 checkRemoteWorkingDir。 */
export async function isRemoteWorkingDirAllowed(
  dir: string,
  probeOptions: RemoteDirectoryProbeOptions = {},
): Promise<boolean> {
  return (await checkRemoteWorkingDir(dir, probeOptions)).allowed;
}

/** 将 guard 拒绝原因收敛为稳定 IPC 错误,不向控制端暴露被控端绝对路径。 */
export function remoteWorkingDirRejectionToIpcError(reason: RemoteWorkingDirRejectionReason): {
  code: IpcErrorCode;
  message: string;
} {
  switch (reason) {
    case 'invalid':
      return { code: 'REMOTE_WORKDIR_INVALID', message: 'Remote working directory is invalid.' };
    case 'not-found':
      return {
        code: 'REMOTE_WORKDIR_NOT_FOUND',
        message: 'Remote working directory does not exist.',
      };
    case 'not-directory':
      return {
        code: 'REMOTE_WORKDIR_NOT_DIRECTORY',
        message: 'Remote working directory is not a directory.',
      };
    case 'timeout':
      return {
        code: 'REMOTE_WORKDIR_UNAVAILABLE',
        message:
          'Remote working directory check timed out. Reconnect the network drive and try again.',
      };
    case 'unavailable':
      return {
        code: 'REMOTE_WORKDIR_UNAVAILABLE',
        message:
          'Remote working directory is unavailable. Reconnect the network drive and try again.',
      };
  }
}
