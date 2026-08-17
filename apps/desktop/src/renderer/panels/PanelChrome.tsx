import type { CSSProperties, ReactNode } from 'react';
import { Maximize2, Minimize2, Minus, PictureInPicture2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CHROME_ACTIONS_GEOMETRY } from '@/components/layout/chromeActionsGeometry';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';

import { usePanelMaximize } from '../layout/panelMaximize';

/**
 * PanelChrome —— 面板标准头。
 *
 * 任何顶级面板(尤其未来意识面板)都应以本组件作为顶带,拿到三件事:
 *   1. 统一视觉:36px 行高、下边框、panel-bg —— 与工具面板 TabBar 同规格族,
 *      多面板并排时顶带连成一条水平线;
 *   2. 拖拽手柄:整条即"拖面板换位"手势面(data-panel-drag-handle,
 *      PanelDragController 识别;窗口拖动走 46px 顶带,见 B3 口径);
 *   3. 左标题 / 右 actions 槽:标题给面板身份,actions 给面板自定义控件。
 *
 * 右端系统按钮(一批,由引擎统一长出,面板作者无感;身份卡
 * panel.systemButtons 可逐个关闭):
 *  - 「最小化为浮动气泡」(minimize):传 onMinimize 即得,点击把面板收成
 *    可拖动的圆形气泡(状态在 renderer/lib/ghostPanelBubbleState.ts);
 *  - 「独立窗口」(detach):传 onDetach 即得,点击把面板抽进自己的 OS 窗口
 *    (状态机在 main 的 ghost-panel-window/controller.ts);
 *  - 「撑满内容区」(maximize):传 panelKind 即得,状态在 LayoutRoot 的
 *    PanelMaximizeContext;
 *  - 「关闭」(close):传 onClose 即得,永远排最右。语义归调用方
 *    (意识面板用它走"二次确认后停用插件",见 ghostPanels.tsx)。
 *
 * 视觉走主题 token(规则 16);按钮 aria 文案走 i18n(panelChrome.*),
 * 标题由调用方传入并自行 i18n。
 */
export interface PanelChromeProps {
  /** 左侧标题(调用方自行 i18n;可以是文本或自定义节点)。 */
  title: ReactNode;
  /** 右端自定义控件槽(排在系统按钮的左侧)。 */
  actions?: ReactNode;
  /**
   * 面板在布局树里的 panelKind。传入且处于 LayoutRoot 的
   * PanelMaximizeContext 之下时,标准头长出「撑满内容区」系统按钮;
   * 不传(或脱离引擎单渲)则不渲染,行为与旧版完全一致。
   */
  panelKind?: string;
  /** 传入即长出「独立窗口」系统按钮(排在撑满按钮左侧),点击回调归调用方。 */
  onDetach?: () => void;
  /** 传入即长出「最小化为浮动气泡」系统按钮(排在独立窗口按钮左侧)。 */
  onMinimize?: () => void;
  /** 传入即长出「关闭」系统按钮(恒排最右);二次确认等语义归调用方。 */
  onClose?: () => void;
  /**
   * 是否渲染贴主窗口顶边的 46px 窗口拖拽带。纵向 Grid 的非首行传 false，
   * 避免在窗口中部浪费高度并产生误触拖窗区域；默认 true 保持根级面板行为。
   */
  showWindowSpacer?: boolean;
}

export function PanelChrome({
  title,
  actions,
  panelKind,
  onDetach,
  onMinimize,
  onClose,
  showWindowSpacer = true,
}: PanelChromeProps): ReactNode {
  const { t } = useTranslation();
  const maximize = usePanelMaximize();
  const showMaximize = panelKind !== undefined && maximize !== null;
  const isMaximized = showMaximize && maximize.maximizedKind === panelKind;
  // ChromeActions 按钮簇的窗口坐标(与 ChromeActions.tsx 的 x 同式):
  // 面板顶带的 no-drag 洞必须钉在这里,见下方洞元素注释。
  const { isMac, isFullscreen } = useMacFullscreen();
  const chromeClusterX =
    isMac && !isFullscreen
      ? CHROME_ACTIONS_GEOMETRY.macTrafficLightLeft
      : CHROME_ACTIONS_GEOMETRY.defaultLeft;
  return (
    <>
      {/* 窗口 chrome 让位带(§6 规则 3:顶部 46px 是系统领地,任何面板不得占用)。
          做进标准头 = 约束由引擎兜底,面板作者不靠自觉;整条归窗口拖动
          (B3 口径:46px 带拖窗、36px 头拖面板),与聊天顶栏/工具面板顶带连成一线。 */}
      {showWindowSpacer && (
        <div
          aria-hidden
          data-testid="panel-chrome-window-spacer"
          className="h-[46px] shrink-0 border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
          {/* ChromeActions 浮层按钮簇的 no-drag 洞:左栏折叠时本面板可能顶到窗口
              最左,顶带会盖住左上角折叠/菜单按钮 —— Electron 拖拽区是纯几何
              (drag 矩形减 no-drag 矩形)且挖洞只在 drag 元素后代上可靠生效,
              浮层自身的 no-drag 不算数(同 Sidebar 顶行 / ContentHeader spacer)。
              fixed 定位取窗口坐标:面板不在左上角时矩形与顶带不相交 = 几何
              no-op,无需感知自己的列位;pointer-events:none 不挡命中(拖拽区
              注册是几何计算,不依赖 DOM 事件)。 */}
          <div
            data-testid="panel-chrome-actions-hit-hole"
            className="pointer-events-none fixed top-0 h-[46px]"
            style={
              {
                left: chromeClusterX,
                width: CHROME_ACTIONS_GEOMETRY.clusterWidth,
                WebkitAppRegion: 'no-drag',
              } as CSSProperties
            }
          />
        </div>
      )}
      <div
        data-panel-drag-handle=""
        className="flex h-[36px] shrink-0 items-center justify-between gap-2 border-b border-[var(--border-default)] bg-[var(--panel-bg)] px-3"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <div className="min-w-0 truncate text-12 font-medium text-[var(--text-secondary)]">
          {title}
        </div>
        {(actions || showMaximize || onDetach || onMinimize || onClose) && (
          <div className="flex shrink-0 items-center gap-0.5">
            {actions}
            {onMinimize && (
              <ChromeIconButton
                aria-label={t('panelChrome.minimizeAria')}
                onClick={onMinimize}
              >
                <Minus size={14} />
              </ChromeIconButton>
            )}
            {onDetach && (
              <ChromeIconButton
                aria-label={t('panelChrome.detachAria')}
                onClick={onDetach}
              >
                <PictureInPicture2 size={14} />
              </ChromeIconButton>
            )}
            {showMaximize && (
              <ChromeIconButton
                aria-label={t(isMaximized ? 'panelChrome.restoreAria' : 'panelChrome.maximizeAria')}
                onClick={() => maximize.toggle(panelKind)}
              >
                {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </ChromeIconButton>
            )}
            {onClose && (
              <ChromeIconButton
                aria-label={t('panelChrome.closeAria')}
                onClick={onClose}
              >
                <X size={14} />
              </ChromeIconButton>
            )}
          </div>
        )}
      </div>
    </>
  );
}
