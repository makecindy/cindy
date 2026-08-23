/**
 * ChromeActions — 浮动 chrome 按钮簇（折叠/展开 Sidebar + 菜单）
 * ---------------------------------------------------------------------------
 * 为什么是浮层：按钮簇浮在 Sidebar 顶行 / ContentHeader 之上,不随侧栏
 * 折叠/展开/peek 重建或被裁切,是唯一一份常驻实例。
 *
 * 位置（Codex 风格:钉死在窗口左上角,不随侧栏状态移动）：
 *   - mac 非全屏：x = 78（红绿灯 70 + 呼吸 8），紧贴红绿灯右侧；
 *   - mac 全屏：x = 8（红绿灯隐藏,回收让位）；
 *   - Windows：恒定 x = 8（左上角无红绿灯）。
 *   侧栏关闭 / 打开 / peek 临时浮出,按钮簇位置一律不变 —— peek 的 hover
 *   触发钮(折叠按钮)因此有稳定的触发区域。唯一的位移是 mac 进出全屏
 *   （78 ↔ 8）,保留 250ms 过渡与红绿灯出现/消失同步。
 *
 * 顺序：折叠按钮在左（紧贴红绿灯,对齐 Codex）,菜单（三横杠）在其右。
 *
 * 尺寸：按钮 h-7 w-7(28px)+ 图标 15 + rounded-md —— 与折叠态标题行的
 * 「…」按钮(SessionContentHeader,h-7 w-7 / Ellipsis 15 / rounded-md)同一
 * 规格族,收起侧栏后整行 chrome(红绿灯 → 本簇 → 标题 → 标题后图标)
 * 视觉重量一致(对齐 Codex 的小图标密度)。
 *
 * 垂直对齐：容器 h-[46px] —— 红绿灯由主进程钉在 trafficLightPosition
 * {x:12, y:16}(bootstrap-electron / secondary-windows / right-sidebar-window
 * 三处同值),灯径 12,灯心实测 23(y=16 + macOS 渲染偏移;理论 y+6=22,实测灯心比理论低约 1pt),本簇图标与红绿灯严格同轴。
 * 改行高必须同步:renderer 侧 ContentHeader / Sidebar 顶行 / MainLayout
 * 右上浮层 / RightSidebar 顶条 / SidebarWindowLayout,以及 main 侧的
 * trafficLightPosition y ≈ (行高-12)/2 - 1(经验公式:macOS 实际渲染
 * 比理论低约 1pt,2026-07 与 Codex 截图逐像素比对标定)。
 *
 * ⚠️ 必须用 `left` 而不是 `transform` 做定位：Electron/Chromium 的
 * `-webkit-app-region` 命中区域按布局矩形计算，**不跟随 CSS transform**——
 * 用 transform 平移后按钮视觉位置和 no-drag 挖洞错位，点击会变成拖拽窗口。
 */

import { PanelLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MenuButton } from '@/components/title-bar/MenuButton';
import { Tip } from '@/components/ui/tooltip';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { cn } from '@/lib/utils';

import type { SidebarPeekTriggerProps } from '@/hooks/useSidebarPeek';
import { CHROME_ACTIONS_GEOMETRY } from './chromeActionsGeometry';

interface ChromeActionsProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /**
   * 完全隐藏态 hover peek 的触发钮 props(useSidebarPeek)——只挂在折叠按钮上,
   * MenuButton 的 hover 有自己的语义(打开菜单),不参与 peek。
   */
  peekTriggerProps?: SidebarPeekTriggerProps;
}

export function ChromeActions({
  isSidebarCollapsed,
  onToggleSidebar,
  peekTriggerProps,
}: ChromeActionsProps) {
  const { t } = useTranslation();
  const { isMac, isFullscreen } = useMacFullscreen();

  // 钉死左上角:mac 非全屏让位红绿灯(78),其余 8。不随侧栏状态变化。
  const x =
    isMac && !isFullscreen
      ? CHROME_ACTIONS_GEOMETRY.macTrafficLightLeft
      : CHROME_ACTIONS_GEOMETRY.defaultLeft;
  const sidebarToggleLabel = t(
    isSidebarCollapsed ? 'contentHeader.expandSidebar' : 'contentHeader.collapseSidebar',
  );

  return (
    <div
      className="absolute top-0 z-20 flex h-[46px] items-center gap-1"
      style={
        {
          left: x,
          // 仅 mac 进出全屏时产生位移(78↔8),与红绿灯让位过渡同步。
          transition: 'left 250ms cubic-bezier(0.4, 0, 0.2, 1)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties
      }
    >
      <Tip text={sidebarToggleLabel} side="bottom">
        <button
          {...peekTriggerProps}
          className={cn(
            'flex items-center justify-center',
            'h-7 w-7 rounded-md',
            'text-titlebar-icon',
            'transition-colors',
            'hover:bg-titlebar-button-hover',
          )}
          onClick={onToggleSidebar}
          aria-label={sidebarToggleLabel}
          aria-expanded={!isSidebarCollapsed}
        >
          <PanelLeft size={15} />
        </button>
      </Tip>
      <MenuButton />
    </div>
  );
}
