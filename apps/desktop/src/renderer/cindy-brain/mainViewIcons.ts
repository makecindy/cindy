/**
 * 插件 mainView 图标名 → lucide 图标。左侧栏导航入口与右侧栏插件视图页签共用,
 * 单独成模块避免页签插件为取图标表而拖进路由相关依赖。
 */

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

import type { GhostMainViewIcon } from '../../shared/ghost';

export const MAIN_VIEW_ICONS: Record<GhostMainViewIcon, LucideIcon> = {
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
