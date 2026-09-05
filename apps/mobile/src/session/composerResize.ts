/**
 * Composer 输入区「拖拽调高」的纯函数模型。
 *
 * 高度模型有两种模式：
 * - auto：现状行为——输入区高度跟随内容自动增长，到 autoMaxContentHeight 封顶后内部滚动。
 * - manual：用户拖动 grabber 之后——输入区高度固定为用户拖出的值（clamp 进边界），
 *   内容超出可视高度时内部滚动；把 grabber 拖回单行高度附近即恢复 auto。
 *
 * 所有高度都用「输入区内容高度」语义（与页面 onContentSizeChange 上报的 state 同一坐标系），
 * 不含 composer 外围 chrome。渲染层需要的 input 可视高度 = 内容高度 + 输入框上下 padding。
 */

export interface ComposerResizeBounds {
  /** manual 模式允许拖到的最小内容高度（单行）。 */
  minContentHeight: number;
  /** manual 模式允许拖到的最大内容高度（受屏幕 / 键盘可用空间约束）。 */
  maxContentHeight: number;
}

export type ComposerResizeMode = 'auto' | 'manual';

export interface ComposerInputHeightModel {
  mode: ComposerResizeMode;
  /** 输入区当前应呈现的内容高度。 */
  visibleContentHeight: number;
  /**
   * TextInput 内部滚动开关。激活卡片态(collapsed !== true)下**恒为 true**:
   * 早先按「contentHeight > 可视高度」动态开关,但 contentHeight 依赖原生
   * onContentSizeChange 上报,RN 新架构下该回调有漏报历史(fb/react-native#52854
   * 一类),漏一拍开关就停在 false——输入超过上限后既不跟随光标也无法手动滚动,
   * 用户看不到自己正在输入的文本。原生 UITextView / EditText 在内容未超出时
   * 本就滚不动、不抢手势,常开没有交互代价,还能让超限瞬间的光标跟随由原生层
   * 直接兜底,不再经过「测量 → setState → 重渲染」链路。
   * 简洁态(collapsed)维持测量判定:多行草稿钉在单行时才需要滚,误差只影响
   * 收起态的次要浏览场景。
   */
  scrollEnabled: boolean;
}

/**
 * 松手时距单行高度小于该阈值则吸附回 auto 模式（并由页面退出激活态）。
 * 取约一行行高：用户把输入框拖到「看起来只剩一行」的手感误差在一行以内，
 * 窗口太小（如 12px）会导致视觉上到底了却没触发吸附。
 */
export const COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD = 24;

/** manual 模式上边界之上保留的屏幕空间（顶部导航 + 至少一部分消息内容可见）。 */
export const COMPOSER_RESIZE_TOP_RESERVED_HEIGHT = 220;

export interface ResolveComposerInputHeightInput {
  /** TextInput 上报的内容高度（页面 state）。 */
  contentHeight: number;
  /** 用户拖出的内容高度；null 表示 auto 模式。 */
  userContentHeight: number | null;
  /** auto 模式的内容高度上限（页面既有的 max 计算结果）。 */
  autoMaxContentHeight: number;
  /**
   * 简洁态（非激活卡片态）时置 true：输入框一律收到单行——不管是下拉收起
   * 还是点别处收键盘，退出激活态的结果一致。auto / manual 记忆不丢，
   * 重新聚焦（置回 false）后恢复原高度。
   */
  collapsed?: boolean;
  bounds: ComposerResizeBounds;
}

export function resolveComposerInputHeight(
  input: ResolveComposerInputHeightInput,
): ComposerInputHeightModel {
  const bounds = normalizeBounds(input.bounds);
  const mode: ComposerResizeMode = input.userContentHeight === null ? 'auto' : 'manual';
  if (input.collapsed === true) {
    return {
      mode,
      visibleContentHeight: bounds.minContentHeight,
      scrollEnabled: input.contentHeight > bounds.minContentHeight,
    };
  }
  if (input.userContentHeight === null) {
    const autoMax = Math.max(bounds.minContentHeight, input.autoMaxContentHeight);
    return {
      mode,
      visibleContentHeight: clamp(input.contentHeight, bounds.minContentHeight, autoMax),
      // 激活态常开,不依赖 contentHeight 测量(见 ComposerInputHeightModel.scrollEnabled 注释)。
      scrollEnabled: true,
    };
  }
  const visibleContentHeight = clamp(
    input.userContentHeight,
    bounds.minContentHeight,
    bounds.maxContentHeight,
  );
  return {
    mode,
    visibleContentHeight,
    // manual 定高同理常开:内容超过钉住高度时必须能滚,不能赌测量回调不漏拍;
    // 高度 > 内容时 UITextView/EditText 不会主动滚动、不抢外层手势,无交互代价
    // (同 ComposerInputHeightModel.scrollEnabled 注释说明)。
    scrollEnabled: true,
  };
}

export interface ApplyComposerResizeDragInput {
  /** 手势开始时输入区的内容高度。 */
  startContentHeight: number;
  /** 手势累计位移；grabber 在输入区顶部，向上拖（负值）= 变大。 */
  translationY: number;
  bounds: ComposerResizeBounds;
}

export function applyComposerResizeDrag(input: ApplyComposerResizeDragInput): number {
  'worklet';
  const bounds = normalizeBounds(input.bounds);
  return clamp(
    Math.round(input.startContentHeight - input.translationY),
    bounds.minContentHeight,
    bounds.maxContentHeight,
  );
}

export interface SettleComposerResizeDragInput {
  /** 松手时的拖拽内容高度（applyComposerResizeDrag 的结果）。 */
  draggedContentHeight: number;
  /** TextInput 当前实际内容高度。 */
  contentHeight: number;
  bounds: ComposerResizeBounds;
}

/**
 * 松手结算：
 * - 中段松手 → 记住 manual 内容高度；
 * - 拖到底（单行吸附区）且内容只有一行 → 返回 null 恢复 auto；
 * - 拖到底但内容多行 → manual 钉在单行（内容内部滚动）。此时
 *   shouldDismissComposerOnRelease 同时触发收键盘；钉住单行保证收起后的
 *   简洁态不会按 auto 弹回完整内容高度——「拖小再收起」的结果永远不比
 *   拖到的大小更大。
 */
export function settleComposerResizeDrag(input: SettleComposerResizeDragInput): number | null {
  const bounds = normalizeBounds(input.bounds);
  const settled = clamp(
    Math.round(input.draggedContentHeight),
    bounds.minContentHeight,
    bounds.maxContentHeight,
  );
  if (settled > bounds.minContentHeight + COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD) return settled;
  if (input.contentHeight <= bounds.minContentHeight + COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD) return null;
  return bounds.minContentHeight;
}

/** 松手时手势向下位移达到该值即可触发「下拉收起」（配合高度处于单行吸附区）。 */
export const COMPOSER_RESIZE_DISMISS_PULL_THRESHOLD = 24;

export interface ShouldDismissComposerOnReleaseInput {
  /** 松手时的拖拽内容高度（applyComposerResizeDrag 的结果）。 */
  draggedContentHeight: number;
  /** 手势累计位移，向下为正。 */
  translationY: number;
  bounds: ComposerResizeBounds;
}

/**
 * 松手时是否应视为「下拉收起」手势（页面借此让输入框 blur、退出激活态）。
 *
 * 判定不依赖高度变化量：输入框本来就只有一行时向下拖，高度被 clamp 在单行
 * 纹丝不动，但手势位移是真实的——只要向下拉了一段且松手高度落在单行吸附区，
 * 就是「想收起」。从大高度拖回单行松手同样命中本判定；内容多行时输入框
 * 虽收不到一行以下，但键盘必须能这样收起。
 */
export function shouldDismissComposerOnRelease(
  input: ShouldDismissComposerOnReleaseInput,
): boolean {
  const bounds = normalizeBounds(input.bounds);
  return input.translationY >= COMPOSER_RESIZE_DISMISS_PULL_THRESHOLD
    && input.draggedContentHeight <= bounds.minContentHeight + COMPOSER_RESIZE_AUTO_SNAP_THRESHOLD;
}

/** 手势位移小于该值视为轻点而非拖动，不认领手势、不改变高度模式。 */
export const COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD = 3;

/** PanResponder 手势判定用到的位移子集（与 RN GestureState 结构兼容）。 */
export interface ComposerResizeGestureTranslation {
  dx: number;
  dy: number;
}

/**
 * grabber 是否应认领当前手势：竖直位移出阈值且竖直分量占优。
 * 水平滑动留给外层容器，轻点（位移不足）穿透给下层。
 */
export function shouldClaimComposerResizeDrag(
  gesture: ComposerResizeGestureTranslation,
): boolean {
  return Math.abs(gesture.dy) > COMPOSER_RESIZE_DRAG_ACTIVATION_THRESHOLD
    && Math.abs(gesture.dy) > Math.abs(gesture.dx);
}

export interface ComposerResizeGestureCallbacks {
  /** 认领手势成功（开始拖动）。 */
  onGrant: () => void;
  /** 拖动位移更新，translationY 向下为正。 */
  onMove: (translationY: number) => void;
  /** 手势结束（松手或被强制终止），做高度结算。 */
  onEnd: (translationY: number) => void;
}

/**
 * 构造 grabber 的 PanResponder 配置（纯函数，便于单测锁行为）。
 *
 * 关键约束——grabber 可能挂在 ScrollView 内（会话页 composer 外壳）：
 * - **touch-down 即认领 responder**（onStartShouldSetPanResponder = true）。
 *   外壳 ScrollView 带 keyboardShouldPersistTaps="handled"：键盘弹出
 *   （有聚焦的 TextInput）时，它会在 touch-start 的 bubble 阶段抢下任何
 *   「目标不是聚焦输入框」的触摸（RN ScrollResponder 的收键盘逻辑），
 *   之后 grabber 的 move 认领永远不会被询问——表现为键盘弹出时拖拽
 *   完全无响应、松手偶尔还触发 blur 把整个输入框收掉。bubble 阶段触摸
 *   目标最先被询问，grabber 起点认领即可截断这条抢占链。grabber 是
 *   88x20 的专用把手、轻点本无任何操作，起点认领没有交互损失。
 * - 竖直拖动同时在 move-capture 阶段认领（多一道保险），水平滑动留给外层；
 * - 认领后拒绝 termination request：PanResponder 默认让出，父级 ScrollView
 *   中途请求接管会让调高中断变成滚动。Android 原生容器仍可能强制 terminate，
 *   由 onPanResponderTerminate 结算保底。
 */
export function buildComposerResizeGestureConfig(callbacks: ComposerResizeGestureCallbacks) {
  return {
    onMoveShouldSetPanResponder: (_event: unknown, gesture: ComposerResizeGestureTranslation) =>
      shouldClaimComposerResizeDrag(gesture),
    onMoveShouldSetPanResponderCapture: (_event: unknown, gesture: ComposerResizeGestureTranslation) =>
      shouldClaimComposerResizeDrag(gesture),
    onPanResponderGrant: () => callbacks.onGrant(),
    onPanResponderMove: (_event: unknown, gesture: ComposerResizeGestureTranslation) =>
      callbacks.onMove(gesture.dy),
    onPanResponderRelease: (_event: unknown, gesture: ComposerResizeGestureTranslation) =>
      callbacks.onEnd(gesture.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: (_event: unknown, gesture: ComposerResizeGestureTranslation) =>
      callbacks.onEnd(gesture.dy),
    onStartShouldSetPanResponder: () => true,
  };
}

/**
 * 构造 grabber 的原生触摸监听（纯函数，便于单测锁行为）。
 *
 * 为什么需要它：会话页 composer 外壳是 ScrollView，且键盘弹出时
 * scrollEnabled 为 true（mobileNativeShellLayout 的既有语义）。RN 竖直
 * ScrollView 默认 alwaysBounceVertical，内容不满一屏也会 rubber-band 跟手,
 * 原生手势会直接抢走 grabber 的竖直拖动（新架构下 JS responder 的
 * blockNativeResponder 拦不住），表现为「拖 grabber 变成拖输入框位置」。
 * 唯一可靠的做法是确定性关闸：touch-down 落在 grabber 上就通过
 * onActiveChange(true) 让页面把外壳 ScrollView 的 scrollEnabled 关掉,
 * 原生滚动识别从源头不启动；抬手 / 触摸被取消时恢复。
 */
export function buildComposerResizeTouchHandlers(onActiveChange: (active: boolean) => void) {
  return {
    onTouchCancel: () => onActiveChange(false),
    onTouchEnd: () => onActiveChange(false),
    onTouchStart: () => onActiveChange(true),
  };
}

export interface ComputeComposerResizeBoundsInput {
  /** 窗口高度（useWindowDimensions().height）。 */
  windowHeight: number;
  /** 键盘可见高度；键盘收起时传 0。 */
  keyboardHeight: number;
  /** 单行内容高度（下边界）。 */
  singleLineContentHeight: number;
  /** auto 模式上限；manual 上边界不低于它，保证拖拽总能达到 auto 能达到的高度。 */
  autoMaxContentHeight: number;
  /** composer 除输入区之外占用的高度（水平 padding、工具行等）。 */
  composerChromeHeight: number;
}

/**
 * 计算 manual 模式的拖拽边界：上限 = 键盘上方可用空间减去顶部保留区与 composer chrome，
 * 且不低于 auto 上限（保证 manual 总是 auto 的超集）。
 */
export function computeComposerResizeBounds(
  input: ComputeComposerResizeBoundsInput,
): ComposerResizeBounds {
  const windowHeight = normalizePositiveDimension(input.windowHeight, 812);
  const keyboardHeight = normalizeNonNegativeDimension(input.keyboardHeight, 0);
  const singleLine = Math.max(1, Math.round(input.singleLineContentHeight));
  const available = windowHeight
    - keyboardHeight
    - COMPOSER_RESIZE_TOP_RESERVED_HEIGHT
    - Math.max(0, input.composerChromeHeight);
  const maxContentHeight = Math.max(
    singleLine,
    Math.round(input.autoMaxContentHeight),
    Math.round(available),
  );
  return {
    minContentHeight: singleLine,
    maxContentHeight,
  };
}

function normalizeBounds(bounds: ComposerResizeBounds): ComposerResizeBounds {
  'worklet';
  const minContentHeight = Math.max(1, Math.round(bounds.minContentHeight));
  return {
    minContentHeight,
    maxContentHeight: Math.max(minContentHeight, Math.round(bounds.maxContentHeight)),
  };
}

function normalizePositiveDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(Math.max(value, min), max);
}
