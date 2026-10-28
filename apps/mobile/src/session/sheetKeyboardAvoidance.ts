/**
 * sheetKeyboardAvoidance —— 底部浮窗（SheetModal）在 Android 上需要为软键盘让出的高度。
 *
 * 背景：iOS 的浮窗用 KeyboardAvoidingView(padding) 避让；Android 长期依赖
 * windowSoftInputMode=adjustResize 由系统缩窗，SheetModal 因此不套 KAV（#429：KAV 与
 * adjustResize 对同一个键盘各调一次高度，在 Modal 里形成每帧 relayout 的闪烁）。但
 * edge-to-edge（Android 15+ targetSdk 35、Android 16 强制）下系统不再为 IME 缩窗
 * （同一结论见 auth/loginKeyboardAvoidance.ts 的 U-8b / 2026-07-21 记录），浮窗就停在窗口
 * 底部被键盘盖住——伙伴设置页的「简介 / 性格」多行输入框正是这样被遮住的。
 *
 * 这里只补「系统没有让出的那部分」：
 *  - 键盘整体高度 = endCoordinates.height + 系统栏底（RN 已从 height 里扣掉导航栏）；
 *  - 系统已让出的高度取两条实测证据的较大者：键盘事件的 screenY（窗口可见区底边，缩窗时
 *    = 键盘顶边、未缩窗时 = 窗口底边）与浮窗内容区自己缩掉的高度（浮窗在键盘弹起前见过的
 *    最大高度 - 当前高度，Modal 自己的窗口，onLayout 实测）。
 * 两条取大：键盘事件可能来自另一个 window root（activity / modal 各有一份），也可能浮窗
 * 是在键盘已弹起后才打开，单看一条会把「系统已让出」误判成 0 而重复避让。调用方必须让
 * 内容区基线跟随正常的窗口变化（旋转 / 分屏 / 折叠）：旧的大高度会被当成系统缩窗，把让位
 * 整个吃掉。
 *
 * 缩窗设备上结果恒为 0，不会与 adjustResize 叠加。单位统一为 dp / 屏幕坐标（与
 * endCoordinates、Dimensions.get('screen') 一致）。
 */
export interface AndroidSheetKeyboardLiftInput {
  /** endCoordinates.height：IME 高度（RN 已减去系统栏底）。 */
  imeHeight: number;
  /** 系统栏底 inset：补回 RN 从 imeHeight 中扣掉的导航栏高度。 */
  systemBarBottom: number;
  /**
   * 浮窗窗口内容区当前高度：Modal 内铺满窗口、不受本次 padding 影响的探针 onLayout 实测。
   * 键盘事件里的 screenY / Dimensions 在部分 ROM（MIUI）上会随键盘变化但窗口并未让出空间，
   * 不能作为「系统已避让」的证据。
   */
  contentHeight: number;
  /** 同一探针在键盘弹起前见过的最大高度（按窗口尺寸分组，旋转/分屏后作废）。 */
  baselineContentHeight: number;
}

/** 大于它的缩窗才算系统真的让过位；更小的差值按亚像素抖动处理。 */
export const ANDROID_SHEET_KEYBOARD_RESIZE_THRESHOLD = 10;

function nonNegative(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 浮窗需要让给键盘的高度；0 表示系统已经处理完，不要重复避让。 */
export function computeAndroidSheetKeyboardLift(
  input: AndroidSheetKeyboardLiftInput,
): number {
  // 先要求 IME 真的可见:否则只看系统栏底会在键盘收起后仍返回 24~48dp,把纯动作浮窗顶起来。
  const imeHeight = nonNegative(input.imeHeight);
  if (imeHeight <= 0) return 0;
  const imeFullHeight = imeHeight + nonNegative(input.systemBarBottom);
  const shrink = (Number.isFinite(input.baselineContentHeight) ? input.baselineContentHeight : 0)
    - (Number.isFinite(input.contentHeight) ? input.contentHeight : 0);
  if (!(shrink > ANDROID_SHEET_KEYBOARD_RESIZE_THRESHOLD)) return Math.round(imeFullHeight);
  return Math.max(0, Math.round(imeFullHeight - shrink));
}
