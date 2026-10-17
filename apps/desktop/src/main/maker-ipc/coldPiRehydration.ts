/**
 * 冷 Pi 切模核实前的运行时恢复（#5508）。
 *
 * 从 register.ts 抽出来，只为了让每一条失败路径都能被真实执行到：会话行读取、
 * 本地 Pi 判定、原生会话 ID、工作目录探测、Orca/extraDirs 选项合成、bootstrap，
 * 每一步失败都抛带类别的 `ColdPiRehydrationError`；探测阶段的超时 / 权限错误不再
 * 落到 `unknown`。所有分支仍 fail-closed：不会以缺失信息继续切模。
 */

import { ColdPiRehydrationError, type ColdPiRehydrationFailureCategory } from './coldPiRehydrationFailure.js';

export interface ColdPiSessionRow {
  agentKind: string;
  remoteHostId: string | null;
  sdkSessionId: string | null;
  workingDir: string | null;
}

export type ColdPiResumableRow<Row extends ColdPiSessionRow> = Row & {
  sdkSessionId: string;
  workingDir: string;
};

export interface ColdPiRehydrationDeps<
  Row extends ColdPiSessionRow,
  Opts extends { workingDir?: string; agentKind: string; remoteHostId?: string | null },
> {
  hasLiveSession(sessionId: string): boolean;
  loadSessionRow(sessionId: string): Promise<Row | undefined>;
  buildCreateOpts(sessionId: string, row: ColdPiResumableRow<Row>): Opts;
  checkWorkDirExists(
    sessionId: string,
    workingDir: Opts['workingDir'],
    agentKind: Opts['agentKind'],
    remoteHostId: Opts['remoteHostId'],
  ): Promise<boolean>;
  /** 合成 Orca vendor options 与 extraDirs；失败归为 session-options-failed。 */
  prepareCreateOpts(sessionId: string, createOpts: Opts): Promise<void>;
  bootstrapSession(createOpts: Opts): Promise<unknown>;
}

/**
 * 冷 Pi 恢复失败后的落点（分支表抽成可执行函数，供接线层与单测共用）：
 * - `verified`：恢复后有活会话，拿 live 读数刷新当前窗口；
 * - `degraded`：恢复失败（最常见是存量 BYOM 路由已死，bootstrap 按 fail-closed
 *   语义必然失败）——只记日志继续切，闸门对未知当前窗口 fail-open 放行热切，
 *   目标路由由下一次发送懒创建。失败即拒绝切模会让会话永久卡死；
 * - `fail-closed`：bootstrap 声称成功却没有活会话，且没降级过（原 #5508 出口）。
 */
export function classifyColdPiRehydrationOutcome(input: {
  rehydrationFailed: boolean;
  liveAfterBootstrap: boolean;
}): 'verified' | 'degraded' | 'fail-closed' {
  if (input.liveAfterBootstrap) return 'verified';
  return input.rehydrationFailed ? 'degraded' : 'fail-closed';
}

async function stage<T>(
  category: ColdPiRehydrationFailureCategory,
  describe: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ColdPiRehydrationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ColdPiRehydrationError(category, `${describe}: ${message}`, { cause: error });
  }
}

export function createColdPiRehydrationForWindowVerification<
  Row extends ColdPiSessionRow,
  Opts extends { workingDir?: string; agentKind: string; remoteHostId?: string | null },
>(deps: ColdPiRehydrationDeps<Row, Opts>) {
  return async function rehydrateColdPiRuntimeForWindowVerification(sessionId: string): Promise<void> {
    if (deps.hasLiveSession(sessionId)) return;
    const row = await stage('session-lookup-failed', `session ${sessionId} row lookup failed`, () =>
      deps.loadSessionRow(sessionId),
    );
    // 失败分类只为诊断（#5508）：每个分支仍 fail-closed，切模不会继续。
    if (!row) {
      throw new ColdPiRehydrationError('session-row-missing', `session ${sessionId} has no database row`);
    }
    if (row.agentKind !== 'pi' || row.remoteHostId) {
      throw new ColdPiRehydrationError(
        'not-local-pi',
        `session ${sessionId} is not a local Pi runtime (agentKind=${row.agentKind}${row.remoteHostId ? ', remote' : ''})`,
      );
    }
    if (!row.sdkSessionId) {
      throw new ColdPiRehydrationError('native-session-missing', `session ${sessionId} has no native Pi session to resume`);
    }
    if (!row.workingDir) {
      throw new ColdPiRehydrationError('working-dir-missing', `session ${sessionId} has no working directory`);
    }
    const createOpts = deps.buildCreateOpts(sessionId, row as ColdPiResumableRow<Row>);
    // 探测只把 ENOENT 视为「目录不存在」；超时、权限、I/O 错误会原样抛出，这里按
    // 探测失败单独分类，并保留错误码供日志与 IPC 概述使用。
    const workDirExists = await stage(
      'working-dir-probe-failed',
      `working directory probe failed for session ${sessionId}`,
      () => deps.checkWorkDirExists(sessionId, createOpts.workingDir, createOpts.agentKind, createOpts.remoteHostId),
    );
    if (!workDirExists) {
      throw new ColdPiRehydrationError('working-dir-missing', `working directory is missing for session ${sessionId}`);
    }
    await stage('session-options-failed', `session ${sessionId} create options could not be prepared`, () =>
      deps.prepareCreateOpts(sessionId, createOpts),
    );
    await stage('bootstrap-failed', `session ${sessionId} bootstrap failed`, () => deps.bootstrapSession(createOpts));
  };
}
