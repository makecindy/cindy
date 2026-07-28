import { createLogger } from '@/lib/logger';
import { toLocalFileUrl } from '@/lib/localPathResolver';

import {
  isLocalThemeId,
  LOCAL_THEME_SUFFIX,
  type LocalThemeWire,
  type LocalThemesResult,
} from '../../shared/local-themes';
import { Emitter } from './event';
import { normalizeLocalThemeColors } from './local-themes-normalize';
import { exportThemeColors } from './theme-service';
import type { Theme, ThemeType } from './types';

const log = createLogger('themes/local-themes');

let cachedThemes: Theme[] = [];
let cachedSignature = '';
const didChange = new Emitter<void>();

function mapWireTheme(theme: LocalThemeWire): Theme {
  const iconPath = theme.brand?.icon;
  const logoPath = theme.brand?.logo;
  const icon = iconPath
    ? {
        src: toLocalFileUrl(iconPath, theme.brandRevisions?.icon),
        ...(theme.brandBounds?.icon ? { visibleBounds: theme.brandBounds.icon } : {}),
      }
    : undefined;
  const logo = logoPath
    ? {
        src: toLocalFileUrl(logoPath, theme.brandRevisions?.logo),
        ...(theme.brandBounds?.logo ? { visibleBounds: theme.brandBounds.logo } : {}),
      }
    : undefined;
  return {
    id: theme.id,
    name: theme.name,
    type: theme.type,
    ...(theme.family ? { family: theme.family } : {}),
    // 加载期兼容归一化:把 text-placeholder slot 引入前创建的旧本地主题统一收口
    // 到新 slot(详见 local-themes-normalize.ts / docs/design-rules/cindy-design-system.md §13 G3)。
    colors: normalizeLocalThemeColors(theme.colors),
    ...(icon || logo
      ? { brand: { ...(icon ? { icon } : {}), ...(logo ? { logo } : {}) } }
      : {}),
  };
}

function signatureOf(themes: Theme[]): string {
  return JSON.stringify(
    themes.map((t) => [t.id, t.type, t.name, t.family, t.colors, t.brand]),
  );
}

/** Returns true if the cache content actually changed. */
function updateCachedThemes(payload: LocalThemesResult): boolean {
  const next = payload.success ? payload.themes.map(mapWireTheme) : [];
  const nextSignature = signatureOf(next);
  // 即使签名相同也替换对象引用，让显式刷新可以重试此前加载失败的同路径素材。
  cachedThemes = next;
  if (nextSignature === cachedSignature) return false;
  cachedSignature = nextSignature;
  return true;
}

export function bootstrapLocalThemesSync(): void {
  try {
    updateCachedThemes(window.electronAPI.localThemes.listSync());
  } catch (error) {
    log.warn('Failed to bootstrap local themes:', error);
  }
}

export async function refreshLocalThemes(): Promise<LocalThemesResult> {
  const payload = await window.electronAPI.localThemes.list();
  if (updateCachedThemes(payload)) {
    didChange.fire(undefined);
  }
  return payload;
}

export function getLocalThemes(): Theme[] {
  return [...cachedThemes];
}

export function onLocalThemesChange(listener: () => void): () => void {
  return didChange.event(listener);
}

export function buildCopyFromTheme(source: Theme): {
  baseId: string;
  theme: {
    id: string;
    name: string;
    type: ThemeType;
    brand: {
      icon: string;
      logo: string;
    };
    colors: Record<string, string>;
  };
} {
  const sourceId = isLocalThemeId(source.id)
    ? source.id.slice(0, -LOCAL_THEME_SUFFIX.length)
    : source.id;
  const baseId = `${sourceId}-copy`;
  return {
    baseId,
    theme: {
      id: baseId,
      name: `${source.name} Copy`,
      type: source.type,
      // JSON 不支持注释，用一眼可替换的示例绝对路径说明配置方式；文件不存在时
      // ThemeBrandLockup 会回退默认素材，不展示破图。
      brand: {
        icon: '/absolute/path/to/your-image-folder/icon-square-50x50px.png',
        logo: '/absolute/path/to/your-image-folder/logo-horizontal-110x37.5px.png',
      },
      colors: exportThemeColors(source),
    },
  };
}
