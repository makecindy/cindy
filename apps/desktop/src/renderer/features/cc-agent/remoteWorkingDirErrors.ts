import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';

const REMOTE_WORKDIR_ERROR_CODES = new Set([
  'REMOTE_WORKDIR_INVALID',
  'REMOTE_WORKDIR_NOT_FOUND',
  'REMOTE_WORKDIR_NOT_DIRECTORY',
  'REMOTE_WORKDIR_UNAVAILABLE',
]);

/** 将远程目录 IPC 错误映射为面向用户的本地化提示；非目录错误交回调用方处理。 */
export function getRemoteWorkingDirErrorMessage(
  err: unknown,
  t: (key: string) => string,
): string | null {
  const ipcError = extractIpcError(err);
  if (!ipcError || !REMOTE_WORKDIR_ERROR_CODES.has(ipcError.code)) return null;
  return t(mapIpcErrorToI18nKey(err));
}
