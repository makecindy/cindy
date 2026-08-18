/**
 * RightSidebarDetach —— 「在新窗口中打开侧边栏」按钮。
 *
 * 点击 = 开启「侧边栏在新窗口显示」全局偏好并弹出子窗口(main 落盘,重启保留;
 * 子窗口里的"合并回主窗口"是逆操作)。
 *
 * 视觉与 RightSidebarMaximize / RightSidebarToggle 一致:无底无边、hover 出底色。
 * Mac 端渲染在 MainLayout 右上浮层簇;Win 端此按钮走 TabBar 内右端(size='chip')。
 */

import { PictureInPicture2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface RightSidebarDetachProps {
  onDetach: () => void;
  /** 与 RightSidebarToggle 对齐的尺寸变体。Mac 浮层用 'toolbar',Win TabBar 用 'chip'。 */
  size?: 'chip' | 'toolbar';
}

export function RightSidebarDetach({ onDetach, size = 'toolbar' }: RightSidebarDetachProps) {
  const { t } = useTranslation();
  const isToolbar = size === 'toolbar';
  const label = t('rightSidebar.tabs.controls.detachAria');

  return (
    <Tip text={label} side="bottom">
      <button
        type="button"
        // toolbar(mac 浮层)与左簇 28px 规格族对齐(rounded-md);chip(Win TabBar)保持圆形。
        className={cn(
          'pointer-events-auto flex h-7 w-7 items-center justify-center',
          isToolbar ? 'rounded-md' : 'rounded-full',
          'text-titlebar-icon',
          'transition-colors',
          'hover:bg-titlebar-button-hover',
        )}
        onClick={onDetach}
        aria-label={label}
      >
        <PictureInPicture2 size={14} />
      </button>
    </Tip>
  );
}
