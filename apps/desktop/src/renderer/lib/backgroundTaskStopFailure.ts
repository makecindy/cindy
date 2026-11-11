/**
 * 后台任务停止失败的用户提示(任务卡 / 后台任务面板 / 状态栏共用)。
 *
 * 只提示用户能处理、且立即重试也不会变好的远程失败:
 *  - 远程电脑版本过旧,未收录停止 channel → 提示升级;
 *  - 远程电脑暂时无法响应:未连接 / 超时 / 归属尚未解析(与远程会话列表重试同一瞬态判据),
 *    以及调度繁忙(DEVICE_LINK_BUSY)→ 提示稍后重试。
 * 其余失败保持静默:状态翻转由事件流 / 快照收口,按钮保留可重试。
 */

import type { TFunction } from 'i18next';

import { isTransientRemoteError } from '@/features/device-link/refreshRemoteSessions';
import { extractIpcError } from '@/utils/ipcError';

import { toast } from './toast';

export function reportBackgroundTaskStopFailure(error: unknown, t: TFunction): void {
  if (extractIpcError(error)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') {
    toast.warning(t('chat.backgroundActivity.remoteStopUnsupported'));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isTransientRemoteError(message) || extractIpcError(error)?.code === 'DEVICE_LINK_BUSY') {
    toast.warning(t('chat.backgroundActivity.remoteStopUnreachable'));
  }
}
