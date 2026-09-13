import { shouldShowOpenPathError } from '../../shared/openPathResult';
import { toast } from './toast';
import { isTextPreviewSupported } from './textPreview';
import { i18n } from '@/i18n';
import { isRemoteFileOrigin, type SessionFileOrigin } from './sessionFileOrigin';
import { openRemoteChatFile } from './remoteFileOpen';

/**
 * TextLightbox only handles text/code/markdown. For every other local file,
 * hand off to the OS default application instead of trying to decode binary
 * content as UTF-8.
 */
export async function shouldOpenTextLightbox(filePath: string): Promise<boolean> {
  if (isTextPreviewSupported(filePath)) return true;

  try {
    const res = await window.electronAPI.openPath(filePath);
    if (shouldShowOpenPathError(res)) {
      toast.error(res.error || i18n.t('logic.errors.openFileFailed'));
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : i18n.t('logic.errors.openFileFailed'));
  }

  return false;
}

/**
 * shouldOpenTextLightbox 的 origin-aware 版本(聊天流调用面统一走这里):
 *   - 文本类扩展名 → true,调用方打开 TextLightbox(其内部按 origin 决定读本机
 *     还是远端取回缓存副本);
 *   - 非文本 + 本地会话 → 原有行为:直接交系统默认应用打开;
 *   - 非文本 + 远程会话 → **绝不**对远端路径调本机 openPath(那是误开本机同
 *     路径文件的最大单点),改走「取回缓存副本 → 打开副本」。
 */
export async function shouldOpenTextLightboxForOrigin(
  ctx: { origin: SessionFileOrigin; workingDir: string },
  filePath: string,
): Promise<boolean> {
  if (isTextPreviewSupported(filePath)) return true;
  if (!isRemoteFileOrigin(ctx.origin)) return shouldOpenTextLightbox(filePath);
  await openRemoteChatFile(ctx.origin, ctx.workingDir, filePath);
  return false;
}
