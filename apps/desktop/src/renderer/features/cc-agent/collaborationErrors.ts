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
  const base = (() => {
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
  })();
  // 被控端出错时,`_REMOTE` 文案只讲「去那台机器修好再重试」,没说这一条**仍然会发出去**。
  // 用户据此可能以为没发、再提交一次,或在不知情下让首轮脱离协同运行(codex review P2)。
  // remoteDevice 已经占掉了 `_CONTINUE` 后缀那一档,所以用一句独立的补充说明,而不是再
  // 铺一套 `_REMOTE_CONTINUE` 文案 —— 两句都是完整句子,拼接不会产生语法碎片。
  if (options.remoteDevice && options.continueAsSingleSession) {
    return `${base}${t('newChat.collaboration.remoteContinueNotice')}`;
  }
  return base;
}
