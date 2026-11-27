/**
 * PanelDragPrototype —— 「直接拖面板换位」交互原型(dev 构建限定,布局树 Step B 决策辅助)。
 *
 * 背景:编辑模式的交互形态未定,本原型把两种候选手势
 * 都做出来给 Lizi 体感,决策后本文件按结论转正或删除 —— **不是正式功能**:
 *   1. 拖 Tab 条:按住工具面板 Tab 条空白处(data-panel-drag-handle)移动 >5px 即拖;
 *   2. 长按窗体:面板任意区域按住 600ms 不动(<8px)后"浮起"进入拖动。
 *      注意:网页(webview)/独立进程区域宿主收不到按压事件,长按在那里天然无效 ——
 *      这正是要体感对比的核心取舍之一。
 *
 * 交互语义(2026-07-07 按 Lizi 反馈定为 drop-zone 式):**拖动过程不换位**;
 * 指针拖进**对面那块面板的真实矩形**(共享边内缩 12px 防贴边抖动)时,该面板
 * 区域亮起「松手会落到这里」的半透明高亮罩 —— 高亮就是会被交换的区域本身的
 * 尺寸,不是半屏;退出即熄灭。**松手在高亮亮着时才写树交换**(layout.set 即
 * 持久化,LayoutRoot 收广播重排),Esc / 松手在原侧 = 取消,什么都不发生。
 *
 * 性能口径(2026-07-07 按 Lizi "卡手"反馈重做):pointermove 热路径**零 React
 * 渲染、零布局读取**——边界几何在起拖时量一次缓存(拖动期间不换位,界面静止,
 * 没有失效场景);拖影跟手走 transform: translate3d 直改 DOM(GPU 合成,不触发
 * 排版);只有"目标区亮/灭"这种低频状态切换才 setState(一次拖动至多几次)。
 *
 * 复用 body.resizing-pane 让 webview 在拖动期间指针穿透(与拖宽同款方案),
 * 否则指针滑进浏览器 tab 区域后 pointermove 会被 guest 吃掉、拖动卡死。
 *
 * 生产构建(import.meta.env.DEV=false)完全不挂,零暴露。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { findSplitChildByPanelKind } from '../../shared/layoutTree';
import { makeRootSwappedLayout } from './layoutDevTools';

/** 拖 Tab 条:按下后移动超过该距离(px)进入拖动。 */
const HANDLE_MOVE_THRESHOLD_PX = 5;
/** 长按窗体:按住该时长(ms)且位移小于容差才"浮起"。 */
const LONG_PRESS_MS = 600;
/** 长按期间允许的手抖位移容差(px),超过即取消长按判定。 */
const LONG_PRESS_MOVE_TOLERANCE_PX = 8;
/** 落点高亮框相对目标面板边界的内缩(px),视觉上是"悬浮在那块面板上的落点框"。 */
const DROP_ZONE_INSET_PX = 6;
/** 触发区在源/目标共享边一侧的内缩(px):指针要真正拖进目标面板一小段才点亮,防贴边抖动。 */
const ZONE_ENTER_MARGIN_PX = 12;

/** 高亮/提交共用的触发横向区间(亮着的时候松手就一定交换,所见即所得)。 */
export interface TriggerRange {
  left: number;
  right: number;
}

/**
 * 纯函数:由目标面板矩形推触发区间 —— 只在**与源面板共享的那条边**内缩入界余量
 * (指针要真正拖进目标一小段才点亮,防贴边抖动);远端边不缩,拖到窗口边缘也算在内。
 */
export function computeTriggerRange(
  rectLeft: number,
  rectRight: number,
  sourceIsLeftOfTarget: boolean,
  enterMarginPx: number = ZONE_ENTER_MARGIN_PX,
): TriggerRange {
  return sourceIsLeftOfTarget
    ? { left: rectLeft + enterMarginPx, right: rectRight }
    : { left: rectLeft, right: rectRight - enterMarginPx };
}

/** 纯函数:指针横坐标是否落在触发区间内。 */
export function isPointerInTargetZone(pointerX: number, range: TriggerRange): boolean {
  if (!(range.right > range.left)) return false;
  return pointerX >= range.left && pointerX <= range.right;
}

/** 当前树上某面板所在侧(root 分割首个 child = 左)。树里没有它返回 null。 */
function sideOfPanelKind(kind: string): 'left' | 'right' | null {
  try {
    const layout = window.electronAPI.layout.getStateSync().layout;
    const ref = findSplitChildByPanelKind(layout, kind);
    if (!ref) return null;
    return ref.childIndex === 0 ? 'left' : 'right';
  } catch {
    return null;
  }
}

interface PanelDragPrototypeProps {
  /** MainLayout 的 row 容器(全宽 flex 行),用于算内容区右边界与纵向范围。 */
  rowRef: React.RefObject<HTMLDivElement | null>;
  /** 左侧占位块 wrapper(B1a 引入),用于算内容区左边界;设置页等场景为 null 按 0 计。 */
  sidebarBlockRef: React.RefObject<HTMLDivElement | null>;
  /** 工具面板当前可拖(在场 + 展开 + 非 maximize + 未弹出子窗口)。 */
  enabled: boolean;
}

interface ZoneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 起拖时一次性缓存的几何:目标面板的真实矩形(高亮框)+ 触发区间(拖动期间界面静止,不会失效)。 */
interface DragGeometry {
  zone: ZoneRect;
  trigger: TriggerRange;
}

/** 低频渲染状态:只在拖动开始/结束与目标区亮灭时变化,不随指针移动更新。 */
interface DragRenderState {
  overTarget: boolean;
}

export function PanelDragPrototype({
  rowRef,
  sidebarBlockRef,
  enabled,
}: PanelDragPrototypeProps): ReactNode {
  const [drag, setDrag] = useState<DragRenderState | null>(null);
  const dragActiveRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  // 热路径通道:指针位置与几何走 ref + 直改 DOM,绕过 React。
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const pointRef = useRef({ x: 0, y: 0 });
  const geometryRef = useRef<DragGeometry | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV || !enabled) return;

    /** 拖影跟手:直改 transform(GPU 合成),不进 React、不触发排版。 */
    const moveGhost = (x: number, y: number) => {
      pointRef.current = { x, y };
      const node = ghostRef.current;
      if (node) node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    /** 进入拖动态:量一次几何 + 挂全局监听 + webview 穿透 + 禁选中。 */
    const activateDrag = (sourceKind: string, startX: number, startY: number) => {
      const sourceSide = sideOfPanelKind(sourceKind);
      if (!sourceSide) return;
      // 目标面板 = root 分割里的另一个 pane;高亮/提交区域就是它**当下的真实矩形**
      // (2026-07-07 Lizi 反馈:高亮必须是"会被交换的那块区域"的尺寸,不是半屏)。
      // 几何一次性缓存:拖动期间不换位、界面静止,没有需要每帧重量的理由。
      let targetEl: Element | null = null;
      try {
        const layout = window.electronAPI.layout.getStateSync().layout;
        if (layout.content.type !== 'split') return;
        const otherKind = layout.content.children
          .map((c) => (c.node.type === 'pane' ? c.node.panelKind : null))
          .find((k) => k && k !== sourceKind);
        if (!otherKind) return;
        targetEl = document.querySelector(`[data-panel-drag-root="${otherKind}"]`);
      } catch {
        return;
      }
      if (!targetEl) return;
      const targetRect = targetEl.getBoundingClientRect();
      geometryRef.current = {
        zone: {
          left: targetRect.left + DROP_ZONE_INSET_PX,
          top: targetRect.top + DROP_ZONE_INSET_PX,
          width: Math.max(0, targetRect.width - DROP_ZONE_INSET_PX * 2),
          height: Math.max(0, targetRect.height - DROP_ZONE_INSET_PX * 2),
        },
        trigger: computeTriggerRange(targetRect.left, targetRect.right, sourceSide === 'left'),
      };

      dragActiveRef.current = true;
      let overTargetNow = false;
      pointRef.current = { x: startX, y: startY };
      setDrag({ overTarget: false });
      document.body.classList.add('resizing-pane');
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';
      // 长按期间 mousedown 默认行为可能已拉出文字选区,浮起时清掉。
      window.getSelection()?.removeAllRanges();

      /** 每帧:直改拖影 transform;只有目标区亮/灭变化才 setState。 */
      const onMove = (e: PointerEvent) => {
        moveGhost(e.clientX, e.clientY);
        const geo = geometryRef.current;
        if (!geo) return;
        const nextOver = isPointerInTargetZone(e.clientX, geo.trigger);
        if (nextOver !== overTargetNow) {
          overTargetNow = nextOver;
          setDrag({ overTarget: nextOver });
        }
      };

      const finish = (opts: { commit: boolean; suppressClick: boolean }) => {
        dragActiveRef.current = false;
        geometryRef.current = null;
        setDrag(null);
        document.body.classList.remove('resizing-pane');
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        cleanupRef.current = null;
        if (opts.commit && overTargetNow) {
          // 松手在高亮上 → 此刻才真正交换并持久化。
          try {
            const layout = window.electronAPI.layout.getStateSync().layout;
            const swapped = makeRootSwappedLayout(layout);
            if (swapped) void window.electronAPI.layout.set(swapped).catch(() => undefined);
          } catch {
            // IPC 异常 —— 放弃本次交换,界面保持原样
          }
        }
        if (opts.suppressClick) {
          // 松手落点可能是按钮(尤其长按路径),吞掉紧随其后的这一次 click;
          // 100ms 兜底移除,避免"没有 click 跟来"时误吞用户下一次正常点击。
          const swallow = (ce: MouseEvent) => {
            ce.preventDefault();
            ce.stopPropagation();
          };
          window.addEventListener('click', swallow, { capture: true, once: true });
          window.setTimeout(
            () => window.removeEventListener('click', swallow, { capture: true } as EventListenerOptions),
            100,
          );
        }
      };
      const onUp = () => finish({ commit: true, suppressClick: true });
      const onCancel = () => finish({ commit: false, suppressClick: false });
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') finish({ commit: false, suppressClick: false });
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      cleanupRef.current = () => finish({ commit: false, suppressClick: false });
    };

    /** 手势识别入口:按下时区分 Tab 条(拖动阈值)与窗体(长按)。 */
    const onPointerDown = (e: PointerEvent) => {
      if (dragActiveRef.current) return;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const root = target.closest('[data-panel-drag-root]');
      if (!root) return;
      // 标记值即面板身份(chat-main / right-tabs),两块都可拖、都往对面半区落。
      const sourceKind = root.getAttribute('data-panel-drag-root');
      if (!sourceKind) return;
      if (target.closest('[data-rsb-resize-handle]')) return; // 拖宽把手让路

      const startX = e.clientX;
      const startY = e.clientY;
      const onHandleSurface = !!target.closest('[data-panel-drag-handle]');

      if (onHandleSurface) {
        // Tab 条:pill / 按钮等可交互元素让路,空白处移动 >5px 进入拖动。
        if (target.closest('button, a, input, textarea, select, [role="menuitem"]')) return;
        const onMove = (me: PointerEvent) => {
          if (
            Math.abs(me.clientX - startX) > HANDLE_MOVE_THRESHOLD_PX ||
            Math.abs(me.clientY - startY) > HANDLE_MOVE_THRESHOLD_PX
          ) {
            stop();
            activateDrag(sourceKind, me.clientX, me.clientY);
          }
        };
        const stop = () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', stop);
          document.removeEventListener('pointercancel', stop);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', stop);
        document.addEventListener('pointercancel', stop);
        return;
      }

      // 窗体长按:600ms 内位移 <8px 才浮起。按钮等可交互元素不排除 ——
      // "哪里都能长按"正是本手势要验证的点;误触由激活后的 click 吞噬兜底。
      // 例外:文字输入面(输入框 / 富文本)让路,按住不动在那里是真实的
      // 光标/选词手势(聊天输入框首当其冲),劫持它会直接破坏打字体验。
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      const timer = window.setTimeout(() => {
        stop();
        activateDrag(sourceKind, startX, startY);
      }, LONG_PRESS_MS);
      const onMove = (me: PointerEvent) => {
        if (
          Math.abs(me.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE_PX ||
          Math.abs(me.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE_PX
        ) {
          stop();
        }
      };
      const stop = () => {
        window.clearTimeout(timer);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', stop);
      document.addEventListener('pointercancel', stop);
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      cleanupRef.current?.();
    };
  }, [enabled, rowRef, sidebarBlockRef]);

  if (!drag) return null;
  const zone = drag.overTarget ? geometryRef.current?.zone : null;
  // 视觉(全走主题 token,规则 16;无文案免 i18n):
  //   1. 落点高亮:半透明淡蓝罩层(VSCode 拖 tab 落点同款质感)——透出下方内容,
  //      取色基于 focus-ring 语义蓝低透明度混合,light / dark / 扩展主题都自然;
  //   2. 拖影:迷你面板骨架卡,微倾斜 + 淡入起手动画(内层卡的 transform 被
  //      居中偏移+倾斜占用,起手动画只能碰 opacity,不许上 scale 类 keyframe)。
  //      外层定位壳(translate3d 跟手,热路径直改)与内层视觉卡(居中偏移 + 倾斜)
  //      分离 —— transform 各自独立,互不覆盖。
  return createPortal(
    <>
      {zone && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[9998] rounded-xl border animate-fade-in"
          style={{
            left: zone.left,
            top: zone.top,
            width: zone.width,
            height: zone.height,
            background: 'color-mix(in srgb, var(--focus-ring) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--focus-ring) 55%, transparent)',
          }}
        />
      )}
      <div
        aria-hidden
        ref={(node) => {
          ghostRef.current = node;
          // 挂载瞬间就位到当前指针(此后由 pointermove 直改 transform 跟手)。
          if (node) {
            node.style.transform = `translate3d(${pointRef.current.x}px, ${pointRef.current.y}px, 0)`;
          }
        }}
        className="pointer-events-none fixed left-0 top-0 z-fullscreen will-change-transform"
      >
        <div
          className="h-[110px] w-[170px] rounded-xl border animate-fade-in"
          style={{
            transform: 'translate(-50%, -58%) rotate(-2deg)',
            background: 'var(--surface-elevated)',
            borderColor: drag.overTarget ? 'var(--focus-ring)' : 'var(--border-default)',
            boxShadow: 'var(--shadow-menu)',
            opacity: 0.92,
          }}
        >
          {/* 迷你骨架示意"这是一个面板":一条假 Tab 条 + 两行假内容。 */}
          {/* 插画内部的形状，不是控件框（DESIGN.md §5 插画登记） */}
          <div className="mx-2 mt-2 h-[14px] w-[70%] rounded-md bg-[var(--surface-chip)]" />
          <div className="mx-2 mt-2 h-[10px] w-[85%] rounded bg-[var(--surface-chip)] opacity-70" />
          <div className="mx-2 mt-1.5 h-[10px] w-[60%] rounded bg-[var(--surface-chip)] opacity-70" />
        </div>
      </div>
    </>,
    document.body,
  );
}
