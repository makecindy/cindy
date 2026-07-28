import { useEffect, useRef, useState } from 'react';

import type { GhostAppearanceSnapshot } from '../../shared/ghost';
import { themeService } from '@/themes/theme-service';
import { publishSkinAppearance } from './skinAppearanceStore';

const OVERRIDDEN_TOKENS = [
  'surface',
  'surface-hsl',
  'content-area',
  'sidebar',
  'surface-elevated',
  'surface-elevated-soft',
  'surface-card-ivory',
  'surface-chip',
  'surface-chip-alt',
  'surface-hover',
  'surface-hover-soft',
  'surface-hover-hsl',
  'surface-translucent-sidebar',
  'surface-translucent-main',
  'surface-translucent-overlay',
  'sidebar-border',
  'sidebar-item-active',
  'sidebar-item-active-foreground',
  'sidebar-item-active-border',
  'sidebar-search-input-bg',
  'sidebar-user-card-bg',
  'sidebar-user-card-bg-hover',
  'sidebar-user-card-border',
  'settings-profile-card-bg',
  'settings-theme-card-bg',
  'settings-input-bg',
  'settings-badge-bg',
  'settings-integration-avatar-bg',
  'chat-input-bg',
  'create-agent-quick-card-bg',
  'create-agent-quick-card-bg-hover',
  'create-agent-quick-card-border',
  'create-agent-quick-card-icon-bg',
] as const;

const PALETTES: Record<
  GhostAppearanceSnapshot['palette'],
  { light: [string, string, string]; dark: [string, string, string] }
> = {
  graphite: { light: ['210 8% 95%', '210 8% 97%', '210 8% 88%'], dark: ['210 8% 11%', '210 7% 17%', '210 7% 24%'] },
  ocean: { light: ['205 48% 94%', '205 38% 97%', '205 35% 86%'], dark: ['209 35% 11%', '207 30% 17%', '205 28% 24%'] },
  forest: { light: ['142 28% 94%', '140 24% 97%', '141 22% 85%'], dark: ['145 25% 10%', '143 22% 16%', '141 20% 23%'] },
  ember: { light: ['26 52% 94%', '28 40% 97%', '24 38% 85%'], dark: ['20 31% 11%', '22 27% 17%', '24 25% 24%'] },
  violet: { light: ['266 42% 95%', '266 32% 97%', '264 31% 87%'], dark: ['266 28% 11%', '265 25% 17%', '264 23% 24%'] },
  rose: { light: ['340 43% 95%', '340 33% 97%', '338 31% 87%'], dark: ['340 27% 11%', '339 24% 17%', '338 22% 24%'] },
};

type OverriddenToken = (typeof OVERRIDDEN_TOKENS)[number];

function clearAppearanceTokens(): void {
  const root = document.documentElement;
  delete root.dataset.skinActive;
  for (const token of OVERRIDDEN_TOKENS) root.style.removeProperty(`--${token}`);
}

/**
 * 皮肤 token 映射的唯一事实来源:Record 的 key 集由 OVERRIDDEN_TOKENS 约束
 * (缺一个或多写一个都是类型错误),apply 与 clear 因此不可能漂移。
 */
function appearanceTokenValues(
  appearance: GhostAppearanceSnapshot,
  dark: boolean,
): Record<OverriddenToken, string> {
  const [base, elevated, chip] = PALETTES[appearance.palette][dark ? 'dark' : 'light'];
  const alpha = appearance.surfaceOpacity;
  const cardAlpha = Math.max(0.5, alpha - 0.18);
  const sidebarAlpha = Math.max(0.62, alpha - 0.08);
  const hoverAlpha = Math.min(1, alpha + 0.04);
  const borderAlpha = Math.min(0.72, alpha);
  // The composer floats above scrollback content. Keep its own rounded surface
  // nearly opaque so text cannot visually pass through it; the surrounding
  // footer remains transparent and lets the wallpaper breathe.
  const composerAlpha = Math.max(0.94, alpha);
  return {
    'surface-hsl': `${base} / ${alpha}`,
    'surface': `hsl(${base} / ${alpha})`,
    'content-area': 'var(--surface-hsl)',
    'sidebar': 'var(--surface-hsl)',
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
    'sidebar-border': `${chip} / ${borderAlpha}`,
    'sidebar-item-active': `${chip} / ${hoverAlpha}`,
    'sidebar-item-active-foreground': dark ? 'hsl(0 0% 92%)' : 'hsl(210 10% 18%)',
    'sidebar-item-active-border': `hsl(${chip} / ${hoverAlpha})`,
    'sidebar-search-input-bg': `hsl(${elevated} / ${alpha})`,
    'sidebar-user-card-bg': `hsl(${elevated} / ${Math.max(0.55, alpha - 0.18)})`,
    'sidebar-user-card-bg-hover': `hsl(${chip} / ${alpha})`,
    'sidebar-user-card-border': `hsl(${chip} / ${borderAlpha})`,
    'settings-profile-card-bg': `hsl(${elevated} / ${cardAlpha})`,
    'settings-theme-card-bg': `hsl(${elevated} / ${cardAlpha})`,
    'settings-input-bg': `hsl(${elevated} / ${alpha})`,
    'settings-badge-bg': `hsl(${elevated} / ${alpha})`,
    'settings-integration-avatar-bg': `hsl(${elevated} / ${alpha})`,
    'chat-input-bg': `hsl(${elevated} / ${composerAlpha})`,
    'create-agent-quick-card-bg': `hsl(${elevated} / ${cardAlpha})`,
    'create-agent-quick-card-bg-hover': `hsl(${elevated} / ${hoverAlpha})`,
    'create-agent-quick-card-border': `hsl(${chip} / ${borderAlpha})`,
    'create-agent-quick-card-icon-bg': `hsl(${chip} / ${cardAlpha})`,
  };
}

function applyAppearanceTokens(appearance: GhostAppearanceSnapshot): void {
  const root = document.documentElement;
  const values = appearanceTokenValues(appearance, root.classList.contains('dark'));
  root.dataset.skinActive = 'true';
  for (const token of OVERRIDDEN_TOKENS) root.style.setProperty(`--${token}`, values[token]);
}

/**
 * 宿主唯一的换肤渲染层。插件只提供结构化快照；这里把固定 palette 映射到
 * 语义 token，并在最底层铺经过主机账本验证的 cindy-media 图片。
 */
export function SkinBackdrop() {
  const [appearance, setAppearance] = useState<GhostAppearanceSnapshot | null | undefined>();
  const [themeRevision, setThemeRevision] = useState(0);
  const receivedPush = useRef(false);

  useEffect(() => {
    const load = () => {
      void window.electronAPI.ghosts
        .getAppearance()
        .then(({ appearance: next }) => {
          if (!receivedPush.current) setAppearance(next);
        })
        .catch(() => {
          if (!receivedPush.current) setAppearance(null);
        });
    };
    const unsubscribeAppearance = window.electronAPI.ghosts.onAppearanceChanged((payload) => {
      receivedPush.current = true;
      setAppearance(payload.appearance);
    });
    const unsubscribeGhosts = window.electronAPI.ghosts.onChanged(() => {
      receivedPush.current = false;
      load();
    });
    load();
    return () => {
      unsubscribeAppearance();
      unsubscribeGhosts();
    };
  }, []);

  useEffect(
    () => themeService.onDidChangeTheme(() => setThemeRevision((value) => value + 1)),
    [],
  );

  useEffect(() => {
    publishSkinAppearance(appearance);
    if (appearance) applyAppearanceTokens(appearance);
    else if (appearance === null) clearAppearanceTokens();
    return () => {
      if (appearance) clearAppearanceTokens();
    };
  }, [appearance, themeRevision]);

  if (!appearance) return null;
  const bg = appearance.background;
  const mode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  const overlay = `linear-gradient(rgba(0,0,0,${appearance.dim}),rgba(0,0,0,${appearance.dim}))`;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0"
      style={{
        backgroundColor: `hsl(${PALETTES[appearance.palette][mode][0]})`,
        backgroundImage: bg ? `${overlay}, url("${bg.url}")` : overlay,
        backgroundPosition: bg ? `center, ${bg.focusX * 100}% ${bg.focusY * 100}%` : 'center',
        backgroundSize: bg ? 'cover, cover' : 'cover',
      }}
    />
  );
}
