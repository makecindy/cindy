import path from 'node:path';
import type { AgentKind } from '@cindy/maker-core';
import type { Logger } from '../logger.js';
import type { createWorkingDirectoryRecovery } from './workingDirectoryRecovery.js';
import { workdirDiagnosticContext, workdirDiagnosticErrorCode, workdirDiagnosticId } from '../workdirDiagnostics.js';
import { probeSessionWorkingDirectory, workdirErrorCode, type SessionWorkingDirectoryStat } from './sessionWorkingDirectoryProbe.js';

/** Main-owned dependencies for the local send preflight; remote sessions bypass it. */
export interface WorkingDirectoryPreflightDeps {
  workingDirectoryRecovery: ReturnType<typeof createWorkingDirectoryRecovery>;
  statWorkingDirectory(dir: string): Promise<SessionWorkingDirectoryStat>;
  readBoundWorkingDir(sessionId: string): Promise<string | null | readonly (string | null)[]>;
  getUserDataPath(): string;
  isCindyMakeWorktreePath(userData: string, dir: string): boolean;
  assertCindyMakeWorkspace(userData: string, dir: string): Promise<unknown>;
  getManagedWorktreeBasePath(dir: string): string | null;
  getManagedWorktreeReadinessForSession(sessionId: string, dir: string): Promise<'ready' | 'gone' | 'retry'>;
  findSimilarDirOnDisk(dir: string): Promise<string | null>;
  listActiveSessions(): { id: string; workDir: string; remoteHostId?: string | null }[];
  emitWorkDirMissingError(sessionId: string, dir: string, source: AgentKind, reason: 'not-exist' | 'not-dir', similar?: string | null): void;
  workdirLog: Pick<Logger, 'debug' | 'warn'>;
  log: Pick<Logger, 'debug' | 'warn'>;
}

/** Timeout is uncertainty, not absence. Keep recovery and missing broadcasts behind evidence. */
export function createWorkingDirectoryPreflight(deps: WorkingDirectoryPreflightDeps) {
  const {
    workingDirectoryRecovery, statWorkingDirectory, readBoundWorkingDir, getUserDataPath,
    isCindyMakeWorktreePath, assertCindyMakeWorkspace, getManagedWorktreeBasePath,
    getManagedWorktreeReadinessForSession, findSimilarDirOnDisk, listActiveSessions,
    emitWorkDirMissingError, workdirLog, log,
  } = deps;
  return async function checkWorkDirExists(
    sessionId: string,
    requestedWorkingDir: string | undefined | null,
    agentKind: AgentKind | undefined,
    remoteHostId?: string | null,
    opts?: { suppressMissingBroadcast?: boolean },
  ): Promise<boolean> {
    // 远端 session: workdir 在远端机器上, 本地 fs.stat 必然 ENOENT 但完全没意义。
    // 这条 guard 当初是为本地 session 兜底 "用户在 Finder 把目录删了 / 改名了" 的
    // 场景, 远端走自己的 probe (StartRemoteSessionPanel 创建前 stat-remote-path,
    // 或者 agent 真跑起来时由远端 codex 自己报 ENOENT)。这里直接放行。
    if (remoteHostId) return true;
    if (!requestedWorkingDir?.trim()) return true;
    const cindyMakeWorkspace = isCindyMakeWorktreePath(getUserDataPath(), requestedWorkingDir);
    if (cindyMakeWorkspace) workingDirectoryRecovery.discard(sessionId);
    let workingDir = workingDirectoryRecovery.resolve(sessionId, requestedWorkingDir);
    const source: AgentKind = agentKind === 'codex' || agentKind === 'pi' ? agentKind : 'claude-code';
    // suppressMissingBroadcast: 调用方(SEND 事务)手里还有 DB 权威值可兜底时,
    // 首检失败只记日志不广播错误横幅——兜底成功的话用户不该看到假错误。
    const suppress = opts?.suppressMissingBroadcast === true;
    const startedAt = Date.now();
    const diagnosticContext = {
      ...workdirDiagnosticContext(sessionId, workingDir),
      suppressMissingBroadcast: suppress,
      usingFallback: workingDirectoryRecovery.isFallback(sessionId, workingDir),
    };
    try {
      if (cindyMakeWorkspace) await assertCindyMakeWorkspace(getUserDataPath(), workingDir);
      // Reuse a previously selected conversation-recovery directory before probing
      // the original path. This lookup must not allocate a new directory.
      if (!cindyMakeWorkspace &&
        !workingDirectoryRecovery.isFallback(sessionId, workingDir) &&
        getManagedWorktreeBasePath(path.resolve(workingDir).replace(/\\/g, '/')) === null) {
        if (!await workingDirectoryRecovery.recover(sessionId, workingDir, undefined, [], 'ordinary', { existingFallbackOnly: true })) {
          workdirLog.debug('workdir preflight rejected', { ...diagnosticContext, reason: 'saved-recovery-lookup-failed' });
          return false;
        }
        workingDir = workingDirectoryRecovery.resolve(sessionId, workingDir);
      }
      const normalizedWorkingDir = path.resolve(workingDir).replace(/\\/g, '/');
      const managedWorktree = getManagedWorktreeBasePath(normalizedWorkingDir) !== null;
      const ensureManagedWorktreeReady = async (allowRecovery: boolean): Promise<boolean> => {
        if (!managedWorktree) return true;
        const ready = await getManagedWorktreeReadinessForSession(sessionId, workingDir);
        if (ready === 'ready') return true;
        if (allowRecovery && ready === 'gone' && !suppress &&
          await workingDirectoryRecovery.recover(sessionId, workingDir, undefined, [], 'unrestored-worktree')) return true;
        (suppress ? workdirLog.debug : workdirLog.warn)('workdir preflight rejected', { ...diagnosticContext, reason: 'managed-worktree-not-ready' });
        if (suppress) {
          log.debug('send: managed worktree not ready (broadcast suppressed, caller has fallback)', {
            sessionId,
            workingDir,
          });
        } else {
          emitWorkDirMissingError(sessionId, workingDir, source, 'not-exist');
        }
        return false;
      };
      const probe = await probeSessionWorkingDirectory(workingDir, {
        stat: statWorkingDirectory,
        readBoundWorkingDir: async () => {
          const boundWorkingDir = await readBoundWorkingDir(sessionId);
          const resolveBoundWorkingDir = (dir: string | null) =>
            dir ? workingDirectoryRecovery.resolve(sessionId, dir) : null;
          if (typeof boundWorkingDir === 'string' || boundWorkingDir === null) {
            return resolveBoundWorkingDir(boundWorkingDir);
          }
          return boundWorkingDir.map(resolveBoundWorkingDir);
        },
      });
      if (probe.kind === 'bound-timeout') {
        if (!await ensureManagedWorktreeReady(false)) return false;
        workingDirectoryRecovery.deferObservationUntilNextProbe(sessionId, workingDir);
        workdirLog.debug('workdir preflight timeout tolerated for bound session', {
          ...diagnosticContext, code: 'WORKDIR_PROBE_TIMEOUT', reason: 'bound-directory',
          elapsedMs: Date.now() - startedAt,
        });
        return true;
      }
      const stat = probe.stat;
      if (!stat.isDirectory()) {
        (suppress ? workdirLog.debug : workdirLog.warn)('workdir preflight rejected', { ...diagnosticContext, reason: 'not-directory' });
        if (suppress) {
          log.debug('send: workdir not a directory (broadcast suppressed, caller has fallback)', {
            sessionId,
            workingDir,
          });
        } else {
          emitWorkDirMissingError(sessionId, workingDir, source, 'not-dir');
        }
        return false;
      }
      // Managed worktrees need a stronger readiness check than directory existence: another send
      // may observe `git worktree add` before snapshot apply finishes, and a previous apply conflict
      // deliberately leaves the directory present while keeping the session blocked.
      if (!await ensureManagedWorktreeReady(true)) return false;
      if (!cindyMakeWorkspace && getManagedWorktreeBasePath(normalizedWorkingDir) === null) {
        if (!await workingDirectoryRecovery.recover(sessionId, workingDir)) {
          (suppress ? workdirLog.debug : workdirLog.warn)('workdir preflight rejected', { ...diagnosticContext, reason: 'recovery-failed-after-stat' });
          return false;
        }
        await workingDirectoryRecovery.observe(sessionId, workingDir, stat);
      }
      return true;
    } catch (error) {
      const errorCode = workdirErrorCode(error);
      const reportProbeFailure = suppress || errorCode === 'WORKDIR_PROBE_TIMEOUT' ? workdirLog.debug : workdirLog.warn;
      reportProbeFailure('workdir preflight failed', {
        ...diagnosticContext, code: workdirDiagnosticErrorCode(error), elapsedMs: Date.now() - startedAt,
      });
      // A timeout means the filesystem did not answer before the safety deadline.
      // It does not prove that the directory is gone, so never enter recovery or
      // report WORKDIR_MISSING from this branch. A caller using a DB fallback may
      // still probe that authoritative path after receiving false with suppression.
      if (errorCode === 'WORKDIR_PROBE_TIMEOUT') {
        if (suppress) {
          log.debug('send: workdir probe timed out (broadcast suppressed, caller has fallback)', {
            sessionId, workingDir,
          });
          return false;
        }
        throw error;
      }
      // ENOTDIR proves that a path component is not a directory, while other
      // permission, I/O and transport failures must keep their original error.
      if (errorCode === 'ENOTDIR') {
        (suppress ? workdirLog.debug : workdirLog.warn)('workdir preflight rejected', { ...diagnosticContext, reason: 'not-directory' });
        if (suppress) {
          log.debug('send: workdir not a directory (broadcast suppressed, caller has fallback)', {
            sessionId,
            workingDir,
          });
        } else {
          emitWorkDirMissingError(sessionId, workingDir, source, 'not-dir');
        }
        return false;
      }
      // Only ENOENT proves that a directory is absent. Permission, I/O and
      // transport failures must keep their original error instead of becoming a
      // misleading WORKDIR_MISSING report.
      if (errorCode !== 'ENOENT') {
        if (suppress) {
          log.debug('send: workdir probe unavailable (broadcast suppressed, caller has fallback)', {
            sessionId, workingDir, code: workdirDiagnosticErrorCode(error),
          });
          return false;
        }
        throw error;
      }
      if (cindyMakeWorkspace) {
        if (!suppress) emitWorkDirMissingError(sessionId, workingDir, source, 'not-exist');
        return false;
      }
      // Cindy 托管 worktree 被外部 PR cleanup / 手动 git 命令移除时，先按 DB 中
      // 的精确 worktree_path 从本地或 origin tracking 分支重建，保留原代码与快照。
      const restored = await getManagedWorktreeReadinessForSession(sessionId, workingDir);
      if (restored === 'ready') {
        workdirLog.debug('workdir preflight recovered', { ...diagnosticContext, action: 'managed-worktree-restored' });
        log.debug('send: restored missing managed worktree', { sessionId, workingDir });
        return true;
      }
      // Preserve the existing sibling-path diagnostic before mkdir makes the probe pass.
      // A fuzzy match is a lead for the agent, not authority to switch project identity.
      let similar: string | null = null;
      if (
        restored === 'gone' && !suppress &&
        errorCode === 'ENOENT' &&
        getManagedWorktreeBasePath(path.resolve(workingDir).replace(/\\/g, '/')) !== null &&
        await workingDirectoryRecovery.recover(sessionId, workingDir, undefined, [], 'unrestored-worktree')
      ) return true;
      // A missing ordinary/dialogue cwd must not stop the conversation. Prefer a repaired
      // DB path when the caller has one; never turn a managed Git recovery into
      // an empty project, or treat permission/non-directory failures as ENOENT.
      if (
        !suppress &&
        errorCode === 'ENOENT' &&
        getManagedWorktreeBasePath(path.resolve(workingDir).replace(/\\/g, '/')) === null &&
        await workingDirectoryRecovery.recover(sessionId, workingDir, async () => {
          similar = await findSimilarDirOnDisk(workingDir!);
          return similar;
        },
          listActiveSessions()
            .filter((session) => !session.remoteHostId)
            .map((session) => ({ id: session.id, workingDir: session.workDir })))
      ) {
        const resolvedDir = workingDirectoryRecovery.resolve(sessionId, workingDir);
        workdirLog.debug('workdir preflight recovered', {
          ...diagnosticContext, code: workdirDiagnosticErrorCode(error),
          resolvedDirectoryRef: workdirDiagnosticId(resolvedDir),
          usingFallback: workingDirectoryRecovery.isFallback(sessionId, workingDir),
          sameDirectory: path.resolve(workingDir) === path.resolve(resolvedDir),
          elapsedMs: Date.now() - startedAt,
        });
        log.debug('send: working directory recovery completed', { sessionId, workingDir });
        return true;
      }
      if (suppress) {
        log.debug('send: workdir missing (broadcast suppressed, caller has fallback)', {
          sessionId,
          workingDir,
        });
        return false;
      }
      workdirLog.warn('workdir preflight blocked', {
        ...diagnosticContext, code: workdirDiagnosticErrorCode(error), reportedReason: 'not-exist',
        recoveryEligible: errorCode === 'ENOENT',
        managedWorktree: getManagedWorktreeBasePath(path.resolve(workingDir).replace(/\\/g, '/')) !== null,
        similarPathFound: !!similar, elapsedMs: Date.now() - startedAt,
      });
      emitWorkDirMissingError(sessionId, workingDir, source, 'not-exist', similar);
      return false;
    }
  };
}
