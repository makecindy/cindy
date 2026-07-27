/**
 * GhostPanelWindowLayout —— 插件停靠面板独立窗口的根组件(路由 `/ghost-panel-window`)。
 *
 * 窗口由 main/ghost-panel-window/window.ts 打开(`?ghostPanelWindow=<id>`),本组件:
 *  - 画 46px 自绘 chrome(蓝本 SidebarWindowLayout):整条 drag region;mac 左端
 *    红绿灯让位、win 右端 WindowControls(close 按 sender 解析 = 只关本窗);
 *    右端「合并回主窗口」按钮 → setDetached(id, false)(main 落盘 + 关本窗,
 *    主窗收广播后面板原位回停靠)。
 *  - 面板体零改动复用 GhostChipPanelBody(webview 供片/主题/崩溃接管全同款;
 *    附加闸只认分区/地址,与宿主窗口无关);崩溃/熔断走 GhostPanelError。
 *  - manifest 经 useInstalledGhosts 自查(ghosts:changed 广播发所有窗口);
 *    插件被卸载/停用时 main 的 reconcile 会直接收窗,这里只需短暂占位。
 *  - 挂 GhostMediaLightboxHost:面板 /preview/ 点图事件推给本窗口(embedder),
 *    不挂的话子窗里"点开看大图"没有承接端。无 sessionId,「发送到对话」隐藏。
 *  - ⌘W / Ctrl+W:本窗口没有 tab 语义,直接关窗(= 合并回主窗的同一条 main 收口)。
 */

import { useTranslation } from 'react-i18next';
import { PictureInPicture2, Puzzle } from 'lucide-react';

import { GhostMediaLightboxHost } from '@/cindy-brain/GhostMediaLightboxHost';
import { GhostChipPanelBody, GhostPanelError } from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useCloseShortcutShellOwner } from '@/hooks/useCloseWindowShortcut';
import { getGhostPanelWindowGhostId } from '@/lib/ghostPanelWindow';
import { createLogger } from '@/lib/logger';
import type { GhostManifest } from '../../../shared/ghost';

const log = createLogger('GhostPanelWindowLayout');

/** 面板体 + 崩溃接管(与停靠形态 GhostPanel 同一分支逻辑,不含标准头)。 */
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
  const isMac = window.electronAPI?.platform === 'darwin';
  const ghostId = getGhostPanelWindowGhostId();
  const ghosts = useInstalledGhosts();
  const ghost = ghostId ? ghosts.find((g) => g.manifest.id === ghostId) : undefined;
  // 停用/卸载的瞬间 main 的 reconcile 会收窗;这里只兜住收窗前的一两帧。
  const manifest = ghost && ghost.enabled !== false ? ghost.manifest : undefined;
  const title = manifest?.panel?.title ?? manifest?.name ?? '';

  // ⌘W / Ctrl+W:直接关本窗(main 端按 sender win.close(),controller 走
  // onClosed = 回停靠)。声明壳层所有权,App 根的 fallback 让路。
  useCloseShortcutShellOwner();
  useAppShortcut('close-tab-or-window', () => {
    window.electronAPI.windowClose();
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
      {/* 46px 自绘 chrome:整条 drag region;布局对齐 SidebarWindowLayout。 */}
      <div
        className="relative flex h-[46px] shrink-0 items-center border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className={isMac ? 'w-20 shrink-0' : 'w-3 shrink-0'} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Puzzle size={14} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="truncate text-[13px] text-[var(--text-secondary)]">{title}</span>
        </div>
        <div
          className="flex shrink-0 items-center gap-1 pr-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 合并回主窗口:关偏好 + 关本窗,面板原位回停靠 */}
          <button
            type="button"
            onClick={mergeBack}
            title={t('ghostPanelWindow.mergeBack')}
            aria-label={t('ghostPanelWindow.mergeBack')}
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-[var(--titlebar-icon)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <PictureInPicture2 size={14} />
            <span>{t('ghostPanelWindow.mergeBack')}</span>
          </button>
        </div>
        {!isMac && (
          <div
            className="flex h-full shrink-0 items-center"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <WindowControls />
          </div>
        )}
      </div>

      {/* 面板体:manifest 在场即挂 webview;不在场(收窗前瞬态/野 URL)给占位。 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel-bg)]">
        {manifest ? (
          <PanelBody manifest={manifest} />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <span className="text-[13px] text-[var(--text-tertiary)]">
              {t('ghostPanelWindow.unavailable')}
            </span>
          </div>
        )}
      </div>

      {/* 面板 /preview/ 点图的承接端(无 sessionId:「发送到对话」隐藏)。 */}
      <GhostMediaLightboxHost />
    </div>
  );
}
