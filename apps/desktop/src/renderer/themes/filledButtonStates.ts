/**
 * 填充按钮的悬停 / 按下由基础色算出，主题不用写状态色（DESIGN.md §4 Filled button states）。
 *
 * 亮度在 OKLCH 里减固定步长，不同色相看起来变化接近。步长取自 Cindy 反相中性按钮的定稿色：
 * 浅色悬停 -0.051 / 按下 -0.091，深色 -0.036 / -0.079。
 * 底色亮度低于 0.25 时已压不出可见差异，改抬到固定灰阶。
 *
 * CSS 没有条件表达式，用 sign 把 `l > 0.25` 变成只取 0 / 1 的开关，阈值两侧不会混合出中间亮度。
 */
function filledButtonState(base: string, step: number, liftTo: number): string {
  const isLight = 'sign(max(0, l - 0.25))';
  return `oklch(from ${base} calc(${isLight} * (l - ${step}) + (1 - ${isLight}) * ${liftTo}) c h)`;
}

export function filledButtonHover(base: string): string {
  return filledButtonState(base, 0.045, 0.27);
}

export function filledButtonPressed(base: string): string {
  return filledButtonState(base, 0.085, 0.355);
}

/**
 * 主题显式给了悬停色时，按下沿「底色到悬停」的方向再走一步，步长是规则里悬停到按下的差值。
 * 不把悬停色当新底色套用阈值：接近黑色的悬停色会被抬亮，又变成悬停变暗、按下变亮。
 */
export function filledButtonPressedFromHover(hover: string, direction: 'darker' | 'lighter'): string {
  return `oklch(from ${hover} calc(l ${direction === 'darker' ? '-' : '+'} 0.04) c h)`;
}
