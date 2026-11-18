import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createSourceFileAccessError, isSourceFileAccessError } from './sourceFileError';

interface SourceFileAccessRecovery {
  /** A native single-file picker; the selected path stays inside Main. */
  selectFile(source: string): Promise<string | null>;
  assertCurrent(): void;
  signal?: AbortSignal;
}
const recoveryContext = new AsyncLocalStorage<SourceFileAccessRecovery & { attempted: Set<string>; discard: Set<() => void> }>();

/** Only the trusted foreground chat adapter installs this scope. Exports/background jobs do not prompt. */
export function withSourceFileAccessRecovery<T>(recovery: SourceFileAccessRecovery, operation: () => Promise<T>): Promise<T> {
  const discard = new Set<() => void>();
  const discardUploads = () => {
    for (const cleanup of discard) cleanup();
    discard.clear();
  };
  recovery.signal?.addEventListener('abort', discardUploads, { once: true });
  return recoveryContext.run({ ...recovery, attempted: new Set(), discard }, async () => {
    try {
      return await operation();
    } catch (error) {
      discardUploads();
      // 兜底复查失败只作补充信息(#10852):真实故障(传输超时、离线、附件读失败)
      // 才是主错误,不能被权限类错误顶替,否则用户无法判断该重试还是查链路。
      try {
        recovery.assertCurrent();
      } catch (assertError) {
        // 例外:中止类错误是作用域作废掐断在途传输的**症状**,根因是作用域失效。
        // 这时守卫错误当主错误(它带着"这次发送为什么作废"),中止错误降级成 cause。
        if (isScopeTeardownSymptom(error, recovery.signal)) {
          attachDiagnosticCause(assertError, error);
          throw assertError;
        }
        attachDiagnosticCause(error, assertError);
      }
      throw error;
    } finally {
      recovery.signal?.removeEventListener('abort', discardUploads);
      discard.clear();
    }
  });
}

/** 把补充原因挂到原始错误的 cause 上;挂不上就放弃,绝不顶替原始错误。 */
function attachDiagnosticCause(error: unknown, cause: unknown): void {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return;
  try {
    const current = (error as { cause?: unknown }).cause;
    if (current === undefined || current === null) (error as { cause?: unknown }).cause = cause;
  } catch {
    // 冻结或只读的错误对象附不上 cause;原始错误照常抛出。
  }
}

/**
 * 传输链路明确抛出的中止标记(`mediaTransfer` / `filePeer` / `fileAccess` 抛的就是这两个
 * token,整条消息只有 token 本身)。
 *
 * **只认整条消息就是标记**,不做子串匹配:附件路径自己就可能含这个词 ——
 * `/tmp/UPLOAD_CANCELLED/report.pdf` 读取失败时,ENOENT 文案带着整条路径,按子串判就会把
 * 真实的「文件不存在」误判成中止症状,又让它被权限错误顶替一次(#10906 review P2)。
 * 包装层(`[DEVICE_LINK_MEDIA_TRANSFER_FAILED] <inner>`)先剥前缀再比,内层整条是标记才算。
 */
const CANCELLED_SENTINELS = new Set(['UPLOAD_CANCELLED', 'FILE_PEER_CANCELLED']);

/** 剥掉 IPC 包装层的 `[CODE] ` 前缀,拿到内层原文;没有前缀就原样返回。 */
function unwrapIpcMessage(message: string): string {
  const match = /^\[[A-Z0-9_]+\]\s+([\s\S]*)$/.exec(message);
  return (match ? match[1] : message).trim();
}

/** 这条消息本身是不是「传输链路明确报告中止」——整条消息必须就是标记。 */
function isCancellationSentinel(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  return CANCELLED_SENTINELS.has(unwrapIpcMessage(message));
}

/**
 * 这个错误是不是「作用域作废掐断在途传输」的症状,而非失败根因。
 * 传输链路用 `UPLOAD_CANCELLED` / `FILE_PEER_CANCELLED` 报告中止,标准中止异常用
 * AbortError 标记 —— 都不说明"为什么"中止,只有作用域守卫知道。
 */
function isScopeTeardownSymptom(error: unknown, signal?: AbortSignal): boolean {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (isAbortMarker(candidate)) return true;
  if (signal && error === signal.reason) return true;
  // 包装层自己不带标记:DEVICE_LINK_MEDIA_TRANSFER_FAILED 会把 readFile 的 signal 中止
  // 包成一句「The operation was aborted」,name/code 全丢(#10906 review P2)。这时只有
  // **本作用域的信号确实已中止**、且 cause 链上带着中止标记,才算作用域拆坏的症状 ——
  // 否则远端自己的中止会把真实故障重新顶替掉。
  if (signal?.aborted !== true) return false;
  return chainHasAbortMarker(candidate.cause, 0);
}

/** 错误自身就是中止:标准 AbortError,或传输链路的显式中止标记(整条消息即标记)。 */
function isAbortMarker(error: { name?: unknown; code?: unknown; message?: unknown }): boolean {
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return true;
  return isCancellationSentinel(error.message);
}

/** cause 链上(有深度上限,防环)是否带着中止标记。 */
function chainHasAbortMarker(cause: unknown, depth: number): boolean {
  if (depth > 3 || cause === null || (typeof cause !== 'object' && typeof cause !== 'function')) return false;
  const candidate = cause as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (isAbortMarker(candidate)) return true;
  return chainHasAbortMarker(candidate.cause, depth + 1);
}

/** Captured by each transfer, so its asynchronous checkpoints retain the initiating scope. */
export function sourceFileAccessTransferOptions(): { assertCurrent?: () => void; signal?: AbortSignal } {
  const scope = recoveryContext.getStore();
  return scope ? { assertCurrent: scope.assertCurrent, signal: scope.signal } : {};
}

/** A multi-attachment send owns every new object until its final dispatch starts. */
export function onSourceFileAccessDiscard(cleanup: () => void): void {
  const scope = recoveryContext.getStore();
  if (!scope) return;
  if (scope.signal?.aborted) cleanup();
  else scope.discard.add(cleanup);
}

/** Once dispatch starts its outcome may be uncertain; accepted messages still need these bytes. */
export function releaseSourceFileAccessUploads(): void {
  recoveryContext.getStore()?.discard.clear();
}

async function isSelectedSource(source: string, selected: string): Promise<boolean> {
  if (selected === source) return true;
  if (process.platform !== 'win32'
    || path.win32.normalize(selected).toLowerCase() !== path.win32.normalize(source).toLowerCase()) return false;
  // Folding alone would accept a different file in a case-sensitive Windows directory.
  // Compare filesystem identity instead; a missing/unsupported identity fails closed.
  try {
    const [original, confirmed] = await Promise.all([stat(source, { bigint: true }), stat(selected, { bigint: true })]);
    return original.isFile() && confirmed.isFile() && original.ino !== 0n
      && original.dev === confirmed.dev && original.ino === confirmed.ino;
  } catch {
    return false;
  }
}

export async function readWithSourceFileAccessRecovery<T>(source: string, read: () => Promise<T>): Promise<T> {
  const scope = recoveryContext.getStore();
  scope?.assertCurrent();
  try {
    const result = await read();
    scope?.assertCurrent();
    return result;
  } catch (error) {
    if (!scope || !isSourceFileAccessError(error, source)
      || !(process.platform === 'win32' ? path.win32 : path).isAbsolute(source) || scope.attempted.has(source)) throw error;
    // 走到这里说明读取被真的拒绝了(EPERM / EACCES / ACCESS_DENIED),它才是根因。
    // 若读取期间作用域恰好也失效了,守卫错误只作补充信息挂到 cause,并且不再弹选择框
    // —— 否则「附件读失败保留真实原因」这半边会在内层又被权限错误顶替一次
    // (#10906 review),外层无论如何都恢复不回来。
    try {
      scope.assertCurrent();
    } catch (assertError) {
      attachDiagnosticCause(error, assertError);
      throw error;
    }
    scope.attempted.add(source);
    const selected = await scope.selectFile(source);
    scope.assertCurrent();
    // Confirm only this original. A different file must never silently replace a draft attachment.
    if (!selected || !await isSelectedSource(source, selected)) throw createSourceFileAccessError();
    scope.assertCurrent();
    // No recursive retry: a second denial returns the normal error and restores the draft.
    const result = await read();
    scope.assertCurrent();
    return result;
  }
}
