/**
 * useOpenWithMenu
 * ---------------------------------------------------------------------------
 * 消息流里 http(s) 链接的**右键**「打开方式」菜单:在侧边栏浏览器中打开 /
 * 在默认浏览器中打开。左键不再弹菜单——由 openUrlByPreference /
 * openHtmlFileByPreference 按用户偏好(设置 → 个性化 → 链接打开方式)直开。
 * 外部网页与内部网页(本地 HTML / localhost)是两套默认,互不影响。
 *
 * html 文件 chip 的右键不走本 hook——它们已有 useFileChipContextMenu
 * (复制 / 路径 / 目录 / 浏览器查看),「侧边栏打开 / 查看源文件」以可选项
 * 合并进那份菜单,避免同一个元素挂两份右键菜单。
 *
 * sessionId 缺失时仍可右键复制和交给系统浏览器，只省略侧边栏项。
 *
 * 视觉与交互复用 useFileChipContextMenu 的模式:Radix DropdownMenu + 光标处
 * 0×0 虚拟 trigger;menu 渲染一次挂在调用组件旁。
 */

import { useRef, useState, type ReactElement, type MouseEvent } from 'react';
import { Globe, Link2, PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { toast } from '@/lib/toast';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  openUrlInSidebarBrowser,
  pathToFileUrl,
} from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { getLinkOpenPreference, getLinkOpenPreferenceForUrl } from '@/hooks/useLinkOpenPreference';
import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import type { SessionFileOrigin } from '@/lib/sessionFileOrigin';
import { isSeparateLinkActivation, linkMenuPosition } from './linkInteraction';
import { readMailPreview, openMailPreview } from '@/features/right-sidebar/lib/mailPreview';

/** 左键"按偏好直开"只对浏览器"作为页面渲染"有意义的 html 家族生效;其余本地
 *  文件保持原有"点击即预览"。右键菜单的 BROWSER_OPENABLE_EXTS 也收敛到
 *  HTML,二者保持同一产品语义。 */
export function isHtmlFilePath(filePath: string): boolean {
  return /\.(html?|xhtml)$/i.test(filePath);
}

/** 在侧边栏浏览器打开 url,失败 toast(addTab 上限 / IPC 异常等)。 */
async function openInSidebar(sessionId: string, url: string, t: TFunction): Promise<void> {
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
    try { supported = (await readMailPreview(sessionId, url, false)).supported; } catch { /* Older hosts retain normal link opening. */ }
    if (supported) { await openMailPreview(sessionId, url); return; }
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
  event: Pick<MouseEvent<HTMLElement>, 'preventDefault' | 'stopPropagation' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'button'>,
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
  const key = JSON.stringify([sessionId, context.origin, context.workingDir, absPath, resolvedTarget]);
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

export interface UseOpenWithMenu {
  openAt: (x: number, y: number, url: string) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, url: string) => void;
  menu: ReactElement | null;
}

export function useOpenWithMenu({ sessionId }: { sessionId?: string }): UseOpenWithMenu {
  const { t } = useTranslation();
  const [state, setState] = useState<{ x: number; y: number; url: string } | null>(null);
  const sidebarTargetSessionId = useSidebarTargetSessionId(sessionId);
  const triggerRef = useRef<HTMLElement | null>(null);

  const openAt = (x: number, y: number, url: string): void => {
    setState({ x, y, url });
  };
  const onContextMenu = (event: MouseEvent<HTMLElement>, url: string) => {
    event.preventDefault();
    event.stopPropagation();
    triggerRef.current = event.currentTarget;
    const { x, y } = linkMenuPosition(event);
    openAt(x, y, url);
  };

  async function handleOpenInSidebar(): Promise<void> {
    const target = state;
    setState(null);
    if (!target || !sidebarTargetSessionId) return;
    await openInSidebar(sidebarTargetSessionId, target.url, t);
  }

  async function handleOpenInDefaultBrowser(): Promise<void> {
    const target = state;
    setState(null);
    if (!target) return;
    try {
      const res = await window.electronAPI.openExternal(target.url);
      if (!res.success) toast.error(t('chat.markdownRenderer.openLinkFailed'));
    } catch {
      toast.error(t('chat.markdownRenderer.openLinkFailed'));
    }
  }

  async function handleCopyLink(): Promise<void> {
    const target = state;
    setState(null);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.url);
      toast.success(t('chat.markdownRenderer.linkCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  const menu = (
    <DropdownMenu
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) setState(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          data-fixed-menu-anchor
          style={{
            position: 'fixed',
            left: state?.x ?? 0,
            top: state?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        // 同 useFileChipContextMenu:menu portal 到 body 但 React 合成事件仍沿
        // React 树冒泡,不拦会触发外层元素的 onClick。
        onClick={(e) => e.stopPropagation()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
        }}
      >
        {sidebarTargetSessionId ? (
          <DropdownMenuItem onClick={handleOpenInSidebar}>
            <PanelRight className="mr-2 h-4 w-4" />
            {t('chat.markdownRenderer.openInSidebarBrowser')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={handleOpenInDefaultBrowser}>
          <Globe className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.openInDefaultBrowser')}
          <DropdownMenuShortcut aria-hidden>
            {t('chat.markdownRenderer.shiftClick')}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCopyLink}>
          <Link2 className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.copyLink')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return { openAt, onContextMenu, menu };
}
