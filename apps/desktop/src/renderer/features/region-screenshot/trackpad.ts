/**
 * 触控板与鼠标滚轮的区分 (截图浮层、贴图、编辑窗共用)。
 *
 * Chromium 对触控板 / 妙控鼠标的连续滚动给出 `wheelDeltaY === -3 × deltaY`, 鼠标滚轮
 * 每格是 120 的倍数; 没有 wheelDelta 的环境按像素模式的小数增量判断。macOS 的双指
 * 捏合以带 ctrlKey 的 wheel 事件送达, deltaY 约为 `-100 × ln(缩放比例)`。
 */
export function isPreciseWheel(event: WheelEvent): boolean {
  const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (legacy) return legacy === -3 * event.deltaY;
  return event.deltaMode === 0 && !Number.isInteger(event.deltaY);
}

/** 捏合手势一次事件对应的缩放倍率 (连续、可叠乘)。 */
export function pinchZoomFactor(deltaY: number): number {
  return Math.exp(-Math.max(-50, Math.min(50, deltaY)) / 100);
}

/** 一次触控板手势结束的判定: 这么久没有新的滚轮事件 (含惯性) 就算新手势。 */
export const WHEEL_GESTURE_GAP_MS = 220;
