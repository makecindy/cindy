/**
 * 收藏同步失败提示的文案选择。
 *
 * renderer 经设备互联拿到的是 ipc.ts DEVICE_LINK_CODE_MAP 映射后的码。连不上那台电脑的几类码
 * 用「连不上」文案；其它错误(含对方版本不支持收藏同步)保留原文案，不再统一暗示「需要更新」。
 */

const FAVORITES_UNREACHABLE_CODES = new Set([
  'DEVICE_LINK_NOT_CONNECTED',
  'DEVICE_LINK_DEVICE_OFFLINE',
  'DEVICE_LINK_DEVICE_UNRESPONSIVE',
  'DEVICE_LINK_TIMEOUT',
  'DEVICE_LINK_BUSY',
]);

export function favoritesSyncFailureI18nKey(
  errorCode: string | null | undefined,
): 'newChat.modelSelector.unified.favoritesSyncFailedUnreachable' | 'newChat.modelSelector.unified.favoritesSyncFailed' {
  return errorCode && FAVORITES_UNREACHABLE_CODES.has(errorCode)
    ? 'newChat.modelSelector.unified.favoritesSyncFailedUnreachable'
    : 'newChat.modelSelector.unified.favoritesSyncFailed';
}
