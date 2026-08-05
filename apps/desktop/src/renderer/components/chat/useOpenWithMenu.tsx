/**
 * useOpenWithMenu
 * ---------------------------------------------------------------------------
 * 消息流里 http(s) 链接的**右键**「打开方式」菜单:在侧边栏浏览器中打开 /
 * 在默认浏览器中打开。左键不再弹菜单——由 openUrlByPreference /
 * openHtmlFileByPreference 按用户偏好(设置 → 个性化 → 链接打开方式)直开。
 *
 * html 文件 chip 的右键不走本 hook——它们已有 useFileChipContextMenu
 * (复制 / 路径 / 目录 / 浏览器查看),「侧边栏打开 / 查看源文件」以可选项
 * 合并进那份菜单,避免同一个元素挂两份右键菜单。
 *
 * sessionId 缺失(Market 预览等无会话上下文)时 isEnabled=false,调用方保持
 * 原有行为(左键直开系统浏览器、无右键菜单)。
 *
 * 视觉与交互复用 useFileChipContextMenu 的模式:Radix DropdownMenu + 光标处
 * 0×0 虚拟 trigger;menu 渲染一次挂在调用组件旁。
 */

import { useState, type ReactElement } from 'react';
import { Globe, Link2, PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { toast } from '@/lib/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  openUrlInSidebarBrowser,
  pathToFileUrl,
} from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { getLinkOpenPreference } from '@/hooks/useLinkOpenPreference';
import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';

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

/** http(s) 链接左键:按用户偏好直开(sidebar → 内置新页签;external → 系统浏览器)。 */
export async function openUrlByPreference(
  sessionId: string,
  url: string,
  t: TFunction,
): Promise<void> {
  if (getLinkOpenPreference() === 'sidebar') {
    await openInSidebar(sessionId, url, t);
    return;
  }
  const res = await window.electronAPI.openExternal(url);
  if (!res.success) toast.error(t('chat.markdownRenderer.openLinkFailed'));
}

/** 本地 html 文件左键:按用户偏好直开(sidebar → file:// 进内置;external → 系统浏览器)。 */
export async function openHtmlFileByPreference(
  sessionId: string,
  absPath: string,
  t: TFunction,
): Promise<void> {
  if (getLinkOpenPreference() === 'sidebar') {
    await openInSidebar(sessionId, pathToFileUrl(absPath), t);
    return;
  }
  const res = await window.electronAPI.openFileInBrowser(absPath);
  if (!res.success) toast.error(res.error ?? t('chat.markdownRenderer.openInBrowserFailed'));
}

export interface UseOpenWithMenu {
  /** sessionId 就位才启用;false 时调用方保持原直开行为,不要 openAt。 */
  isEnabled: boolean;
  openAt: (x: number, y: number, url: string) => void;
  menu: ReactElement | null;
}

export function useOpenWithMenu({ sessionId }: { sessionId?: string }): UseOpenWithMenu {
  const { t } = useTranslation();
  const [state, setState] = useState<{ x: number; y: number; url: string } | null>(null);
  const sidebarTargetSessionId = useSidebarTargetSessionId(sessionId);

  const isEnabled = Boolean(sidebarTargetSessionId);

  const openAt = (x: number, y: number, url: string): void => {
    setState({ x, y, url });
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
    const res = await window.electronAPI.openExternal(target.url);
    if (!res.success) toast.error(t('chat.markdownRenderer.openLinkFailed'));
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
      >
        <DropdownMenuItem onClick={handleOpenInSidebar}>
          <PanelRight className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.openInSidebarBrowser')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleOpenInDefaultBrowser}>
          <Globe className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.openInDefaultBrowser')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCopyLink}>
          <Link2 className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.copyLink')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return { isEnabled, openAt, menu };
}
