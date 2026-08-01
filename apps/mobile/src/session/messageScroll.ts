import {
  DEFAULT_NEAR_BOTTOM_THRESHOLD,
  isNearMessageListBottom,
  type MessageScrollMetrics,
} from '@cindy/maker-shared/message-window';
import type {
  MobileMessageRenderItem,
  MobileWorkChildItem,
} from '@/session/messageRenderModel';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';

export {
  DEFAULT_NEAR_BOTTOM_THRESHOLD,
  DEFAULT_LOAD_EARLIER_THRESHOLD,
  buildMessageLoadEarlierAction,
  buildSearchLoadEarlierAction,
  evaluateMessageWindowUpdate,
  isNearMessageListBottom,
  isNearMessageListTop,
  shouldAutoFollowMessages,
  shouldShowNewMessageIndicator,
  type MessageLoadEarlierActionPresentation,
  type MessageScrollMetrics,
  type MessageWindowChangeKind,
  type MessageWindowUpdateDecision,
} from '@cindy/maker-shared/message-window';

export const MOBILE_MESSAGE_LIST_BOTTOM_PADDING = 132;
export const MOBILE_NEAR_BOTTOM_THRESHOLD =
  DEFAULT_NEAR_BOTTOM_THRESHOLD + MOBILE_MESSAGE_LIST_BOTTOM_PADDING;

export function mobileMessageListBottomPadding(bottomOverlayHeight?: number): number {
  if (typeof bottomOverlayHeight !== 'number' || !Number.isFinite(bottomOverlayHeight)) {
    return MOBILE_MESSAGE_LIST_BOTTOM_PADDING;
  }
  return Math.max(MOBILE_MESSAGE_LIST_BOTTOM_PADDING, Math.ceil(bottomOverlayHeight));
}

export function mobileMessageListNearBottomThreshold(bottomOverlayHeight?: number): number {
  return DEFAULT_NEAR_BOTTOM_THRESHOLD + mobileMessageListBottomPadding(bottomOverlayHeight);
}

export function isNearMobileMessageListBottom(
  metrics: MessageScrollMetrics,
  bottomOverlayHeight?: number,
): boolean {
  return isNearMessageListBottom(metrics, mobileMessageListNearBottomThreshold(bottomOverlayHeight));
}

export function mobileMessageListEndOffset(metrics: MessageScrollMetrics): number {
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight);
}

// ── 贴底跟随的解除 / 恢复判定(对齐桌面版 autoFollowIntent 语义)──
// 修复背景(桌面版同源 bug 的手机版变体):近底判定原来是纯距离阈值
// (≥228px),流式期间内容增长会触发 handleContentSize 的 scrollToEnd 与
// LegendList 内置 maintainScrollAtEnd。用户慢速小幅上滑(未超过阈值)松手后,
// 距底仍在阈值带内 → 仍被判「近底」→ 下一帧内容增长又被拽回最底。触摸惯性
// 大多一次就滑出阈值,所以比桌面版难触发,但结构性竞态相同。
// 修复:「解除」看手势意图(拖动中向上位移超过死区,只有用户能产生),
// 「恢复」保留距离判定但要求 scroll 方向明确向下——否则解除后紧跟着的上滑
// scroll 事件(距底仍在阈值带内)会把刚解除的跟随立刻翻回去。

/**
 * 拖动解除跟随的累计位移死区(px)。手指按住不动也有 ±2-3px 抖动,取 8px
 * 与桌面版 touch 意图阈值(TOUCH_HISTORY_INTENT_THRESHOLD_PX)同源;
 * 真实的「上滑一行」轻松超过它,解除仍然是「一滑即停」的体感。
 */
export const MOBILE_FOLLOW_UNPIN_DRAG_DEAD_ZONE = 8;

/**
 * 恢复跟随的单事件方向死区(px)。scroll 事件的 offsetY 是浮点布局值,
 * 1px 内的增量不算「明确向下」。
 */
export const MOBILE_FOLLOW_REPIN_DIRECTION_DEAD_ZONE = 1;

/** 容器「真的可滚」的最小内容富余(px),亚像素圆整内视为不可滚。 */
const MOBILE_FOLLOW_MIN_SCROLLABLE_PX = 1;

export interface MobileFollowUnpinInput {
  /** 当前处于用户拖动手势中(onScrollBeginDrag ~ onScrollEndDrag)。 */
  dragging: boolean;
  /** 本次拖动起点的 contentOffset.y;非拖动期为 null。 */
  dragStartOffsetY: number | null;
  /** 当前滚动 metrics。 */
  metrics: MessageScrollMetrics;
}

/**
 * 用户拖动是否构成「想向上回看、应解除贴底跟随」。
 *
 * 条件(全部满足):
 *  - 处于拖动手势中:拖动期间的 offset 变化只可能由用户产生(原生层在活跃
 *    手势期基本忽略程序化 scrollTo),不会误伤程序化贴底/补偿滚动;
 *  - 相对拖动起点累计向上超过死区:按住不动的抖动不算;
 *  - 内容可滚:未撑满一屏时解除毫无视觉意义,却会在内容长出滚动区后表现为
 *    「不跟了」且无法用「滑回底部」恢复。
 */
export function shouldUnpinMobileFollowOnDrag(input: MobileFollowUnpinInput): boolean {
  if (!input.dragging || input.dragStartOffsetY === null) return false;
  const { contentHeight, offsetY, viewportHeight } = input.metrics;
  if (contentHeight - viewportHeight <= MOBILE_FOLLOW_MIN_SCROLLABLE_PX) return false;
  return offsetY < input.dragStartOffsetY - MOBILE_FOLLOW_UNPIN_DRAG_DEAD_ZONE;
}

export interface MobileNearBottomResolveInput {
  /** scroll 事件前的跟随态(nearBottomRef)。 */
  wasNearBottom: boolean;
  /** 当前滚动 metrics。 */
  metrics: MessageScrollMetrics;
  /** 本次 scroll 事件的 offsetY 增量(正 = 向内容末端)。 */
  scrollDelta: number;
  /** 底部浮层高度(近底阈值随之放大,同 isNearMobileMessageListBottom)。 */
  bottomOverlayHeight?: number;
  /**
   * Whether the event was emitted while an imperative list scroll is settling.
   * Native list implementations can report a transient offset before the
   * commanded end position is applied; that event must not cancel auto-follow.
   */
  programmaticScrollInFlight?: boolean;
}

/**
 * scroll 事件驱动的近底/跟随态迁移(handleScroll 消费)。
 *
 *  - 命令式滚动 settling → 保持原跟随态,不把瞬时 offset 当成用户上翻;
 *  - 内容未撑满一屏 → true(与 isNearMessageListBottom 同口径);
 *  - 距底超出阈值 → false(离底解除,原行为不变);
 *  - 阈值带内且原本在跟 → 保持 true(贴底期间程序化 scrollToEnd 产生的
 *    向下增量、以及被动微小位移都不改变状态);
 *  - 阈值带内且已解除 → 仅「明确向下」(增量 > 死区)才恢复跟随。**不能只看
 *    距离**:拖动解除后同一手势内继续到达的上滑 scroll 事件距底仍在阈值带内,
 *    无方向守卫会立即翻回跟随,解除失效(修复核心)。
 */
export function resolveMobileNearBottomOnScroll(input: MobileNearBottomResolveInput): boolean {
  if (input.programmaticScrollInFlight) return input.wasNearBottom;
  const { contentHeight, viewportHeight } = input.metrics;
  if (contentHeight <= viewportHeight) return true;
  if (!isNearMobileMessageListBottom(input.metrics, input.bottomOverlayHeight)) return false;
  if (input.wasNearBottom) return true;
  return input.scrollDelta > MOBILE_FOLLOW_REPIN_DIRECTION_DEAD_ZONE;
}

// ── 贴底跟随的 contentSize 补滚护栏(振荡断路器)──
// 背景(bug:冷开会话消息区空白 + 无 loading + 返回键无响应,杀 App 才恢复):
// handleContentSize 的「贴底且内容长高 → 命令式 scrollToEnd」补偿,与 LegendList
// 内置 alignItemsAtEnd / maintainScrollAtEnd / mVCP(size:true)叠在同一条布局流上。
// 初始窗口里若存在测量高度不稳定的 item(异步媒体回填、字体回退重排、WebView 块
// 高度结算等),每次重测都会触发 onContentSizeChange → scrollToEnd → 再次锚定/
// 重测……命令式滚动不经 React state,「Maximum update depth」守卫不介入,回调
// 洪泛把 JS 线程打满:首帧(header)已提交、消息区停在半布局态、SyncingMessages
// 的延迟显形 timer 与一切 Pressable 全部失活。
// 护栏语义(evaluateMobileFollowEndContentSizePin):
//  - 高度死区:与上次已补滚高度差在死区内(浮点/舍入噪声、同值重复回调)→ 跳过;
//  - 振荡断路:跳闸信号是「高度方向翻转」而**不是**补滚频率——合法路径(冷开分批
//    渲染、流式逐行增长、媒体回填)的 contentHeight 单调递增,无论多快都不该被
//    限流(内置 maintainScrollAtEnd 对「大块一帧撑高」恰恰不兜底:它的 0.12×视口
//    距底闸在 rAF 里二次核验,单帧大增长直接被甩出阈值放弃跟随——这正是本手动
//    补滚存在的理由,review P1);病理重测环的特征是 A/B 往返振荡,滚动窗口内
//    方向翻转次数到达上限即打开断路器一段时间,期间不再手动 scrollToEnd;
//  - 断路到期自动闭合;翻转计数在断路期间继续记账(不重新跳闸、不延长断路),
//    上游若仍在振荡,断路一闭合就会立刻再次跳闸,净效果是把无界洪泛钳制成
//    「每个断路周期最多一轮」的有界节奏;
//  - 跳闸返回 suppressionStarted,调用方据此安排断路到期后的 one-shot 贴底清账
//    (断路窗内错过的最终高度可能停在半空,且之后再无 contentSize 事件来纠正);
//    首次跳闸另返回 trippedNow,供上层打一条诊断告警(每列表实例一次,防刷屏)。

/**
 * 补滚高度死区(px):与基准高度差 ≤ 此值视为噪声。与 MOBILE_ANCHOR_VERIFY_TOLERANCE
 * 同源取 2px——小于任何真实的内容增长(一行文字 ≥ 20px),大于 Fabric 布局舍入抖动。
 * 补滚判定基准是 lastPinnedHeight(不随被吞事件漂移,缓慢累积增长最终能逃逸死区);
 * 方向观察基准是 lastObservedHeight(死区内的噪声不构成方向信号,不制造假翻转)。
 */
export const MOBILE_FOLLOW_END_PIN_HEIGHT_DEAD_ZONE = 2;
/** 振荡统计的滚动窗口(ms)。 */
export const MOBILE_FOLLOW_END_PIN_WINDOW_MS = 1000;
/**
 * 窗口内允许的方向翻转次数上限。合法场景的翻转极稀:流式单调增 = 0 次;用户折叠
 * 长消息 / rewind 整窗替换 = 1~2 次;LegendList 冷开 estimated→measured 向下修正
 * ≈ 1 次。病理振荡环是每帧一次翻转(~60/s),100ms 便可越线。取 6:两侧安全边际
 * 都在 2 倍以上。
 */
export const MOBILE_FOLLOW_END_PIN_MAX_REVERSALS_PER_WINDOW = 6;
/** 断路器打开时长(ms):给 LegendList 内置锚定一个不被外部滚动干扰的收敛窗口。 */
export const MOBILE_FOLLOW_END_PIN_SUPPRESS_MS = 2000;

/**
 * 护栏状态:由 MessageRenderer 以 ref 持有,evaluate 原地更新(受控可变,滚动热路径
 * 不为每次评估重建状态对象;reversalTimestamps 长度有界于窗口内事件数)。会话切换
 * (scrollResetKey)与用户主动跳底(明确的重锚意图)时用工厂重建。
 */
export interface MobileFollowEndPinState {
  /** 上次实际补滚时的 contentHeight;0 = 本实例尚未补滚过(首次必放行)。 */
  lastPinnedHeight: number;
  /** 上次越过死区的观察高度(方向翻转检测基准);0 = 尚无观察。 */
  lastObservedHeight: number;
  /** 上次观察到的高度变化方向;0 = 尚无方向。 */
  lastDirection: 1 | -1 | 0;
  /** 滚动窗口内的方向翻转时间戳(evaluate 内按窗口过滤)。 */
  reversalTimestamps: number[];
  /** 断路器打开截止时刻(epoch ms);0 = 闭合。 */
  suppressedUntil: number;
  /** 本实例是否跳闸过(诊断告警只报第一次)。 */
  hasTripped: boolean;
}

export function createMobileFollowEndPinState(): MobileFollowEndPinState {
  return {
    lastPinnedHeight: 0,
    lastObservedHeight: 0,
    lastDirection: 0,
    reversalTimestamps: [],
    suppressedUntil: 0,
    hasTripped: false,
  };
}

export interface MobileFollowEndPinDecision {
  /** 允许本次命令式 scrollToEnd。 */
  shouldScroll: boolean;
  /** 本次评估打开了断路器(调用方安排断路到期后的 one-shot 贴底清账)。 */
  suppressionStarted: boolean;
  /** 本次评估触发本实例首次跳闸(上层据此打一条诊断告警)。 */
  trippedNow: boolean;
}

/**
 * 「贴底补滚是否放行」判定。调用方已确认业务前置条件(贴底跟随中、内容超一屏、
 * 非 load-earlier),这里只做护栏:方向翻转记账与跳闸 → 断路检查 → 死区去噪。
 * 高度收缩(rewind / 删消息 / 用户折叠)本身不受限——收缩只是一次方向观察,
 * 随后的补滚照常放行,只有窗口内反复往返才构成振荡。
 */
export function evaluateMobileFollowEndContentSizePin(
  state: MobileFollowEndPinState,
  input: { now: number; contentHeight: number },
): MobileFollowEndPinDecision {
  const { now, contentHeight } = input;
  let suppressionStarted = false;
  let trippedNow = false;
  // 方向观察在断路检查之前:断路期间振荡照常记账,窗口不清零,断路一闭合、
  // 上游仍在抖时首个翻转就能重新跳闸(而不是重新积累一整轮)。
  const observedDelta = contentHeight - state.lastObservedHeight;
  if (Math.abs(observedDelta) > MOBILE_FOLLOW_END_PIN_HEIGHT_DEAD_ZONE) {
    const direction: 1 | -1 = observedDelta > 0 ? 1 : -1;
    if (state.lastDirection !== 0 && direction !== state.lastDirection) {
      const windowStart = now - MOBILE_FOLLOW_END_PIN_WINDOW_MS;
      state.reversalTimestamps = state.reversalTimestamps.filter((at) => at > windowStart);
      state.reversalTimestamps.push(now);
      if (
        state.reversalTimestamps.length >= MOBILE_FOLLOW_END_PIN_MAX_REVERSALS_PER_WINDOW
        && state.suppressedUntil <= now
      ) {
        state.suppressedUntil = now + MOBILE_FOLLOW_END_PIN_SUPPRESS_MS;
        suppressionStarted = true;
        trippedNow = !state.hasTripped;
        state.hasTripped = true;
      }
    }
    state.lastDirection = direction;
    state.lastObservedHeight = contentHeight;
  }
  if (state.suppressedUntil > now) {
    return { shouldScroll: false, suppressionStarted, trippedNow };
  }
  if (Math.abs(contentHeight - state.lastPinnedHeight) <= MOBILE_FOLLOW_END_PIN_HEIGHT_DEAD_ZONE) {
    return { shouldScroll: false, suppressionStarted: false, trippedNow: false };
  }
  state.lastPinnedHeight = contentHeight;
  return { shouldScroll: true, suppressionStarted: false, trippedNow: false };
}

/**
 * 贴底锚定校验的判定容差:contentSize / offset 都是浮点布局值,亚像素误差不算落空。
 * 取 2px:小于任何真实遮挡(一行文字 ≥ 20px),大于 Fabric 布局的舍入抖动。
 */
export const MOBILE_ANCHOR_VERIFY_TOLERANCE = 2;

/**
 * 校验补滚上限:每次补滚目标幂等(同一 end offset),多滚无视觉副作用,上限只为防
 * 目标不可达(如 metrics 偏大被原生截停)时空转。6 次 × 双帧 ≈ 200ms 内收敛。
 */
export const MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS = 6;

/**
 * 校验等待上限(独立于补滚预算):mVCP 还开着 / metrics 未就绪时环只等不滚,等待
 * 不消耗补滚额度——否则 mVCP 长开(open-settle cap 2s)会把预算烧光,窗口关闭后
 * 反而没额度补滚,遮挡残留(review P1)。上限按最长 mVCP 窗口取:双帧一轮 ≈ 33ms,
 * 75 轮 ≈ 2.5s > OPEN_SETTLE_CAP_MS(2000ms),窗口自然关闭后环仍活着;再长说明
 * 状态异常(如列表空置),结束环交给常规事件跟随,每轮只是一次纯函数比较,无副作用。
 */
export const MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS = 75;

export interface MobileAnchorVerifyInput {
  attempts: number;
  listVisible: boolean;
  metrics: MessageScrollMetrics;
  preserveVisibleContentPosition: boolean;
  stickToLatest: boolean;
  waitRounds: number;
}

export type MobileAnchorVerifyAction =
  /** 已贴底(或用户已接管滚动),校验结束。 */
  | 'settled'
  /** 未贴底且允许补滚:重发一次落底 scrollToOffset 后继续校验。 */
  | 'retry'
  /** 暂不能判定/不能滚(mVCP 还开着、metrics 未就绪):下一轮再校验。 */
  | 'wait'
  /** 重试预算耗尽,放弃(交给后续 contentSize / layout 事件的常规跟随)。 */
  | 'give-up';

/**
 * 贴底锚定校验判定(纯函数,供 MessageRenderer 的 verify 环使用)。
 *
 * 背景:贴底跟随的落底 scrollToOffset 存在两类静默落空——
 * (a) maintainVisibleContentPosition 尚未真正关闭的帧里执行,被 mVCP 当成上方内容
 *     增长吸收/抵消(组件内 open-settle 注释实测过的偶发路径);
 * (b) 落底一刻 scrollMetricsRef 里的 contentHeight / viewportHeight 是陈旧值,目标
 *     offset 偏短,且之后再无 contentSize / layout 事件来纠正。
 * 两类的共同结果都是「最新消息停在底部浮层(composer)后面」。verify 环在每次落底后
 * 校验 offset 是否真到内容末端,未到位则带上限补滚,从机制上兜掉所有此类竞态。
 */
export function evaluateMobileAnchorVerify(input: MobileAnchorVerifyInput): MobileAnchorVerifyAction {
  if (!input.stickToLatest || !input.listVisible) return 'settled';
  // mVCP 还开着(state 已请求关闭但 prop 未下发,或 settle 窗口仍在):此刻补滚会再次
  // 被吸收,等窗口真正关闭后的下一轮再判。等待走独立预算,不消耗补滚额度。
  const { contentHeight, offsetY, viewportHeight } = input.metrics;
  if (input.preserveVisibleContentPosition || contentHeight <= 0 || viewportHeight <= 0) {
    return input.waitRounds >= MOBILE_ANCHOR_VERIFY_MAX_WAIT_ROUNDS ? 'give-up' : 'wait';
  }
  // 内容不足一屏时 end offset 为 0,任何非负 offset 都算贴底(iOS bounce 可为负,同样无遮挡)。
  const endOffset = mobileMessageListEndOffset(input.metrics);
  if (offsetY >= endOffset - MOBILE_ANCHOR_VERIFY_TOLERANCE) return 'settled';
  if (input.attempts >= MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS) return 'give-up';
  return 'retry';
}

/** 顶部让位后额外的呼吸间距:第一条消息与工具栏 hairline 分隔线之间留一点空隙。 */
const MOBILE_MESSAGE_LIST_TOP_GAP = 8;

/**
 * 顶部 chrome(绝对定位的半透明工具栏)高度 → 列表内容顶部让位。
 * chrome 浮在列表之上,不让位的话滚到历史最顶端时第一条消息永远被工具栏盖住、再也滑不出来;
 * 让位只加在内容起点,滚动途中内容仍从工具栏下方穿过,半透明效果不变(与 bottomOverlayHeight 同款模式)。
 */
export function mobileMessageListTopPadding(topOverlayHeight?: number): number {
  if (typeof topOverlayHeight !== 'number' || !Number.isFinite(topOverlayHeight) || topOverlayHeight <= 0) {
    return 0;
  }
  return Math.ceil(topOverlayHeight) + MOBILE_MESSAGE_LIST_TOP_GAP;
}

export interface MobileTopPaddingCompensationInput {
  previousTopPadding: number;
  nextTopPadding: number;
  offsetY: number;
  stickToLatest: boolean;
  preserveVisibleContentPosition: boolean;
  listVisible: boolean;
}

/**
 * 顶部让位(paddingTop)在阅读中途变化时的 offset 补偿目标(review P2)。
 * 场景:chrome 实高会因连接横幅出现/消失而变,paddingTop 随之突变;稳态阅读时 mVCP 未开启,
 * contentSize 变化走 skip 分支、contentOffset 不动,可见内容会整体跳 padding delta。
 * 返回补偿后的目标 offset;返回 null 表示不需要补偿:
 * - 贴底跟随中(stickToLatest):contentSize follow 分支自会重锚到底;
 * - preserve 窗口开着(load-earlier / open-settle):mVCP 正锚着首个可见 cell,会自行吸收上方位移,
 *   再手动补偿会双重位移;
 * - 列表未揭开:揭开路径自己定位;
 * - 停在最顶(offset<=0):让位本来就该把内容推下来给横幅腾位,补偿反而会把第一条消息藏回横幅下。
 */
export function mobileTopPaddingCompensationOffset(input: MobileTopPaddingCompensationInput): number | null {
  const delta = input.nextTopPadding - input.previousTopPadding;
  if (delta === 0) return null;
  if (input.stickToLatest || input.preserveVisibleContentPosition || !input.listVisible) return null;
  if (input.offsetY <= 0) return null;
  return Math.max(0, input.offsetY + delta);
}

/**
 * 「加载更早」预取触发距离:离顶还有约两屏时就开始拉上一页,而不是撞到顶(旧默认 96px)才拉。
 * 目标是无感翻页——用户滑到旧内容顶端之前,更早的消息已经 prepend 完毕,浏览像连续对话一样;
 * 同时触发时刻锚点(首个可见消息 cell)远离接缝,mVCP 的视口补偿也最稳定。
 * 视口高度未知(布局前)时退回旧默认,不凭空放大。
 * 不会级联连拉:每页 80 条消息的高度远超两屏,prepend 落地后 offsetY 被 mVCP 顶高、立即脱离阈值。
 * 边界假设(review P2):上一行成立的前提是页均高度 > 两屏,即平均每条 > viewportHeight/40
 * (典型视口 844px 约 21px/条,低于单行气泡的最小实高)。理论上整页全是极短消息才可能连拉一页,
 * 且有 loadingEarlier 门禁串行化,最坏是多拉一页,不会失控循环。
 */
export function mobileLoadEarlierPrefetchThreshold(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 96;
  return Math.max(96, Math.ceil(viewportHeight * 2));
}

export interface MobileAutoLoadEarlierDecisionInput {
  /** 「加载更早」动作当前不可点(加载中)。 */
  actionDisabled: boolean;
  /** 「加载更早」入口可见(hasOlderMessages 且列表非空)。 */
  actionVisible: boolean;
  /** 列表当前贴在内容末端(LegendList getState().isAtEnd,含 prepend 补偿后的记账)。 */
  atEnd: boolean;
  /** 当前首个渲染项 key(prepend 落地后必变,作为「上次尝试有进展」的信号)。 */
  firstItemKey: string | null;
  /** 冷开补齐预算尚有余额；只用于未经手势的初始短窗口。 */
  initialAutoFillAllowed: boolean;
  /** 上一次自动触发时的首项 key;相同说明上次尝试无进展(失败/重复页),不再自动重试。 */
  lastAttemptedFirstItemKey: string | null;
  /** 列表处于近顶预取区(LegendList getState().isNearStart,阈值 = onStartReachedThreshold × 视口)。 */
  nearStart: boolean;
  /** 用户产生过真实上翻意图(拖动 / 上跳导航);冷开初始布局不算。 */
  userScrolledForOlder: boolean;
}

/**
 * 「自动加载更早」的电平触发判定(纯函数,MessageRenderer 每个可能改变结果的时机都重新评估)。
 *
 * 背景(bug:停在顶部但更早消息永远不自动加载):LegendList 的 onStartReached 是**边沿触发**——
 * 触发过一次后,要么滚离顶部超过 threshold × 1.3(迟滞)再回来、要么阈值内发生 data 变化,才会再发。
 * 而 handleStartReached 里有一组业务 guard(用户没拖动过 / 正在加载 / hasOlderMessages 未就绪),
 * guard 不满足时这次边沿被直接吞掉;之后 guard 条件就绪,却再也等不到下一个边沿:
 * - 短加载窗口(内容总高 < ~3.6 屏)冷开时列表底部就落在近顶阈值内,边沿在用户拖动前就被消费,
 *   用户之后永远滚不出 1.3 × 阈值的复位区 → 永久哑火(实机高频复现的截图场景);
 * - 上一页在途时到达顶部(disabled guard 吞边沿),加载完成后停在顶部无任何重评估 → 哑火。
 * 修复:把判定改成电平语义——nearStart / atEnd 直接读 LegendList getState() 的实时账
 * (它的 scroll 记账含 prepend 锚点补偿,app 侧 onScroll 的原生 offsetY 在 prepend 后不可信),
 * 并在 scroll 事件、onStartReached、eligibility 变化(加载结束/入口点亮/首项变化)时都重新评估。
 *
 * 防失控:
 * - 用户浏览态 atEnd 时不触发:贴底跟流不因自动预取被关掉 end-pin；只有冷开有界补齐
 *   允许短窗口同时 nearStart + atEnd 时拉取；
 * - firstItemKey 去重:一次尝试后必须看到首项变化(真有 prepend)才允许下一次,
 *   加载失败或拉回重复页(host cursor 未命中返回最新页)不会无限重试;用户重新拖动时清除,
 *   保证手势永远能重新驱动一次尝试。
 */
export function shouldAutoLoadEarlier(input: MobileAutoLoadEarlierDecisionInput): boolean {
  if (!input.userScrolledForOlder && !input.initialAutoFillAllowed) return false;
  if (!input.actionVisible || input.actionDisabled) return false;
  if (!input.nearStart) return false;
  if (input.atEnd && !input.initialAutoFillAllowed) return false;
  if (!input.firstItemKey) return false;
  return input.lastAttemptedFirstItemKey !== input.firstItemKey;
}

export interface MobilePreviousUserJumpTarget {
  clientId: string;
  index: number;
  itemKey: string;
  preview: string;
}

export function previousUserMessageJumpTarget(
  items: readonly MobileMessageRenderItem[],
  firstVisibleIndex: number,
): MobilePreviousUserJumpTarget | null {
  if (!Number.isFinite(firstVisibleIndex)) return null;
  const startIndex = Math.min(items.length - 1, Math.floor(firstVisibleIndex) - 1);
  if (startIndex < 0) return null;
  for (let index = startIndex; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type !== 'message' || item.message.kind !== 'user') continue;
    const clientId = mobileMessageClientId(item.message);
    if (!clientId) continue;
    return {
      clientId,
      index,
      itemKey: item.key,
      preview: firstNonEmptyMessageLine(item.message.body),
    };
  }
  return null;
}

export function findMobileRenderItemKeyByClientId(
  items: readonly MobileMessageRenderItem[],
  clientId: string | null | undefined,
): string | null {
  if (!clientId) return null;
  for (const item of items) {
    const key = findClientIdInRenderItem(item, clientId, item.key);
    if (key) return key;
  }
  return null;
}

export function firstNonEmptyMessageLine(raw: string): string {
  return raw.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

function findClientIdInRenderItem(
  item: MobileMessageRenderItem | MobileWorkChildItem,
  clientId: string,
  scrollTargetKey: string,
): string | null {
  if (item.type === 'message' && mobileMessageClientId(item.message) === clientId) {
    return scrollTargetKey;
  }
  if (item.type === 'thinking' && mobileMessageClientId(item.message) === clientId) {
    return scrollTargetKey;
  }
  if (item.type === 'tool_group') {
    return item.tools.some((tool) => (tool.source.clientId || tool.source.id || tool.key) === clientId)
      ? scrollTargetKey
      : null;
  }
  if (item.type === 'agent_task') {
    const tool = item.toolCall;
    return tool && (tool.source.clientId || tool.source.id || tool.key) === clientId ? scrollTargetKey : null;
  }
  if (item.type === 'work_group') {
    for (const child of item.children) {
      const key = findClientIdInRenderItem(child, clientId, scrollTargetKey);
      if (key) return key;
    }
  }
  if (item.type === 'subagent_group') {
    for (const child of item.childItems) {
      const key = findClientIdInRenderItem(child, clientId, scrollTargetKey);
      if (key) return key;
    }
  }
  return null;
}

function mobileMessageClientId(message: NormalizedRemoteMessage): string {
  return message.source.clientId || message.source.id || message.key;
}
