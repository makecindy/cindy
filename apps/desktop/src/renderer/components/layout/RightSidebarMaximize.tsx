/**
 * RightSidebarMaximize —— Mac 端 MainLayout 浮层里的"最大化 RightSidebar"按钮。
 *
 * 与 RightSidebarToggle 配对:toggle 负责"折叠/展开",maximize 负责"接管整个内容区"
 * (Phase 6 真实现 — RSB 撑满 availableWidth,主聊天区隐藏;再次点击恢复)。
 * Phase 1 仅渲染,onMaximize 占位 no-op,Phase 6 接真行为。
 *
 * 视觉与 RightSidebarToggle 一致:无底无边、hover 才出底色;`size='toolbar'` 用于
 * Mac 浮层(h-7 / 图标 14 / rounded-md),与 ChromeActions 左簇的 28px 规格族对齐
 * (2026-07 随左簇一起从 36px 缩到 28px,左右对称)。
 */

import { Maximize2, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface RightSidebarMaximizeProps {
  onMaximize: () => void;
  /** 与 RightSidebarToggle 对齐的尺寸变体。Mac 浮层用 'toolbar';保留 'chip' 以备未来在 Win 端 chip 栈或 TabBar 内复用。 */
  size?: 'chip' | 'toolbar';
  /** 当前是否处于 maximize 态(Phase 6)。true → 显示 Minimize2 + 切 aria 文案,
   *  让用户知道按一下是"退出最大化"。 */
  isMaximized?: boolean;
}

export function RightSidebarMaximize({
  onMaximize,
  size = 'toolbar',
  isMaximized = false,
}: RightSidebarMaximizeProps) {
  const { t } = useTranslation();
  const isToolbar = size === 'toolbar';
  const Icon = isMaximized ? Minimize2 : Maximize2;
  const label = t(
    isMaximized
      ? 'rightSidebar.tabs.controls.restoreAria'
      : 'rightSidebar.tabs.controls.maximizeAria',
  );

  return (
    <Tip text={label} side="bottom">
      <button
        type="button"
        className={cn(
          'pointer-events-auto flex h-7 w-7 items-center justify-center',
          isToolbar ? 'rounded-md' : 'rounded-full',
          'text-titlebar-icon',
          'transition-colors',
          'hover:bg-titlebar-button-hover',
        )}
        onClick={onMaximize}
        aria-label={label}
      >
        <Icon size={14} />
      </button>
    </Tip>
  );
}
