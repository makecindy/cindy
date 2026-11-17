/**
 * RightSidebarToggle — 工具面板开关按钮（纯图标，无选中底色）
 * ---------------------------------------------------------------------------
 * 单一一份裸图标按钮，多处复用，两平台同款样式、不同落点：
 *   - Mac：显示入口钉在聊天区右上角；关闭入口跟随侧栏。
 *   - Windows：显示入口始终在聊天区靠面板一侧的角上；关闭入口位于 TabBar 末端。
 *     入口不依赖具体路由页面渲染。
 * `action="show"` 是单向显示 / 聚焦语义，关闭或收起由面板自己的按钮负责。
 * resting 无底无边、仅 hover 底色（用户明确这个开关不要圆底；chip 栈里下方两个
 * chip 保留圆底，裸图标 + 圆底 chip 连成一列）。尺寸 h-7 / 图标 15 / 圆形，与左栏折叠按钮
 * （ChromeActions 的 PanelLeft）同一规格族（DESIGN §5：按钮为胶囊档）。
 * chip 栈容器是 pointer-events-none，本按钮自带 `pointer-events-auto` 才能接收点击
 * （Windows chip 栈约束；mac 在 ContentHeader 里无副作用）。图标随 `side` 翻转:
 * 面板在右 = lucide `PanelRight`(与左栏 `PanelLeft` 对称),面板在左 = `PanelLeft`
 * ——图标画的就是"面板贴哪条边",跟着面板走才不说谎。
 *
 * Mac 固定入口还承载"右侧面板常驻"：短按仍开关面板，按住 2 秒切换常驻；
 * 按住时沿按钮内缘走一圈进度，常驻开启后右下角显示状态点，移动超过 8px 取消长按。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { PanelLeft, PanelRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface RightSidebarToggleProps {
  /** 右栏是否折叠（用于 aria-expanded）。 */
  collapsed: boolean;
  onToggle: () => void;
  /** 面板当前贴哪条边(B2b:由布局树推导,经 MainLayout 下发);决定图标方向。默认 'right'。 */
  side?: 'left' | 'right';
  /** toggle 表达展开 / 收起；show 是聊天区的显示入口；close 是侧栏的关闭入口。 */
  action?: 'toggle' | 'show' | 'close';
  /** 长按按钮切换“进入任务时默认展开”的常驻状态。 */
  onLongPress?: () => void;
  /** 当前是否处于常驻展开状态；只在可长按的入口显示状态点。 */
  persistent?: boolean;
}

const LONG_PRESS_MS = 2000;
const LONG_PRESS_MOVE_TOLERANCE_PX = 8;
const PROGRESS_RING_RADIUS = 12.5;
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_RADIUS;

interface LongPressState {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  timer: number;
  frame: number;
  didLongPress: boolean;
}

export function RightSidebarToggle({
  collapsed,
  onToggle,
  side = 'right',
  action = 'toggle',
  onLongPress,
  persistent = false,
}: RightSidebarToggleProps) {
  const { t } = useTranslation();
  const [holdProgress, setHoldProgress] = useState(0);
  const longPressRef = useRef<LongPressState | null>(null);
  const suppressClickRef = useRef(false);
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const Icon = action === 'close' ? X : side === 'left' ? PanelLeft : PanelRight;
  // B2c:文案只说动作(折叠/展开),不提"右栏"等方位名词 —— 按钮按位置寻址,
  // 管的是"贴这条缘的面板",绑定方位词会在面板换侧后说谎。
  const label = t(
    action === 'close'
      ? 'rightSidebar.tabs.controls.closeAria'
      : action === 'show'
      ? 'rightSidebar.tabs.controls.showAria'
      : collapsed
        ? 'contentHeader.expandPanel'
        : 'contentHeader.collapsePanel',
  );
  const tipText = onLongPress
    ? t(
        persistent
          ? 'rightSidebar.tabs.controls.persistentHintActive'
          : 'rightSidebar.tabs.controls.persistentHint',
      )
    : label;

  const clearLongPress = useCallback((suppressClick = false) => {
    const active = longPressRef.current;
    if (!active) return;
    window.clearTimeout(active.timer);
    window.cancelAnimationFrame(active.frame);
    if (suppressClick && active.didLongPress) suppressClickRef.current = true;
    longPressRef.current = null;
    setHoldProgress(0);
  }, []);

  useEffect(() => () => clearLongPress(), [clearLongPress]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!onLongPress || event.button !== 0 || event.isPrimary === false) return;
    clearLongPress();
    const button = event.currentTarget;
    const startedAt = performance.now();
    const state: LongPressState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt,
      timer: 0,
      frame: 0,
      didLongPress: false,
    };
    const tick = () => {
      if (longPressRef.current !== state) return;
      const next = Math.min(1, (performance.now() - startedAt) / LONG_PRESS_MS);
      setHoldProgress(next);
      if (next < 1) state.frame = window.requestAnimationFrame(tick);
    };
    state.frame = window.requestAnimationFrame(tick);
    state.timer = window.setTimeout(() => {
      if (longPressRef.current !== state) return;
      state.didLongPress = true;
      setHoldProgress(1);
      onLongPressRef.current?.();
    }, LONG_PRESS_MS);
    longPressRef.current = state;
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional; pointerup on the button still completes the gesture.
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = longPressRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (
      Math.hypot(event.clientX - active.startX, event.clientY - active.startY) >
      LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      // 已经触发过长按：移动取消手势时也要拦住这次 click，否则松手会把刚打开的面板又收起。
      clearLongPress(active.didLongPress);
    }
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (longPressRef.current?.pointerId === event.pointerId) clearLongPress(true);
  };

  return (
    <Tip text={tipText} side="bottom">
      <button
        type="button"
        className={cn(
          'pointer-events-auto relative flex h-7 w-7 items-center justify-center rounded-full',
          'text-titlebar-icon',
          'transition-colors',
          'hover:bg-titlebar-button-hover',
        )}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          onToggle();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        aria-label={label}
        aria-expanded={action === 'close' ? undefined : !collapsed}
        // 常驻偏好只有长按入口，读屏要能听到当前值；状态点本身是纯装饰。
        {...(onLongPress ? { 'aria-description': tipText } : {})}
      >
        {holdProgress > 0 && (
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0"
            viewBox="0 0 28 28"
          >
            <circle
              cx="14"
              cy="14"
              r={PROGRESS_RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeDasharray={PROGRESS_RING_CIRCUMFERENCE}
              strokeDashoffset={PROGRESS_RING_CIRCUMFERENCE * (1 - holdProgress)}
              transform="rotate(-90 14 14)"
            />
          </svg>
        )}
        <Icon size={15} />
        {persistent && (
          <span
            aria-hidden
            data-testid="right-sidebar-persistent-indicator"
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-current"
          />
        )}
      </button>
    </Tip>
  );
}
