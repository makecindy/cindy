import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

/**
 * MorphPopover —— 「chip 脱身上浮长成弹层」的容器形变原语(DESIGN.md §14.4)。
 *
 * 与 Radix Popover 的区别:弹层不是在目标位置凭空浮现,而是以 trigger chip 的
 * 精确几何(位置/尺寸/胶囊圆角/pill 底色)为形变起点,一边生长一边整体位移,
 * 最终停靠在 chip 的 side 侧、留 GAP 间隙;关闭时反向缩回 chip。
 *
 * 「脱身上浮」语义(2026-07-22 用户定稿,取代第一版的「原位取代」):
 * - trigger chip 全程可见、可交互 —— 面板打开后再点 chip 即关闭(保住
 *   「原地再点一下收起」的肌肉记忆,这是原位取代方案做不到的);
 * - 因此不再需要 ghost 幽灵层、chip 隐藏/复形那套时序(第一版的抖动与
 *   HMR 卡隐身问题全部源于它)。
 *
 * 实现要点(每条都对应一个踩过的坑):
 * - portal + position:fixed 锚定视口坐标,天然豁免 composer 工具条
 *   `overflow-hidden` 的裁剪(这是不能沿用 Radix in-flow 方案后自建 portal 的原因)。
 * - side='top' 底边锚定、生长时底边从 chip 底边上浮到 chip 顶边上方 GAP 处;
 *   side='bottom' 顶边锚定对称下沉。align='start' 左缘对齐 / 'end' 右缘对齐
 *   (右缘锚定时内容加宽自动向左扩)。
 * - 测量目标几何时必须临时禁用 transition:否则 offsetHeight 在宽度过渡第 0 帧
 *   按旧宽度排版,含换行文本时会量出几十行的假高度(§14.4 实现红线 b)。
 * - 形变起点圆角 = chip 高度一半,禁止 9999px(9999→12 插值中途帧会变形,红线)。
 * - 打开期间 ResizeObserver 跟随内容尺寸变化(搜索过滤 / 模型 Edit 面板 320↔516
 *   展宽),几何更新推迟到 rAF 并合并同帧通知(直接在 RO 回调写布局会触发
 *   Chromium "ResizeObserver loop" 告警)。
 * - prefers-reduced-motion 降级为直切(红线 a);焦点/Esc/outside-click 语义
 *   与 §14.2 相同(红线 d):打开聚焦 [data-morph-autofocus] → 首个 input →
 *   面板容器,关闭后焦点归还 trigger。
 * - Esc 分层:面板内嵌套的 Radix 浮层(role=dialog,如模型行 effort 子面板)
 *   开着时先让内层关。必须挂 capture —— keydown 是 discrete 事件,Radix 的
 *   capture 处理器关层后 React 同步 flush DOM 移除,bubble 阶段已看不到 dialog;
 *   本监听注册早于内层,capture 同阶段按注册序先跑,此时 dialog 必在。
 *
 * 职责边界:本组件只管几何形变与开合语义;面板内容的 role(listbox/menu)、
 * 行高亮、i18n 全部由调用方提供。业务不进这里。
 */

const MORPH_MS = 220;
const MORPH_EASE = 'cubic-bezier(0.3, 0.9, 0.25, 1)';
/** 面板停靠位与 chip 之间的间隙(对齐 Radix sideOffset 习惯) */
const SIDE_GAP = 6;
/** 面板与视口边缘的最小留白(对齐 Radix collisionPadding 习惯) */
const VIEWPORT_PADDING = 8;

/** 形变属性集(§14.4);top/bottom 参与过渡实现「脱身位移」;reduced-motion 时整组置空直切 */
const MORPH_TRANSITION = [
  `width ${MORPH_MS}ms ${MORPH_EASE}`,
  `height ${MORPH_MS}ms ${MORPH_EASE}`,
  `top ${MORPH_MS}ms ${MORPH_EASE}`,
  `bottom ${MORPH_MS}ms ${MORPH_EASE}`,
  `border-radius ${MORPH_MS}ms ${MORPH_EASE}`,
  `background-color ${MORPH_MS}ms ease`,
  `border-color ${MORPH_MS}ms ease`,
  `box-shadow ${MORPH_MS}ms ease`,
  // opacity 仅收合相位使用:面板缩回时与位移耦合整体淡出,否则末帧会有一个
  // 空白胶囊盖住 chip,按钮文字闪没一下(2026-07-22 用户反馈)
  `opacity ${MORPH_MS}ms ease`,
].join(', ');

interface MorphPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** trigger chip(调用方渲染完整按钮,含 aria-expanded/haspopup 与点击开关)。 */
  trigger: ReactNode;
  /** 面板内容(role/选项行由调用方定义)。 */
  children: ReactNode;
  /** 停靠方向:top = 浮到 chip 上方(composer 默认);bottom = 沉到下方(settings 场景)。 */
  side?: 'top' | 'bottom';
  /** 水平对齐:start = 左缘对齐 chip;end = 右缘对齐(工具条右端控件用,防溢出视口)。 */
  align?: 'start' | 'end';
  /**
   * 固定面板宽度(px)。内容含换行文本(描述行等)时必须提供 —— 自适应测量对
   * 换行内容无法稳定收敛;不提供则按 max-content 自适应(仅限 nowrap / 自带定宽的内容)。
   */
  panelWidth?: number;
  /** 面板形变起点底色/边色(= chip 的),默认 composer pill 规格。 */
  startBg?: string;
  startBorderColor?: string;
  /** 面板终态底色/边色,默认 model dropdown 规格。 */
  endBg?: string;
  endBorderColor?: string;
  /**
   * 形变起点圆角(px)。默认取 chip 高度一半(胶囊等效值);
   * trigger 不是胶囊时(settings field 8px 矩形)必须显式传,否则起点圆角失真。
   */
  startRadius?: number;
  /** 面板内容容器 className(padding 等由调用方给)。 */
  panelClassName?: string;
  /** trigger 外层 wrapper className(布局用,如 shrink)。 */
  wrapperClassName?: string;
  /** 面板 aria-label(容器为 group 语义时可选)。 */
  panelAriaLabel?: string;
}

/** 是否处于 reduced-motion(SSR/jsdom 无 matchMedia 时按 false) */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

export function MorphPopover({
  open,
  onOpenChange,
  trigger,
  children,
  side = 'top',
  align = 'start',
  panelWidth,
  startBg = 'var(--composer-pill-bg)',
  startBorderColor = 'var(--border-default)',
  endBg = 'var(--model-dropdown-bg)',
  endBorderColor = 'var(--model-dropdown-border)',
  startRadius,
  panelClassName,
  wrapperClassName,
  panelAriaLabel,
}: MorphPopoverProps) {
  // mounted 独立于 open:关闭时先播收合动画,动画完再卸载 portal
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 收合焦点快照的 setTimeout(0) id:见收合分支注释(快照必须晚于浏览器默认聚焦)。
  const focusSnapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 开场双 rAF 的 id:关闭打断时必须取消,否则已排队的回调会在 open 已翻 false 后
  // 仍套用"打开几何 + opacity 1",菜单闪回一下(codex P2)。
  const openRaf1Ref = useRef<number | null>(null);
  const openRaf2Ref = useRef<number | null>(null);
  // 收合的回归几何 = 打开瞬间的 chip rect(开合期间 chip 布局不变,可安全复用)
  const chipRectRef = useRef<DOMRect | null>(null);
  // 初始形变是否已完成(ResizeObserver 只在其后接管,避免和开场动画打架)
  const settledRef = useRef(false);
  // 指针选择菜单动作时不把焦点归还 trigger:否则 trigger 的 focus tooltip 会压在
  // 动作打开的下一层弹窗上。键盘关闭仍按 §14.2 回焦。
  const pointerInteractionRef = useRef(false);

  const requestClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  if (open && !mounted) setMounted(true);

  /** 定宽量高。调用前必须已把 panel.style.transition 置为 'none'(红线 b)。 */
  const measure = useCallback(
    (panel: HTMLDivElement, chipRect: DOMRect) => {
      const prevW = panel.style.width;
      const prevH = panel.style.height;
      panel.style.height = 'auto';
      let desiredW: number;
      if (panelWidth) {
        desiredW = Math.max(panelWidth, chipRect.width);
      } else {
        panel.style.width = 'max-content';
        desiredW = Math.max(panel.offsetWidth, chipRect.width);
      }
      // 视口宽度钳制(窄窗 / split-pane 下 +菜单 360 / 权限 300 可能超视口):
      // 主钳制不超视口宽;次钳制不越过锚定对侧视口边(align='end' 右缘固定向左扩、
      // 'start' 左缘固定向右扩),floor 到 chip 宽保证脱身起点连贯。
      const viewportMaxW = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2);
      const sideAvailW =
        align === 'end'
          ? chipRect.right - VIEWPORT_PADDING
          : window.innerWidth - chipRect.left - VIEWPORT_PADDING;
      const targetW = Math.min(desiredW, viewportMaxW, Math.max(chipRect.width, sideAvailW));
      panel.style.width = `${targetW}px`;
      // 可视高度钳制:停靠位到视口边缘的可用空间(内容区自滚)。avail 夹到 ≥0——
      // chip 极靠近视口边(如 side='top' 且距顶 <14px)时 avail 会为负,负 height
      // 被浏览器静默忽略→面板停在 chip 高度"打不开"(greptile P1)。
      const avail =
        side === 'top'
          ? chipRect.top - SIDE_GAP - VIEWPORT_PADDING
          : window.innerHeight - chipRect.bottom - SIDE_GAP - VIEWPORT_PADDING;
      const targetH = Math.min(panel.offsetHeight, Math.max(0, avail));
      panel.style.width = prevW;
      panel.style.height = prevH;
      return { w: targetW, h: targetH };
    },
    [align, panelWidth, side],
  );

  /**
   * 把已展开面板无条件补量到内容最新尺寸。移植自 origin/main 2570230dc
   * (fix: close composer morph review gaps):opening 期间 RO 通知被 settledRef
   * gate 掉,若异步 capability / provider 列表恰在开场动画内返回、settle 后不再有
   * 新 RO 通知,面板会永久停在开场那一刻量到的旧尺寸。settle 时补量一次堵这个洞。
   * 位置由 right/bottom 锚点承接(align='end' 右缘固定、内容向左扩;side 决定纵向锚边),
   * 故只需重写 w/h,无需像 origin/main 版那样重定位 left。
   */
  const syncPanelToContent = useCallback(() => {
    const panel = panelRef.current;
    const rect = chipRectRef.current;
    if (!panel || !rect) return;
    const prevT = panel.style.transition;
    panel.style.transition = 'none';
    const m = measure(panel, rect);
    const curW = panel.offsetWidth;
    const curH = panel.offsetHeight;
    panel.style.width = `${curW}px`;
    panel.style.height = `${curH}px`;
    void panel.offsetHeight;
    panel.style.transition = prevT;
    // 差 1px 内不动,防 ResizeObserver 观察回环
    if (Math.abs(m.w - curW) <= 1 && Math.abs(m.h - curH) <= 1) return;
    panel.style.width = `${m.w}px`;
    panel.style.height = `${m.h}px`;
  }, [measure]);

  /** 面板锚到 chip 的形变起点几何(closed 视觉态:与 chip 重合的胶囊) */
  const applyChipGeometry = useCallback(
    (panel: HTMLDivElement, rect: DOMRect) => {
      panel.style.left = align === 'start' ? `${rect.left}px` : 'auto';
      panel.style.right = align === 'end' ? `${window.innerWidth - rect.right}px` : 'auto';
      panel.style.top = side === 'bottom' ? `${rect.top}px` : 'auto';
      panel.style.bottom = side === 'top' ? `${window.innerHeight - rect.bottom}px` : 'auto';
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      panel.style.borderRadius = `${startRadius ?? rect.height / 2}px`;
      panel.style.backgroundColor = startBg;
      panel.style.borderColor = startBorderColor;
      panel.style.boxShadow = '0 0 0 rgba(0,0,0,0)';
    },
    [align, side, startBg, startBorderColor, startRadius],
  );

  /** 停靠位的锚边值(脱身后面板贴靠的 top/bottom) */
  const dockedAnchor = useCallback(
    (rect: DOMRect) =>
      side === 'top'
        ? { prop: 'bottom' as const, value: window.innerHeight - rect.top + SIDE_GAP }
        : { prop: 'top' as const, value: rect.bottom + SIDE_GAP },
    [side],
  );

  /** 开合主流程:全部几何走 DOM 直写(避免 state 往返打断同帧测量) */
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const wrap = wrapRef.current;
    if (!mounted || !panel || !wrap) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);

    const reduced = prefersReducedMotion();

    if (open) {
      settledRef.current = false;
      pointerInteractionRef.current = false;
      const rect = wrap.getBoundingClientRect();
      chipRectRef.current = rect;
      // 1) 面板落到 chip 精确几何(与 chip 重合的起点),transition 关闭防测量污染。
      //    起点透明:面板与 chip 重叠的开场帧若不透明,会把 chip 内容盖没一下
      //    (2026-07-22 用户反馈"按钮闪烁");与位移耦合淡入,离开 chip 时已显形。
      panel.style.transition = 'none';
      applyChipGeometry(panel, rect);
      panel.style.opacity = '0';
      // 形变期间内容区禁滚:高度未长够时滚动条短暂出现会把行宽压窄 ~10px,
      // 高度到位后又弹回 —— 行尾元素(对勾/选中条)看起来往右抖一下
      // (2026-07-22 用户反馈)。动画完成(settle)后再开自滚。
      if (contentRef.current) contentRef.current.style.overflowY = 'hidden';
      panel.dataset.state = 'closed';
      // 开场解除 inert(收合分支置上):closed 态面板必须整体退出 tab order,见 else 分支。
      panel.inert = false;
      // 2) 定宽量高(transition 已关,量到的是真实终态排版)
      const m = measure(panel, rect);
      // 3) 回初始几何并强制 reflow,再恢复 transition
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      void panel.offsetHeight;
      panel.style.transition = reduced ? 'none' : MORPH_TRANSITION;
      // 4) 双 rAF 过渡:生长 + 脱身位移到停靠位(reduced-motion 时等效直切)。
      //    id 存起来,关闭打断时取消(见 else 分支 + cleanup),防菜单闪回。
      openRaf1Ref.current = requestAnimationFrame(() => {
        openRaf2Ref.current = requestAnimationFrame(() => {
          openRaf1Ref.current = null;
          openRaf2Ref.current = null;
          if (!panelRef.current) return;
          const dock = dockedAnchor(rect);
          panel.dataset.state = 'open';
          panel.style.width = `${m.w}px`;
          panel.style.height = `${m.h}px`;
          panel.style[dock.prop] = `${dock.value}px`;
          panel.style.borderRadius = '12px';
          panel.style.backgroundColor = endBg;
          panel.style.borderColor = endBorderColor;
          panel.style.boxShadow = 'var(--shadow-menu)';
          panel.style.opacity = '1';
        });
      });
      // 5) §14.2 焦点:autofocus 标记 → 首个 input → 首个可交互项(按钮/选项)→ 面板容器。
      //    无 input 的菜单(权限 / +)必须落到首个可交互项,否则键盘落在 role=group 容器上
      //    无法直接方向键/回车操作,可达性回退(codex P2)。
      const focusDelay = reduced ? 0 : MORPH_MS;
      closeTimerRef.current = setTimeout(() => {
        settledRef.current = true;
        if (contentRef.current) contentRef.current.style.overflowY = 'auto';
        // RO 在 opening 期间收到的尺寸变化不会在 settled 后自动重发,这里补量一次
        // (异步 capability / provider 列表在开场动画内返回时防面板卡旧尺寸)。
        syncPanelToContent();
        const target =
          panel.querySelector<HTMLElement>('[data-morph-autofocus]:not([disabled])') ??
          panel.querySelector<HTMLElement>('input, textarea') ??
          panel.querySelector<HTMLElement>(
            'button:not([disabled]), [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [tabindex]:not([tabindex="-1"])',
          ) ??
          panel;
        target.focus({ preventScroll: true });
      }, focusDelay);
    } else {
      // 收合:缩回 chip 几何并整体淡出(与位移耦合的溶解,防末帧空胶囊盖住
      // chip 文字),动画完卸载并归还焦点。先取消可能仍在排队的开场 rAF,
      // 否则它会在 open 已 false 后套用"打开几何 + opacity 1",菜单闪回。
      if (openRaf1Ref.current !== null) cancelAnimationFrame(openRaf1Ref.current);
      if (openRaf2Ref.current !== null) cancelAnimationFrame(openRaf2Ref.current);
      openRaf1Ref.current = null;
      openRaf2Ref.current = null;
      settledRef.current = false;
      // 收合目标几何 = trigger chip 的**当前**位置/尺寸(脱身上浮下 chip 全程可见,可实测)。
      // 不能复用打开瞬间的 chipRectRef:开着期间 trigger 可能变(换模型/权限、±引用目录改 ×N
      // chip 宽),复用旧 rect 会让面板往错位置/旧尺寸缩(codex P2)。0 宽兜底回旧 rect。
      const liveRect = wrap.getBoundingClientRect();
      const rect = liveRect.width > 0 ? liveRect : chipRectRef.current;
      if (rect) chipRectRef.current = rect;
      const reducedClose = reduced || !rect;
      panel.dataset.state = 'closed';
      if (contentRef.current) contentRef.current.style.overflowY = 'hidden';
      if (rect) applyChipGeometry(panel, rect);
      panel.style.opacity = '0';
      // 焦点归还判定(§14.2)延迟一拍快照,不在本 layout effect 里同步做:outside
      // pointerdown 走 capture 先触发关闭,浏览器把焦点移交给被点控件的默认动作发生在
      // 事件派发结束之后 —— 同步快照会误判"焦点还在面板内",动画完抢回 trigger,偷走
      // 用户刚点的控件焦点(codex P2)。setTimeout(0) 落在默认聚焦之后:此刻焦点仍在
      // 面板 / trigger 内 = 键盘关闭(Enter/Space 选项、Esc、点 trigger 收起)→ 归还
      // trigger;已被外部控件 / body 接走(点空白、动作交接)→ 不抢回,避免点空白
      // 关闭后凭空冒 trigger 的 tooltip。
      let ownedFocusAtClose = false;
      focusSnapTimerRef.current = setTimeout(() => {
        focusSnapTimerRef.current = null;
        const active = document.activeElement;
        ownedFocusAtClose =
          !pointerInteractionRef.current &&
          active instanceof Node && (panel.contains(active) || wrap.contains(active));
        // 快照之后才上 inert(inert 会立刻 blur 面板内焦点,先上会破坏上面的判定):
        // pointer-events-none 只挡鼠标不挡 Tab,键盘用户 Esc/选完后立刻 Tab 会摸进
        // 隐形面板里的按钮/选项(codex P2)。inert 把收合余辉整体移出 tab order 与辅助树。
        panel.inert = true;
      }, 0);
      closeTimerRef.current = setTimeout(
        () => {
          setMounted(false);
          if (ownedFocusAtClose) {
            const active = document.activeElement;
            const focusClaimedElsewhere =
              active instanceof Node &&
              active !== document.body &&
              !panel.contains(active) &&
              !wrap.contains(active);
            if (!focusClaimedElsewhere) {
              wrap.querySelector<HTMLElement>('button, [tabindex]')?.focus({
                preventScroll: true,
              });
            }
          }
        },
        reducedClose ? 0 : MORPH_MS + 20,
      );
    }
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (focusSnapTimerRef.current) clearTimeout(focusSnapTimerRef.current);
      if (openRaf1Ref.current !== null) cancelAnimationFrame(openRaf1Ref.current);
      if (openRaf2Ref.current !== null) cancelAnimationFrame(openRaf2Ref.current);
    };
  }, [mounted, open, measure, applyChipGeometry, dockedAnchor, endBg, endBorderColor, syncPanelToContent]);

  /** 打开稳定后跟随内容尺寸变化(搜索过滤 / Edit 面板展宽),同曲线平滑过渡 */
  useEffect(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!mounted || !open || !panel || !content || typeof ResizeObserver === 'undefined') return;
    let roRaf = 0;
    const ro = new ResizeObserver(() => {
      // RO 回调内直接写布局会触发 "ResizeObserver loop completed with
      // undelivered notifications" 告警 —— 推迟到下一帧,合并同帧通知
      if (roRaf) return;
      roRaf = requestAnimationFrame(() => {
        roRaf = 0;
        // settle 前不跟随(和开场动画抢几何);settle 后走同一条补量逻辑
        if (!settledRef.current) return;
        syncPanelToContent();
      });
    });
    ro.observe(content);
    return () => {
      if (roRaf) cancelAnimationFrame(roRaf);
      ro.disconnect();
    };
  }, [mounted, open, syncPanelToContent]);

  /** 打开期间的全局关闭手势:outside pointerdown / Esc(分层) / 窗口 resize */
  useEffect(() => {
    if (!mounted || !open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || wrapRef.current?.contains(t)) return;
      // 面板内容可能再弹 Radix 浮层(portal 到 body,如模型行的 effort/Fast 配置
      // 子面板)——点它不算 outside,否则子面板永远点不了(整个面板会先被关掉)
      if ((t as Element).closest?.('[data-radix-popper-content-wrapper]')) return;
      requestClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        pointerInteractionRef.current = false;
      }
      if (e.key !== 'Escape') return;
      pointerInteractionRef.current = false;
      // 分层关闭(必须 capture,原因见文件头注释)
      if (document.querySelector('[data-radix-popper-content-wrapper] [role="dialog"]')) return;
      // Esc 时焦点仍在面板内,收合分支的 shouldRestoreFocus 会据此归还 trigger(§14.2)
      requestClose();
    };
    // 焦点离开交互层则关闭:键盘用户 Tab 出开着的 + / 权限菜单后,菜单不该继续浮在
    // 已聚焦到背后控件的上方(codex P2)。面板 / trigger / 嵌套 Radix 浮层内不算离开;
    // 焦点回到 body(如面板卸载瞬间)也不关。焦点被用户主动移走→不回焦 trigger。
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || target === document.body) return;
      if (panelRef.current?.contains(target) || wrapRef.current?.contains(target)) return;
      if ((target as Element).closest?.('[data-radix-popper-content-wrapper]')) return;
      requestClose();
    };
    const onResize = () => requestClose();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('resize', onResize);
    };
  }, [mounted, open, requestClose]);

  return (
    <>
      <span
        ref={wrapRef}
        className={cn('relative inline-flex', wrapperClassName)}
        onPointerDownCapture={() => {
          pointerInteractionRef.current = true;
        }}
      >
        {trigger}
      </span>
      {mounted &&
        createPortal(
          <div
            ref={panelRef}
            data-state="closed"
            // 停靠侧外显:本组件按请求侧钳高、不做碰撞翻转,选错侧会开成截断/零高,
            // 而 jsdom 无布局引擎测不出几何 —— 暴露出来让调用方的选侧决策可被断言。
            data-morph-side={side}
            role="group"
            aria-label={panelAriaLabel}
            tabIndex={-1}
            onPointerDownCapture={() => {
              pointerInteractionRef.current = true;
            }}
            // data-[state=closed]:pointer-events-none —— 收合动画期间面板已透明但仍以
            // position:fixed 覆盖视口,不加会拦住底下点击(选完项 / Esc 后那 300ms)。
            className="group fixed z-50 overflow-hidden border outline-none data-[state=closed]:pointer-events-none"
            // 初始几何由 useLayoutEffect 直写;这里只兜首帧不可见位置
            style={{ left: -9999, bottom: -9999 }}
          >
            {/* 面板内容: 随生长淡入(50ms 延迟 + 5px 浮入);形变期禁滚(防滚动条
                闪现挤压行宽),settle 后由 JS 切回自滚 */}
            <div
              ref={contentRef}
              className={cn(
                'max-h-full overflow-y-hidden',
                side === 'top' ? 'translate-y-[5px]' : 'translate-y-[-5px]',
                'opacity-0 transition-[opacity,transform] delay-[50ms] duration-[140ms] ease-out',
                'group-data-[state=open]:translate-y-0 group-data-[state=open]:opacity-100',
                'motion-reduce:transition-none',
                panelClassName,
              )}
            >
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
