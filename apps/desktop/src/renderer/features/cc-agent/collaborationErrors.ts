import type { TFunction } from 'i18next';

import { extractIpcError } from '@/utils/ipcError';

interface CollaborationStartErrorOptions {
  continueAsSingleSession?: boolean;
  remoteDevice?: boolean;
}

const ACTIONABLE_COLLABORATION_ERROR_CODES = new Set([
  'INVALID_PARAMS',
  'PRECONDITION_FAILED',
  'NO_PROVIDER_FOR_AGENT',
  'PROVIDER_ROUTE_UNAVAILABLE',
  'BUDGET_MODEL_REQUIRES_API_MODE',
]);

/**
 * 协同启动错误的 renderer 文案边界。
 * main 只负责返回稳定错误码；UI 文案统一在 i18n 里按错误码映射，避免把 IPC message 当作界面文本。
 */
export function getCollaborationStartErrorMessage(
  err: unknown,
  t: TFunction,
  options: CollaborationStartErrorOptions = {},
): string {
  const ipcError = extractIpcError(err);
  if (ipcError && ACTIONABLE_COLLABORATION_ERROR_CODES.has(ipcError.code)) {
    const suffix = options.remoteDevice
      ? '_REMOTE'
      : options.continueAsSingleSession
        ? '_CONTINUE'
        : '';
    return t(`newChat.collaboration.errors.${ipcError.code}${suffix}`);
  }
  return t(
    options.continueAsSingleSession
      ? 'newChat.collaboration.startFailedContinue'
      : 'newChat.collaboration.startFailed',
  );
}
