import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Ellipsis, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BotCreateMenu } from '@/features/bots/BotCreateMenu';
import { FilterReminderDot } from './FilterReminderDot';
import { MachineSettingsMenuItems } from './MachineSwitcherMenu';
import { MENU_ITEM_CLASS } from './menuStyles';
import { SIDEBAR_MAIN_TABS, type SidebarMainTab } from './sidebarMainTab';
import { useHorizontalScrollFade } from './useHorizontalScrollFade';

const TAB_LABEL_KEYS: Record<SidebarMainTab, string> = {
  tasks: 'newChat.createAgent.sidebar.conversations',
  buddies: 'sidebar.tabs.bots',
  chats: 'ccAgent.sidebar.railNav.dialogues',
  automations: 'sidebar.navigation.items.automations',
};

/**
 * 侧栏顶部标签行(2026-11-19 用户裁决):任务 / 伙伴 / 对话 / 自动化横向切换。
 * - 当前标签用与选中任务行同一套胶囊底;其余标签灰字。
 * - 别的标签里有需要你看的(完成未读 / 等你回复 / 出错 / 伙伴未读)→ 该标签字加粗，
 *   与任务行同一规则，不加点、不加数字。
 * - 放不下时横向滑动，不换行、不截断。
 * - 行尾:伙伴标签时多一个新建伙伴;选项菜单收着远程桌面、远程连接设置和侧边栏显示设置
 *   (原「全部任务 ▾」下拉里的三项)。查看已归档 / 收件箱有筛选时选项按钮带筛选提醒点。
 */
export function SidebarMainTabs({
  tab,
  onTabChange,
  attention,
  showFilterReminder,
  onOpenOrganize,
}: {
  tab: SidebarMainTab;
  onTabChange: (tab: SidebarMainTab) => void;
  attention: Readonly<Record<SidebarMainTab, boolean>>;
  /** 列表不是默认视图(查看已归档，或收件箱里有筛选)时，选项按钮带筛选提醒点。 */
  showFilterReminder: boolean;
  /** 在给定屏幕坐标打开「侧边栏显示设置」菜单。 */
  onOpenOrganize: (pos: { x: number; y: number }) => void;
}): ReactNode {
  const { t } = useTranslation();
  const optionsRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<SidebarMainTab, HTMLButtonElement>());

  // 窄侧栏 / 长文案放不下四个标签时横向滑动，被遮住的一侧渐隐，当前标签滑进可见区。
  const [listRef, fadeStyle] = useHorizontalScrollFade(tab, '[aria-selected="true"]');

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = SIDEBAR_MAIN_TABS.indexOf(tab);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = SIDEBAR_MAIN_TABS[(index + step + SIDEBAR_MAIN_TABS.length) % SIDEBAR_MAIN_TABS.length];
    onTabChange(next);
    tabRefs.current.get(next)?.focus();
  };

  const optionsLabel = t('ccAgent.sidebar.mainTabs.options');
  return (
    <div className="group/sidebar-header flex h-8 shrink-0 items-center gap-1 pr-1 pl-3" data-sidebar-main-tabs="">
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('ccAgent.sidebar.mainTabs.label')}
        onKeyDown={onKeyDown}
        style={fadeStyle}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {SIDEBAR_MAIN_TABS.map((item) => {
          const selected = item === tab;
          return (
            <button
              key={item}
              ref={(node) => {
                if (node) tabRefs.current.set(item, node);
                else tabRefs.current.delete(item);
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              data-sidebar-main-tab={item}
              data-attention={!selected && attention[item] ? '' : undefined}
              onClick={() => onTabChange(item)}
              className={cn(
                'flex h-7 shrink-0 items-center rounded-full px-3 text-sm whitespace-nowrap outline-none transition-colors',
                'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
                selected
                  ? 'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)]'
                  : attention[item]
                    ? 'font-semibold text-foreground hover:bg-sidebar-item-hover'
                    : 'font-normal text-[var(--sidebar-list-muted)] hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]',
              )}
            >
              {t(TAB_LABEL_KEYS[item])}
            </button>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {tab === 'buddies' ? <BotCreateMenu variant="header" /> : null}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Tip text={optionsLabel} side="bottom">
              <button
                ref={optionsRef}
                type="button"
                aria-label={optionsLabel}
                className={cn(
                  'relative flex h-6 w-6 items-center justify-center rounded-lg',
                  'text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]',
                  'outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  'data-[state=open]:text-[var(--sidebar-nav-text)]',
                )}
              >
                <Ellipsis size={14} strokeWidth={2} />
                {showFilterReminder && <FilterReminderDot />}
              </button>
            </Tip>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" sideOffset={4} className="min-w-48">
            <MachineSettingsMenuItems />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => {
                // 等本菜单关完再开显示设置，避免两个菜单抢焦点。
                const rect = optionsRef.current?.getBoundingClientRect();
                window.setTimeout(
                  () => onOpenOrganize({ x: rect ? rect.right : 0, y: rect ? rect.bottom : 0 }),
                  0,
                );
              }}
            >
              <SlidersHorizontal size={14} strokeWidth={2} className="shrink-0 opacity-70" />
              <span className="truncate">{t('ccAgent.sidebar.organizeSidebar')}</span>
              {showFilterReminder && <FilterReminderDot inline />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
