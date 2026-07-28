/**
 * loginKeyboardAvoidance —— 登录键盘避让纯判定引擎(PR4b Step 5b.1,方案 B:
 * 不动全局 soft-input 配置;纯数据/纯函数,零 react-native,node vitest 直接校验)。
 *
 * 契约权威链(照抄,禁止目测):
 *  - U-8b 硬标准(用户原话,2026-07-20):任何键盘形态弹起时,当前输入框 + 主按钮
 *    (继续/登录)必须完整可见;
 *  - 停靠键盘 = 10px 贴附:shift = max(0, panelBottomY + 10 - keyboardTopY)
 *    (demo mobileKeyboard() KB_GAP=10 同式);
 *  - iOS 悬浮/分离键盘 = 键盘矩形与「当前输入框 ∪ 主按钮」union 矩形二维相交判定,
 *    仅相交时按纵向遮挡量上移、不遮挡不动;
 *  - Android 悬浮键盘 = U-11 裁决选项 B(2026-07-20)显式例外:不触发自定义上移,
 *    adjustResize 系统行为保底 + 用户可拖键盘避让(RN Android adjustResize 下
 *    endCoordinates 的 x/width 是 visible frame 而非浮动 IME 真实矩形,JS 层拿不到
 *    真实矩形;native WindowInsets helper 不实施);
 *  - shift 设 safe-top 上限:不得把输入框顶出屏幕顶部安全区;极端矮视口放不下时
 *    回退手机窄窗弹性规则(面板优先,clamped-fallback 模式,不无限上移);
 *  - Android 停靠键盘顶判定(用户 2026-07-21 再拍板:四形态含 Android 必须完整露出
 *    主按钮;原 U-8b Android 依赖 adjustResize 缩窗保底在 edge-to-edge insets 模式下
 *    不缩窗 → screenY 退化为 viewportHeight 误判无遮挡,按钮被截):screenY
 *    (= getWindowVisibleDisplayFrame.bottom)在缩窗(全高 > 当前 viewport)时 = 缩窗后
 *    viewport 底 = 真实键盘顶(可靠);未缩窗(edge-to-edge insets / adjustPan)→ 改用
 *    「全高 - 键盘高 - 系统栏底」兜底(height / safe-area 可靠,edge-to-edge 下 = 真实
 *    键盘顶)。iOS 停靠 = min(screenY, viewport)(screenY 可靠)。基线由未变换测量
 *    wrapper 重测,位移只计一次(无系统/自定义双算)。
 */

/** 窗口坐标系矩形(物理 px;键盘 = endCoordinates,控件 = 未变换基线换算)。 */
export interface LoginKeyboardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 停靠键盘判定阈值:键盘宽 ≥ viewport 宽 × 0.95 视为停靠(悬浮/分离键盘显著更窄)。 */
export const DOCKED_KEYBOARD_WIDTH_RATIO = 0.95;
/** 停靠键盘与面板底的固定间隙(Step 5b.1 拍板,demo KB_GAP 同值)。 */
export const LOGIN_KEYBOARD_PANEL_GAP = 10;
/** Android 缩窗检测阈值:全高 - 当前 viewport 超过此值视为 adjustResize 已缩窗(px)。 */
export const LOGIN_KEYBOARD_RESIZE_THRESHOLD = 10;

export type LoginKeyboardShiftMode =
  /** 键盘不可见/无矩形:不动 */
  | 'hidden'
  /** 停靠键盘:10px 贴附 */
  | 'docked'
  /** iOS 悬浮/分离键盘,与控件 union 二维不相交:不动 */
  | 'floating-clear'
  /** iOS 悬浮/分离键盘,与控件 union 相交:按纵向遮挡量上移 */
  | 'floating-overlap'
  /** Android 悬浮键盘:U-11=B 显式例外,不自定义上移(合法口径,非 GAP) */
  | 'android-floating-exception'
  /** 需求位移超过 safe-top 上限:钳到上限并回退窄窗弹性规则(面板优先) */
  | 'clamped-fallback';

export interface LoginKeyboardShiftInput {
  platform: 'ios' | 'android';
  /** 键盘可见性(hook 层 show/hide 事件驱动) */
  visible: boolean;
  /** 键盘矩形(endCoordinates;窗口坐标) */
  keyboard: LoginKeyboardRect | null;
  /** 未变换基线:面板底 y(物理 px;停靠贴附锚) */
  panelBottomY: number;
  /** 未变换基线:「当前输入框 ∪ 主按钮」union 矩形(悬浮相交判定锚) */
  controlsUnion: LoginKeyboardRect;
  viewportWidth: number;
  viewportHeight: number;
  /** 顶部安全区下边界(shift 上限锚:union 顶不得越过) */
  safeTop: number;
  /**
   * 全高 = 键盘未显示时的 viewportHeight(page 跟踪 max;Android 未缩窗兜底锚)。
   * iOS 不缩窗 = viewportHeight;Android edge-to-edge + adjustResize 可能不缩窗,
   * 需独立全高以算「全高 - 键盘高 - 系统栏底」。
   */
  fullViewportHeight: number;
  /** 系统栏底 inset(nav bar;Android 未缩窗兜底要减去,edge-to-edge 下补回 ime 的系统栏部分)。 */
  systemBarBottom: number;
}

export interface LoginKeyboardShiftResult {
  /** 自定义 translate 位移量(物理 px,向上为正;唯一位移源) */
  shift: number;
  mode: LoginKeyboardShiftMode;
}

/** 二维相交(严格重叠;贴边不算遮挡)。 */
export function rectsIntersect(a: LoginKeyboardRect, b: LoginKeyboardRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** 键盘形态判定:宽 ≈ viewport = 停靠(双端);显著更窄 = 悬浮/分离。 */
export function isDockedKeyboard(
  keyboard: LoginKeyboardRect,
  viewportWidth: number,
): boolean {
  return keyboard.width >= viewportWidth * DOCKED_KEYBOARD_WIDTH_RATIO;
}

/**
 * 停靠键盘顶 Y(窗口坐标;U-8b 10px 贴附锚 = panelBottomY + 10 - keyboardTop)。
 *
 * Android screenY(= endCoordinates.screenY = getWindowVisibleDisplayFrame.bottom)
 * 在 adjustResize 缩窗时 = 缩窗后 viewport 底 = 真实键盘顶(可靠);但 edge-to-edge
 * insets 模式 / adjustPan 下系统不缩窗 → screenY 退化为 viewportHeight(误判无遮挡,
 * required ≤ 0 → 不位移 → 主按钮被键盘截,U-8b 违反;用户 2026-07-21 拍板四形态含
 * Android 必须完整露出)。用「全高 - 当前 viewport」检测缩窗:
 *  - 缩窗 → screenY 可靠,取 min(screenY, viewport);
 *  - 未缩窗 → 用「全高 - 键盘高 - 系统栏底」兜底(keyboard.height = ime - bar 可靠,
 *    edge-to-edge 下 + systemBarBottom 补回 ime 的系统栏部分 = 真实键盘顶)。
 *
 * iOS screenY(keyboardWillShow endCoordinates.screenY)始终可靠,取 min(screenY, viewport)。
 */
function computeDockedKeyboardTop(
  input: LoginKeyboardShiftInput,
  keyboard: LoginKeyboardRect,
): number {
  const screenYTop = Math.min(keyboard.y, input.viewportHeight);
  if (input.platform === 'android') {
    const viewportShrunk =
      input.fullViewportHeight - input.viewportHeight >
      LOGIN_KEYBOARD_RESIZE_THRESHOLD;
    if (!viewportShrunk) {
      // 未缩窗(edge-to-edge insets / adjustPan):screenY 不可靠,改 height 兜底
      return Math.max(
        0,
        input.fullViewportHeight - keyboard.height - input.systemBarBottom,
      );
    }
  }
  return screenYTop;
}

/**
 * 键盘避让判定(U-8b 可执行形式)。输入全部来自「未变换测量 wrapper」基线与
 * endCoordinates,输出位移交给内层 translate 容器——测量与位移分层,杜绝
 * 测到已位移值的抖动(v5 冻结拓扑)。
 */
export function computeLoginKeyboardShift(
  input: LoginKeyboardShiftInput,
): LoginKeyboardShiftResult {
  const { keyboard, visible, controlsUnion } = input;
  if (!visible || keyboard == null || keyboard.height <= 0) {
    return { shift: 0, mode: 'hidden' };
  }
  // safe-top 上限:union 顶(基线)最多上移到安全区下边界
  const maxShift = Math.max(0, controlsUnion.y - input.safeTop);
  if (isDockedKeyboard(keyboard, input.viewportWidth)) {
    const keyboardTop = computeDockedKeyboardTop(input, keyboard);
    const required = Math.max(
      0,
      input.panelBottomY + LOGIN_KEYBOARD_PANEL_GAP - keyboardTop,
    );
    if (required > maxShift) return { shift: maxShift, mode: 'clamped-fallback' };
    return { shift: required, mode: 'docked' };
  }
  if (input.platform === 'android') {
    // U-11 裁决 B:Android 悬浮键盘例外——系统 adjustResize 保底,不自定义上移
    return { shift: 0, mode: 'android-floating-exception' };
  }
  if (!rectsIntersect(keyboard, controlsUnion)) {
    return { shift: 0, mode: 'floating-clear' };
  }
  // 纵向遮挡量 = union 底越过键盘顶的深度;横向不相交已在上方排除
  const required = Math.max(
    0,
    controlsUnion.y + controlsUnion.height - keyboard.y,
  );
  if (required > maxShift) return { shift: maxShift, mode: 'clamped-fallback' };
  return { shift: required, mode: 'floating-overlap' };
}

/**
 * U-8b 验收断言辅助(测试用):shift 应用后「当前输入框 + 主按钮」是否完整可见——
 * union 顶不越顶部安全区、底不被键盘遮挡(停靠 = 位于键盘顶上方;悬浮 = 与键盘
 * 矩形二维不相交)。clamped-fallback 模式按定义不满足本断言(回退窄窗弹性规则)。
 */
export function controlsFullyVisibleAfterShift(
  input: LoginKeyboardShiftInput,
  result: LoginKeyboardShiftResult,
): boolean {
  const shifted: LoginKeyboardRect = {
    ...input.controlsUnion,
    y: input.controlsUnion.y - result.shift,
  };
  if (shifted.y < input.safeTop) return false;
  const keyboard = input.keyboard;
  if (!input.visible || keyboard == null || keyboard.height <= 0) return true;
  if (isDockedKeyboard(keyboard, input.viewportWidth)) {
    const keyboardTop = computeDockedKeyboardTop(input, keyboard);
    return shifted.y + shifted.height <= keyboardTop;
  }
  return !rectsIntersect(keyboard, shifted);
}
