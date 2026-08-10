/**
 * FileTabsBar — VSCode 风格已打开文件 tab 条。
 *
 * Layout：
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ [icon name ×][icon name ×][icon name ×] ...        scroll →│
 *   └────────────────────────────────────────────────────────────┘
 *
 * 行为：
 *   - 点击 tab → 切换 active（更新 URL ?file=）。
 *   - 点击 × → 关闭 tab；若关闭的是 active：依次尝试 next / prev / 清空。
 *   - 横向溢出 → overflow-x-auto，鼠标滚轮 / 拖拽自然滚动。
 *   - 拖拽重排 → 手写 mousedown/mousemove/mouseup,5px 阈值激活,
 *     放置位置 = 目标 tab 中线左/右半区。不走 HTML5 dnd —— Electron Windows
 *     上 app-region:drag 即便做成 sibling overlay 也会让 dragstart 失效,
 *     手写实现绕开整套机制(详见 handleTabMouseDown 注释)。
 *   - 右键 tab → 上下文菜单：复制路径 / 关闭 / 关闭其他 / 关闭右侧 /
 *     关闭左侧 / 关闭所有(共用 closeMany,active dirty 时仍走 onBeforeClose)。
 *
 * 状态：tab 列表来自 openTabsStore（per-workdir 持久化）；active 仍由 URL
 * `?file=` 决定 — 与现有 Sidebar / Route 保持单一信源一致。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsLeft, ChevronsRight, Clipboard, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { pickFileIcon } from './lib/fileIcon';
import { useOpenTabs } from './hooks/useOpenTabs';
import { getTabs as storeGetTabs } from './lib/openTabsStore';
import { clearFileScroll } from './lib/fileScrollStore';
import { toOsAbsolutePath } from './lib/fileMeta';

const log = createLogger('cc-agent.workdir-browse.file-tabs-bar');

// 右键菜单视口边界 padding / 估算尺寸 —— 与 FileBodyView 同套数,菜单不会
// 顶到屏幕边或被截断。菜单 6 个 item × 28px + padding ≈ 184。
const CONTEXT_MENU_VIEWPORT_PADDING = 8;
const CONTEXT_MENU_ESTIMATED_WIDTH = 192;
const CONTEXT_MENU_ESTIMATED_HEIGHT = 220;

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  const maxX = Math.max(
    CONTEXT_MENU_VIEWPORT_PADDING,
    window.innerWidth - CONTEXT_MENU_ESTIMATED_WIDTH - CONTEXT_MENU_VIEWPORT_PADDING,
  );
  const maxY = Math.max(
    CONTEXT_MENU_VIEWPORT_PADDING,
    window.innerHeight - CONTEXT_MENU_ESTIMATED_HEIGHT - CONTEXT_MENU_VIEWPORT_PADDING,
  );
  return {
    x: Math.min(Math.max(CONTEXT_MENU_VIEWPORT_PADDING, x), maxX),
    y: Math.min(Math.max(CONTEXT_MENU_VIEWPORT_PADDING, y), maxY),
  };
}

export interface FileTabsBarProps {
  workdir: string;
  /** 当前 URL ?file= 指向的文件；null 表示无选中。 */
  activePath: string | null;
  /** 用户点击 tab 或关闭后转移焦点 → 把 ?file= 设为该 path。 */
  onActivate: (relPath: string) => void;
  /** 批量关闭场景下,active tab 被关后切到 next 时调用。语义和 onActivate 一致
   *  (写 URL + saveSelectedFile + storeAddTab),但**跳过 dirty switch-away
   *  确认** —— 因为用户在 onBeforeClose 那一步已经明确选择了"不保存"丢弃改动,
   *  再走一遍 dirty 二次确认是冗余的:用户取消的话,closeMany 已经 closeTabs
   *  把 active path 从 store 删了,但 URL 还停在原 path,造成 tab/URL 错位。
   *  未传时 fallback 到 onActivate(行为退化为可能弹二次 dialog,与之前一致)。 */
  onActivateAfterClose?: (relPath: string) => void;
  /** 关闭最后一个 tab 或关闭 active 且无邻居时调用 → 清空 ?file=。 */
  onClear: () => void;
  /** 关闭 tab 前的 async 拦截器。返回 false 则取消关闭。典型场景:active tab
   *  对应文件正在编辑且 dirty,宿主弹 "保存 / 不保存 / 取消" 三选一。未传时
   *  关闭直接进行,与原行为一致。 */
  onBeforeClose?: (relPath: string) => Promise<boolean>;
  /** 右侧聊天流当前是否折叠。传了就在 bar 最右挂"折叠/展开"按钮(VSCode 风格)。
   *  未传则不渲染按钮,bar 保持纯 tab 滚动行为不变。 */
  isChatRailCollapsed?: boolean;
  /** 用户点折叠按钮 → 宿主切换 collapse state(persist + 触发 rail 宽度动画)。
   *  必须和 isChatRailCollapsed 配对传入。 */
  onToggleChatRail?: () => void;
}

interface DropIndicator {
  /** 目标 tab 的 idx（即将被插入的那个 idx 之前的"缝"）。 */
  insertAt: number;
}

interface ContextMenuState {
  /** 屏幕坐标(client X/Y),用于虚拟 anchor 定位。 */
  pos: { x: number; y: number };
  /** 被右键的 tab path。"关闭右侧 / 左侧"在菜单 render 里用 tabs.indexOf(relPath)
   *  实时反查位置,不冻结 idx —— 防止右键和点菜单之间 tabs 被外部改动导致
   *  idx 漂移、误关右键的 tab 自身。 */
  relPath: string;
}

interface DragGhost {
  /** 当前光标位置(client X/Y),浮动 ghost 跟随它定位。 */
  x: number;
  y: number;
  /** 被拖动 tab 的 relPath,用来在 ghost 里渲染图标+文件名。 */
  relPath: string;
}

export function FileTabsBar({
  workdir,
  activePath,
  onActivate,
  onActivateAfterClose,
  onClear,
  onBeforeClose,
  isChatRailCollapsed,
  onToggleChatRail,
}: FileTabsBarProps) {
  const { t } = useTranslation();
  const { tabs, closeTabs, reorderTabs } = useOpenTabs(workdir);
  const [dragSrcIdx, setDragSrcIdx] = useState<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 拖拽时挂在 window 上的 mousemove/mouseup/blur 监听清理函数。handleTabMouseDown
  // 设置,onUp/onBlur 清空。组件 unmount 时由下方 useEffect 兜底调用,避免拖拽
  // 中导航走时监听器 leak 到 window。
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // Esc / 任意 pointerdown 关闭右键菜单(类比 FileBodyView 的菜单关闭策略,
  // 这里不接 Radix DropdownMenu —— Radix 的虚拟 trigger 在父级有 contain:layout
  // 时定位会偏掉,实测见 [[fix-tab-context-menu]];改用 createPortal 直挂 body,
  // 自己接 outside-click / Esc 即可)。
  useEffect(() => {
    if (contextMenu === null) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // 右键菜单的锚点 tab 被外部移除(sidebar 删文件 / 其它 tab 同 path 关闭等)时
  // 自动关菜单 —— 否则菜单残留 + m.idx 已和 tabs 不对齐,会让"关闭右侧/左侧"
  // 算到错误的 idx 上(典型场景 [P1]:打开 [A,B,C,D,E] 右键 D(idx=3)→ 期间
  // sidebar 在 D 前插一个 X → tabs 变成 [A,B,C,X,D,E],原 idx 3 现在指向 X,
  // "关闭右侧"会从 X 之后切到 D,把右键的 D 自己也关掉)。
  useEffect(() => {
    if (contextMenu && !tabs.includes(contextMenu.relPath)) {
      setContextMenu(null);
    }
  }, [tabs, contextMenu]);

  // 组件 unmount 时强制清理拖拽中的 window 监听 —— 避免拖到一半切换路由时
  // mousemove / mouseup / blur 永远 leak 在 window 上(再次进入页面时,残留
  // 监听仍会响应,触发陈旧 setState)。
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);
  // 每个 tab 的 DOM 节点 —— 切换 active 时滚动入视用。Map 而不是数组,避免
  // tab 列表重排/删除后的 idx 漂移。
  const tabRefs = useRef(new Map<string, HTMLDivElement>());

  // active 变化时(点击 tab / 从 sidebar 选文件 / URL 恢复)瞬切到目标 tab。
  // 全程直接写 scrollLeft,不走 scrollIntoView —— 绕开任何 scroll-behavior CSS
  // 引发的动画。doc 模式下用户切文件应该是 "瞬时定位",滚动动效反而是干扰。
  // 留 PEEK_PX 缓冲 → 目标 tab 不会贴死边,旁边还有 tab 时露出 "下一个一半",
  // 提示用户还能继续滚 (无 scrollbar 场景下的视觉补偿)。
  useEffect(() => {
    if (!activePath) return;
    const el = tabRefs.current.get(activePath);
    const scroller = scrollRef.current;
    if (!el || !scroller) return;
    const PEEK_PX = 32;
    const tabLeft = el.offsetLeft;
    const tabRight = tabLeft + el.offsetWidth;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    if (tabLeft < viewLeft) {
      const peek = tabLeft > 0 ? PEEK_PX : 0;
      scroller.scrollLeft = Math.max(0, tabLeft - peek);
    } else if (tabRight > viewRight) {
      const peek = tabRight < scroller.scrollWidth ? PEEK_PX : 0;
      scroller.scrollLeft = Math.min(maxScroll, tabRight - scroller.clientWidth + peek);
    }
  }, [activePath]);

  if (tabs.length === 0 && !onToggleChatRail) {
    // 没有任何 tab + 宿主没传聊天流折叠按钮:不渲染条,避免占额外纵向高度。
    // (有折叠按钮时, 即便 tabs 为空也保留 bar —— 否则用户在"未打开任何文件"
    // 状态下没法收/展开右侧聊天流, 体验断档。)
    return null;
  }

  function handleTabClick(relPath: string): void {
    if (relPath !== activePath) onActivate(relPath);
  }

  // 批量关闭(单 × / Close Others / All / Left / Right 全复用这一个)。
  // dirty 拦截:实测 FileBodyView 只在 active tab 挂载,其它 tab 没有 dirty,
  // 所以只要关闭集合命中 activePath 就过一次 onBeforeClose 即可,不需要 N 次。
  async function closeMany(pathsToClose: readonly string[]): Promise<void> {
    if (pathsToClose.length === 0) return;
    const closeSet = new Set(pathsToClose);
    const activeIsClosing = activePath !== null && closeSet.has(activePath);
    if (activeIsClosing && onBeforeClose && activePath) {
      const ok = await onBeforeClose(activePath);
      if (!ok) return;
    }
    // 计算 next active —— 必须用 live store 而不是 closure 里的 tabs。
    // 原因:onBeforeClose 是 async,等 dialog 那段时间 tabs 可能被外部改动
    // (sidebar 打开新文件 / 别处 close / rename 等),闭包快照已过时。典型故障:
    // tabs=[A,B*,C] 关 All → dialog 期间加 D → 用户确认 → 闭包 tabs 仍 [A,B,C]
    // 算出 onClear,但 bar 里其实还有 D。
    // closeTabs(pathsToClose) 走 store 操作 live 状态,不受影响。
    const liveTabs = storeGetTabs(workdir);
    if (activeIsClosing && activePath) {
      const oldIdx = liveTabs.indexOf(activePath);
      let next: string | null = null;
      // 选择策略:从原 active 位置出发,优先右邻居 → 左邻居 → onClear。
      for (let i = oldIdx + 1; i < liveTabs.length; i++) {
        if (!closeSet.has(liveTabs[i])) {
          next = liveTabs[i];
          break;
        }
      }
      if (!next) {
        for (let i = oldIdx - 1; i >= 0; i--) {
          if (!closeSet.has(liveTabs[i])) {
            next = liveTabs[i];
            break;
          }
        }
      }
      // 优先走 onActivateAfterClose 跳过 dirty switch-away 二次确认 ——
      // 用户在上面 onBeforeClose 已选过"不保存",再问一遍冗余,且若用户在
      // 二次 dialog 上 cancel 而我们没 await,下面 closeTabs 仍会执行,造成
      // tabs 已删 active 但 URL 还指向它的错位状态(greptile / Codex 第二轮 P2)。
      // 宿主未传 onActivateAfterClose 时 fallback 回 onActivate,行为不变。
      if (next) (onActivateAfterClose ?? onActivate)(next);
      else onClear();
    }
    for (const p of pathsToClose) clearFileScroll(workdir, p);
    closeTabs(pathsToClose);
  }

  // 单 tab × 关闭 = 批量关闭一个元素 —— 共用 closeMany 走 live tabs 计算 next
  // active,避免 onBeforeClose dialog 期间 tabs 被外部改动后用闭包陈旧值
  // (greptile review 第二轮 P1)。e.stopPropagation 防止冒泡触发外层 click。
  async function handleClose(e: React.MouseEvent, relPath: string): Promise<void> {
    e.stopPropagation();
    await closeMany([relPath]);
  }

  async function handleCopyPath(relPath: string): Promise<void> {
    const abs = toOsAbsolutePath(workdir, relPath);
    try {
      await navigator.clipboard.writeText(abs);
      toast.success(t('ccAgent.workdirBrowse.pathCopied'));
    } catch (err) {
      log.warn('clipboard write failed', err);
      toast.warning(t('ccAgent.workdirBrowse.copyFailed'));
    }
  }

  // 拖拽重排:手写 mousedown/mousemove/mouseup 实现,不走 HTML5 dnd ——
  // Electron 上 app-region:drag 即便做成 absolute sibling overlay,Windows 平台
  // 也会让 tab 内的 HTML5 dragstart 失效(实测确认);手写实现绕开整套机制。
  // 顺带能彻底回避 Radix Tooltip / Slot 与 native draggable 的潜在交互。
  // 流程:
  //   1. mousedown:记录起点,挂 window 级 mousemove/mouseup
  //   2. mousemove:位移 < 5px → 视为点击抖动,什么都不做;>= 5px 进入拖拽态
  //      (设 dragSrcIdx → tab 半透明)。每次移动按光标 X 对照各 tab rect 中线
  //      算 insertAt,刷 dropIndicator 显示插入指示线
  //   3. mouseup:未进入拖拽态 → 让 click 正常走;已拖拽 → 抑制随之而来的 click
  //      防止落点 tab 被误切 active,提交 reorder
  function handleTabMouseDown(e: React.MouseEvent<HTMLDivElement>, idx: number): void {
    if (e.button !== 0) return; // 只接受鼠标左键,右键交给 onContextMenu
    // 起点落在 button 后代上(目前 tab 内唯一的 button 是 × 关闭按钮) → 不进入
    // drag 流程,让 mousedown / click 自然派发到那个按钮。否则用户按 × 时如果
    // 手稍微抖一下(>5px),onUp 会误判为 drag → suppressClick 把 × 的 click
    // 吞掉,关不掉 tab(Codex review 第五轮 P2)。
    if ((e.target as HTMLElement | null)?.closest('button') !== null) return;
    // 拦默认 —— 否则浏览器会在 mousedown+mousemove 时启动文本选区(实测 tab
    // 内文件名会被选中),不仅视觉上很乱,且选区有时还会盖过我们的 mousemove
    // 追踪。preventDefault 不影响后续 click 派发(click 由 mouseup 决定),所以
    // "未越 5px 阈值"那条 fallback 路径仍能正常切 tab。
    e.preventDefault();
    // 同一 mousedown 多次触发或上一次 drag 没正常结束(理论不应该,防御一下)
    // → 先清旧的再装新的。
    dragCleanupRef.current?.();

    const startX = e.clientX;
    const startY = e.clientY;
    const srcIdx = idx;
    // tabs 在拖拽过程中不会重排(只有 mouseup 才提交 reorder),这里取一次
    // 即可,不必每次 onMove 重读。
    const srcRelPath = tabs[idx];
    let active = false;
    let pendingInsertAt: number | null = null;

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
    };

    const onMove = (ev: MouseEvent) => {
      if (!active) {
        const dx = Math.abs(ev.clientX - startX);
        const dy = Math.abs(ev.clientY - startY);
        if (dx < 5 && dy < 5) return;
        active = true;
        setDragSrcIdx(srcIdx);
      }
      // 浮动 ghost 跟随光标(VSCode 风格视觉:原 tab 半透明留在原位,一个
      // 透明 pill 紧跟鼠标显示图标 + 文件名,作为"我现在拖的是什么"的提示)。
      setDragGhost({ x: ev.clientX, y: ev.clientY, relPath: srcRelPath });
      // 计算插入位置:遍历 tab,光标 X 在哪个 tab rect 中线之前 → insertAt = i;
      // 都没命中 → 落到末尾(tabs.length)。
      let insertAt = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const el = tabRefs.current.get(tabs[i]);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (ev.clientX < rect.left + rect.width / 2) {
          insertAt = i;
          break;
        }
      }
      if (pendingInsertAt !== insertAt) {
        pendingInsertAt = insertAt;
        setDropIndicator({ insertAt });
      }
    };

    const onUp = () => {
      cleanup();
      dragCleanupRef.current = null;
      if (!active) {
        // 未拖拽 → 让随后的 click 正常触发(切 active tab)
        return;
      }
      // 拖拽结束:抑制随之而来的 click,防止落点 tab 被误切 active。
      // 用 capture: true 在最早期截获 + 一次性消费。
      const suppressClick = (clickEv: MouseEvent) => {
        clickEv.preventDefault();
        clickEv.stopPropagation();
        window.removeEventListener('click', suppressClick, true);
      };
      window.addEventListener('click', suppressClick, true);
      // mouseup 后浏览器最多再派发一次 click;100ms 兜底清理避免吞掉用户后续点击。
      window.setTimeout(() => window.removeEventListener('click', suppressClick, true), 100);

      if (pendingInsertAt !== null) {
        // splice 语义:先移除 src,再 insertAt 处插入。所以 src < insertAt 时
        // 实际目标 idx 要 -1。
        let target = pendingInsertAt;
        if (srcIdx < target) target -= 1;
        if (target !== srcIdx) reorderTabs(srcIdx, target);
      }
      setDragSrcIdx(null);
      setDropIndicator(null);
      setDragGhost(null);
    };

    // 窗口失焦 → 取消拖拽,不提交 reorder。否则用户 Alt-Tab / 最小化时
    // mouseup 永不在 window 上派发,ghost 和半透明态会卡住,直到下次点击才解。
    const onBlur = () => {
      cleanup();
      dragCleanupRef.current = null;
      if (active) {
        setDragSrcIdx(null);
        setDropIndicator(null);
        setDragGhost(null);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onBlur);
    dragCleanupRef.current = cleanup;
  }

  // 鼠标 wheel 直接转横向滚动 (vscode tabs 体验) ——
  // 非 shift + deltaY 时把它加到 scrollLeft, 拦默认避免页面被一起滚。
  function handleWheel(e: React.WheelEvent<HTMLDivElement>): void {
    const el = scrollRef.current;
    if (!el) return;
    if (e.shiftKey || e.deltaX !== 0) return; // 用户已经用 shift 或 trackpad 横向 → 不接管
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0) return; // 没溢出, 让默认行为走 (理论上也没什么好滚的)
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }

  return (
    <div
      className={cn(
        // 外层结构:固定高度 + 边框 + 底色, 不参与滚动。tab 滚动放到内层 scroller,
        // 折叠聊天流按钮 sticky 在右边永远可见(对齐 SessionTabsBar 的 + 按钮布局)。
        'flex h-9 w-full shrink-0 items-stretch',
        'border-b border-[var(--cmd-palette-border)]',
        // bg 跟中栏 (bg-background) 一致,跟左右两侧的 --sidebar 区分;
        // active tab 的 bg 仍用专属灰色保持选中态可见。
        'bg-background',
      )}
      // 窗口拖拽区:WINDOW_DRAG_STYLE 必须挂在外层,tab / 按钮作为**后代**用
      // WINDOW_NO_DRAG_STYLE 挖洞 —— ContentHeader.tsx:97-99 已写明 Electron
      // 拖拽区挖洞**只在 drag 元素自己的后代**上可靠生效,浮层(非后代/sibling)
      // 的 no-drag 不被计入(Codex review 第三轮 P1 指正,之前我做成 absolute
      // sibling overlay 在 macOS 上会导致 tab/按钮的 mousedown 被吞成窗口拖拽)。
      // 之前担心的 Electron Windows 上 HTML5 dragstart 失效问题已不存在 ——
      // 拖拽重排已重写为手写 mousedown 实现,与 HTML5 drag 链路无关。
      // mac 上 doc 模式不渲染通用 ContentHeader,tab 条整行承担窗口拖拽,空白处
      // 可拖窗口;Windows 上系统标题栏常驻是纯增益(参见 windowDrag.tsx 末段)。
      style={WINDOW_DRAG_STYLE}
    >
      <div
        ref={scrollRef}
        className={cn(
          // 内层滚动区:横向溢出由这里接管。scrollbar 直接隐掉(workdir-tabs-scroll
          // 的 ::-webkit-scrollbar { display:none }),用户通过 wheel/trackpad
          // 横向滚动,不出现可见的滚动条 —— 之前几次 overlay 尝试都有视觉副作用,
          // 干脆不显示。
          'min-w-0 flex-1 flex items-center overflow-x-auto overflow-y-hidden',
          'workdir-tabs-scroll',
        )}
        onWheel={handleWheel}
      >
        {tabs.map((relPath, idx) => {
        const name = relPath.split('/').pop() ?? relPath;
        const Icon = pickFileIcon(name);
        const isActive = relPath === activePath;
        const isDragging = dragSrcIdx === idx;
        const showInsertBefore = dropIndicator?.insertAt === idx && dragSrcIdx !== idx;
        const showInsertAfter =
          dropIndicator?.insertAt === idx + 1 && dragSrcIdx !== idx && dragSrcIdx !== idx + 1;
        return (
          <Tip key={relPath} text={relPath} mono side="bottom" delay={400}>
            <div
              ref={(node) => {
                if (node) tabRefs.current.set(relPath, node);
                else tabRefs.current.delete(relPath);
              }}
              style={WINDOW_NO_DRAG_STYLE}
              onMouseDown={(e) => handleTabMouseDown(e, idx)}
              onClick={() => handleTabClick(relPath)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ pos: clampMenuPosition(e.clientX, e.clientY), relPath });
              }}
              className={cn(
                'group/tab relative flex h-9 shrink-0 items-center gap-1.5 px-3',
                'border-r border-[var(--cmd-palette-border)]',
                // select-none —— 配合 handleTabMouseDown 里的 preventDefault,
                // 确保拖动 tab 时不会顺手选中文件名文本(双保险:CSS 兜住 +
                // JS 拦截默认行为)。
                'cursor-pointer text-12 transition-colors select-none',
                isActive
                  ? // active = hover 的底色 + 字重稍重；不加顶部 accent 线
                    'bg-[var(--chat-input-chip-bg)] text-foreground font-medium'
                  : 'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--chat-input-chip-bg)] hover:text-foreground',
                isDragging && 'opacity-50',
              )}
            >
              {/* 拖拽插入位置指示线 */}
              {showInsertBefore && (
                <span
                  aria-hidden
                  className="absolute left-0 top-0 h-full w-[2px] bg-sidebar-action-icon"
                />
              )}
              {showInsertAfter && (
                <span
                  aria-hidden
                  className="absolute right-0 top-0 h-full w-[2px] bg-sidebar-action-icon"
                />
              )}
              <Icon
                size={14}
                strokeWidth={1.75}
                className={cn(
                  'shrink-0',
                  isActive ? 'text-foreground' : 'text-[var(--cmd-palette-item-meta)]',
                )}
              />
              <span className="max-w-[180px] truncate">{name}</span>
              <button
                type="button"
                onClick={(e) => handleClose(e, relPath)}
                aria-label={t('ccAgent.workdirBrowse.tabClose', { name })}
                className={cn(
                  'ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded',
                  'text-[var(--cmd-palette-item-meta)]',
                  'opacity-0 transition-opacity duration-150',
                  'group-hover/tab:opacity-100 focus-visible:opacity-100',
                  isActive && 'opacity-100',
                  'hover:bg-[var(--cmd-palette-border)] hover:text-foreground',
                )}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          </Tip>
        );
      })}
      </div>

      {/* 右侧折叠按钮:sticky 在 tab 区右边, 不参与横向滚动。点击 → 切换右侧
          聊天流的展开/折叠状态(宿主走 useChatRailCollapsed.toggle, persist
          + 触发 rail 的 width transition)。
          尺寸 size-6 / Plus 14 / rounded-md / hover bg —— 与 SessionTabsBar 的
          + 按钮完全一致, 视觉上跟 doc 模式的另一侧按钮成对出现。
          border-l 把按钮区从横向滚动区视觉切开, 跟 SessionTabsBar 的 + 区同套
          做法, 避免最后一个 tab 滚到边缘时和按钮糊成一坨。
          icon 用 ChevronsRight / ChevronsLeft 区分两态: 小尺寸下双箭头比 Panel
          系列(panel + 内嵌 arrow)更干净, 方向语义也直白:
            - 展开态 → ChevronsRight, 暗示"点击 = 收到右边"
            - 折叠态 → ChevronsLeft,  暗示"点击 = 从右边拉回来"。 */}
      {onToggleChatRail && (
        <div className="flex shrink-0 items-center border-l border-[var(--cmd-palette-border)] px-1.5" style={WINDOW_NO_DRAG_STYLE}>
          <Tip
            text={isChatRailCollapsed ? t('ccAgent.workdirBrowse.chatRail.expand') : t('ccAgent.workdirBrowse.chatRail.collapse')}
            side="bottom"
            delay={300}
          >
            <button
              type="button"
              aria-label={isChatRailCollapsed ? t('ccAgent.workdirBrowse.chatRail.expand') : t('ccAgent.workdirBrowse.chatRail.collapse')}
              aria-pressed={!isChatRailCollapsed}
              onClick={onToggleChatRail}
              className={cn(
                'flex size-6 items-center justify-center rounded-md',
                'text-[var(--settings-section-desc)]',
                'hover:bg-[var(--chat-input-chip-bg)] hover:text-foreground',
                'transition-colors outline-none',
              )}
            >
              {isChatRailCollapsed ? (
                <ChevronsLeft size={14} strokeWidth={2} />
              ) : (
                <ChevronsRight size={14} strokeWidth={2} />
              )}
            </button>
          </Tip>
        </div>
      )}

      {/* 右键菜单 —— createPortal 到 document.body,绕开父层 [contain:layout]
          带来的 fixed-positioning 偏移(WorkdirBrowseRoute 的中栏有
          [contain:layout_paint_style],会把 position:fixed 的子节点改成相对
          自身定位,Radix DropdownMenu 的虚拟 trigger 在该上下文里位置会偏
          一个 sidebar 宽度)。Esc / outside-click 关闭由前面的 useEffect 处理。
          关闭操作复用 closeMany,active dirty 时仍走 onBeforeClose 拦截。 */}
      {contextMenu &&
        createPortal(
          (() => {
            const m = contextMenu;
            // 从 relPath 反查当前 tabs 里的真实位置 —— 不能直接用 m.idx
            // (右键时记录的快照值)。tabs 在右键和点菜单之间可能被外部改动
            // (sidebar 新建文件 / 别处 close / rename 等),用快照 idx 算
            // closeRight/closeLeft 会切错 tab,典型故障:[A,B,C,D,E] 右键 D
            // (m.idx=3) → tabs 变成 [A,B,C,X,D,E] → tabs.slice(3+1) 包含 D
            // 自己,误关右键的 D。
            // 上面的 useEffect 已经在 m.relPath 不在 tabs 里时主动清掉
            // contextMenu,这里走到的话 indexOf 一定 ≥ 0;为防御 race 再兜一层。
            const currentIdx = tabs.indexOf(m.relPath);
            if (currentIdx === -1) return null;
            const hasLeft = currentIdx > 0;
            const hasRight = currentIdx < tabs.length - 1;
            const hasOthers = tabs.length > 1;
            const itemCls =
              'flex h-7 w-full items-center rounded-md px-2.5 text-left text-13 leading-none text-[var(--msg-assistant-text)] hover:bg-[var(--cmd-palette-item-hover)] focus:bg-[var(--cmd-palette-item-hover)] focus:outline-none disabled:pointer-events-none disabled:opacity-45';
            // 菜单项的 onClick 在 onPointerDown 关闭菜单 之后 触发? 不是 ——
            // 我们在菜单容器上 stopPropagation pointerdown,避免外层 window
            // 监听把菜单收掉;但菜单内的 button 自身 click 仍可正常触发。
            const handleSelect = (action: () => void) => {
              setContextMenu(null);
              action();
            };
            return (
              <div
                role="menu"
                aria-orientation="vertical"
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  'fixed z-[9999] min-w-[176px] rounded-xl p-0.5 overflow-hidden',
                  'bg-[var(--cmd-palette-bg)]',
                  'border border-[var(--cmd-palette-border)]',
                  'shadow-[var(--shadow-menu)]',
                )}
                style={{ left: m.pos.x, top: m.pos.y }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={itemCls}
                  onClick={() => handleSelect(() => void handleCopyPath(m.relPath))}
                >
                  <Clipboard className="mr-2 h-3.5 w-3.5 shrink-0" />
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.tabMenu.copyPath')}</span>
                </button>
                <div className="my-1 h-px bg-[var(--cmd-palette-border)]" />
                <button
                  type="button"
                  role="menuitem"
                  className={itemCls}
                  onClick={() => handleSelect(() => void closeMany([m.relPath]))}
                >
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.tabMenu.close')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!hasOthers}
                  className={itemCls}
                  onClick={() =>
                    handleSelect(() => void closeMany(tabs.filter((p) => p !== m.relPath)))
                  }
                >
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.tabMenu.closeOthers')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!hasRight}
                  className={itemCls}
                  onClick={() => handleSelect(() => void closeMany(tabs.slice(currentIdx + 1)))}
                >
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.tabMenu.closeRight')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!hasLeft}
                  className={itemCls}
                  onClick={() => handleSelect(() => void closeMany(tabs.slice(0, currentIdx)))}
                >
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.tabMenu.closeLeft')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={itemCls}
                  onClick={() => handleSelect(() => void closeMany(tabs.slice()))}
                >
                  <span className="relative top-px">{t('ccAgent.workdirBrowse.tabMenu.closeAll')}</span>
                </button>
              </div>
            );
          })(),
          document.body,
        )}

      {/* 拖拽浮动 ghost —— VSCode 风格视觉反馈:原 tab 半透明留在原位
          (isDragging → opacity-50),光标跟随一个 pill 形状的 ghost 显示
          "正在拖什么"。createPortal 到 body 是因为父层 [contain:layout] 会
          把 fixed 的子节点改成相对自身定位,直接渲染会偏一个 sidebar 宽度
          (与右键菜单同根因)。pointer-events-none 让 ghost 不抢任何鼠标事件,
          x/y 偏移 +12 让 ghost 不直接盖住光标,与多数桌面端 drag preview
          的视觉惯例对齐。 */}
      {dragGhost &&
        createPortal(
          (() => {
            const name = dragGhost.relPath.split('/').pop() ?? dragGhost.relPath;
            const Icon = pickFileIcon(name);
            return (
              <div
                aria-hidden
                className={cn(
                  'fixed z-[10000] pointer-events-none',
                  'flex h-7 items-center gap-1.5 px-3 rounded-md',
                  'bg-[var(--chat-input-chip-bg)] text-foreground font-medium',
                  'border border-[var(--cmd-palette-border)]',
                  'shadow-[var(--shadow-menu)]',
                  'text-12 opacity-90',
                )}
                style={{ left: dragGhost.x + 12, top: dragGhost.y + 12 }}
              >
                <Icon
                  size={14}
                  strokeWidth={1.75}
                  className="shrink-0 text-foreground"
                />
                <span className="max-w-[180px] truncate">{name}</span>
              </div>
            );
          })(),
          document.body,
        )}
    </div>
  );
}
