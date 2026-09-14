/**
 * windowDrag — 窗口拖拽区共享工具
 * ---------------------------------------------------------------------------
 * Codex 风格布局后，mac 上"自带顶部行"的页面不再渲染通用 ContentHeader
 * （见 ContentHeader.tsx 的空 header 隐藏逻辑），这些页面的顶行需要自己
 * 承担"窗口标题栏可拖动"的职责。约定：
 *
 *   - 页面自带顶行（页头 / 工具栏 / tab 条）→ 顶行容器加 WINDOW_DRAG_STYLE，
 *     行内可交互元素（按钮 / 输入框 / tab）包 WINDOW_NO_DRAG_STYLE 挖洞。
 *   - 页面顶部是空白（居中布局的 empty state / hero）→ 根部叠一条
 *     <InvisibleWindowDragStrip />。
 *
 * ⚠️ Electron 拖拽区域是纯几何计算：drag 矩形减 no-drag 矩形，与 z-index /
 * paint 顺序无关；但 no-drag 挖洞只在 drag 元素自己的**后代**上可靠生效，
 * 浮层／兄弟节点上的 no-drag 不被计入（实机结论，见 ContentHeader.tsx:155-157
 * ／ FileTabsBar.tsx:421-425）。交互元素漏标 no-drag 会变成"点了就拖窗口"；
 * 反之 drag 条叠在交互元素上同样会吞掉点击 —— InvisibleWindowDragStrip
 * 只能用在顶部确实无交互元素的页面。
 *
 * Windows 上通用 header 不隐藏（窗口控制按钮常驻），这些拖拽区是纯增益。
 */

import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

/** 顶行容器：整行作为窗口拖拽区。 */
export const WINDOW_DRAG_STYLE = { WebkitAppRegion: 'drag' } as CSSProperties;

/** 行内交互元素 / 交互簇 wrapper：从拖拽区里挖洞。 */
export const WINDOW_NO_DRAG_STYLE = { WebkitAppRegion: 'no-drag' } as CSSProperties;

interface InvisibleWindowDragStripProps {
  /** 拖拽条高度，默认 50px（与 ContentHeader 同高）。 */
  height?: number;
}

/**
 * 透明窗口拖拽条：absolute 叠在页面顶部，无视觉、不参与布局。
 * 仅用于顶部 50px 内确实没有任何交互元素的页面（父容器需 relative）。
 *
 * pointer-events: none —— 拖拽区域注册是纯几何计算，不依赖 DOM 事件，
 * drag 在 pointer-events: none 下依然生效；而本条退出 DOM 命中后，未来
 * 若有元素落进顶部 50px，点击 / 聚焦不会被本条挡住（标了 no-drag 的
 * 交互元素可正常工作）。
 */
export function InvisibleWindowDragStrip({ height = 50 }: InvisibleWindowDragStripProps) {
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 top-0 z-10"
      style={{ height, pointerEvents: 'none', ...WINDOW_DRAG_STYLE }}
    />
  );
}

/** 按住移动超过该距离(px)才认定为拖窗;死区内的按-放序列留给 click / dblclick。 */
const MANUAL_DRAG_DEAD_ZONE_PX = 4;

interface ManualWindowDragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * useManualWindowDrag — 让 no-drag 元素也能"按住拖动移动窗口"。
 *
 * 适用场景:元素既要响应鼠标事件(如双击改名的会话标题文字)、又要保留
 * "从它上面按住拖动 = 拖窗"的习惯。原生 `-webkit-app-region: drag` 做不到
 * ——drag 区域会吞掉全部 DOM 鼠标事件(macOS/Windows 实测连 mousedown 都
 * 收不到,electron#37789),所以元素必须标 no-drag,拖窗改由本 hook 经 IPC
 * 请求 main 手动跟随(见 main/windowManualDrag.ts)。
 *
 * 行为:按下后移动超过死区才通知 main 开始跟随;死区内的按-放不动窗口,
 * click / dblclick 照常合成,双击语义不受影响。pointer capture 保证拖出
 * 元素 / 窗口后 pointerup 仍能到达并结束拖拽;组件卸载时兜底 stop。
 *
 * 用法:`<span style={WINDOW_NO_DRAG_STYLE} {...useManualWindowDrag()} />`。
 */
export function useManualWindowDrag(): ManualWindowDragHandlers {
  const stateRef = useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    dragging: boolean;
  } | null>(null);

  // 卸载兜底:拖拽中元素被卸载(极端)时结束 main 侧跟随,避免窗口粘在光标上。
  useEffect(() => {
    return () => {
      if (stateRef.current?.dragging) window.electronAPI.windowDragMoveStop();
      stateRef.current = null;
    };
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    stateRef.current = {
      pointerId: e.pointerId,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      dragging: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const state = stateRef.current;
    if (!state || state.pointerId !== e.pointerId || state.dragging) return;
    const dx = e.screenX - state.startScreenX;
    const dy = e.screenY - state.startScreenY;
    if (Math.hypot(dx, dy) < MANUAL_DRAG_DEAD_ZONE_PX) return;
    state.dragging = true;
    window.electronAPI.windowDragMoveStart();
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const state = stateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    stateRef.current = null;
    if (state.dragging) window.electronAPI.windowDragMoveStop();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };
}
