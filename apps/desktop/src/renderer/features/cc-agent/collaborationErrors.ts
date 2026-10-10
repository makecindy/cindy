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
    if (options.remoteDevice && ipcError?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') {
      return t('newChat.collaboration.unsupportedRemoteHint');
    }
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

/**
 * Worker 的 Agent 在另一台电脑或分享来的供应商上运行(远程供应商)时创建失败的具体原因，与任务里
 * 远程 Agent 出错同一套文案；其余错误沿用协同通用文案。
 */
export function workerAgentDeviceErrorMessage(err: unknown, t: TFunction): string | null {
  const code = extractIpcError(err)?.code;
  switch (code) {
    case 'REMOTE_AGENT_DEVICE_UNREACHABLE':
      return t('chat.remoteError.REMOTE_AGENT_UNAVAILABLE');
    case 'REMOTE_AGENT_SHARE_PAUSED':
    case 'REMOTE_AGENT_SHARE_REMOVED':
    case 'REMOTE_AGENT_SHARE_UNAVAILABLE':
      return t(`chat.remoteError.${code}`);
    default:
      return null;
  }
}

/** 运行设备(另一台电脑)创建失败时的具体原因；其余错误沿用协同通用文案。 */
export function executionDeviceErrorMessage(
  err: unknown,
  t: TFunction,
  deviceName: string | undefined,
  withDir: boolean,
): string | null {
  const device = deviceName || t('orca.rolePill.unknownDevice');
  switch (extractIpcError(err)?.code) {
    case 'REMOTE_AGENT_DEVICE_UNREACHABLE':
      return t('orca.createWorker.errors.deviceUnreachable', { device });
    case 'UNSUPPORTED_CAPABILITY':
      return t('orca.createWorker.errors.deviceOutdated', { device });
    case 'REMOTE_WORKDIR_NOT_FOUND':
    case 'REMOTE_WORKDIR_NOT_DIRECTORY':
    case 'REMOTE_WORKDIR_INVALID':
      return t('orca.createWorker.errors.dirRejected', { device });
    case 'REMOTE_WORKDIR_UNAVAILABLE':
      return t('orca.createWorker.errors.dirUnavailable', { device });
    case 'INVALID_PARAMS':
      return withDir ? t('orca.createWorker.errors.dirRejected', { device }) : null;
    default:
      return null;
  }
}
