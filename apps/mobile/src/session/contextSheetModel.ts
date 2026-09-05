/**
 * Context 面板（+ 号弹出的可拖动 bottom sheet）的纯函数档位模型。
 *
 * 面板有两个吸附档位：
 * - half：默认档，露出照片条 + 模式分组 + 添加分组的前几行（对照设计稿 S1）。
 * - full：全高档，完整展示全部分组（对照设计稿 S2）。
 *
 * 拖动语义与 composerResize 一致：grabber 在面板顶部，向上拖（translationY 为负）
 * 面板变高；松手后按「就近吸附」结算到 half / full，拖得足够低则判定为关闭（dismiss）。
 * 所有高度都是「面板整体可视高度」（含 grabber / header / 内容），单位 px。
 */

export type ContextSheetSnap = 'half' | 'full';

export interface ContextSheetSnapHeights {
  half: number;
  full: number;
}

/** half 档占屏高比例（对照设计稿 470 / 844）。 */
const HALF_HEIGHT_RATIO = 0.56;
/** half 档高度下限，保证小屏也能露出模式分组第一行。 */
const HALF_MIN_HEIGHT = 320;
/** full 档顶部至少保留的屏幕空间（状态栏 + 一点背景，对照设计稿 64 / 844）。 */
const FULL_TOP_RESERVED_HEIGHT = 64;

/** 松手高度低于 half 档的该比例时判定为「想关掉」。 */
export const CONTEXT_SHEET_DISMISS_RATIO = 0.62;

export interface ComputeContextSheetSnapHeightsInput {
  /** 窗口高度（useWindowDimensions().height）。 */
  screenHeight: number;
  /** 顶部安全区 inset；full 档保留区取 max(inset, 固定保留)。 */
  safeAreaTopInset?: number;
}

export function computeContextSheetSnapHeights(
  input: ComputeContextSheetSnapHeightsInput,
): ContextSheetSnapHeights {
  const screenHeight = normalizePositiveDimension(input.screenHeight, 812);
  const topReserved = Math.max(
    FULL_TOP_RESERVED_HEIGHT,
    normalizeNonNegativeDimension(input.safeAreaTopInset, 0) + 12,
  );
  const full = Math.max(HALF_MIN_HEIGHT, Math.round(screenHeight - topReserved));
  const half = clamp(Math.round(screenHeight * HALF_HEIGHT_RATIO), HALF_MIN_HEIGHT, full);
  return { half, full };
}

export interface ApplyContextSheetDragInput {
  /** 手势开始时面板的可视高度。 */
  startHeight: number;
  /** 手势累计位移；向上（负值）= 变高。 */
  translationY: number;
  heights: ContextSheetSnapHeights;
}

/** 拖动跟手：位移换算成面板高度，上限 full；向下允许拖过 half（用于 dismiss 判定）。 */
export function applyContextSheetDrag(input: ApplyContextSheetDragInput): number {
  'worklet';
  const heights = normalizeHeights(input.heights);
  return clamp(Math.round(input.startHeight - input.translationY), 0, heights.full);
}

export type ContextSheetSettle = ContextSheetSnap | 'dismiss';

export interface SettleContextSheetDragInput {
  /** 松手时的拖拽高度（applyContextSheetDrag 的结果）。 */
  draggedHeight: number;
  heights: ContextSheetSnapHeights;
}

/**
 * 松手结算：高度过了 half / full 中点吸附到 full；低于 half 的 dismiss 阈值判关闭；
 * 其余情况回 half。half === full（小屏钳住）时只在 full 与 dismiss 之间二选一。
 */
export function settleContextSheetDrag(input: SettleContextSheetDragInput): ContextSheetSettle {
  'worklet';
  const heights = normalizeHeights(input.heights);
  if (input.draggedHeight < heights.half * CONTEXT_SHEET_DISMISS_RATIO) return 'dismiss';
  if (heights.full <= heights.half) return 'full';
  if (input.draggedHeight >= (heights.half + heights.full) / 2) return 'full';
  return 'half';
}

function normalizeHeights(heights: ContextSheetSnapHeights): ContextSheetSnapHeights {
  'worklet';
  const half = Math.max(1, Math.round(heights.half));
  return { half, full: Math.max(half, Math.round(heights.full)) };
}

function normalizePositiveDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}
