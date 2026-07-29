import type { GhostAppearancePalette, GhostAppearanceSnapshot } from '../../shared/ghost';
import { cindyDark } from './builtin/cindy-dark';
import { cindyLight } from './builtin/cindy-light';
import type { ColorValue, Theme, ThemeType } from './types';

type SkinPaletteValues = readonly [base: string, elevated: string, chip: string];

/**
 * 插件皮肤的宿主色板。插件只提交枚举；Light / Dark 两套实际颜色完全由
 * Cindy 持有，因此显示模式只切换皮肤自己的明暗变体，不会重新引入普通主题。
 */
const SKIN_PALETTES: Record<GhostAppearancePalette, Record<ThemeType, SkinPaletteValues>> = {
  graphite: {
    light: ['210 8% 95%', '210 8% 97%', '210 8% 88%'],
    dark: ['210 8% 11%', '210 7% 17%', '210 7% 24%'],
  },
  ocean: {
    light: ['205 48% 94%', '205 38% 97%', '205 35% 86%'],
    dark: ['209 35% 11%', '207 30% 17%', '205 28% 24%'],
  },
  forest: {
    light: ['142 28% 94%', '140 24% 97%', '141 22% 85%'],
    dark: ['145 25% 10%', '143 22% 16%', '141 20% 23%'],
  },
  ember: {
    light: ['26 52% 94%', '28 40% 97%', '24 38% 85%'],
    dark: ['20 31% 11%', '22 27% 17%', '24 25% 24%'],
  },
  violet: {
    light: ['266 42% 95%', '266 32% 97%', '264 31% 87%'],
    dark: ['266 28% 11%', '265 25% 17%', '264 23% 24%'],
  },
  rose: {
    light: ['340 43% 95%', '340 33% 97%', '338 31% 87%'],
    dark: ['340 27% 11%', '339 24% 17%', '338 22% 24%'],
  },
};

function skinSurfaceColors(
  appearance: GhostAppearanceSnapshot,
  type: ThemeType,
): Record<string, ColorValue> {
  const [base, elevated, chip] = SKIN_PALETTES[appearance.palette][type];
  const dark = type === 'dark';
  const alpha = appearance.surfaceOpacity;
  const cardAlpha = Math.max(0.5, alpha - 0.18);
  const sidebarAlpha = Math.max(0.62, alpha - 0.08);
  const hoverAlpha = Math.min(1, alpha + 0.04);
  const borderAlpha = Math.min(0.72, alpha);
  const composerAlpha = Math.max(0.94, alpha);

  return {
    surface: `hsl(${base} / ${alpha})`,
    'surface-hsl': `${base} / ${alpha}`,
    'surface-elevated': `hsl(${elevated} / ${alpha})`,
    'surface-elevated-soft': `hsl(${chip} / ${alpha})`,
    'surface-card-ivory': `hsl(${elevated} / ${cardAlpha})`,
    'surface-chip': `hsl(${chip} / ${alpha})`,
    'surface-chip-alt': `hsl(${chip} / ${alpha})`,
    'surface-hover': `hsl(${chip} / ${hoverAlpha})`,
    'surface-hover-soft': `hsl(${base} / ${hoverAlpha})`,
    'surface-hover-hsl': `${chip} / ${hoverAlpha}`,
    'surface-translucent-sidebar': `hsl(${base} / ${sidebarAlpha})`,
    'surface-translucent-main': `hsl(${elevated} / ${alpha})`,
    'surface-translucent-overlay': `hsl(${elevated} / ${alpha})`,

    'border-default': `hsl(${chip} / ${borderAlpha})`,
    'border-default-hsl': `${chip} / ${borderAlpha}`,
    'border-shadcn-hsl': `${chip} / ${borderAlpha}`,
    'border-transparent-mixed': `hsl(${chip} / ${borderAlpha})`,
    border: `${chip} / ${borderAlpha}`,
    input: `${chip} / ${borderAlpha}`,

    background: `${base} / ${alpha}`,
    'content-area': `${base} / ${alpha}`,
    'panel-bg': `hsl(${base} / ${alpha})`,
    titlebar: `${base} / ${alpha}`,
    'titlebar-border': `${chip} / ${borderAlpha}`,
    'titlebar-button-hover': `${chip} / ${hoverAlpha}`,
    'titlebar-control-hover': `${chip} / ${hoverAlpha}`,
    sidebar: `${base} / ${alpha}`,
    'sidebar-border': `${chip} / ${borderAlpha}`,
    'sidebar-search-bg': `${base} / ${sidebarAlpha}`,
    'sidebar-search-input-bg': `hsl(${elevated} / ${alpha})`,
    'sidebar-item-hover': `${chip} / ${hoverAlpha}`,
    'sidebar-item-active': `${chip} / ${hoverAlpha}`,
    'sidebar-item-active-foreground': dark ? 'hsl(0 0% 92%)' : 'hsl(210 10% 18%)',
    'sidebar-item-active-border': `hsl(${chip} / ${hoverAlpha})`,
    'sidebar-user-card-bg': `hsl(${elevated} / ${Math.max(0.55, alpha - 0.18)})`,
    'sidebar-user-card-bg-hover': `hsl(${chip} / ${alpha})`,
    'sidebar-user-card-border': `hsl(${chip} / ${borderAlpha})`,

    popover: `${elevated} / ${alpha}`,
    muted: `${chip} / ${alpha}`,
    secondary: `${chip} / ${alpha}`,
    accent: `${chip} / ${hoverAlpha}`,
    'model-trigger-hover': `hsl(${chip} / ${hoverAlpha})`,
    'model-item-hover': `hsl(${chip} / ${hoverAlpha})`,

    'settings-profile-card-bg': `hsl(${elevated} / ${cardAlpha})`,
    'settings-theme-card-bg': `hsl(${elevated} / ${cardAlpha})`,
    'settings-input-bg': `hsl(${elevated} / ${alpha})`,
    'settings-badge-bg': `hsl(${elevated} / ${alpha})`,
    'settings-integration-avatar-bg': `hsl(${elevated} / ${alpha})`,
    'settings-menu-bg-hover': `hsl(${chip} / ${hoverAlpha})`,
    'settings-menu-bg-selected': `hsl(${chip} / ${alpha})`,

    'chat-input-bg': `hsl(${elevated} / ${composerAlpha})`,
    'create-agent-quick-card-bg': `hsl(${elevated} / ${cardAlpha})`,
    'create-agent-quick-card-bg-hover': `hsl(${elevated} / ${hoverAlpha})`,
    'create-agent-quick-card-border': `hsl(${chip} / ${borderAlpha})`,
    'create-agent-quick-card-icon-bg': `hsl(${chip} / ${cardAlpha})`,
  };
}

/** 把受控皮肤解析成一份完整 Theme；普通主题不会参与合并。 */
export function resolveSkinTheme(appearance: GhostAppearanceSnapshot, type: ThemeType): Theme {
  const foundation = type === 'dark' ? cindyDark : cindyLight;
  const icon = appearance.brand?.icon?.url;
  const logo = appearance.brand?.logo?.url;
  return {
    ...foundation,
    id: `skin-${appearance.palette}-${type}`,
    name: appearance.name ?? `Skin ${appearance.palette}`,
    colors: {
      ...foundation.colors,
      ...skinSurfaceColors(appearance, type),
    },
    brand:
      icon || logo
        ? {
            ...(icon ? { icon: { src: icon } } : {}),
            ...(logo ? { logo: { src: logo } } : {}),
          }
        : foundation.brand,
  };
}

export function getSkinPaletteSurface(palette: GhostAppearancePalette, type: ThemeType): string {
  return SKIN_PALETTES[palette][type][0];
}
