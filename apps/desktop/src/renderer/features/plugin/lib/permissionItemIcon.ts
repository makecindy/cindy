import {
  AppWindow,
  Bot,
  Cpu,
  FileCode2,
  FilePen,
  FolderOpen,
  FolderPlus,
  Globe,
  GraduationCap,
  KeyRound,
  LayoutTemplate,
  Library,
  MapPin,
  Megaphone,
  MessageCircleQuestion,
  PanelLeft,
  PanelRight,
  Radio,
  Smartphone,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { GhostPermissionItem } from '../../../../shared/ghost';

const PERMISSION_ICON: Record<GhostPermissionItem['kind'], LucideIcon> = {
  cindy: Sparkles,
  agent: Bot,
  node: Cpu,
  tool: Wrench,
  command: Terminal,
  panel: PanelRight,
  'main-view': AppWindow,
  code: FileCode2,
  subscribe: Radio,
  card: LayoutTemplate,
  network: Globe,
  notify: Megaphone,
  confirm: MessageCircleQuestion,
  fs: FilePen,
  library: Library,
  'session-context': MapPin,
  pick: FolderOpen,
  preview: AppWindow,
  skill: GraduationCap,
  'ios-simulator': Smartphone,
  workspace: FolderPlus,
};

/**
 * Chooses a visual affordance without changing the host-owned permission title or meaning.
 * Shared by the plugin detail page and the install confirmation dialog.
 */
export function permissionItemIcon(item: GhostPermissionItem): LucideIcon {
  if (item.labelKey === 'panelLeft') return PanelLeft;
  if (
    item.labelKey === 'networkSecret' ||
    item.labelKey === 'networkSecretOauth' ||
    item.labelKey === 'networkSecretGhCli' ||
    item.labelKey === 'networkSecretIdentity'
  ) {
    return KeyRound;
  }
  return PERMISSION_ICON[item.kind];
}
