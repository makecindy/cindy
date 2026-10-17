import { isSharedTaskPeer } from '@cindy/device-link';

/**
 * 「我的消息气泡颜色」只染确定是自己发的消息。共享任务里所有 user 消息都右对齐,
 * 不能按对齐判断:
 * - 带共享作者的消息(访客发的)只有作者账号是当前账号才算自己的;
 * - 没有共享作者的消息是房主本人发的,只有当前不是以访客身份查看共享任务时才算自己的。
 * 归属只用于展示,不作权限依据。
 */
export function isOwnUserBubble(
  message: { sharedAuthorName?: string; sharedAuthorAccountId?: string },
  viewer: { accountId?: string | null; remoteDeviceId?: string },
): boolean {
  if (message.sharedAuthorName || message.sharedAuthorAccountId) {
    return !!viewer.accountId && message.sharedAuthorAccountId === viewer.accountId;
  }
  return !isSharedTaskPeer(viewer.remoteDeviceId);
}
