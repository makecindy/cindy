/**
 * AddTabDropdown — 「+」按钮的下拉菜单(对应设计稿 F5 dropdown)。
 *
 * 视觉对齐项目实际下拉规范(参考 `RolePillDropdown.tsx` 的 worker popover、
 * `RolePillDropdown.tsx` 的 WorkerLayoutMenu):
 * - 容器 12px 圆角 + 1px border-default + surface-elevated + shadow-menu, padding 4
 * - 分组头 10px / weight 500 / text-tertiary / px-2.5 pt-2 pb-1
 * - menu item 28px / rounded-lg(8px) / px-2.5 py-1.5 / text-[12px] / text-primary,
 *   hover bg-surface-hover, disabled opacity-50
 * - 分隔线 mx-1 my-1 h-px bg-border-default
 *
 * Phase 1 menu meta 硬编码;Phase 2 改从 TabKindRegistry 汇总。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDiff, FolderTree, Globe, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listGhostTabMenuMetas, useTabKindRegistryVersion } from './registry';
import type { TabKindId, TabKindMenuMeta } from './types';

const DROPDOWN_WIDTH = 220;
/** 视口右边给 dropdown 留的呼吸空间;<8 就翻成 right-0 向左展开。 */
const VIEWPORT_PADDING = 8;

interface AddTabDropdownProps {
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
    kind: 'web-browser',
    labelKey: 'rightSidebar.tabs.kinds.browser',
    icon: Globe,
    order: 20,
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

export function AddTabDropdown({ onClose, onSelect, existingKinds }: AddTabDropdownProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  // 视口边缘检测:默认 left-0 从 + 按钮往右展开;若右边空间不够 220 + 8,翻成
  // right-0 向左展开。RSB 贴窗口右边时 + 按钮天然靠右,默认配置必然右溢出,所
  // 以这里实测翻转,而不是预设一种方向。
  //
  // 用 useLayoutEffect 在 paint 之前同步切换,避免 1 帧"先冒出再缩回去"的闪烁。
  const [alignRight, setAlignRight] = useState(false);

  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // rect.left = + 按钮 wrapper 左边 X;若从这里往右 220px 装不下(伸出窗口右
    // 边),翻向左展开。判据用 left 而不是 right,因为我们看的是 dropdown 左对齐
    // 时的展开起点是否够。
    const rightSpace = window.innerWidth - rect.left;
    setAlignRight(rightSpace < DROPDOWN_WIDTH + VIEWPORT_PADDING);
  }, []);

  // 点 outside / Escape 关闭(模式参考 RolePillDropdown 的 click-outside 实现)
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
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
  }, [onClose]);

  const enabled = MENU_ITEMS.filter((m) => m.enabled).sort((a, b) => a.order - b.order);
  const coming = MENU_ITEMS.filter((m) => !m.enabled).sort((a, b) => a.order - b.order);
  // 插件页签(panel.position:'tab')动态分组:随装/卸/停用增减,版本号驱动重渲。
  useTabKindRegistryVersion();
  const ghostItems = listGhostTabMenuMetas();

  return (
    <div
      ref={ref}
      role="menu"
      className={cn(
        'absolute top-full z-50 mt-1 w-[220px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1',
        alignRight ? 'right-0' : 'left-0',
      )}
      style={{ boxShadow: 'var(--shadow-menu)' }}
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
                <span className="text-[10px] text-[var(--text-tertiary)]">
                  {t('rightSidebar.tabs.menu.alreadyOpen')}
                </span>
              ) : undefined
            }
            onClick={() => onSelect(m.kind)}
          />
        );
      })}
      {ghostItems.length > 0 && (
        <>
          <div className="mx-1 my-1 h-px bg-[var(--border-default)]" />
          <GroupHeader label={t('rightSidebar.tabs.menu.pluginGroup')} />
          {ghostItems.map((m) => {
            const alreadyOpen = m.singleton && existingKinds?.has(m.kind);
            return (
              <DropdownItem
                key={m.kind}
                icon={m.icon}
                // 插件名是用户内容原文(labelText),labelKey 只作兜底。
                label={m.labelText ?? t(m.labelKey)}
                trailing={
                  alreadyOpen ? (
                    <span className="text-[10px] text-[var(--text-tertiary)]">
                      {t('rightSidebar.tabs.menu.alreadyOpen')}
                    </span>
                  ) : undefined
                }
                onClick={() => onSelect(m.kind)}
              />
            );
          })}
        </>
      )}
      {coming.length > 0 && (
        <>
          <div className="mx-1 my-1 h-px bg-[var(--border-default)]" />
          <GroupHeader label={t('rightSidebar.tabs.menu.comingSoon')} />
          {coming.map((m) => (
            <DropdownItem key={m.kind} icon={m.icon} label={t(m.labelKey)} disabled />
          ))}
        </>
      )}
    </div>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium text-[var(--text-tertiary)]">
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
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] leading-snug text-[var(--text-primary)] transition-colors',
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-[var(--surface-hover)]',
      )}
    >
      <Icon size={13} className="shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      {trailing}
    </button>
  );
}
