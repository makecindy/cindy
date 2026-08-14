/**
 * AddTabDropdown — 「+」按钮的下拉菜单(对应设计稿 F5 dropdown)。
 *
 * 视觉对齐项目实际下拉规范(参考 `RolePillDropdown.tsx` 的 worker popover、
 * `RolePillDropdown.tsx` 的 WorkerLayoutMenu):
 * - 容器 12px 圆角 + 1px border-default + surface-elevated + shadow-menu, padding 4
 * - 分组头 10px / weight 500 / text-tertiary / px-2.5 pt-2 pb-1
 * - menu item 28px / rounded-lg(8px) / px-2.5 py-1.5 / text-12 / text-primary,
 *   hover bg-surface-hover, disabled opacity-50
 * - 分隔线 mx-1 my-1 h-px bg-border-default
 *
 * Phase 1 menu meta 硬编码;Phase 2 改从 TabKindRegistry 汇总。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  FileDiff,
  FolderTree,
  Globe,
  ListTodo,
  Smartphone,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TabKindId, TabKindMenuMeta } from './types';

const DROPDOWN_WIDTH = 220;
/** 视口两侧给 dropdown 留的呼吸空间。 */
const VIEWPORT_PADDING = 8;
/** anchor 底边到 dropdown 顶边的间距(原 mt-1)。 */
const ANCHOR_GAP = 4;

interface AddTabDropdownProps {
  /** 定位锚点:「+」按钮 wrapper。dropdown portal 到 body 后按它的 rect 摆位。 */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** 点 outside / Escape 关闭。 */
  onClose: () => void;
  /** 选 kind。调用方负责真创建 tab + 关闭 dropdown。单例 kind 已存在时
   *  host 应走 setActive,本组件不挡(host 知道 existing tab id)。 */
  onSelect: (kind: TabKindId) => void;
  /**
   * 当前 session bucket 已存在的 kind 集合。单例 kind 在此集合中时,
   * dropdown 改 trailing 文案为"已打开"并维持 enabled(点击 = host 切到现有)。
   */
  existingKinds?: ReadonlySet<TabKindId>;
  /** Host viewer is a public surface only while the product plugin is enabled. */
  iosSimulatorAvailable?: boolean;
}

// Phase 1 硬编码。Phase 2 之后由 plugin registry 自动汇总。
const MENU_ITEMS: TabKindMenuMeta[] = [
  {
    kind: 'file-browser',
    labelKey: 'rightSidebar.tabs.kinds.fileBrowser',
    icon: FolderTree,
    order: 10,
    enabled: true,
  },
  {
    kind: 'review',
    labelKey: 'rightSidebar.tabs.kinds.review',
    icon: FileDiff,
    order: 15,
    enabled: true,
    singleton: true,
  },
  {
    kind: 'subagents',
    labelKey: 'rightSidebar.tabs.kinds.subagents',
    icon: Bot,
    order: 16,
    enabled: true,
    singleton: true,
  },
  {
    kind: 'background-tasks',
    labelKey: 'rightSidebar.tabs.kinds.backgroundTasks',
    icon: ListTodo,
    order: 17,
    enabled: true,
    singleton: true,
  },
  {
    kind: 'web-browser',
    labelKey: 'rightSidebar.tabs.kinds.browser',
    icon: Globe,
    order: 20,
    enabled: true,
  },
  {
    kind: 'ios-simulator',
    labelKey: 'rightSidebar.tabs.kinds.iosSimulator',
    icon: Smartphone,
    order: 25,
    enabled: true,
  },
  {
    kind: 'terminal',
    labelKey: 'rightSidebar.tabs.kinds.terminal',
    icon: Terminal,
    order: 30,
    enabled: true,
  },
];

export function AddTabDropdown({
  anchorRef,
  onClose,
  onSelect,
  existingKinds,
  iosSimulatorAvailable = false,
}: AddTabDropdownProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  // 定位:portal 到 body + fixed,按 anchor rect 摆位。原实现是「+」wrapper 内的
  // absolute 元素,RSB 面板窄于 220px 时向左展开的部分会被 Shell 根容器的
  // overflow-hidden 直接裁掉(左圆角/边框消失)。portal 出去后 dropdown 浮在面板
  // 之上,只受视口约束 —— 与 radix DropdownMenuContent portal 到 body 的做法一致。
  //
  // 摆位规则:默认从 anchor 左边往右展开;右边装不下翻成右对齐(贴 anchor 右边
  // 向左展开);最后整体 clamp 进视口(两侧留 VIEWPORT_PADDING)。
  //
  // 跟随:portal 后菜单不再随面板布局流动,打开期间用 rAF 轮询 anchor rect ——
  // 位置变了(键盘触发的布局变化 / 面板换位 / 拖宽侧栏)同步重摆;anchor 从布局
  // 中消失(关掉最后一个 tab 面板收起)直接关闭,避免菜单悬空残留在旧坐标。
  // 每帧一次 getBoundingClientRect 只发生在菜单打开的短窗口内,成本可忽略。
  //
  // 用 useLayoutEffect 在 paint 之前完成首次定位,避免 1 帧"先冒出再挪位"的闪烁。
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    let raf = 0;
    // 主窗口内嵌形态的宿主 aside:收起时不 unmount 而是 w-0 + overflow-hidden
    // 保挂载(见 RightSidebar.tsx 规则 7 注释),此时 anchor 自身 rect 并不归零
    // (「+」wrapper shrink-0 仍有宽度),要靠 aside 的 data-pane-collapsed 状态
    // 判定。detached 子窗口没有这层 aside(closest 为 null),跳过该检测。
    const hostPane = anchorRef.current?.closest('[data-panel-drag-root="right-tabs"]');
    const track = () => {
      const anchor = anchorRef.current;
      const rect = anchor?.getBoundingClientRect();
      if (
        !anchor ||
        !rect ||
        (rect.width === 0 && rect.height === 0) ||
        hostPane?.hasAttribute('data-pane-collapsed')
      ) {
        onClose();
        return;
      }
      const alignRight = window.innerWidth - rect.left < DROPDOWN_WIDTH + VIEWPORT_PADDING;
      const raw = alignRight ? rect.right - DROPDOWN_WIDTH : rect.left;
      const maxLeft = window.innerWidth - DROPDOWN_WIDTH - VIEWPORT_PADDING;
      const left = Math.max(VIEWPORT_PADDING, Math.min(raw, maxLeft));
      const top = rect.bottom + ANCHOR_GAP;
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
      raf = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(raf);
  }, [anchorRef, onClose]);

  // 焦点:portal 在 body 末尾,原生 tab 序从「+」按钮出发够不到菜单,打开时把焦点
  // 落到第一个可用 menuitem 上(DESIGN.md 焦点规范:浮层打开焦点落主控件 —— 键盘
  // Enter/Space 打开后直接可再按 Enter 选中;鼠标打开时首项走 focus-visible,不会
  // 无端高亮)。
  //
  // 卸载时仅当焦点仍在菜单里时才还给「+」按钮(Escape / 选中菜单项的路径):⌘W
  // 归属按 activeElement 判定,焦点随菜单 DOM 摘除丢到 body 会让下一次 ⌘W 误关
  // 整个窗口。必须用 useLayoutEffect —— cleanup 在 DOM 摘除前运行,此时还能读到
  // "焦点是否在菜单内";点击菜单外时浏览器已先把焦点移走(不可聚焦区 → body),
  // 该场景下不 restore,⌘W 归属正确地跟随用户点击的区域(而不是被拽回右栏)。
  useLayoutEffect(() => {
    const menuEl = ref.current;
    const anchor = anchorRef.current;
    const firstItem = menuEl?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
    (firstItem ?? menuEl)?.focus();
    return () => {
      const active = document.activeElement;
      if (!menuEl || !menuEl.contains(active)) return;
      // 面板收起触发的关闭(如 ⌘W 关掉最后一个 tab):「+」已随宿主 aside 缩进
      // w-0 不可见,焦点还给它会落在不可见控件上 —— 跳过,让焦点自然回落。
      const pane = anchor?.closest('[data-panel-drag-root="right-tabs"]');
      if (pane?.hasAttribute('data-pane-collapsed')) return;
      anchor?.querySelector('button')?.focus();
    };
  }, [anchorRef]);

  // 点 outside / Escape 关闭(模式参考 RolePillDropdown 的 click-outside 实现)
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current || ref.current.contains(target)) return;
      // 「+」按钮自身不算 outside:mousedown 先 onClose、click 再 toggle 会把菜单
      // 重新打开,导致点「+」永远关不上;关闭交给按钮自己的 onClick toggle。
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const visibleItems = MENU_ITEMS.filter(
    (item) => item.kind !== 'ios-simulator' || iosSimulatorAvailable,
  );
  const enabled = visibleItems.filter((m) => m.enabled).sort((a, b) => a.order - b.order);
  const coming = visibleItems.filter((m) => !m.enabled).sort((a, b) => a.order - b.order);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      // 编程式容器焦点(见上方焦点 effect),不渲染 focus ring;Tab 离开菜单时关闭
      // (relatedTarget 为 null 的失焦交给 mousedown-outside / Escape 处理)。
      tabIndex={-1}
      // RSB 交互领地标记:MainLayout 的 ⌘W 归属判定(RSB_TERRITORY_SELECTOR)靠它
      // 识别 portal 到 body 的右栏浮层 —— 菜单打开期间 ⌘W 仍应关右栏 tab 而非窗口。
      data-rsb-territory=""
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !ref.current || ref.current.contains(next)) return;
        // 焦点移向「+」按钮不算离开:菜单打开时首项持有焦点,点「+」的 mousedown
        // 会先把焦点转移到按钮触发本 blur —— 这里关闭会让随后的 click toggle 把
        // 菜单重新打开("点 + 关不上"以 blur 路径回归)。关闭交给按钮 onClick。
        if (anchorRef.current?.contains(next)) return;
        onClose();
      }}
      className="fixed z-50 w-[220px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1 outline-none"
      style={{
        boxShadow: 'var(--shadow-menu)',
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // 首帧 pos 未测出前不可见,layoutEffect 同步定位后展示(paint 前,无闪烁)。
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <GroupHeader label={t('rightSidebar.tabs.menu.addLabel')} />
      {enabled.map((m) => {
        const alreadyOpen = m.singleton && existingKinds?.has(m.kind);
        return (
          <DropdownItem
            key={m.kind}
            icon={m.icon}
            label={t(m.labelKey)}
            trailing={
              alreadyOpen ? (
                <span className="text-10 text-[var(--text-tertiary)]">
                  {t('rightSidebar.tabs.menu.alreadyOpen')}
                </span>
              ) : undefined
            }
            onClick={() => onSelect(m.kind)}
          />
        );
      })}
      {coming.length > 0 && (
        <>
          <div className="mx-1 my-1 h-px bg-[var(--border-default)]" />
          <GroupHeader label={t('rightSidebar.tabs.menu.comingSoon')} />
          {coming.map((m) => (
            <DropdownItem key={m.kind} icon={m.icon} label={t(m.labelKey)} disabled />
          ))}
        </>
      )}
    </div>,
    document.body,
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-10 font-medium text-[var(--text-tertiary)]">
      {label}
    </div>
  );
}

function DropdownItem({
  icon: Icon,
  label,
  trailing,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // focus-visible 与 hover 同款背景:键盘打开时首项自动聚焦要有可见落点,
        // 鼠标交互不触发 focus-visible,无视觉噪音。
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-13 leading-snug text-[var(--text-primary)] transition-colors focus:outline-none focus-visible:bg-[var(--surface-hover)]',
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-[var(--surface-hover)]',
      )}
    >
      <Icon size={13} className="shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      {trailing}
    </button>
  );
}
