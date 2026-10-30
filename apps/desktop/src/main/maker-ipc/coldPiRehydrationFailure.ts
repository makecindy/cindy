/**
 * 冷 Pi 切模前的运行时恢复失败原因（#5508）。
 *
 * `handleSetModel` 在冷 Pi 有原生会话 ID 时先恢复旧运行时核实当前窗口；恢复失败原本
 * 被裸 `catch {}` 吞掉，只抛固定文案「Pi current runtime could not be verified」。
 * 用户与日志都看不到是会话行缺失、工作目录不存在还是 bootstrap 失败，重试又会走同一条
 * 失败路径，排查无从下手。
 *
 * 这里把失败分成两层：
 * - `reason`：完整的单行原因（来自原始异常 message），只进 Main 日志；
 * - `detail`：可跨 IPC 的概述，只含类别约定文案与错误名称/错误码，不带原始 message，
 *   因此工作目录探测或 bootstrap 抛出的本机路径、stderr 不会进入渲染层。
 * 错误码与用户可见文案不变，行为仍然 fail-closed、不改路由。
 */

import type { IpcErrorCode } from '../../shared/ipc-errors.js';

export type ColdPiRehydrationFailureCategory =
  | 'session-lookup-failed'
  | 'session-row-missing'
  | 'not-local-pi'
  | 'native-session-missing'
  | 'working-dir-missing'
  | 'working-dir-probe-failed'
  | 'session-options-failed'
  | 'bootstrap-failed'
  | 'runtime-not-live'
  | 'unknown';

export interface ColdPiRehydrationFailure {
  category: ColdPiRehydrationFailureCategory;
  /** 完整单行、有界的原因，只写 Main 日志。 */
  reason: string;
  /** 跨 IPC 的概述：类别约定文案或「错误名 错误码」，不含原始 message。 */
  detail: string;
}

const REASON_MAX_LENGTH = 240;
const DETAIL_MAX_LENGTH = 120;

export class ColdPiRehydrationError extends Error {
  /** 跨 IPC 的概述；未显式给出时按 `cause` 的错误名/错误码生成，不会回退到 message。 */
  readonly detail: string;

  constructor(
    readonly category: ColdPiRehydrationFailureCategory,
    message: string,
    options?: { cause?: unknown; detail?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ColdPiRehydrationError';
    this.detail = redactLocalPaths(
      options?.detail ?? (options?.cause === undefined ? message : describeCauseForIpc(options.cause)),
    );
  }
}

/** 压成单行并截断：原因来自异常 message，可能含多行栈或超长路径。 */
export function sanitizeColdPiRehydrationReason(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '');
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'no error detail';
  return singleLine.length > REASON_MAX_LENGTH
    ? `${singleLine.slice(0, REASON_MAX_LENGTH - 1)}…`
    : singleLine;
}

/**
 * 只取错误名与错误码（如 `Error EACCES`、`Error WORKDIR_PROBE_TIMEOUT`）。message
 * 可能带本机路径、命令行或子进程 stderr，一律不进 IPC。
 */
export function describeCauseForIpc(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const name = cause.name && cause.name !== 'Error' ? cause.name : 'Error';
    return typeof code === 'string' && code ? `${name} ${code}` : name;
  }
  if (cause === null || cause === undefined) return 'no error detail';
  return `non-error ${typeof cause}`;
}

/**
 * 兜底脱敏：把 POSIX / Windows / `~` 开头的绝对路径替换为 `<path>`。类别约定文案本身不含
 * 路径，这里只防未来有人把路径拼进 detail。
 */
export function redactLocalPaths(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  // `~/…` 先于绝对路径处理，否则 `/Library/…` 会先被吃掉而留下 `~`。路径段含空格时
  // 只能脱敏到第一个空格为止：detail 的来源是类别约定文案与错误码，这里只是兜底。
  const redacted = singleLine
    .replace(/~[\\/][^\s'"`<>|]*/g, '<path>')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'"`<>|]+[\\/])+[^\s'"`<>|]*/g, '<path>');
  if (!redacted) return 'no error detail';
  return redacted.length > DETAIL_MAX_LENGTH
    ? `${redacted.slice(0, DETAIL_MAX_LENGTH - 1)}…`
    : redacted;
}

export function describeColdPiRehydrationFailure(error: unknown): ColdPiRehydrationFailure {
  if (error instanceof ColdPiRehydrationError) {
    return {
      category: error.category,
      reason: sanitizeColdPiRehydrationReason(error),
      detail: error.detail,
    };
  }
  return {
    category: 'unknown',
    reason: sanitizeColdPiRehydrationReason(error),
    detail: redactLocalPaths(describeCauseForIpc(error)),
  };
}

/**
 * 抛给渲染层的错误信息。保留原固定前缀（接线测试与既有文案依赖它），括号内只附失败
 * 类别与 IPC 概述；渲染层按错误码映射用户文案，完整原因看 Main 日志。
 */
export function coldPiRehydrationFailureMessage(failure: ColdPiRehydrationFailure): string {
  return `Pi current runtime could not be verified (${failure.category}: ${failure.detail}); runtime selection was not changed`;
}

export interface ColdPiRehydrationFailureContext {
  sessionId: string;
  fromModel: string | null;
  toModel: string;
  currentProviderId: string | null | undefined;
  nextProviderId: string | null | undefined;
}

export interface ColdPiRehydrationFailureReporterDeps {
  log: { warn(...args: unknown[]): void };
  throwIpcError: (code: IpcErrorCode, message: string) => never;
  errorCode: IpcErrorCode;
}

/** 只记日志的调用方：恢复失败降级继续的路径（切模不死锁），不向渲染层抛错。 */
export interface ColdPiRehydrationFailureLoggerDeps {
  log: { warn(...args: unknown[]): void };
}

export const COLD_PI_REHYDRATION_FAILURE_LOG_MESSAGE =
  'set-model: cold Pi runtime rehydration failed; runtime selection unchanged';

// 降级继续的日志文案不能复用上面的“runtime selection unchanged”：切模没有失败，
// 草率写 unchanged 会让排障者以为选择被拒，指向错误的方向。
export const COLD_PI_REHYDRATION_DEGRADED_LOG_MESSAGE =
  'set-model: cold Pi window verification degraded; continuing with the selected route';

function logColdPiRehydrationFields(
  log: { warn(...args: unknown[]): void },
  message: string,
  context: ColdPiRehydrationFailureContext,
  failure: ColdPiRehydrationFailure,
): void {
  log.warn(message, {
    sessionId: context.sessionId,
    category: failure.category,
    reason: failure.reason,
    detail: failure.detail,
    fromModel: context.fromModel,
    toModel: context.toModel,
    currentProviderId: context.currentProviderId,
    nextProviderId: context.nextProviderId,
  });
}

/**
 * 冷 Pi 恢复失败但切模降级继续时的出口：完整原因写 Main 日志，不抛 IPC 错误。
 * 核实是护栏不是闸门——存量路由死掉时 bootstrap 必然失败，若据此拒绝切模，
 * 用户既发不出去也切不走（会话永久卡死）；目标路由由下一次发送懒创建。
 */
export function logColdPiRehydrationFailure(
  deps: ColdPiRehydrationFailureLoggerDeps,
  context: ColdPiRehydrationFailureContext,
  error: unknown,
): void {
  logColdPiRehydrationFields(
    deps.log,
    COLD_PI_REHYDRATION_DEGRADED_LOG_MESSAGE,
    context,
    describeColdPiRehydrationFailure(error),
  );
}

/**
 * 冷 Pi 恢复失败仍 fail-closed 的出口（runtime-not-live 等非降级分支）：完整原因写
 * Main 日志，IPC 错误只带类别与脱敏概述。错误码由调用方给出（设备链路下仍映射为
 * PRECONDITION_FAILED）。
 */
export function reportColdPiRehydrationFailure(
  deps: ColdPiRehydrationFailureReporterDeps,
  context: ColdPiRehydrationFailureContext,
  error: unknown,
): never {
  const failure = describeColdPiRehydrationFailure(error);
  logColdPiRehydrationFields(deps.log, COLD_PI_REHYDRATION_FAILURE_LOG_MESSAGE, context, failure);
  return deps.throwIpcError(deps.errorCode, coldPiRehydrationFailureMessage(failure));
}
