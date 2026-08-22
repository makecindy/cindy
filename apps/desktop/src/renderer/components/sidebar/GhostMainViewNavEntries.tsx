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
  type LucideIcon,
} from 'lucide-react';
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
      <button
        key={item.ghostId}
        type="button"
        aria-label={item.title}
        title={item.title}
        data-native-title="truncated-text"
        aria-current={active ? 'page' : undefined}
        onClick={open}
        className={cn(ROW_CLASS, active && ROW_ACTIVE_CLASS)}
      >
        {icon}
        <span className="min-w-0 truncate leading-none">{item.title}</span>
      </button>
    );
  });
}
