/** Navigation-only actions shared by message links and mail previews.
 * Keep task association and account stores in useOpenWithMenu, not this module.
 */
import type { MouseEvent } from 'react';
import type { TFunction } from 'i18next';
import type { SessionFileOrigin } from '@/lib/sessionFileOrigin';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { toast } from '@/lib/toast';
import { getLinkOpenPreference, getLinkOpenPreferenceForUrl } from '@/hooks/useLinkOpenPreference';
import { readMailPreview, openMailPreview } from '@/features/right-sidebar/lib/mailPreview';
import {
  openUrlInSidebarBrowser,
  pathToFileUrl,
} from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { isSeparateLinkActivation } from './linkInteraction';

/** 在侧边栏浏览器打开 url,失败 toast(addTab 上限 / IPC 异常等)。 */
export async function openInSidebar(sessionId: string, url: string, t: TFunction): Promise<void> {
  try {
    await openUrlInSidebarBrowser(sessionId, url);
  } catch {
    // store 层已 log,这里只给用户反馈。
    toast.error(t('chat.markdownRenderer.openInSidebarFailed'));
  }
}

/** http(s) / file 链接左键:按 URL 属于外部网页还是内部网页选对应偏好直开。 */
export async function openUrlByPreference(
  sessionId: string,
  url: string,
  t: TFunction,
): Promise<void> {
  if (url.startsWith('https://')) {
    let supported = false;
    try {
      supported = (await readMailPreview(sessionId, url, false)).supported;
    } catch {
      /* Older hosts retain normal link opening. */
    }
    if (supported) {
      await openMailPreview(sessionId, url);
      return;
    }
  }
  if (getLinkOpenPreferenceForUrl(url) === 'sidebar') {
    await openInSidebar(sessionId, url, t);
    return;
  }
  const res = await window.electronAPI.openExternal(url);
  if (!res.success) toast.error(t('chat.markdownRenderer.openLinkFailed'));
}

/** Identical activation for user URLs, assistant Markdown and keyboard/middle clicks. */
export async function activateMessageUrl(
  event: Pick<
    MouseEvent<HTMLElement>,
    'preventDefault' | 'stopPropagation' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'button'
  >,
  sessionId: string | undefined,
  url: string,
  t: TFunction,
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  try {
    if (sessionId && !isSeparateLinkActivation(event)) {
      await openUrlByPreference(sessionId, url, t);
    } else {
      const result = await window.electronAPI.openExternal(url);
      if (!result.success) toast.error(t('chat.markdownRenderer.openLinkFailed'));
    }
  } catch {
    toast.error(t('chat.markdownRenderer.openLinkFailed'));
  }
}

/** 左键"按偏好直开"只对浏览器"作为页面渲染"有意义的 html 家族生效;其余本地
 *  文件保持原有"点击即预览"。右键菜单的 BROWSER_OPENABLE_EXTS 也收敛到
 *  HTML,二者保持同一产品语义。 */
export function isHtmlFilePath(filePath: string): boolean {
  return /\.(html?|xhtml)$/i.test(filePath);
}

// Repeated clicks share preparation and navigation, not a completed-result cache.
const pendingHtmlPreviews = new Map<string, Promise<void>>();

/** Local HTML opens in place; remote HTML uses the viewer-local HTTP preview. */
export async function openHtmlFileByPreference(
  sessionId: string,
  absPath: string,
  t: TFunction,
  context: { origin: SessionFileOrigin; workingDir: string } = {
    origin: { kind: 'local' },
    workingDir: '',
  },
  target?: 'sidebar' | 'external',
): Promise<void> {
  if (context.origin.kind === 'local') {
    if ((target ?? getLinkOpenPreference('local')) === 'sidebar' && sessionId) {
      await openInSidebar(sessionId, pathToFileUrl(absPath), t);
    } else {
      try {
        await window.electronAPI.openFileInBrowser(absPath);
      } catch (error) {
        toast.error(
          t(
            mapIpcErrorToI18nKey(error, {
              namespace: 'chat.markdownRenderer',
              fallback: 'chat.markdownRenderer.openInBrowserFailed',
            }),
          ),
        );
      }
    }
    return;
  }
  const resolvedTarget = target ?? getLinkOpenPreference('local');
  const key = JSON.stringify([
    sessionId,
    context.origin,
    context.workingDir,
    absPath,
    resolvedTarget,
  ]);
  const pending = pendingHtmlPreviews.get(key);
  if (pending) return pending;
  const opening = prepareRemoteHtml().finally(() => {
    if (pendingHtmlPreviews.get(key) === opening) pendingHtmlPreviews.delete(key);
  });
  pendingHtmlPreviews.set(key, opening);
  return opening;

  async function prepareRemoteHtml(): Promise<void> {
    const requestId = crypto.randomUUID();
    let cancelled = false;
    let finished = false;
    let loading: string | null = null;
    const cancel = () => {
      if (cancelled || finished) return;
      cancelled = true;
      pendingHtmlPreviews.delete(key);
      void window.electronAPI.fileBrowser.cancelHtmlPreview(requestId).catch(() => {});
      if (loading) toast.dismiss(loading);
    };
    window.addEventListener('beforeunload', cancel);
    const delayed = setTimeout(() => {
      if (cancelled) return;
      loading = toast.loading(t('chat.remoteFile.previewFetching'), {
        action: { label: t('commonUi.confirmDialog.cancel'), onClick: cancel },
        onClose: cancel,
      });
    }, 600);
    try {
      const result = await window.electronAPI.fileBrowser.previewHtml({
        origin: context.origin,
        workdir: context.workingDir,
        absPath,
        requestId,
      });
      if (cancelled) return;
      finished = true;
      if (resolvedTarget === 'sidebar' && sessionId) {
        await openInSidebar(sessionId, result.url, t);
      } else {
        const opened = await window.electronAPI.openExternal(result.url);
        if (!opened.success) toast.error(t('chat.markdownRenderer.openInBrowserFailed'));
      }
    } catch (error) {
      const code = extractIpcError(error)?.code;
      if (cancelled || code === 'HTML_PREVIEW_CANCELLED') return;
      const key =
        code === 'DEVICE_LINK_BUSY'
          ? 'previewConnectionBusy'
          : code === 'DEVICE_LINK_TIMEOUT'
            ? 'previewTimeout'
            : code === 'DEVICE_LINK_NOT_CONNECTED' ||
                code === 'DEVICE_LINK_DEVICE_OFFLINE' ||
                code === 'DEVICE_LINK_DEVICE_UNRESPONSIVE'
              ? 'previewDisconnected'
              : code === 'HTML_PREVIEW_TOO_LARGE'
                ? 'previewTooLarge'
                : code === 'HTML_PREVIEW_UNSUPPORTED'
                  ? 'previewUnsupported'
                  : code === 'NOT_FOUND'
                    ? 'previewNotFound'
                    : 'previewFailed';
      toast.error(t(`chat.remoteFile.${key}`));
    } finally {
      finished = true;
      window.removeEventListener('beforeunload', cancel);
      clearTimeout(delayed);
      if (loading) toast.dismiss(loading);
    }
  }
}
