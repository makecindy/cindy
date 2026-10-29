/**
 * AddTabDropdown — 「+」按钮下拉菜单的内容(对应设计稿 F5 dropdown)。
 *
 * 面板、分组头、行、分隔线、滑动高亮、方向键 / Esc / 焦点返回都用共享
 * `components/ui/dropdown-menu.tsx` 的默认值(DESIGN §4 Select & Dropdown);
 * DropdownMenu 根与「+」触发按钮在 TabBar。
 *
 * 菜单内容与空面板共用宿主提供的创建菜单。
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { TabCreationMenu, TabCreationSelectionOptions } from './lib/useTabCreationMenu';
import type { TabKindId } from './types';

interface AddTabDropdownProps extends TabCreationSelectionOptions {
  /** 菜单是否打开:只在打开期间跟随锚点。 */
  open: boolean;
  /** 「+」按钮 wrapper:它从布局中消失或宿主面板收起时关闭菜单。 */
  anchorRef: React.RefObject<HTMLElement | null>;
  menu: TabCreationMenu;
  /** 锚点消失 / 面板收起时关闭(点外部与 Esc 由 DropdownMenu 根处理)。 */
  onClose: () => void;
  /**
   * 当前 session bucket 已存在的 kind 集合。单例 kind 在此集合中时,
   * dropdown 改 trailing 文案为"已打开"并维持 enabled(点击 = host 切到现有)。
   */
  existingKinds?: ReadonlySet<TabKindId>;
}

export function AddTabDropdown({
  open,
  anchorRef,
  menu,
  groupId,
  onGlobalTabSelected,
  onClose,
  existingKinds,
}: AddTabDropdownProps) {
  const { t } = useTranslation();
  // 跟随:Radix Popper 负责摆位与视口碰撞。打开期间用 rAF 轮询 anchor —— 从布局中
  // 消失(关掉最后一个 tab 面板收起)直接关闭,避免菜单悬空残留在旧坐标。
  //
  // 主窗口内嵌形态的宿主 aside:收起时不 unmount 而是 w-0 + overflow-hidden
  // 保挂载(见 RightSidebar.tsx 规则 7 注释),此时 anchor 自身 rect 并不归零
  // (「+」wrapper shrink-0 仍有宽度),要靠 aside 的 data-pane-collapsed 状态
  // 判定。detached 子窗口没有这层 aside(closest 为 null),跳过该检测。
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const hostPane = anchorRef.current?.closest('[data-panel-drag-root="right-tabs"]');
    const track = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (
        !rect ||
        (rect.width === 0 && rect.height === 0) ||
        hostPane?.hasAttribute('data-pane-collapsed')
      ) {
        onClose();
        return;
      }
      raf = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(raf);
  }, [open, anchorRef, onClose]);

  const enabled = menu.items.filter(item => item.enabled && item.group !== 'plugins');
  const plugins = menu.items.filter(item => item.group === 'plugins');
  const coming = menu.items.filter(item => !item.enabled);
  const renderItem = (item: TabCreationMenu['items'][number]) => (
    <AddTabItem
      key={item.kind}
      icon={item.icon}
      label={item.labelText ?? t(item.labelKey)}
      trailing={item.alreadyOpen || (item.singleton && existingKinds?.has(item.kind))
        ? t('rightSidebar.tabs.menu.alreadyOpen') : undefined}
      disabled={item.disabled}
      onSelect={() => {
        onClose();
        if (item.group === 'plugins') menu.select(item.kind, { groupId, onGlobalTabSelected });
        else menu.select(item.kind);
      }}
    />
  );

  return (
    <DropdownMenuContent
      align="start"
      // RSB 交互领地标记:MainLayout 的 ⌘W 归属判定(RSB_TERRITORY_SELECTOR)靠它
      // 识别 portal 到 body 的右栏浮层 —— 菜单打开期间 ⌘W 仍应关右栏 tab 而非窗口。
      data-rsb-territory=""
      onCloseAutoFocus={(e) => {
        // 面板收起触发的关闭(如 ⌘W 关掉最后一个 tab):「+」已随宿主 aside 缩进
        // w-0 不可见,焦点还给它会落在不可见控件上 —— 跳过,让焦点自然回落。
        const pane = anchorRef.current?.closest('[data-panel-drag-root="right-tabs"]');
        if (pane?.hasAttribute('data-pane-collapsed')) e.preventDefault();
      }}
    >
      <DropdownMenuLabel>{t('rightSidebar.tabs.menu.addLabel')}</DropdownMenuLabel>
      {enabled.map(renderItem)}
      {plugins.length > 0 && <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('rightSidebar.tabs.menu.pluginsLabel')}</DropdownMenuLabel>
        {plugins.map(renderItem)}
      </>}
      {coming.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t('rightSidebar.tabs.menu.comingSoon')}</DropdownMenuLabel>
          {coming.map((m) => (
            <AddTabItem key={m.kind} icon={m.icon} label={m.labelText ?? t(m.labelKey)} disabled />
          ))}
        </>
      )}
    </DropdownMenuContent>
  );
}

function AddTabItem({
  icon: Icon,
  label,
  trailing,
  onSelect,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  trailing?: string;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect} className="gap-2">
      <Icon size={14} className="shrink-0" />
      <span className="flex-1">{label}</span>
      {trailing && (
        <span className="pl-4 text-12 font-normal text-[var(--cmd-palette-item-meta)]">
          {trailing}
        </span>
      )}
    </DropdownMenuItem>
  );
}
