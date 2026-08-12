/**
 * MessageNavRail
 * ---------------------------------------------------------------------------
 * 聊天区左缘的"提问导航条":每条用户提问一根短刻度,当前正在阅读的提问加深,
 * hover 显示"提问 + 回答摘要"预览卡,点击跳转到那一轮的顶部。
 *
 * 职责定义(设计推导起点):长 agent 对话的意义单元是"轮次"(提问→回答),
 * 导航条同时承担 ①定位(当前项)②跳转(落点框住整轮)③识别(预览卡)。
 *
 * 显隐(活跃深、空闲浅,不完全隐没):
 *   - 前提条件:真实提问 ≥ NAV_RAIL_MIN_ENTRIES 且内容列左侧留白足够
 *     (窄窗口 / 嵌入面板自然隐藏,绝不压在气泡上);
 *   - 满足前提后**常驻但分两档**:滚动、鼠标滑到左缘、悬停刻度时全亮;
 *     静止阅读 NAV_RAIL_IDLE_HIDE_MS 后**减淡**为浅灰(2026-07-28 验收
 *     定稿:完全淡出会让人忘记它的存在,减淡保留"地图在这"的心理暗示,
 *     阅读态噪音仍然很低)。
 *
 * 入口去重:导航条**完整覆盖导航**(出场且未截断)时,父级抑制右上角
 * "跳到上一条提问"chip —— 同一个导航任务只保留一套入口(经
 * onNavCoverageChange 上报)。刻度被截断的超长会话里 chip 回归,截断区
 * 仍有导航可用(PR #830 review)。
 *
 * 几何职责分工:
 *   - 本组件只做 DOM 测量(scroll + ResizeObserver,rAF 节流,与
 *     usePrevUserMessageInView 同款套路)并渲染;
 *   - 判定与规划是纯函数,在 messageNavRailModel.ts,node 环境直接单测;
 *   - 点击后的跳转(含渲染窗口外目标的扩窗、落点计算)由 MessageStream 的
 *     onJump 承接,那边持有 firstVisibleItemKey / chip-jump 抑制协议等状态。
 *
 * pending 态:点击后目标立即显示为当前项(乐观),平滑滚动落定(几何判定
 * 追上)或用户产生主动滚动意图(wheel / touch / 方向键)时回归几何真值;
 * 3s 安全兜底防"点完不动"卡住乐观态,与 CHIP_JUMP_SAFETY_MS 同源经验值。
 */

import { useCallback, useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

import { useNavigationKeyListener } from './useNavigationKeyListener';
import {
  NAV_RAIL_ACTIVE_FUDGE_PX,
  NAV_RAIL_MIN_AVAIL_HEIGHT_PX,
  NAV_RAIL_MIN_ENTRIES,
  NAV_RAIL_RANGE_BOTTOM_EDGE_PX,
  hasNavRailRoom,
  pickActiveNavId,
  pickVisibleNavRange,
  planNavRailTicks,
  type NavRailEntry,
} from './messageNavRailModel';
import { forwardNavRailWheel } from './messageNavRailWheel';

// 乐观 pending 态的安全兜底时长,对齐 MessageStream 的 CHIP_JUMP_SAFETY_MS。
const PENDING_SAFETY_MS = 3000;
// 静止这么久后减淡(不隐没) — 节奏对齐全局滚动条自动隐藏
// (lib/scrollbarAutoHide.ts 的 .is-scrolling,2s)。
const NAV_RAIL_IDLE_HIDE_MS = 2000;
// 空闲档的整条不透明度。全亮 100% / 空闲减淡到这个值,保留"地图在这"的
// 存在感又不抢阅读注意力(2026-07-28 实机验收定的档位)。
const NAV_RAIL_IDLE_OPACITY_CLASS = 'opacity-40';
// 鼠标滑进滚动容器左缘这么宽的区域时唤醒导航条(mousemove 探测,不放
// pointer-events 层,避免挡住从留白处起手的划选)。
const WAKE_GUTTER_PX = 48;
// 刻度带的上下保留:顶部对齐内容区 pt-7;底部在输入 overlay 之上再让 16px。
const RAIL_TOP_PX = 28;
const RAIL_BOTTOM_EXTRA_PX = 16;

export interface MessageNavRailProps {
  /** 已加载的全部真实提问(deriveNavRailEntries 产物,时间正序)。 */
  entries: NavRailEntry[];
  /** MessageStream 的滚动容器 ref,测量与锚点查询都以它为根。 */
  scrollRef: { readonly current: HTMLDivElement | null };
  /** 内容列 maxWidth(与 MessageStream contentRef 的 maxWidth 同值)。 */
  contentMaxWidth: number;
  /** 底部输入 overlay 高度(resolvedBottomPadding),刻度带避开这段。 */
  bottomOffset: number;
  /** 点击刻度 → 跳到该提问。目标可能在渲染窗口外,由父级扩窗后滚动。 */
  onJump: (clientId: string) => void;
  /**
   * "导航条完整覆盖导航"变化上报(出场资格 && 刻度未截断)。父级用它做
   * 入口去重:覆盖时抑制"跳到上一条提问"chip;导航条缺席或截断了更早
   * 刻度时 chip 回归。与淡入淡出无关 —— chip 只在滚动时出现,而滚动一定
   * 会唤醒导航条,按覆盖态抑制即可,信号稳定不闪烁。
   */
  onNavCoverageChange?: (covers: boolean) => void;
  /** 切会话重置几何与 pending 态(与 usePrevUserMessageInView 同款)。 */
  resetKey?: string;
}

export function MessageNavRail({
  entries,
  scrollRef,
  contentMaxWidth,
  bottomOffset,
  onJump,
  onNavCoverageChange,
  resetKey,
}: MessageNavRailProps) {
  const { t } = useTranslation();

  const [activeId, setActiveId] = useState<string | null>(null);
  // 视口内可见轮次的范围(整段提亮,与"当前项加长"互补)。存 id 而非下标:
  // 测量与渲染之间 entries 可能已更新,按 id 回查最稳。
  const [visibleRange, setVisibleRange] = useState<{ startId: string; endId: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [hasRoom, setHasRoom] = useState(false);
  const [availHeight, setAvailHeight] = useState(0);
  // 淡入淡出:挂载即亮(给切进会话的用户一个初始定位),此后随活动唤醒。
  const [awake, setAwake] = useState(true);

  const rafRef = useRef<number | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const hoveringRef = useRef(false);
  // 容器左缘缓存,给高频 mousemove 的左缘唤醒判定用,免得每次事件都
  // getBoundingClientRect 强制布局读;measure(scroll/resize 都会触发)时刷新。
  const containerLeftRef = useRef(0);
  // 测量回调经 rAF 异步触发,entries 派生的 id 列表 / 布局参数用 ref 透传
  // 拿最新值,避免把大数组挂进依赖链让监听器反复重挂。id 列表按 entries
  // 引用缓存,长会话滚动的高频测量不逐帧重新分配数组(Copilot review);
  // 初值空占位,首次渲染即被下面的引用比较填充,不在每次 render 白算一遍。
  const measureIdsRef = useRef<{ source: readonly NavRailEntry[] | null; ids: string[] }>({
    source: null,
    ids: [],
  });
  if (measureIdsRef.current.source !== entries) {
    measureIdsRef.current = { source: entries, ids: entries.map((e) => e.id) };
  }
  const contentMaxWidthRef = useRef(contentMaxWidth);
  contentMaxWidthRef.current = contentMaxWidth;
  const bottomOffsetRef = useRef(bottomOffset);
  bottomOffsetRef.current = bottomOffset;

  // 切会话全部归零,防旧目标 / 旧乐观态残留;重新亮一次做初始定位。
  useEffect(() => {
    setActiveId(null);
    setVisibleRange(null);
    setPendingId(null);
    setAwake(true);
  }, [resetKey]);

  // 唤醒 + 重排空闲淡出计时。悬停刻度期间不淡出(计时器到点重排)。
  const wake = useCallback(() => {
    setAwake((cur) => (cur ? cur : true));
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    const scheduleHide = () => {
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        if (hoveringRef.current) {
          scheduleHide();
          return;
        }
        setAwake(false);
      }, NAV_RAIL_IDLE_HIDE_MS);
    };
    scheduleHide();
  }, []);

  const measure = useCallback(() => {
    rafRef.current = null;
    const root = scrollRef.current;
    if (!root) return;
    const containerRect = root.getBoundingClientRect();
    containerLeftRef.current = containerRect.left;
    const roomOk = hasNavRailRoom(containerRect.width, contentMaxWidthRef.current);
    setHasRoom(roomOk);
    const avail = Math.max(
      0,
      containerRect.height - bottomOffsetRef.current - RAIL_TOP_PX - RAIL_BOTTOM_EXTRA_PX,
    );
    setAvailHeight(avail);
    const ids = measureIdsRef.current.ids;
    // 组件常驻挂载,不出场(条数不足 / 窄窗 / 矮视口)时跳过逐条锚点测量,
    // 短对话滚动不背 querySelector + 布局读的开销;room/avail 已更新,条件
    // 翻转时下一次测量自然恢复(Copilot review)。
    if (ids.length < NAV_RAIL_MIN_ENTRIES || !roomOk || avail < NAV_RAIL_MIN_AVAIL_HEIGHT_PX) {
      setActiveId((cur) => (cur === null ? cur : null));
      setVisibleRange((cur) => (cur === null ? cur : null));
      return;
    }
    // 同一帧内 topAt 会被 active / range 两个判定反复调,缓存 DOM 测量。
    const topCache = new Map<number, number | null>();
    const topAt = (i: number): number | null => {
      const cached = topCache.get(i);
      if (cached !== undefined) return cached;
      const el = root.querySelector(
        `[data-message-client-id="${CSS.escape(ids[i])}"]`,
      ) as HTMLElement | null;
      const top = el ? el.getBoundingClientRect().top : null;
      topCache.set(i, top);
      return top;
    };
    const next = pickActiveNavId(ids, containerRect.top + NAV_RAIL_ACTIVE_FUDGE_PX, topAt);
    setActiveId((cur) => (cur === next ? cur : next));
    // 有效视口 = 扣除容差后的边界:顶部与当前项共用同一条阈值线(空白余量
    // 不算"看见了上一轮"),底部留 8px 防露头即亮。语义见 pickVisibleNavRange。
    const range = pickVisibleNavRange(
      ids,
      containerRect.top + NAV_RAIL_ACTIVE_FUDGE_PX,
      containerRect.bottom - NAV_RAIL_RANGE_BOTTOM_EDGE_PX,
      topAt,
    );
    const nextRange = range ? { startId: ids[range.startIndex], endId: ids[range.endIndex] } : null;
    setVisibleRange((cur) =>
      cur?.startId === nextRange?.startId && cur?.endId === nextRange?.endId ? cur : nextRange,
    );
  }, [scrollRef]);

  const scheduleMeasure = useCallback(() => {
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(measure);
    }
  }, [measure]);

  // 主动滚动意图(wheel / touch / 方向键)→ 放弃乐观 pending,回归几何真值。
  const dropPending = useCallback(() => {
    setPendingId((cur) => (cur === null ? cur : null));
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onScroll = () => {
      wake();
      scheduleMeasure();
    };
    // 左缘唤醒走 mousemove 探测而不是铺一层 pointer-events 热区:
    // 留白区常被用来起手划选文本,热区会吃掉 mousedown。左缘坐标用
    // measure 缓存的值(窗口纯平移导致的极小误差可接受),不在高频事件里
    // 强制布局读。
    const onMouseMove = (e: MouseEvent) => {
      if (e.clientX - containerLeftRef.current <= WAKE_GUTTER_PX) {
        wake();
      }
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('mousemove', onMouseMove, { passive: true });
    root.addEventListener('wheel', dropPending, { passive: true });
    root.addEventListener('touchstart', dropPending, { passive: true });
    const ro = new ResizeObserver(() => scheduleMeasure());
    ro.observe(root);
    // 初次同步:挂载后未滚动也能算出当前项与可用空间。
    scheduleMeasure();
    return () => {
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('mousemove', onMouseMove);
      root.removeEventListener('wheel', dropPending);
      root.removeEventListener('touchstart', dropPending);
      ro.disconnect();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scrollRef, scheduleMeasure, dropPending, wake]);

  useNavigationKeyListener(dropPending);

  // 条目变化(新发消息 / load-more prepend)与喂进测量的布局 props 变化都要
  // 重算。bottomOffset / contentMaxWidth 只经 ref 透传给 measure,不列进这里
  // 的话 composer 撑高(多行输入 / 加附件)既不触发容器 resize 也不滚动,
  // availHeight 与纵向出场门槛会停在旧值直到下次滚动(PR #830 review)。
  useEffect(() => {
    scheduleMeasure();
  }, [entries, bottomOffset, contentMaxWidth, scheduleMeasure]);

  // 挂载亮相的那次也要按空闲节奏淡出。
  useEffect(() => {
    wake();
  }, [wake, resetKey]);

  // 平滑滚动落定,几何判定追上乐观目标 → 乐观态使命完成,交还给几何。
  useEffect(() => {
    if (pendingId !== null && pendingId === activeId) {
      setPendingId(null);
    }
  }, [pendingId, activeId]);

  // 出场资格:条数、横向留白、纵向空间三道门槛。纵向门槛防极矮视口 /
  // 输入 overlay 占满高度时刻度溢出压到输入区(PR #830 review)。
  const eligible =
    entries.length >= NAV_RAIL_MIN_ENTRIES &&
    hasRoom &&
    availHeight >= NAV_RAIL_MIN_AVAIL_HEIGHT_PX;
  const plan = planNavRailTicks(entries.length, availHeight);
  // 覆盖态上报(入口去重用);卸载时收回。截断时不算覆盖 —— 被截掉的
  // 早期区域没有刻度,chip 必须回归兜底。
  const railCoversNav = eligible && plan.hiddenCount === 0;
  useEffect(() => {
    onNavCoverageChange?.(railCoversNav);
  }, [railCoversNav, onNavCoverageChange]);
  useEffect(() => {
    return () => {
      onNavCoverageChange?.(false);
    };
  }, [onNavCoverageChange]);

  useEffect(() => {
    return () => {
      if (pendingTimerRef.current !== null) {
        window.clearTimeout(pendingTimerRef.current);
      }
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
    };
  }, []);

  const handleTickClick = useCallback(
    (clientId: string) => {
      setPendingId(clientId);
      if (pendingTimerRef.current !== null) {
        window.clearTimeout(pendingTimerRef.current);
      }
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null;
        setPendingId(null);
      }, PENDING_SAFETY_MS);
      onJump(clientId);
    },
    [onJump],
  );

  const handleTickMouseEnter = useCallback(() => {
    hoveringRef.current = true;
    wake();
  }, [wake]);
  const handleTickMouseLeave = useCallback(() => {
    hoveringRef.current = false;
  }, []);

  // 悬停刻度带时滚轮不能失灵:导航条是滚动容器的兄弟 overlay,刻度按钮
  // pointer-events-auto 会成为 wheel 目标、冒泡不经过滚动容器,浏览器不会
  // 替我们滚聊天区(PR #830 review)。补两件事,缺一不可:
  //   1. 先把 wheel **重派**给滚动容器 —— root 上挂着既有的 wheel 意图监听
  //      (本组件的 dropPending;MessageStream 的贴底跟随解锚 / 顶部意图
  //      补页 / chip 抑制解除)。只补位移不补意图,贴底流式时在刻度带上滚
  //      会被 pin-to-bottom 拽回、到顶后拉不出更早历史(对抗审查 P1)。
  //      合成事件 untrusted、不产生默认滚动,与下一步不会双滚;先意图后
  //      位移,对齐原生"监听先于默认滚动"的时序。
  //   2. 再把增量转发成真实位移(见 messageNavRailWheel.ts)。产生的
  //      scroll 事件经 root 的 onScroll 走 wake + scheduleMeasure。
  const handleRailWheel = useCallback(
    (e: ReactWheelEvent<HTMLElement>) => {
      const root = scrollRef.current;
      if (!root) return;
      root.dispatchEvent(new WheelEvent('wheel', { deltaX: e.deltaX, deltaY: e.deltaY }));
      forwardNavRailWheel(root, e);
    },
    [scrollRef],
  );

  if (!eligible) return null;

  const shown = entries.slice(plan.startIndex);
  const displayActiveId = pendingId ?? activeId;
  // 可见范围 id → 下标(渲染时按 id 回查,测量与渲染间 entries 变更也不会
  // 错位)。单次遍历同时定位两端,滚动高频重渲下不扫两遍数组。
  let rangeStartIdx = -1;
  let rangeEndIdx = -1;
  if (visibleRange) {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].id === visibleRange.startId) rangeStartIdx = i;
      if (entries[i].id === visibleRange.endId) {
        rangeEndIdx = i;
        if (rangeStartIdx >= 0) break;
      }
    }
  }
  // 空闲档只是减淡、仍然可见可点,指针事件常开(悬停刻度本身就会唤醒全亮)。
  const tickEvents = 'pointer-events-auto';

  return (
    <nav
      aria-label={t('chat.messageNavRail.aria')}
      // 容器不吃事件,只有刻度自身 pointer-events-auto(空闲减淡时也可点,
      // 见 tickEvents 注释),不挡左缘留白里的文字选择;justify-center 让
      // 刻度组在(避开输入 overlay 的)带内垂直居中。
      className={cn(
        'pointer-events-none absolute inset-y-0 left-2 z-30 flex w-6 flex-col items-stretch justify-center',
        // §14.4 禁硬编码 duration / cubic-bezier。不透明度变化属 fast 档
        // (150ms);原先是 Tailwind 的 duration-200 + ease-out。
        'transition-opacity duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
        awake ? 'opacity-100' : NAV_RAIL_IDLE_OPACITY_CLASS,
      )}
      style={{ paddingTop: RAIL_TOP_PX, paddingBottom: bottomOffset + RAIL_BOTTOM_EXTRA_PX }}
      // wheel 事件从 pointer-events-auto 的刻度冒泡到这里统一转发,
      // "更早还有 N 条"占位刻度一并覆盖。
      onWheel={handleRailWheel}
    >
      {/*
       * 整条导轨共用一个 Provider。原先每根刻度包一层 <Tip>,而 Tip 内部是
       * 无条件自带 <TooltipProvider> 的 —— 而 skipDelayDuration 是 **Provider
       * 级**状态,跨刻度就是跨 Provider,新 Provider 没有"刚刚开过"的记忆,于是
       * 每根都重新等满 delay。刻度纵距只有 9px,鼠标竖着划过去是连续闪断。
       * 换成 primitives 挂在一个 Provider 下:首次 hover 等 150ms,之后 700ms 内
       * 切到相邻刻度立即显示,竖向移动时预览卡只换内容、不中断。
       * (在 <Tip> 外面套一层 Provider 没用 —— 内层会把外层遮住。)
       */}
      <Tooltip.Provider delayDuration={150} skipDelayDuration={700}>
        {plan.hiddenCount > 0 ? (
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <div
                className={cn('flex items-center justify-center', tickEvents)}
                style={{ height: plan.pitchPx }}
                onMouseEnter={handleTickMouseEnter}
                onMouseLeave={handleTickMouseLeave}
              >
                <span
                  aria-hidden="true"
                  className="text-10 leading-none text-[var(--text-tertiary)]"
                >
                  ⋯
                </span>
              </div>
            </Tooltip.Trigger>
            {/* 占位刻度是**标签**,继续用默认 tooltip 面色(近黑),与下面的
                内容预览卡两类不混 —— 面色决策同 #830 原状。 */}
            <Tooltip.Content side="right">
              {t('chat.messageNavRail.hiddenEarlier', { count: plan.hiddenCount })}
            </Tooltip.Content>
          </Tooltip.Root>
        ) : null}
        {shown.map((entry, i) => {
          // 纯附件且无文件名的提问用 i18n 计数文案兜底(模型层不碰 i18n)。
          const preview =
            entry.preview ||
            (entry.attachmentsOnly
              ? t('chat.messageNavRail.attachmentOnly', { count: entry.attachmentsOnly })
              : '');
          const isActive = entry.id === displayActiveId;
          const fullIdx = plan.startIndex + i;
          // 该轮次的内容当前正显示在视口里 → 提亮(Codex 同款"屏上内容高亮");
          // 当前项在提亮之上再加长,两个信号分工:范围 = 在看什么,长刻度 = 读到哪。
          const inView = rangeStartIdx >= 0 && fullIdx >= rangeStartIdx && fullIdx <= rangeEndIdx;
          // 自动化提问是系统注入的重复性消息,用更短的刻度保留其导航入口,
          // 同时让手动提问成为更容易扫到的主节奏。当前项仍比普通自动刻度更长,
          // 保持点击跳转后的定位反馈。
          const tickWidthClass = isActive
            ? entry.isAutomation
              ? 'w-3'
              : 'w-4'
            : inView
              ? entry.isAutomation
                ? 'w-2.5'
                : 'w-3'
              : entry.isAutomation
                ? 'w-2'
                : 'w-3';
          const tickHoverWidthClass = entry.isAutomation ? 'group-hover:w-3' : 'group-hover:w-3.5';
          return (
            <Tooltip.Root key={entry.id}>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  aria-label={t('chat.messageNavRail.jumpAria', {
                    index: plan.startIndex + i + 1,
                    preview,
                  })}
                  aria-current={isActive ? 'true' : undefined}
                  data-message-nav-automation={entry.isAutomation ? 'true' : undefined}
                  onClick={() => handleTickClick(entry.id)}
                  onMouseEnter={handleTickMouseEnter}
                  onMouseLeave={handleTickMouseLeave}
                  // 命中区吃满整格纵距,刻度线本体只有 2px 高。焦点环用全局
                  // --focus-ring token(AgentTaskCard 同款),键盘 Tab 可见
                  // (PR #830 review:纯 outline-none 会让键盘用户丢焦点)。
                  className={cn(
                    'group flex w-full items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    tickEvents,
                  )}
                  style={{ height: plan.pitchPx }}
                >
                  <span
                    className={cn(
                      // §14.4 禁硬编码 duration / cubic-bezier:base 档
                      // (200ms)与原先的 duration-200 同值,曲线取尺寸插值的
                      // ease-move。过渡属性从 all 收窄到实际会变的两项。
                      'h-[2px] rounded-full',
                      'transition-[width,background-color] duration-[var(--motion-base)]',
                      'ease-[var(--motion-ease-move)]',
                      tickWidthClass,
                      inView || isActive
                        ? 'bg-[var(--text-primary)]'
                        : 'bg-[var(--border-default)] group-hover:bg-[var(--text-secondary)]',
                      tickHoverWidthClass,
                    )}
                  />
                </button>
              </Tooltip.Trigger>
              {/*
               * 预览卡 = 提问(加粗一行)+ 回答摘要(灰字,至多 3 行)。
               * 摘要是识别的主载体:大量提问是"继续 / 重来"式短指令,只靠
               * 提问认不出是哪一轮。回答未产生时只显示提问行。
               *
               * 面色刻意不用全局 tooltip token(亮暗两模式都是近黑,那是给
               * "一句话标签"定的惯例):本卡是**内容预览**,语义对应 popover
               * 内容面 —— 白底深字 / 暗色深面,多行正文可读性优先。旁边的
               * "更早还有 N 条"是标签,继续用默认 tooltip 面色,两类不混。
               * 覆盖类刻意与 TooltipContent 的原类同形式(任意值 bg-[...] /
               * text-[...]),确保 tailwind-merge 归入同一冲突组、后写的必胜,
               * 不赌歧义值的分组启发式。
               * 阴影不覆盖:继承 TooltipContent 基座的浮层阴影决策,本卡不引入
               * 新的深度样式(PR #830 review)。
               *
               * 无预览文本时不渲染 Content —— 与原先 <Tip text={null}> 的
               * 透明传递等价(空内容不该冒出一个空卡)。
               */}
              {preview ? (
                <Tooltip.Content
                  side="right"
                  className={cn(
                    'max-w-[380px] break-normal px-3 py-2',
                    'border-[var(--border-default)] bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))]',
                    'dark:border-[var(--border-default)]',
                  )}
                >
                  <span className="flex max-w-[344px] flex-col gap-1">
                    <span className="truncate text-13 font-medium">{preview}</span>
                    {entry.answerExcerpt ? (
                      // 摘要 = 主文字色 × 50% 透明度,不引新 token。数值由多轮
                      // 实机验收夹逼、最终用户直接指定(2026-07-28)。注意半透明
                      // 文字经抗锯齿合成会比同亮度实心灰**显得更亮**,别拿色值
                      // 计算器推这个数,调整必须实机看效果。
                      <span className="line-clamp-3 whitespace-normal break-normal text-13 leading-relaxed opacity-50">
                        {entry.answerExcerpt}
                      </span>
                    ) : null}
                  </span>
                </Tooltip.Content>
              ) : null}
            </Tooltip.Root>
          );
        })}
      </Tooltip.Provider>
    </nav>
  );
}
