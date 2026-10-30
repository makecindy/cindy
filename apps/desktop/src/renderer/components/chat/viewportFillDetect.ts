/**
 * viewportFillDetect — 修复"短 session 滚动死锁"的触发判定纯函数集。
 * ---------------------------------------------------------------------------
 * 修复背景: MessageStream 的 scroll 容器是 `h-full`(撑满视口),contentRef
 * 在内容很少时高度 < 容器,scrollHeight === clientHeight,scrollbar 不出现 →
 * `handleScroll` 里"距顶 < 50px → expandWindow / onLoadMore"的分支永远不触发
 * → 内存里 render-window 之外的更老 render-item 扩不进 DOM,DB 里更老的历史
 * 也拉不进来 (典型 case: 渲染单元少、单 item 短,contentH ~500px << 视口 1354px)。
 *
 * 这个模块抽出 caller (MessageStream useLayoutEffect) 二段式编排所需的纯函数:
 *   - shouldAutoExpandRenderWindow: Stage 1 — 内存里有未显示的 render-item 就
 *                                   扩 render-window
 *   - shouldAutoLoadMoreHistory:   Stage 2 — render-window 已覆盖全部 render-item,
 *                                   再 IPC 拉 DB
 *   - decideAutoFillAction:        编排两段, 返回最终 action enum 给 caller switch
 *
 * ── 度量轴说明 ──
 * 本 helper 接收的 `scrollHeight` / `clientHeight` 是像素,`windowAtTop` /
 * `hasMoreMessages` / `isLoadingMore` 是布尔状态 — 全部与"消息条数"还是
 * "渲染单元数"无关。caller 在 render-item 轴下喂入这些参数(windowAtTop =
 * `visibleRenderItems.length === allRenderItems.length`),helper 内部逻辑零改动。
 *
 * 抽成纯函数为了:
 *  - 单测覆盖各种 (scrollH, clientH, windowAtTop, hasMore, loading, attempt) 组合
 *  - 决策逻辑清晰,与 React effect 的副作用解耦
 *  - 跟 scrollAnchoringDetect 同样的 pattern,方便维护
 */

/**
 * 自动拉取的最大尝试次数(per MessageStream mount)。
 * 防御退化场景: DB 里几千条消息但渲染单元密度极低(例如几乎全是被丢弃的
 * orphan tool_result / ask_user / AskUserQuestion / ExitPlanMode,或者一个已完成
 * 长 turn 折叠成少量 work_group)的会话,每次拉 50 条 contentH 几乎不增长,会一直
 * 命中条件无限循环。MAX_AUTO_LOAD_ATTEMPTS=5 ≈ 250 条历史后还撑不满 viewport
 * 就停手,避免打开会话时自动烧太多本地 IPC / 远程隧道往返。
 *
 * 选 5 的依据: 自动补载只负责首屏自愈,不是无上限地替用户翻历史。若 250 条
 * 仍不够撑出滚动区域,MessageStream 会在用户明确向上滚动 / 翻页时走
 * decideUserIntentFillAction 继续加载,不会再被这个自动预算卡死。
 *
 * 注: 渲染窗口下移到 render-item 轴后,以前"末尾窗口全 orphan → 拉再多也
 * 还是空 items → 命中 cap 才停"的恶性退化已经消除(orphan 在 buildRenderItems
 * Pass 2 就被丢弃,不会出现在 allRenderItems 末尾)。本 cap 仍保留作为最后
 * 一道防线。
 */
export const MAX_AUTO_LOAD_ATTEMPTS = 5;

/**
 * scrollHeight === clientHeight 的判等容差(px)。
 *
 * 严格 `!==` 在 DPR=1 的环境下没问题(scrollHeight / clientHeight 都是整数)。
 * 但 Windows 缩放 125%/150% / Retina 等 DPR≠1 环境下,sub-pixel 取整可能让
 * `scrollHeight = clientHeight + 1`(差 1 像素)。此时:
 *  - 用户视觉上滚不动(1px 差异 thumb 都拉不出)
 *  - 严格判等会判 "≠" → auto-fill 不触发 → 死锁原态复发
 * 所以判据放宽到 `|delta| <= NO_SCROLL_TOLERANCE_PX`,1px 内仍视为"不可滚"。
 *
 * 选 1 的依据: sub-pixel 圆整最大 1px(浏览器 layout 引擎规范);取 2+ 会让
 * "本来 scrollH 比 clientH 高一点点(用户能看到 thumb)的场景"被错误地当作
 * 死锁去 auto-fill,不必要。
 */
export const NO_SCROLL_TOLERANCE_PX = 1;

/**
 * 「贴顶」判定阈值(px)——与 MessageStream handleScroll 的"距顶 < 50px 触发
 * 后续加载"用同一个值,两处判定必须一致:handleScroll 靠 scroll 事件在
 * *穿过*这个区间时触发,decideUserIntentFillAction 靠 wheel/touch/键盘意图在
 * *停在*这个区间时触发,合起来才覆盖"到顶后继续上滚"的完整路径。
 */
export const TOP_HISTORY_TRIGGER_PX = 50;

export interface ViewportFillCheckArgs {
  /** scroll 容器当前的 scrollHeight */
  scrollHeight: number;
  /** scroll 容器当前的 clientHeight (视口高度) */
  clientHeight: number;
  /** DB 里是否还有更老的消息可以拉 */
  hasMoreMessages: boolean;
  /** 是否正在拉取上一批(防止重入) */
  isLoadingMore: boolean;
  /** 当前 mount 已经触发了多少次自动拉取 */
  attemptCount: number;
  /** 上限,默认 MAX_AUTO_LOAD_ATTEMPTS */
  maxAttempts?: number;
}

/**
 * 判断是否应该主动触发 onLoadMore 把 viewport 装满。
 *
 * 触发条件 (全部满足才返回 true):
 *  - scrollHeight === clientHeight: 容器没有可滚动空间(用户无法手动触发)
 *  - hasMoreMessages: DB 里确实还有可拉的更老消息
 *  - !isLoadingMore: 上一次拉取已结束(防止 IPC 重入)
 *  - attemptCount < maxAttempts: 没超过退化保护上限
 *
 * 不触发的语义:
 *  - 容器有滚动空间 → 用户可手动滚到顶触发原生 onLoadMore,不需要自动
 *  - 没有更多历史 → 拉了也是空,白浪费 IPC
 *  - 正在加载 → 等当前批回来后再判
 *  - 超上限 → 退化场景,让用户接管
 */
export function shouldAutoLoadMoreHistory({
  scrollHeight,
  clientHeight,
  hasMoreMessages,
  isLoadingMore,
  attemptCount,
  maxAttempts = MAX_AUTO_LOAD_ATTEMPTS,
}: ViewportFillCheckArgs): boolean {
  // sub-pixel 容差: 见 NO_SCROLL_TOLERANCE_PX 说明。Math.abs 防御 scrollH<clientH
  // 的异常输入(实际 DOM 不会出现, 但测试 stub / 边界 case 防一手)。
  if (Math.abs(scrollHeight - clientHeight) > NO_SCROLL_TOLERANCE_PX) return false;
  if (!hasMoreMessages) return false;
  if (isLoadingMore) return false;
  if (attemptCount >= maxAttempts) return false;
  return true;
}

export interface ExpandWindowCheckArgs {
  /** scroll 容器当前的 scrollHeight */
  scrollHeight: number;
  /** scroll 容器当前的 clientHeight */
  clientHeight: number;
  /** 当前 render-window 是否已经覆盖内存里所有 render-item
   *  (true = visibleRenderItems.length === allRenderItems.length) */
  windowAtTop: boolean;
}

/**
 * 判断是否应该主动调 expandWindow 把 render-window 往前(更早)扩。
 *
 * 背景: MessageStream 用 RENDER_WINDOW_INITIAL_ITEMS=80 限制初始渲染量(切大
 * session 不卡)。当 onLoadMore 把更老消息 prepend 进 messages 数组、
 * buildRenderItems 重算让 allRenderItems 增长时,如果 firstVisibleItemKey
 * 锚点没动,visibleRenderItems 的 slice 边界把新 prepend 出来的 render-item
 * 切在外面 → DOM 不渲染 → contentH 不增长 → scrollH 永远 === clientH → 死锁。
 *
 * 触发条件 (全部满足才返回 true):
 *  - scrollHeight === clientHeight: viewport 没滚动 (用户也滚不出 onLoadMore)
 *  - !windowAtTop: render-window 还没覆盖内存全部 → 内存里有可显示的 item、却没显示
 *
 * 与 shouldAutoLoadMoreHistory 的关系: caller (MessageStream) 应该**先**判
 * expand (无 IPC、纯前端),expand 不出滚动条再判 load (IPC、计 attempt)。
 * mirror handleScroll 里 "二段式加载" 注释段的同款逻辑(`!windowAtTop` →
 * expand, 否则 onLoadMore)。
 *
 * 不计入 MAX_AUTO_LOAD_ATTEMPTS: expand 是纯前端操作不打 IPC。
 *
 * ── 终止性 ──
 * Stage 1 (本函数) 单步无独立 cap。单次 messages 快照下,expandWindow
 * 的 `currentStartIdx <= 0 return` 给出下界。完整循环里 Stage 2 (onLoadMore)
 * 每次 prepend ~50 条让 allRenderItems.length 单调增长,Stage 1 才能继续 expand;
 * Stage 2 的 MAX_AUTO_LOAD_ATTEMPTS 给整段循环上界。
 *
 * 渲染窗口下移到 render-item 轴后,每次 Stage 1 expand 至少多吸收一个 item
 * (orphan / ask_user / AskUserQuestion / ExitPlanMode 全部在 buildRenderItems
 * Pass 2 就被丢弃,不会"扩了 N 条 message 却多 0 个 item"),不再有以前以
 * 消息条数切窗时的恶性退化。Stage 1 单步纯本地,误循环代价远低于 Stage 2,
 * 当前不给 Stage 1 独立 cap;若未来重构改了上述假设(例如 build 内引入新的
 * 异步副作用),优先给 Stage 1 加 `MAX_AUTO_EXPAND_ATTEMPTS` 而不是依赖 Stage 2。
 */
export function shouldAutoExpandRenderWindow({
  scrollHeight,
  clientHeight,
  windowAtTop,
}: ExpandWindowCheckArgs): boolean {
  // sub-pixel 容差: 见 NO_SCROLL_TOLERANCE_PX 说明。Math.abs 防御 scrollH<clientH
  // 的异常输入(实际 DOM 不会出现, 但测试 stub / 边界 case 防一手)。
  if (Math.abs(scrollHeight - clientHeight) > NO_SCROLL_TOLERANCE_PX) return false;
  if (windowAtTop) return false;
  return true;
}

/**
 * 二段式决策的最终输出。caller (MessageStream) 直接 switch 这个 enum 决定走 expand
 * 还是 load。'none' = 不做任何 IPC/DOM 操作。
 */
export type AutoFillAction = 'none' | 'expand-window' | 'load-from-db';

export interface AutoFillDecisionArgs {
  scrollHeight: number;
  clientHeight: number;
  windowAtTop: boolean;
  hasMoreMessages: boolean;
  isLoadingMore: boolean;
  attemptCount: number;
  maxAttempts?: number;
}

export type UserIntentFillDecisionArgs = Omit<
  AutoFillDecisionArgs,
  'attemptCount' | 'maxAttempts'
> & {
  /** scroll 容器当前的 scrollTop(判定"停在顶部"用) */
  scrollTop: number;
  /** Explicit upward input can prefetch before reaching the history boundary. */
  triggerDistancePx?: number;
};

/**
 * MessageStream 自动拉历史的二段式决策编排函数。
 *
 * caller (MessageStream useLayoutEffect) 用单点 switch 调它,根据返回的 action
 * 走对应副作用 (expandWindow / onLoadMore)。这样把"先 expand 再 load"的核心
 * 逻辑显式化为一个纯函数,可单测,而不是散在 React effect body 里靠 if/return
 * 链表达。
 *
 * ── 为什么独立成 helper 而不是让 caller 各调两个 helper ──
 * 如果 caller 直接调 shouldAutoLoadMoreHistory 而漏掉 expand 检查 (二段式
 * 写错成单段式), helper 各自的 unit test 仍然全绿但组合是错的 — onLoadMore
 * prepend 回来的更老消息会被 render-window slice 切掉, 实际触发若干次空 IPC
 * 而 contentH 不增长的死锁。把组合逻辑也抽成纯函数 + 测试,可在不依赖 React
 * 集成测试的前提下捕获顺序错误 / 未来重构时的回归。
 *
 * ── 优先级 ──
 * 1. 'expand-window' 优先于 'load-from-db' — expand 是纯前端 (无 IPC、即时)、
 *    且 prepend 进来的更老消息只有先扩 render-window 才进 DOM,跳过 expand
 *    直接 load 会让 DB 拉回的内容看不见,scrollH 不增长,死锁。
 * 2. 任意一个 helper 返回 false → 走下一阶段。
 * 3. 两个都 false → 'none'。
 */
export function decideAutoFillAction({
  scrollHeight,
  clientHeight,
  windowAtTop,
  hasMoreMessages,
  isLoadingMore,
  attemptCount,
  maxAttempts,
}: AutoFillDecisionArgs): AutoFillAction {
  if (shouldAutoExpandRenderWindow({ scrollHeight, clientHeight, windowAtTop })) {
    return 'expand-window';
  }
  if (
    shouldAutoLoadMoreHistory({
      scrollHeight,
      clientHeight,
      hasMoreMessages,
      isLoadingMore,
      attemptCount,
      maxAttempts,
    })
  ) {
    return 'load-from-db';
  }
  return 'none';
}

/**
 * 用户明确向上滚动 / 翻页时的兜底。两类场景在这里接住(共同点:都不会再产生
 * scroll 事件,handleScroll 帮不上忙):
 *
 *  1. **容器不可滚**(scrollHeight ≈ clientHeight)——短 session 死锁原案。
 *  2. **容器可滚,但已停在顶部 TOP_HISTORY_TRIGGER_PX 内**——快速滚到顶时穿过
 *     触发区的 scroll 事件可能因上一次加载 in-flight 被 handleScroll 的
 *     isLoadingMore 守卫吃掉,等加载完用户已停在 scrollTop=0;此后 wheel 上滚
 *     不再产生 scroll 事件,若不在这里接住,用户必须"往下滚一下再往上"才能
 *     继续翻页(2026-07 用户实报)。
 *
 * 判定与 handleScroll 的"距顶 < 50px"分支同口径:先 expand(纯本地)后 load
 * (IPC);不受 MAX_AUTO_LOAD_ATTEMPTS 限制——自动预算耗尽后,用户继续表达
 * "我要看更早历史"就应该继续加载,不能要求切走再切回来重置 mount-local 计数器。
 */
export function decideUserIntentFillAction({
  scrollTop,
  scrollHeight,
  clientHeight,
  windowAtTop,
  hasMoreMessages,
  isLoadingMore,
  triggerDistancePx = TOP_HISTORY_TRIGGER_PX,
}: UserIntentFillDecisionArgs): AutoFillAction {
  const unscrollable = Math.abs(scrollHeight - clientHeight) <= NO_SCROLL_TOLERANCE_PX;
  const parkedNearTop = scrollTop < triggerDistancePx;
  if (!unscrollable && !parkedNearTop) return 'none';
  // expand 优先于 load,原因同 decideAutoFillAction 的「优先级」注释;expand 不看
  // isLoadingMore(纯本地扩窗与 in-flight IPC 不冲突,与既有语义一致)。
  if (!windowAtTop) return 'expand-window';
  if (hasMoreMessages && !isLoadingMore) return 'load-from-db';
  return 'none';
}
