/**
 * ChromeActions — 浮动 chrome 按钮簇（折叠/展开 Sidebar + 菜单）
 * ---------------------------------------------------------------------------
 * 为什么是浮层：按钮簇浮在 Sidebar 顶行 / ContentHeader 之上,不随侧栏
 * 折叠/展开/peek 重建或被裁切,是唯一一份常驻实例。
 *
 * 位置（Codex 风格:钉死在窗口左上角,不随侧栏状态移动）：
 *   - mac 非全屏：x = 78 / windowZoom（原生红绿灯不随页面缩放），紧贴红绿灯右侧；
 *   - mac 全屏：x = 8（红绿灯隐藏,回收让位）；
 *   - Windows：恒定 x = 8（左上角无红绿灯）。
 *   侧栏关闭 / 打开 / peek 临时浮出,按钮簇位置一律不变 —— peek 的 hover
 *   触发钮(折叠按钮)因此有稳定的触发区域。唯一的位移是 mac 进出全屏
 *   （78 ↔ 8）,保留 250ms 过渡与红绿灯出现/消失同步。
 *
 * 顺序：折叠按钮在左（紧贴红绿灯,对齐 Codex）,菜单（三横杠）在其右,
 * 再往右是任务浏览历史的「后退 / 前进」（见 SessionHistoryButtons）。
 *
 * 尺寸：按钮 h-7 w-7(28px)+ 图标 15 + rounded-full —— 与折叠态标题行的
 * 「…」按钮(SessionContentHeader,h-7 w-7 / Ellipsis 15)尺寸一致,
 * 收起侧栏后整行 chrome(红绿灯 → 本簇 → 标题 → 标题后图标)
 * 视觉重量一致(对齐 Codex 的小图标密度)。
 *
 * 垂直对齐：容器 h-[46px]，中心在 23 CSS px。主进程应用界面缩放时，
 * 按 23 × windowZoom - 7 更新原生按钮的 y 坐标（100% 时为 16）。
 * 改行高必须同步 ContentHeader / Sidebar 顶行 / MainLayout 右上浮层 /
 * RightSidebar 顶条 / SidebarWindowLayout，以及 appearance-settings-ipc 的
 * 原生按钮中心换算。原生按钮的直径与横向间距仍由 macOS 管理。
 *
 * ⚠️ 必须用 `left` 而不是 `transform` 做定位：Electron/Chromium 的
 * `-webkit-app-region` 命中区域按布局矩形计算，**不跟随 CSS transform**——
 * 用 transform 平移后按钮视觉位置和 no-drag 挖洞错位，点击会变成拖拽窗口。
 */

import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MenuButton } from '@/components/title-bar/MenuButton';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { Tip } from '@/components/ui/tooltip';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { useAppShortcutDisplay } from '@/hooks/useAppShortcut';
import type { SessionBrowseNavigation } from '@/features/cc-agent/useSessionBrowseHistory';
import { cn } from '@/lib/utils';

import type { SidebarPeekTriggerProps } from '@/hooks/useSidebarPeek';
import { CHROME_ACTIONS_GEOMETRY } from './chromeActionsGeometry';

interface ChromeActionsProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /**
   * 任务浏览栈。由常驻壳层 MainLayout 持有：设置页会整个卸载本按钮簇，
   * 快捷键监听不能跟着按钮一起消失。
   */
  browseHistory: SessionBrowseNavigation;
  /**
   * 完全隐藏态 hover peek 的触发钮 props(useSidebarPeek)——只挂在折叠按钮上,
   * MenuButton 的 hover 有自己的语义(打开菜单),不参与 peek。
   */
  peekTriggerProps?: SidebarPeekTriggerProps;
}

export function ChromeActions({
  isSidebarCollapsed,
  onToggleSidebar,
  browseHistory,
  peekTriggerProps,
}: ChromeActionsProps) {
  const { t } = useTranslation();
  const {
    isMac,
    isFullscreen,
    trafficLightInset = CHROME_ACTIONS_GEOMETRY.macTrafficLightLeft,
  } = useMacFullscreen();

  // mac 非全屏保留 78pt 原生安全区；其余 8 CSS px。不随侧栏状态变化。
  const x = isMac && !isFullscreen ? trafficLightInset : CHROME_ACTIONS_GEOMETRY.defaultLeft;
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
            'h-7 w-7 rounded-full',
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
      <MenuButton
        onExitFullscreen={
          isMac && isFullscreen ? () => window.electronAPI?.windowExitFullscreen() : undefined
        }
      />
      {/* 任务浏览历史：与浏览器同惯例，左键后退、右键前进；到边界置灰并把
          tooltip 换成「为什么不可用」。尺寸与相邻的菜单/折叠按钮同为 28px，
          圆角走 ChromeIconButton 默认的控件 pill（DESIGN §5）。 */}
      <SessionHistoryButtons {...browseHistory} />
    </div>
  );
}

/**
 * 任务浏览历史的两个导航钮。拆成单独导出仅为测试可直接渲染真实按钮,生产
 * 只由 ChromeActions 挂一次。
 */
export function SessionHistoryButtons({
  canBack,
  canForward,
  goBack,
  goForward,
}: SessionBrowseNavigation): React.ReactElement {
  const { t } = useTranslation();
  const backShortcut = useAppShortcutDisplay('session-history-back');
  const forwardShortcut = useAppShortcutDisplay('session-history-forward');
  // 与其它快捷键提示同形:动作 + 生效组合(跟随用户改绑)。
  const withShortcut = (label: string, shortcut: string) =>
    shortcut ? `${label} (${shortcut})` : label;

  return (
    <>
      <ChromeIconButton
        className="disabled:opacity-40"
        disabled={!canBack}
        onClick={goBack}
        tooltip={withShortcut(t('titleBar.historyBack'), backShortcut)}
        disabledTooltip={t('titleBar.historyBackUnavailable')}
        tooltipSide="bottom"
        aria-label={t('titleBar.historyBack')}
      >
        <ArrowLeft size={15} />
      </ChromeIconButton>
      <ChromeIconButton
        className="disabled:opacity-40"
        disabled={!canForward}
        onClick={goForward}
        tooltip={withShortcut(t('titleBar.historyForward'), forwardShortcut)}
        disabledTooltip={t('titleBar.historyForwardUnavailable')}
        tooltipSide="bottom"
        aria-label={t('titleBar.historyForward')}
      >
        <ArrowRight size={15} />
      </ChromeIconButton>
    </>
  );
}
