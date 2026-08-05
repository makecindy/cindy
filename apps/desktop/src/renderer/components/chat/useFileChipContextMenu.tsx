/**
 * useFileChipContextMenu
 * ---------------------------------------------------------------------------
 * Shared right-click menu for the three kinds of "file chip" rendered in the
 * chat message flow:
 *   - MarkdownRenderer inline-code path chip (assistant output)
 *   - UserMessage @file chip (user-typed attachments)
 *   - AgentActionRow tool-call file chip (Edit / Write / Read inputs)
 *
 * Menu items:
 *   0. 在侧边栏文件浏览器中打开 → select/reveal the file in the RSB file browser
 *   1. 在侧边栏浏览器中打开(可选,sidebarOpenSessionId 提供时;html chip 用)
 *   2. 打开方式 ▸        →(文件 + 本地会话)默认应用 + 枚举出的可用应用
 *                          (Windows 注册表,见 main/openWithApps.ts)。应用
 *                          列表在子菜单展开时懒加载。不提供「选择其他应用…」
 *                          (系统 OpenAs 对话框实测起不来,且与 Codex 形态不符)。
 *   3. 复制              → copy the file itself as a clipboard file reference
 *                          (pasteable into Explorer / Finder / chat apps)
 *   4. 复制文件路径      → copy the absolute path string
 *   5. 打开文件所在目录  → reveal in the OS file manager
 *   6. 在浏览器中查看    →(可选,canOpenInBrowser)file:// 交给系统浏览器
 *   7. 查看源文件        →(可选,onViewSource 提供时;html chip 左键改为按
 *                          偏好直开后,TextLightbox 从这里进)
 *
 * Returns `onContextMenu` (attach to the chip button) and `menu` (render once
 * next to the button). Uses Radix DropdownMenu with a 0×0 virtual trigger
 * positioned at the cursor, same pattern as LightboxImage in MarkdownRenderer.
 *
 * `getAbsPath` is async so callers can do path resolution (e.g.
 * resolveLocalPathSmart for monorepo relative refs) only when the user
 * actually opens the menu — chips that are never right-clicked pay nothing.
 */

import { useRef, useState, type ReactElement } from 'react';
import {
  AppWindow,
  ClipboardCopy,
  Copy,
  FileCode,
  FolderOpen,
  FolderTree,
  Globe,
  PanelRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  openUrlInSidebarBrowser,
  pathToFileUrl,
} from '@/features/right-sidebar/lib/openInSidebarBrowser';
import {
  openDirInSidebarFileBrowser,
  openExternalFileInSidebarFileBrowser,
  openFileInSidebarFileBrowser,
} from '@/features/right-sidebar/lib/openInSidebarFileBrowser';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
import { copyRemoteChatFile, revealRemoteChatFile } from '@/lib/remoteFileOpen';
import { toWorkdirRel } from '../../../shared/workdirPath';
import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import { useChatSessionFile } from './ChatSessionFileContext';

export interface UseFileChipContextMenu {
  onContextMenu: (e: React.MouseEvent) => void;
  openAt: (x: number, y: number) => void;
  menu: ReactElement;
}

/**
 * @param getAbsPath        resolver invoked lazily on each menu-item click; must
 *                          return an absolute filesystem path.
 * @param canOpenInBrowser  when true, adds a 4th "在浏览器中查看" menu item.
 *                          Callers compute this from the chip text's extension
 *                          via `isBrowserOpenablePath` (shared). Product policy
 *                          currently limits this to HTML files.
 * @param sidebarFileBrowserKind  target kind for "在侧边栏文件浏览器中打开".
 *                          File chips select/reveal the file; directory chips
 *                          use directory reveal so the folder expands instead
 *                          of being read as a file.
 * @param sidebarOpenSessionId  provided → prepend "在侧边栏浏览器中打开" item。
 *                          默认写该 session；sidebar-embedded Provider 注入了
 *                          可见 Lead bucket 时只替换 RSB 目标，不改变文件来源。
 * @param onViewSource      provided → append "查看源文件" item. Used by html
 *                          chips whose LEFT click now opens the browser by
 *                          preference — TextLightbox stays reachable here.
 */
export function useFileChipContextMenu({
  getAbsPath,
  canOpenInBrowser = false,
  sidebarFileBrowserKind = 'file',
  sidebarOpenSessionId,
  onViewSource,
}: {
  getAbsPath: () => Promise<string> | string;
  canOpenInBrowser?: boolean;
  sidebarFileBrowserKind?: 'file' | 'directory';
  sidebarOpenSessionId?: string;
  onViewSource?: () => void | Promise<void>;
}): UseFileChipContextMenu {
  const { t } = useTranslation();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 打开方式子菜单的应用列表:null = 未加载;子菜单展开时懒加载(枚举 + 图标
  // 提取都在 main,未展开不付成本)。root 菜单关闭即重置,注册表变化能被下次
  // 展开看到。
  const [openWithApps, setOpenWithApps] = useState<
    Array<{ id: string; label: string; iconDataUrl?: string }> | null
  >(null);
  // 远程会话(device-link / SSH):文件字节在远端机器,「复制文件 / 定位」改走
  // 取回缓存副本;「复制路径」保留远端原始路径;浏览器 / 侧边栏项(读本机
  // file://)隐藏。聊天流外 context 是 local 默认值 → 行为与引入前逐字节一致。
  const sessionFileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(sessionFileCtx.origin) ? sessionFileCtx.origin : null;
  const sidebarFileTargetSessionId = useSidebarTargetSessionId(sessionFileCtx.sessionId);
  const sidebarBrowserTargetSessionId = useSidebarTargetSessionId(sidebarOpenSessionId);

  async function handleCopyFile(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    if (remoteOrigin) {
      await copyRemoteChatFile(remoteOrigin, sessionFileCtx.workingDir, abs);
      return;
    }
    const res = await window.electronAPI.copyMediaToClipboard({ filePath: abs });
    if (res.success) toast.success(t('chat.markdownRenderer.fileCopied'));
    else toast.error(res.error ?? t('chat.media.copyFailed'));
  }

  async function handleCopyPath(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    try {
      await navigator.clipboard.writeText(abs);
      toast.success(t('chat.markdownRenderer.pathCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  async function handleReveal(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    if (remoteOrigin) {
      // 远端路径本机不存在:下载缓存副本后在文件管理器中定位副本。
      await revealRemoteChatFile(remoteOrigin, sessionFileCtx.workingDir, abs);
      return;
    }
    const res = await window.electronAPI.showItemInFolder({ filePath: abs });
    if (!res.success) toast.error(res.error ?? t('chat.media.openFolderFailed'));
  }

  async function handleOpenInBrowser(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    try {
      await window.electronAPI.openFileInBrowser(abs);
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

  async function handleOpenInSidebar(): Promise<void> {
    setMenuPos(null);
    if (!sidebarBrowserTargetSessionId) return;
    const abs = await getAbsPath();
    try {
      await openUrlInSidebarBrowser(sidebarBrowserTargetSessionId, pathToFileUrl(abs));
    } catch {
      // store 层已 log(addTab 上限 / IPC 异常),这里只给用户反馈。
      toast.error(t('chat.markdownRenderer.openInSidebarFailed'));
    }
  }

  async function handleOpenInSidebarFileBrowser(): Promise<void> {
    setMenuPos(null);
    const sessionId = sidebarFileTargetSessionId;
    if (!sessionId) return;
    const abs = await getAbsPath();
    const rel = toWorkdirRel(sessionFileCtx.workingDir, abs);
    try {
      if (sidebarFileBrowserKind === 'directory') {
        if (!rel) {
          toast.error(t('chat.markdownRenderer.openInSidebarFileBrowserOutsideWorkdir'));
          return;
        }
        await openDirInSidebarFileBrowser(sessionId, rel);
        return;
      }
      if (rel) {
        await openFileInSidebarFileBrowser(sessionId, rel);
        return;
      }
      // 远程来源的绝对路径位于远端机器，不能按“本机外部拖入”读取；本地来源则
      // 复用文件浏览器的外部文件拖入语义，以只读方式预览 workdir 外文件。
      if (remoteOrigin) {
        toast.error(t('chat.markdownRenderer.openInSidebarFileBrowserOutsideWorkdir'));
        return;
      }
      await openExternalFileInSidebarFileBrowser(sessionId, abs);
    } catch {
      toast.error(t('chat.markdownRenderer.openInSidebarFileBrowserFailed'));
    }
  }

  async function handleViewSource(): Promise<void> {
    setMenuPos(null);
    await onViewSource?.();
  }

  // 懒加载代际:root 菜单每次关闭 +1。在途枚举返回时代际不符 = 菜单已关过,
  // 丢弃写回——否则过期列表把 state 从 null 顶回非 null,下次展开会跳过重载,
  // 破坏「关闭即重置,注册表变化下次展开可见」的不变量(PR #1835 review)。
  const openWithEpochRef = useRef(0);

  async function loadOpenWithApps(): Promise<void> {
    if (openWithApps !== null) return;
    const epoch = openWithEpochRef.current;
    const abs = await getAbsPath();
    const res = await window.electronAPI.listOpenWithApps({ filePath: abs });
    if (openWithEpochRef.current !== epoch) return;
    // 枚举失败不挡菜单:空列表 = 只显示「用默认应用打开」。
    setOpenWithApps(res.success ? res.apps : []);
  }

  async function handleOpenWithDefault(): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    const res = await window.electronAPI.openPath(abs);
    if (!res.success) toast.error(res.error ?? t('chat.markdownRenderer.openWithAppFailed'));
  }

  async function handleOpenWithApp(appId: string): Promise<void> {
    setMenuPos(null);
    const abs = await getAbsPath();
    try {
      await window.electronAPI.openFileWithApp({ filePath: abs, appId });
    } catch (error) {
      toast.error(
        t(
          mapIpcErrorToI18nKey(error, {
            namespace: 'chat.markdownRenderer',
            fallback: 'chat.markdownRenderer.openWithAppFailed',
          }),
        ),
      );
    }
  }

  const openAt = (x: number, y: number): void => {
    setMenuPos({ x, y });
  };

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    openAt(e.clientX, e.clientY);
  };

  const menu = (
    <DropdownMenu
      open={menuPos !== null}
      onOpenChange={(open) => {
        if (!open) {
          setMenuPos(null);
          setOpenWithApps(null);
          openWithEpochRef.current += 1;
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: menuPos?.x ?? 0,
            top: menuPos?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        // The chip and this menu render as siblings inside a clickable ancestor
        // (e.g. AgentActionRow's row has onClick→open-file). DropdownMenuContent
        // is DOM-portaled to <body>, but React synthetic events still bubble up
        // the React *tree* — so a click on any item would bubble item → content →
        // … → the row and re-trigger its open-file onClick. Stop it here (after
        // the item's own handler has already run at the target).
        onClick={(e) => e.stopPropagation()}
      >
        {sidebarFileTargetSessionId && sessionFileCtx.workingDir ? (
          <DropdownMenuItem onClick={handleOpenInSidebarFileBrowser}>
            <FolderTree className="mr-2 h-4 w-4" />
            {t('chat.markdownRenderer.openInSidebarFileBrowser')}
          </DropdownMenuItem>
        ) : null}
        {sidebarBrowserTargetSessionId && !remoteOrigin ? (
          <DropdownMenuItem onClick={handleOpenInSidebar}>
            <PanelRight className="mr-2 h-4 w-4" />
            {t('chat.markdownRenderer.openInSidebarBrowser')}
          </DropdownMenuItem>
        ) : null}
        {sidebarFileBrowserKind === 'file' && !remoteOrigin ? (
          // 打开方式:仅文件 + 本地会话。远程会话的字节在远端机器,本机应用
          // 枚举与执行都无意义(与「在浏览器中查看」同一门控口径)。
          <DropdownMenuSub
            onOpenChange={(open) => {
              if (open) void loadOpenWithApps();
            }}
          >
            <DropdownMenuSubTrigger>
              <AppWindow className="mr-2 h-4 w-4" />
              {t('chat.markdownRenderer.openWith')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={handleOpenWithDefault}>
                <AppWindow className="mr-2 h-4 w-4" />
                {t('chat.media.openWithApp')}
              </DropdownMenuItem>
              {openWithApps && openWithApps.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  {openWithApps.map((appEntry) => (
                    <DropdownMenuItem
                      key={appEntry.id}
                      onClick={() => void handleOpenWithApp(appEntry.id)}
                    >
                      {appEntry.iconDataUrl ? (
                        <img
                          src={appEntry.iconDataUrl}
                          alt=""
                          aria-hidden
                          className="mr-2 h-4 w-4"
                        />
                      ) : (
                        <AppWindow className="mr-2 h-4 w-4" />
                      )}
                      {appEntry.label}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuItem onClick={handleCopyFile}>
          <Copy className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.copyFile')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyPath}>
          <ClipboardCopy className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.copyFilePath')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleReveal}>
          <FolderOpen className="mr-2 h-4 w-4" />
          {remoteOrigin
            ? t('chat.remoteFile.revealLocalCopy')
            : t('chat.markdownRenderer.revealFile')}
        </DropdownMenuItem>
        {canOpenInBrowser && !remoteOrigin ? (
          <DropdownMenuItem onClick={handleOpenInBrowser}>
            <Globe className="mr-2 h-4 w-4" />
            {t('chat.markdownRenderer.openInBrowser')}
          </DropdownMenuItem>
        ) : null}
        {onViewSource ? (
          <DropdownMenuItem onClick={handleViewSource}>
            <FileCode className="mr-2 h-4 w-4" />
            {t('chat.markdownRenderer.viewSourceFile')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return { onContextMenu, openAt, menu };
}
