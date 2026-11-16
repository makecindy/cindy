import { i18n } from '@/i18n';
import { formatRemoteError } from '@cindy/maker-shared/device-link-contract';
import { humanizeRemoteError } from '@/device-link/remoteStatus';
import { mediaLoadFailureKey } from '@/session/remoteMedia';

/**
 * 文件预览页的失败文案（#5426）。
 *
 * 被控端把稳定错误标记放进 message(`[MEDIA_SOURCE_MISSING] …`),传输层还会再包一层
 * (`[MEDIA_FETCH_FAILED] …`)。这些是内部协议码,直接怼到界面上等于把内部状态摊给用户。
 * 对话正文 / 图片查看器早就用 mediaLoadFailureKey 翻成友好文案(见 #5327),预览页沿用
 * 同一套映射,不再另起一份 —— 同一个故障在两条路径上给用户同一种说法。
 */
export type FilePreviewFailureKind = 'sourceMissing' | 'deviceOffline' | 'remoteError' | 'plain';

const REMOTE_CODE_MARKER = /\[[A-Z][A-Z0-9_]{2,}\]/;

/** 分类只认稳定协议码,不猜文案:没有协议码的错误原样透出。 */
export function filePreviewFailureKind(error: unknown): FilePreviewFailureKind {
  const mediaKey = mediaLoadFailureKey(error);
  if (mediaKey === 'message.lightbox.sourceMissing') return 'sourceMissing';
  if (mediaKey === 'message.lightbox.deviceOffline') return 'deviceOffline';
  if (REMOTE_CODE_MARKER.test(formatRemoteError(error))) return 'remoteError';
  return 'plain';
}

/**
 * 远端错误 → 界面语言的说法;不带协议码的错误原样透出(那多半已经是本地文案,
 * 例如导出失败时的 t('files.preview.downloadFailed'))。
 */
export function filePreviewFailureText(error: unknown): string {
  if (!error) return i18n.t('deviceLink.remoteError.unclassified');
  switch (filePreviewFailureKind(error)) {
    case 'sourceMissing':
      return i18n.t('message.lightbox.sourceMissing');
    case 'deviceOffline':
      return i18n.t('message.lightbox.deviceOffline');
    case 'remoteError':
      return humanizeRemoteError(error);
    default:
      return formatRemoteError(error);
  }
}
