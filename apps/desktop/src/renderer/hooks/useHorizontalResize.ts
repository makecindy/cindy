/**
 * useHorizontalResize — 通用水平拖拽 resize hook
 * ---------------------------------------------------------------------------
 * 抽自 useSidebarResize 的核心逻辑，把 storageKey / 默认 / 上下限作为参数，
 * 让主侧边栏 + 任意 inner master-detail 分隔条共用同一份实现，避免代码重复。
 *
 * 行为：
 * - Pointer Events API（不引入第三方拖拽库）
 * - 拖拽中实时更新 width state；松手时一次性写 localStorage（节流到底层）
 * - 跨进程共享：localStorage 在 Electron renderer 层逐窗口隔离即可
 * - 双击 handle 调用 resetWidth() 回到默认值
 *
 * 调用方：拿到 { width, isDragging, handleDragStart, resetWidth } 自行渲染 handle，
 * 同时把 isDragging 透传给上层容器加 'select-none cursor-col-resize' 防止拖拽时
 * 误选中文字 / 鼠标 cursor 跳变。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface HorizontalResizeOptions {
  /** localStorage 键名，跨会话持久化拖拽后的宽度。 */
  storageKey: string;
  /** 初次启动 / 持久值非法时回退到该宽度。 */
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /**
   * rail 折叠支持（sidebar-card-mode redesign）：拖到 threshold 以下进入
   * rail 模式（视觉宽度允许降到 railWidth），拖回 threshold 以上退出。
   * rail 状态由调用方持有（active），本 hook 只在拖拽中触发 onChange。
   */
  rail?: {
    active: boolean;
    /** 原始拖拽宽度低于该值 → rail on；高于 → rail off。 */
    threshold: number;
    /** rail 模式宽度下限（最终停靠宽度由调用方渲染层决定）。 */
    railWidth: number;
    onChange: (on: boolean) => void;
  };
  /**
   * 反转拖拽方向。默认 false：handle 在元素右边缘，指针右移变宽（左侧栏语义）。
   * 右侧栏的 handle 在元素左边缘，指针左移才变宽，需要把 delta 取反。
   */
  invert?: boolean;
  /**
   * 磁吸停靠点（width 像素）：拖拽中宽度进入某停靠点 ±SNAP_TOLERANCE 时吸附到该点，
   * 形成"自动停留/卡位"的手感(如卡片版 2 列最佳最小宽)。rail 态下不吸附。
   */
  snapPoints?: number[];
}

/** 磁吸停靠的吸附半径(px)——进入 ±此值就吸到停靠点;拖出此带即脱离自由拖。 */
const SNAP_TOLERANCE = 16;

export interface HorizontalResizeResult {
  width: number;
  isDragging: boolean;
  /** Supply the displayed width when layout temporarily clamps the preferred width. */
  handleDragStart: (e: React.PointerEvent, displayedWidth?: number) => void;
  resetWidth: () => void;
  /**
   * 命令式设宽：clamp 到 [minWidth, maxWidth] 并持久化。供调用方按运行时布局
   * 动态设定宽度（如右栏打开时按主区域宽度的一半做 50/50 平分），区别于
   * resetWidth() 的静态默认值。
   */
  setWidth: (next: number) => void;
}

function readPersistedWidth(opts: HorizontalResizeOptions): number {
  try {
    const stored = localStorage.getItem(opts.storageKey);
    if (stored !== null) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed >= opts.minWidth && parsed <= opts.maxWidth) {
        return parsed;
      }
    }
  } catch {
    // localStorage not available — fall through
  }
  return opts.defaultWidth;
}

function persistWidth(storageKey: string, width: number): void {
  try {
    localStorage.setItem(storageKey, String(width));
  } catch {
    // silently ignore
  }
}

export function useHorizontalResize(opts: HorizontalResizeOptions): HorizontalResizeResult {
  const [width, setWidth] = useState(() => readPersistedWidth(opts));
  const [isDragging, setIsDragging] = useState(false);

  // Refs to avoid stale closures in global pointer listeners
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const startPreferredWidthRef = useRef(width);
  const currentWidthRef = useRef(width);

  // rail 选项进 ref——拖拽中 active 会被 onChange 翻转触发 re-render，
  // 全局 pointer listener 不能因此重绑（会丢拖拽中间态）。
  const railRef = useRef(opts.rail);
  railRef.current = opts.rail;
  // 磁吸停靠点进 ref——同 rail，拖拽中不重绑 listener。
  const snapPointsRef = useRef(opts.snapPoints);
  snapPointsRef.current = opts.snapPoints;
  // 本次拖拽内的 rail 实时状态（move 里翻转，up 时定稿）
  const railActiveRef = useRef(false);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      // invert(右侧栏)先把 delta 取反,再走 rail 阈值判断与下限钳制。
      const rawDelta = e.clientX - startXRef.current;
      const delta = opts.invert ? -rawDelta : rawDelta;
      const raw = startWidthRef.current + delta;
      const rail = railRef.current;
      if (rail) {
        // rail 区间：原始宽度低于 threshold 进 rail，高于退出（迟滞由阈值差承担）
        if (raw < rail.threshold && !railActiveRef.current) {
          railActiveRef.current = true;
          rail.onChange(true);
        } else if (raw >= rail.threshold && railActiveRef.current) {
          railActiveRef.current = false;
          rail.onChange(false);
        }
      }
      // 拖拽中宽度连续跟手（rail 启用时下限放宽到 railWidth，对照 redesign 稿：
      // min 钳制只在松手时做），rail 开关只切换渲染内容不打断宽度
      const lower = rail ? rail.railWidth : opts.minWidth;
      let newWidth = Math.min(opts.maxWidth, Math.max(lower, raw));
      // 磁吸停靠:非 rail 态下,宽度进入某停靠点 ±SNAP_TOLERANCE 就吸到该点(自动停留),
      // 拖出该带即脱离继续自由拖。
      if (!railActiveRef.current) {
        const snaps = snapPointsRef.current;
        if (snaps) {
          for (const point of snaps) {
            if (Math.abs(newWidth - point) <= SNAP_TOLERANCE) {
              newWidth = point;
              break;
            }
          }
        }
      }
      setWidth(newWidth);
      currentWidthRef.current = newWidth;
    },
    [opts.maxWidth, opts.minWidth, opts.invert],
  );

  const handlePointerUp = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);

    if (railActiveRef.current) {
      // rail 定稿：不把 rail 宽度写进持久化——退出 rail 时要还原到上次的展开宽度
      const restored = readPersistedWidth(opts);
      setWidth(restored);
      currentWidthRef.current = restored;
    } else {
      const snapped = Math.max(opts.minWidth, currentWidthRef.current);
      // Pulling against a temporary layout floor does not move the divider;
      // keep the original preference for when the floor goes away.
      const stayedAtFloor = startWidthRef.current > startPreferredWidthRef.current &&
        snapped <= startWidthRef.current;
      const committedWidth = stayedAtFloor ? startPreferredWidthRef.current : snapped;
      setWidth(committedWidth);
      currentWidthRef.current = committedWidth;
      persistWidth(opts.storageKey, committedWidth);
    }

    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', handlePointerUp);
    // deps 刻意只列原始值——拖拽中 re-render 不得重建已挂到 document 的 listener
  }, [handlePointerMove, opts.storageKey, opts.minWidth, opts.maxWidth, opts.defaultWidth]);

  const handleDragStart = useCallback(
    (e: React.PointerEvent, displayedWidth?: number) => {
      // Only left mouse button
      if (e.button !== 0) return;
      e.preventDefault();

      isDraggingRef.current = true;
      startXRef.current = e.clientX;
      startPreferredWidthRef.current = currentWidthRef.current;
      // rail 态下从 railWidth 起算——currentWidth 还停留在上次展开宽度
      const rail = railRef.current;
      railActiveRef.current = rail?.active ?? false;
      startWidthRef.current = railActiveRef.current && rail
        ? rail.railWidth
        : displayedWidth ?? currentWidthRef.current;
      // rail 态下 width state 仍停在上次展开宽度(松手时刻意还原的),而 Sidebar 在
      // isDragging 期间按 width 渲染(visualWidth = isDragging ? width)。若不先把
      // width 拉回 railWidth,按下 handle 那一刻会从 64 跳到展开宽度、等第一个
      // pointermove 才修正(纯点击不拖则直接闪一下)。这里在开拖前同步到 railWidth,
      // 让拖拽起点视觉连续。
      if (railActiveRef.current && rail) {
        setWidth(rail.railWidth);
        currentWidthRef.current = rail.railWidth;
      }
      setIsDragging(true);

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    },
    [handlePointerMove, handlePointerUp],
  );

  const resetWidth = useCallback(() => {
    // 双击 handle：rail 态下先退出 rail，再回默认宽
    const rail = railRef.current;
    if (rail?.active) rail.onChange(false);
    railActiveRef.current = false;
    setWidth(opts.defaultWidth);
    currentWidthRef.current = opts.defaultWidth;
    persistWidth(opts.storageKey, opts.defaultWidth);
  }, [opts.defaultWidth, opts.storageKey]);

  // 命令式设宽：按当前 [min,max] clamp 后落地 + 持久化。clamp 用闭包里的 opts.maxWidth
  // （右栏由 MainLayout 动态下发），所以 deps 含 maxWidth 以拿到最新上限。
  const setWidthClamped = useCallback(
    (next: number) => {
      const clamped = Math.min(opts.maxWidth, Math.max(opts.minWidth, next));
      setWidth(clamped);
      currentWidthRef.current = clamped;
      persistWidth(opts.storageKey, clamped);
    },
    [opts.maxWidth, opts.minWidth, opts.storageKey],
  );

  // 上限收缩时回收当前宽度：maxWidth 动态变小（右栏场景——窗口 / 左栏变窄使可用
  // 空间减少）且当前宽度越界时，clamp 回新上限避免溢出。非拖拽态才收（拖拽中由
  // pointermove 自己 clamp）；不 persist —— 持久值保留用户拖到的意图，空间恢复
  // 后可再拖回。静态 maxWidth 的调用方（左栏 / skillhub 列等）width 恒 ≤ max，
  // 此 effect 不触发，行为不变。
  useEffect(() => {
    if (isDraggingRef.current) return;
    if (currentWidthRef.current > opts.maxWidth) {
      setWidth(opts.maxWidth);
      currentWidthRef.current = opts.maxWidth;
    }
  }, [opts.maxWidth]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  return { width, isDragging, handleDragStart, resetWidth, setWidth: setWidthClamped };
}
