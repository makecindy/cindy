import {
  CalendarDays,
  ChartColumn,
  Code,
  Database,
  Folder,
  Globe,
  Image,
  MessageCircle,
  Puzzle,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMatch, useNavigate } from 'react-router-dom';

import { useGhostMainViews } from '@/cindy-brain/ghostMainViews';
import { cn } from '@/lib/utils';
import type { GhostMainViewIcon } from '../../../shared/ghost';

import { SIDEBAR_RAIL_ICON_BUTTON_CLASS } from './SidebarIconButton';
import { Tip } from '../ui/tooltip';

const ROW_CLASS =
  'flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-sm font-normal text-[var(--sidebar-nav-text)] transition-colors hover:bg-sidebar-item-hover';
const ROW_ACTIVE_CLASS =
  'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)] hover:bg-sidebar-item-active';
const RAIL_ACTIVE_CLASS =
  'bg-[var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)] hover:bg-[var(--chat-input-chip-bg)]';

const MAIN_VIEW_ICONS: Record<GhostMainViewIcon, LucideIcon> = {
  puzzle: Puzzle,
  globe: Globe,
  code: Code,
  folder: Folder,
  database: Database,
  'chart-column': ChartColumn,
  image: Image,
  'message-circle': MessageCircle,
  'calendar-days': CalendarDays,
};

/** Expanded and rail variants consume the exact same sorted visibility projection. */
export function GhostMainViewNavEntries({ variant }: { variant: 'row' | 'rail' }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeMatch = useMatch('/apps/:ghostId');
  const activeGhostId = activeMatch?.params.ghostId;
  const { sidebarVisible } = useGhostMainViews();

  return sidebarVisible.map((item) => {
    const active = activeGhostId === item.ghostId;
    const Icon = MAIN_VIEW_ICONS[item.icon];
    const icon = (
      <Icon
        aria-hidden="true"
        size={variant === 'row' ? 15 : 18}
        strokeWidth={1.8}
        className="shrink-0"
      />
    );
    const open = () => navigate(`/apps/${encodeURIComponent(item.ghostId)}`);
    const openDetails = () =>
      navigate(`/settings?tab=ghosts&ghost=${encodeURIComponent(item.ghostId)}`);

    if (variant === 'rail') {
      return (
        <Tip key={item.ghostId} text={item.title} side="right">
          <button
            type="button"
            aria-label={item.title}
            aria-current={active ? 'page' : undefined}
            onClick={open}
            className={cn(SIDEBAR_RAIL_ICON_BUTTON_CLASS, active && RAIL_ACTIVE_CLASS)}
          >
            {icon}
          </button>
        </Tip>
      );
    }

    return (
      <div
        key={item.ghostId}
        className={cn(ROW_CLASS, 'group/main-view gap-0 px-0', active && ROW_ACTIVE_CLASS)}
      >
        <button
          type="button"
          aria-label={item.title}
          title={item.title}
          data-native-title="truncated-text"
          aria-current={active ? 'page' : undefined}
          onClick={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-full pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {icon}
          <span className="min-w-0 truncate leading-none">{item.title}</span>
        </button>
        <Tip text={t('settings.ghosts.page.manageAria', { name: item.manifest.name })} side="right">
          <button
            type="button"
            onClick={openDetails}
            aria-label={t('settings.ghosts.page.manageAria', { name: item.manifest.name })}
            className={cn(
              'pointer-events-none mr-1.5 grid size-6 shrink-0 place-items-center rounded-full opacity-0 transition-[background-color,color,opacity] duration-150 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] group-hover/main-view:pointer-events-auto group-hover/main-view:opacity-100 group-focus-within/main-view:pointer-events-auto group-focus-within/main-view:opacity-100',
              active
                ? 'text-sidebar-item-active-foreground hover:bg-[var(--sidebar-item-active-border)] hover:text-sidebar-item-active-foreground'
                : 'text-[var(--sidebar-nav-text)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
            )}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
          </button>
        </Tip>
      </div>
    );
  });
}
