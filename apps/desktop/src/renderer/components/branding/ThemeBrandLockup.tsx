import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import headImageDark from '@/assets/head-image-dark.png';
import headImageLight from '@/assets/head-image-light.png';
import { logoDark, logoLight } from '@/hooks/useBrandLogo';
import { cn } from '@/lib/utils';
import type { Theme, ThemeBrandAsset } from '@/themes/types';
import { useSkinAppearance } from '@/cindy-brain/skinAppearanceStore';

/**
 * ThemeBrandLockup — 新建对话页与设置预览共用的品牌锁定组件。
 *
 * 布局跟随 2026-07 新设计固定为 50px icon + 110×37.5px logo。
 * 本地主题只替换素材，不提供尺寸配置；loader 提供的透明像素边界会在
 * 这里无损裁掉画布留白，原始文件不会被改写。
 */

export const BRAND_ICON_SIZE = 50;
export const BRAND_LOGO_WIDTH = 110;
export const BRAND_LOGO_HEIGHT = 37.5;
export const BRAND_LOCKUP_GAP = 9;

interface CroppedAssetImageProps {
  asset: ThemeBrandAsset;
  boxWidth: number;
  boxHeight: number;
  fit: 'contain' | 'cover';
  alt: string;
  onError: () => void;
}

function CroppedAssetImage({
  asset,
  boxWidth,
  boxHeight,
  fit,
  alt,
  onError,
}: CroppedAssetImageProps) {
  const style = useMemo<CSSProperties>(() => {
    const bounds = asset.visibleBounds;
    if (!bounds) {
      return {
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: fit,
      };
    }
    const scale =
      fit === 'cover'
        ? Math.max(boxWidth / bounds.width, boxHeight / bounds.height)
        : Math.min(boxWidth / bounds.width, boxHeight / bounds.height);
    const visibleWidth = bounds.width * scale;
    const visibleHeight = bounds.height * scale;
    return {
      width: bounds.sourceWidth * scale,
      height: bounds.sourceHeight * scale,
      maxWidth: 'none',
      left: (boxWidth - visibleWidth) / 2 - bounds.x * scale,
      top: (boxHeight - visibleHeight) / 2 - bounds.y * scale,
    };
  }, [asset.visibleBounds, boxHeight, boxWidth, fit]);

  return (
    <img
      src={asset.src}
      alt={alt}
      className="pointer-events-none absolute select-none"
      style={style}
      draggable={false}
      onError={onError}
    />
  );
}

function isDarkTheme(theme: Theme | null): boolean {
  return theme ? theme.type === 'dark' : document.documentElement.classList.contains('dark');
}

export interface ThemeBrandLockupProps {
  theme: Theme | null;
  className?: string;
  testId?: string;
}

export function ThemeBrandLockup({ theme, className, testId }: ThemeBrandLockupProps) {
  const skinAppearance = useSkinAppearance();
  const dark = isDarkTheme(theme);
  const defaultIcon: ThemeBrandAsset = { src: dark ? headImageDark : headImageLight };
  const defaultLogo: ThemeBrandAsset = { src: dark ? logoDark : logoLight };
  const skinIconUrl = skinAppearance?.brand?.icon?.url;
  const skinLogoUrl = skinAppearance?.brand?.logo?.url;
  const customIcon = useMemo<ThemeBrandAsset | undefined>(
    () => (skinIconUrl ? { src: skinIconUrl } : theme?.brand?.icon),
    [skinIconUrl, theme?.brand?.icon],
  );
  const customLogo = useMemo<ThemeBrandAsset | undefined>(
    () => (skinLogoUrl ? { src: skinLogoUrl } : theme?.brand?.logo),
    [skinLogoUrl, theme?.brand?.logo],
  );
  const [iconFailed, setIconFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => setIconFailed(false), [customIcon, defaultIcon.src]);
  useEffect(() => setLogoFailed(false), [customLogo, defaultLogo.src]);

  const icon = customIcon && !iconFailed ? customIcon : defaultIcon;
  const logo = customLogo && !logoFailed ? customLogo : defaultLogo;
  const iconIsCustom = icon === customIcon;

  return (
    <div data-testid={testId} className={cn('flex h-[50px] items-center gap-[9px]', className)}>
      <span
        data-testid={testId ? `${testId}-icon` : undefined}
        className={cn(
          'pointer-events-none relative h-[50px] w-[50px] shrink-0 select-none overflow-hidden rounded-full',
          iconIsCustom && 'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
        )}
        style={{ filter: 'drop-shadow(0 2px 3.65px rgba(0, 0, 0, 0.15))' }}
      >
        <CroppedAssetImage
          asset={icon}
          boxWidth={BRAND_ICON_SIZE}
          boxHeight={BRAND_ICON_SIZE}
          fit="cover"
          alt=""
          onError={() => setIconFailed(true)}
        />
      </span>
      <span
        data-testid={testId ? `${testId}-logo` : undefined}
        className="relative h-[37.5px] w-[110px] shrink-0 overflow-hidden"
      >
        <CroppedAssetImage
          asset={logo}
          boxWidth={BRAND_LOGO_WIDTH}
          boxHeight={BRAND_LOGO_HEIGHT}
          fit="contain"
          alt={BRAND_NAME}
          onError={() => setLogoFailed(true)}
        />
      </span>
    </div>
  );
}
