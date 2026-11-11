import {
  ClipboardList,
  CodeXml,
  Hand,
  Shield,
  Sparkles,
  LockOpen,
  type LucideIcon,
} from 'lucide-react-native';
import { i18n } from '@/i18n';
import type { ThemeColors } from '@/theme';

/**
 * 权限模式的视觉呈现 —— **与桌面 `new-chat/PermissionSelector.tsx` 严格对齐**:
 * 同一权限模式用同一 lucide 图标、同一语义色。改这里前先对照桌面,保持跨端一致(见设计指南 §6)。
 *
 * 所有权限模式使用中性色，区别通过图标、标签与说明表达。
 */
export type PermissionAccent = 'neutral' | 'auto' | 'bypass';

export interface PermissionPresentation {
  Icon: LucideIcon;
  label: string;
  description: string;
  accent: PermissionAccent;
}

// 图标 / 着色语义与语言无关,留在模块顶层;label 只存 catalog key,
// 由 permissionPresentation() 在调用点用 i18n.t 求值(不冻结语言)。
interface PermissionPresentationMeta {
  Icon: LucideIcon;
  labelKey: string;
  accent: PermissionAccent;
}

const PRESENTATION_META: Record<string, PermissionPresentationMeta> = {
  default: { Icon: Hand, labelKey: 'interaction.permission.mode.default', accent: 'neutral' },
  ask: { Icon: Hand, labelKey: 'interaction.permission.mode.default', accent: 'neutral' },
  acceptEdits: { Icon: CodeXml, labelKey: 'interaction.permission.mode.acceptEdits', accent: 'neutral' },
  plan: { Icon: ClipboardList, labelKey: 'interaction.permission.mode.plan', accent: 'neutral' },
  auto: { Icon: Sparkles, labelKey: 'interaction.permission.mode.auto', accent: 'neutral' },
  bypassPermissions: { Icon: LockOpen, labelKey: 'interaction.permission.mode.bypass', accent: 'neutral' },
};

/** 取某权限模式的图标 / 标签 / 着色语义;未知 id 回退到中性盾牌 + 传入标签。 */
export function permissionPresentation(id: string, fallbackLabel?: string): PermissionPresentation {
  const meta = PRESENTATION_META[id];
  if (!meta) return { Icon: Shield, label: fallbackLabel || id, description: '', accent: 'neutral' };
  const descriptionId = id === 'ask' ? 'default' : id === 'bypassPermissions' ? 'bypass' : id;
  return {
    Icon: meta.Icon,
    label: i18n.t(meta.labelKey),
    description: i18n.t(`interaction.permission.description.${descriptionId}`),
    accent: meta.accent,
  };
}

/** 把 accent 语义解析成当前主题的具体色值。 */
export function permissionAccentColor(accent: PermissionAccent, colors: ThemeColors): string {
  if (accent === 'auto') return colors.permAutoAccent;
  if (accent === 'bypass') return colors.statusAccent;
  return colors.textSecondary;
}
