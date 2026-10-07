/**
 * 手机端输入框的 Android 键盘避让判定（纯函数，零 react-native 依赖，可直接 node vitest）。
 *
 * 契约权威链（与 `auth/loginKeyboardAvoidance.ts` 一致，禁止目测）：
 * - Android edge-to-edge（targetSdk 35+）下 `windowSoftInputMode=adjustResize` 不再缩窗，
 *   只依赖系统缩窗的输入框会被键盘整块盖住；RN 的 `KeyboardAvoidingView` 在 Android 上
 *   同样拿不到可靠位移（见 `ComposerKeyboardAvoidingView` 的既有口径）。所以这里按
 *   「键盘高 − 外层已扣的底部 inset − 系统已缩的窗口高」显式留白。
 * - 老系统 / 未开 edge-to-edge 时系统仍会缩窗，此时必须扣掉已缩的部分，否则系统与自定义
 *   双算，输入框会被顶到键盘上方留出一段空白。
 * - 位移只计一次：外层 SafeAreaView 已经扣掉的底部 inset 不在这里重复计算。
 */

/**
 * 系统缩窗检测阈值（px）。全高与当前高的差小于它视为「系统没缩窗」，避免键盘动画过程中
 * 的亚像素抖动被误判成缩窗而产生跳一下的空白。
 */
export const ANDROID_VIEWPORT_RESIZE_THRESHOLD = 10;

export interface AndroidComposerKeyboardPaddingInput {
  /** IME 高度（px）；键盘不可见时为 0。 */
  keyboardHeight: number;
  /** 外层 SafeAreaView 已经扣掉的底部 inset（px）。 */
  bottomInset: number;
  /** 键盘未显示时的窗口高度（px）。 */
  restingWindowHeight: number;
  /** 当前窗口高度（px），键盘弹出后实时变化。 */
  windowHeight: number;
}

function positive(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 系统替我们缩掉的窗口高度（px）；未缩窗（或只有亚像素抖动）时为 0。 */
export function androidViewportShrink(
  input: Pick<AndroidComposerKeyboardPaddingInput, 'restingWindowHeight' | 'windowHeight'>,
): number {
  // 当前窗口高未知（0 / NaN；RN 在 Android 启动、旋转或部分厂商 ROM 上会瞬时上报）时
  // 不参与减法：未知值会把「系统已缩满窗」算成真，让位被整个吃掉——正好倒向重现原始
  // 遮挡的那一侧。未知即按「系统没缩窗」处理，照常全额让位。
  const windowHeight = input.windowHeight;
  if (typeof windowHeight !== 'number' || !Number.isFinite(windowHeight) || windowHeight <= 0) return 0;
  const shrink = positive(input.restingWindowHeight) - windowHeight;
  return shrink > ANDROID_VIEWPORT_RESIZE_THRESHOLD ? shrink : 0;
}

/**
 * 输入框容器在键盘弹起时需要额外让出的底部高度（px）。
 *
 * 键盘不可见时恒为 0；键盘可见时为「键盘高 − 外层已扣的底部 inset − 系统已缩的窗口高」，
 * 并夹到 0 以上，保证结果永远是把输入框往上推，不会反向把它压进键盘里。
 */
export function androidComposerKeyboardBottomPadding(
  input: AndroidComposerKeyboardPaddingInput,
): number {
  const keyboardHeight = positive(input.keyboardHeight);
  if (keyboardHeight === 0) return 0;
  return Math.max(
    0,
    keyboardHeight - positive(input.bottomInset) - androidViewportShrink(input),
  );
}