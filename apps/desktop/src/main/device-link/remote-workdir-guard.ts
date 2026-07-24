/**
 * remote-workdir-guard —— 远程新建会话的 workingDir 收敛(被控端)。
 *
 * 背景(安全):dispatch 把控制端传来的 `args` 原样喂给本机 handler;
 * `maker:create-session` 的 `workingDir` 决定 agent 在哪个目录起进程(可读写 / 执行 shell)。
 * allowlist 只挡 channel、不挡 args,故此处对 workingDir 收敛,挡掉「不存在 / 非目录」的
 * 伪造或笔误路径。
 *
 * 放行判据(任一命中即可):
 *   1. 在被控端最近工作目录(recentWorkdirs)里;
 *   2. 是被控端某个已有会话的 workingDir;
 *   3. **当前在被控端真实存在、且是一个目录**。
 *
 * 第 3 条是必须的:本版本开放了远程文件浏览(AddRemoteProjectDialog + fs:* 隧道),
 * 控制端可浏览 / 新建被控端任意目录并在其下建首个会话——这类目录尚不在 recents / sessions
 * 里,但确实是用户经「已被 remoteControlEnabled 门禁」的浏览流程显式选定的真实目录。
 * 阈值仍有意义:remoteControlEnabled 已开 + 文件浏览已开时,控制端本就能驱动 agent 读写
 * 任意目录,故「限定到已存在目录」是此处剩余的、成本极低的越权兜底(挡掉不存在路径 /
 * 把文件当目录),并非完全放开。
 *
 * 路径比较复用 normalizeWorkingDirForStorage,只做路径形态归一,不复用 recentWorkdirs
 * 的列表准入规则。后者会刻意过滤托管 worktree,若在安全闸复用会让刚创建成功的
 * `.cindy-worktrees/*` 在 fs 存在性检查前被误判为非法。空 / 非法 / 不存在 / 非目录
 * 路径仍一律不放行。
 */

import { stat } from 'node:fs/promises';

import type { IpcErrorCode } from '../../shared/ipc-errors';

import { getDbClient } from '../localDb/client/current';
import { sessions, recentWorkdirs } from '../localDb/schema';
import { createLogger } from '../logger';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir';

const log = createLogger('device-link-workdir-guard');

/** 网络目录探测不能占满 device-link 默认 invoke 的整个等待窗口。 */
export const REMOTE_WORKDIR_PROBE_TIMEOUT_MS = 5_000;

interface DirectoryStatLike {
  isDirectory(): boolean;
}

export type RemoteDirectoryStat = (dir: string) => Promise<DirectoryStatLike>;

export type RemoteWorkingDirRejectionReason =
  'invalid' | 'not-found' | 'not-directory' | 'unavailable' | 'timeout';

export type RemoteWorkingDirCheckResult =
  | { allowed: true; source: 'known' | 'filesystem' }
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
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-found';
  if (code === 'EINVAL' || code === 'ENAMETOOLONG') return 'invalid';
  return 'unavailable';
}

/**
 * 在 libuv worker 上异步探测目录,并在业务超时到期后先行收敛请求。
 * `fs.stat` 本身不支持 AbortSignal,故晚到的 SMB 结果只会被忽略;它不会阻塞
 * Electron 主线程,也不会形成 unhandled rejection。
 */
export async function probeRemoteDirectory(
  dir: string,
  options: RemoteDirectoryProbeOptions = {},
): Promise<RemoteWorkingDirCheckResult> {
  const statDirectory = options.stat ?? stat;
  const timeoutMs = options.timeoutMs ?? REMOTE_WORKDIR_PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = statDirectory(dir).then<RemoteWorkingDirCheckResult, RemoteWorkingDirCheckResult>(
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

/** 该 workingDir 是否在被控端已知目录集合内,或在被控端真实存在的目录。 */
export async function checkRemoteWorkingDir(
  dir: string,
  probeOptions: RemoteDirectoryProbeOptions = {},
): Promise<RemoteWorkingDirCheckResult> {
  const target = normalizeWorkingDirForStorage(dir);
  if (!target) return { allowed: false, reason: 'invalid' };
  try {
    const db = getDbClient().drizzle;
    const recents = await db.select({ path: recentWorkdirs.path }).from(recentWorkdirs);
    if (recents.some((r) => normalizeWorkingDirForStorage(r.path) === target)) {
      return { allowed: true, source: 'known' };
    }
    const rows = await db.select({ workingDir: sessions.workingDir }).from(sessions);
    if (rows.some((r) => normalizeWorkingDirForStorage(r.workingDir) === target)) {
      return { allowed: true, source: 'known' };
    }
  } catch (err) {
    // DB 查询失败不直接拒:继续走「目录是否真实存在」兜底(下面),仍能挡掉不存在 / 非目录。
    log.warn('workingDir guard db query failed, falling back to fs check', err);
  }
  // 远程浏览选定的新目录:接受被控端上真实存在的目录(挡掉不存在路径 / 文件冒充目录)。
  return await probeRemoteDirectory(dir, probeOptions);
}

/** 旧布尔调用方的兼容包装;需要结构化错误的边界应直接调用 checkRemoteWorkingDir。 */
export async function isRemoteWorkingDirAllowed(dir: string): Promise<boolean> {
  return (await checkRemoteWorkingDir(dir)).allowed;
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
