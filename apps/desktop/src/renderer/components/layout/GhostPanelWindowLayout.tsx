/**
 * GhostPanelWindowLayout —�?插件停靠面板独立窗口的根组件(路由 `/ghost-panel-window`)�?
 *
 * 窗口�?main/ghost-panel-window/window.ts 打开(`?ghostPanelWindow=<id>`),本组�?
 *  - �?46px 自绘 chrome(蓝本 SidebarWindowLayout):整条 drag region;mac 左端
 *    红绿灯让位、win 右端 WindowControls(close �?sender 解析 = 只关本窗);
 *    右端「合并回主窗口」按�?�?setDetached(id, false)(main 落盘 + 关本�?
 *    主窗收广播后面板原位回停�?�?
 *  - 面板体零改动复用 GhostChipPanelBody(webview 供片/主题/崩溃接管全同�?
 *    附加闸只认分�?地址,与宿主窗口无�?;崩溃/熔断�?GhostPanelError�?
 *  - manifest �?useInstalledGhosts 自查(ghosts:changed 广播发所有窗�?;
 *    插件被卸�?停用�?main �?reconcile 会直接收�?这里只需短暂占位�?
 *  - �?GhostMediaLightboxHost:面板 /preview/ 点图事件推给本窗�?embedder),
 *    不挂的话子窗�?点开看大�?没有承接端。无 sessionId,「发送到对话」隐藏�?
 *  - ⌘W / Ctrl+W:本窗口没�?tab 语义,直接关窗(= 合并回主窗的同一�?main 收口)�?
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PictureInPicture2, Puzzle } from 'lucide-react';

import { GhostMediaLightboxHost } from '@/cindy-brain/GhostMediaLightboxHost';
import { GhostChipPanelBody, GhostPanelError } from '@/cindy-brain/ghostPanelBody';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useCloseShortcutShellOwner } from '@/hooks/useCloseWindowShortcut';
import { useLocale } from '@/hooks/useLocale';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { minimizeGhostPanel, restoreGhostPanel } from '@/lib/ghostPanelBubbleState';
import { getGhostPanelWindowGhostId } from '@/lib/ghostPanelWindow';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type { GhostManifest } from '../../../shared/ghost';

const log = createLogger('GhostPanelWindowLayout');

/** 面板�?+ 崩溃接管(与停靠形�?GhostPanel 同一分支逻辑,不含标准�?�?*/
function PanelBody({ manifest }: { manifest: GhostManifest }) {
  const runtimeState = useGhostRuntimeState(manifest.id);
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  return broken ? (
    <GhostPanelError manifest={manifest} state={runtimeState} />
  ) : (
    <GhostChipPanelBody manifest={manifest} />
  );
}

export function GhostPanelWindowLayout() {
  const { t } = useTranslation();
  const { effectiveLocale, setLocale } = useLocale();
  const { confirm } = useConfirmDialog();
  const isMac = window.electronAPI?.platform === 'darwin';
  const ghostId = getGhostPanelWindowGhostId();
  const ghosts = useInstalledGhosts();
  const ghost = ghostId ? ghosts.find((g) => g.manifest.id === ghostId) : undefined;
  // 停用/卸载的瞬�?main �?reconcile 会收�?这里只兜住收窗前的一两帧�?
  const manifest = ghost && ghost.enabled !== false ? ghost.manifest : undefined;
  const title = manifest?.panel?.title ?? manifest?.name ?? '';
  const minimizeEnabled =
    manifest !== undefined && manifest.panel?.systemButtons?.minimize !== false;
  const presentationReadySentRef = useRef(false);
  // 复用隐藏窗口时，Chromium 可能保留上一次关闭按钮的 focus / :hover 状态�?
  // 与资源用量窗口一致，隐藏时重挂载 chrome，确保再次显示从干净状态开始�?
  const [windowChromeRevision, setWindowChromeRevision] = useState(0);

  const minimizeToBubble = async (): Promise<void> => {
    if (!ghostId || !minimizeEnabled) return;
    minimizeGhostPanel(ghostId);
    try {
      await window.electronAPI.ghostPanelWindow.setDetached(ghostId, false);
    } catch (err) {
      restoreGhostPanel(ghostId);
      log.warn('minimize ghost panel to bubble failed', err);
    }
  };

  const disableAndClose = async (): Promise<void> => {
    if (!ghostId || !manifest) return;
    const approved = await confirm({
      title: t('ghostPanel.disableConfirm.title', { name: manifest.name }),
      description: t('ghostPanel.disableConfirm.body'),
      confirmText: t('ghostPanel.disableConfirm.confirm'),
    });
    await window.electronAPI.ghostPanelWindow.resolveCloseRequest(approved);
    if (!approved) return;
    try {
      await window.electronAPI.ghosts.setEnabled(ghostId, false);
    } catch (error) {
      toast.error(t(ghostInstallErrorKey(extractIpcError(error)?.code)));
    }
  };

  // mount:renderer-ready 握手 + presentation-ready(manifest 就绪�?�?
  useEffect(() => {
    void window.electronAPI.ghostPanelWindow.rendererReady().catch((err) => {
      log.warn('renderer-ready handshake failed', err);
    });
  }, []);

  useEffect(() => {
    if (presentationReadySentRef.current || !manifest) return;
    presentationReadySentRef.current = true;
    void window.electronAPI.ghostPanelWindow.presentationReady().catch((err) => {
      log.warn('presentation-ready handshake failed', err);
    });
  }, [manifest]);

  // 隐藏/显示时重置瞬时交互态�?
  useEffect(() => {
    return window.electronAPI.ghostPanelWindow.onVisibilityChanged((payload) => {
      if (!payload.visible) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setWindowChromeRevision((revision) => revision + 1);
      } else {
        // 重新显示时模糊焦�?+ �?webview 重获焦点(面板内容持续运行)
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
    });
  }, []);

  useEffect(() => {
    return window.electronAPI.ghostPanelWindow.onCloseRequested(() => {
      void disableAndClose();
    });
  }, [ghostId, manifest, confirm, t, window.electronAPI.ghostPanelWindow]);

  useEffect(() => {
    if (!minimizeEnabled) return;
    return window.electronAPI.ghostPanelWindow.onMinimizeRequested(() => {
      void minimizeToBubble();
    });
  }, [ghostId, minimizeEnabled, window.electronAPI.ghostPanelWindow]);

  useEffect(() => {
    return window.electronAPI.onLocaleChanged?.((locale) => {
      if (locale !== effectiveLocale) setLocale(locale);
    }) ?? undefined;
  }, [effectiveLocale, setLocale]);

  // ⌘W / Ctrl+W:直接关本�?main 端按 sender win.close(),controller �?
  // onClosed = 回停�?。声明壳层所有权,App 根的 fallback 让路�?
  useCloseShortcutShellOwner();
  useAppShortcut('close-tab-or-window', () => {
    void disableAndClose();
    return true;
  });

  const mergeBack = () => {
    if (!ghostId) return;
    void window.electronAPI.ghostPanelWindow.setDetached(ghostId, false).catch((err) => {
      log.warn('merge back failed', err);
    });
  };

  return (
    <div className="flex h-screen flex-col bg-content-area text-foreground">
      {/* 46px 自绘 chrome:整条 drag region;布局对齐 SidebarWindowLayout�?*/}
      <div
        className="relative flex h-[46px] shrink-0 items-center border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className={isMac ? 'w-20 shrink-0' : 'w-3 shrink-0'} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Puzzle size={14} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="truncate text-13 text-[var(--text-secondary)]">{title}</span>
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5 pr-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 合并回主窗口:关偏�?+ 关本�?面板原位回停�?*/}
          <ChromeIconButton
            onClick={mergeBack}
            title={t('rightSidebar.window.mergeBack')}
            aria-label={t('rightSidebar.window.mergeBack')}
          >
            <PictureInPicture2 size={14} />
          </ChromeIconButton>
        </div>
        {!isMac && (
          <div
            className="flex h-full shrink-0 items-center"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <WindowControls
              key={windowChromeRevision}
              onMinimize={minimizeToBubble}
              showMinimize={minimizeEnabled}
              onClose={disableAndClose}
            />
          </div>
        )}
      </div>

      {/* 面板�?manifest 在场即挂 webview;不在�?收窗前瞬�?�?URL)给占位�?*/}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel-bg)]">
        {manifest ? (
          <PanelBody manifest={manifest} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <span className="text-13 text-[var(--text-tertiary)]">
              {t('ghostPanelWindow.unavailable')}
            </span>
          </div>
        )}
      </div>

      {/* 面板 /preview/ 点图的承接端(�?sessionId:「发送到对话」隐�?�?*/}
      <GhostMediaLightboxHost />
    </div>
  );
}
