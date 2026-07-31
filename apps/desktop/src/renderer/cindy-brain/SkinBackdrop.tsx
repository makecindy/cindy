import { useEffect, useState } from 'react';

import { useSkinAppearance } from './skinAppearanceStore';
import { getSkinPaletteSurface } from '@/themes/skin-theme';
import { themeService } from '@/themes/theme-service';
import type { ThemeType } from '@/themes/types';

/**
 * 皮肤装饰层。完整语义主题由 ThemeProvider → resolveSkinTheme 生成；本组件只铺
 * 经宿主账本验证的背景图片与遮罩，避免皮肤和普通主题在 DOM token 上叠加。
 */
export function SkinBackdrop() {
  const appearance = useSkinAppearance();
  const [themeType, setThemeType] = useState<ThemeType>(
    () => themeService.getCurrentTheme()?.type ?? 'light',
  );
  useEffect(
    () => themeService.onDidChangeTheme((theme) => setThemeType(theme.type)),
    [],
  );
  if (!appearance) return null;

  const bg = appearance.background;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0"
      style={{
        backgroundColor: `hsl(${getSkinPaletteSurface(appearance.palette, themeType)})`,
      }}
    >
      {bg ? (
        <div
          className="absolute inset-0 bg-cover"
          style={{
            backgroundImage: `url("${bg.url}")`,
            backgroundPosition: `${bg.focusX * 100}% ${bg.focusY * 100}%`,
          }}
        />
      ) : null}
      <div className="absolute inset-0 bg-black" style={{ opacity: appearance.dim }} />
    </div>
  );
}
