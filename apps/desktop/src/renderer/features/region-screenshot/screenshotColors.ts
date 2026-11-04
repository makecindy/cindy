/**
 * 截图浮层与贴图里不随主题变化的颜色 (DESIGN.md §2「Screenshot overlay and annotation ink」)。
 *
 * - SCREENSHOT_INK: 标注墨水, 烧录进用户截图的内容像素, 不是界面配色 (红色即
 *   annotation-accent 的值)。
 * - SCREENSHOT_OVERLAY: 覆盖在任意屏幕内容上的功能像素 —— 暗化遮罩、选区白描边与暗色
 *   外圈、放大镜十字线、定格画面底色。它们要在任何底色上都看得清, 两种模式同值。
 *
 * 界面 chrome (工具条、放大镜外框与文字、尺寸标签、贴图描边) 一律走主题 token, 不放在这里。
 */
export const SCREENSHOT_INK = {
  red: '#FF3B30',
  yellow: '#FFCC00',
  green: '#34C759',
  blue: '#007AFF',
  black: '#000000',
  white: '#FFFFFF',
} as const;

export type ScreenshotInk = keyof typeof SCREENSHOT_INK;

export const SCREENSHOT_OVERLAY = {
  backdrop: '#000000',
  shade: 'rgba(0, 0, 0, 0.45)',
  edge: '#FFFFFF',
  edgeOuter: 'rgba(0, 0, 0, 0.6)',
  crosshair: 'rgba(0, 0, 0, 0.35)',
} as const;
