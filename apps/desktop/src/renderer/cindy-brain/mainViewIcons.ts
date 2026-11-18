/**
 * 插件 mainView 图标名 → lucide 图标。左侧栏导航入口与右侧栏插件视图页签共用,
 * 单独成模块避免页签插件为取图标表而拖进路由相关依赖。
 */

import {
  CalendarDays,
  ChartColumn,
  Code,
  ContactRound,
  Database,
  Folder,
  Globe,
  Image,
  MessageCircle,
  Podcast,
  Puzzle,
  TabletSmartphone,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import type { GhostMainViewDecl, GhostMainViewIcon } from '../../shared/ghost';

export const MAIN_VIEW_ICONS = {
  puzzle: Puzzle,
  globe: Globe,
  code: Code,
  folder: Folder,
  database: Database,
  'chart-column': ChartColumn,
  image: Image,
  'message-circle': MessageCircle,
  'calendar-days': CalendarDays,
  'tablet-smartphone': TabletSmartphone,
  'contact-round': ContactRound,
  podcast: Podcast,
  workflow: Workflow,
} satisfies Record<GhostMainViewIcon, LucideIcon> & Record<string, LucideIcon>;

export type MainViewIconName = keyof typeof MAIN_VIEW_ICONS;

function isMainViewIconName(name: unknown): name is MainViewIconName {
  return typeof name === 'string' && Object.hasOwn(MAIN_VIEW_ICONS, name);
}

export function mainViewIconName(view?: GhostMainViewDecl): MainViewIconName {
  if (isMainViewIconName(view?.preferredIcon)) return view.preferredIcon;
  return isMainViewIconName(view?.icon) ? view.icon : 'puzzle';
}
