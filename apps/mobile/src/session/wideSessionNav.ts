/**
 * wideSessionNav —— 会话页宽屏导航模式的断点判定(纯函数,便于单测)。
 *
 * 宽屏(iPad 双向 / 折叠屏展开内屏 / 横屏手机)下会话页左上角不再是「返回」,
 * 而是三条杠(Menu):点击拉出任务列表抽屉,原地切换任务,不来回压导航栈。
 *
 * 断点口径与仓内另外两套是三种不同语义,不合并:
 * - `responsiveViewportLayout.wideViewport`(>=700 或 landscape)管的是**内容可读宽度**,
 *   小手机横屏也要限宽,所以 landscape 一律算宽;
 * - `loginSkinLayout`(1000×690 / 700)管的是登录页立绘皮肤的三态;
 * - 本文件管的是**导航形态**:600dp 取 Material 3 的 medium 窗口档,恰好覆盖
 *   iPad 竖屏(768+)、主流折叠屏展开内屏(约 600-680dp,竖持也 >=600)与横屏手机
 *   (>=640),同时排除所有竖屏直板手机(<=约 440)与 iPad 窄分屏(~320,此时回退
 *   返回键模式是正确行为)。不额外要求 landscape:折叠屏内屏竖持宽度已达标,
 *   要求横向反而把它漏掉。
 *
 * 发布策略按平台分闸(2026-08-02 用户定稿):
 * - Android:纯宽度闸——折叠屏展开 / 平板 / 横屏大屏机都启用;
 * - iOS:仅 iPad(iosPad)启用;iPhone 即使横屏达宽也**不发**,保持返回键
 *   (评审风险面最小,后续要放开 iPhone 横屏只改这一处)。
 */

export const WIDE_SESSION_NAV_MIN_WIDTH = 600;

const DRAWER_MIN_WIDTH = 300;
const DRAWER_MAX_WIDTH = 360;
const DRAWER_WIDTH_RATIO = 0.4;

export interface WideSessionNavLayoutInput {
  windowWidth?: number;
  windowHeight?: number;
  /** Platform.OS。iOS 有 iPad 专属闸;其余平台(android/web)纯宽度闸。 */
  platform?: string;
  /** iOS 下是否 iPad(Platform.isPad)。iPhone 恒 false → 宽屏形态不启用。 */
  iosPad?: boolean;
}

export interface WideSessionNavLayout {
  /** true = 会话页用三条杠 + 任务列表抽屉;false = 传统返回键。 */
  enabled: boolean;
  /** 抽屉面板宽度(enabled 为 false 时给 0,调用方不消费)。 */
  drawerWidth: number;
}

export function buildWideSessionNavLayout(
  input: WideSessionNavLayoutInput,
): WideSessionNavLayout {
  const windowWidth = normalizeDimension(input.windowWidth);
  // iOS 只对 iPad 发宽屏形态;iPhone(含横屏)按发布策略回退返回键。
  const platformAllowed = input.platform !== 'ios' || input.iosPad === true;
  const enabled = platformAllowed && windowWidth >= WIDE_SESSION_NAV_MIN_WIDTH;
  if (!enabled) return { drawerWidth: 0, enabled };
  const drawerWidth = clamp(
    Math.round(windowWidth * DRAWER_WIDTH_RATIO),
    DRAWER_MIN_WIDTH,
    DRAWER_MAX_WIDTH,
  );
  return { drawerWidth, enabled };
}

function normalizeDimension(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
