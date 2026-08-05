import { afterEach, describe, expect, it, vi } from 'vitest';

import '../themes/colors';
import {
  bootstrapLocalThemesSync,
  buildCopyFromTheme,
  getLocalThemes,
  refreshLocalThemes,
} from '../themes/local-themes';
import type { Theme } from '../themes/types';

const COPY_SOURCE_COLORS = {
  surface: '#ffffff',
  'surface-on-card': '#f5f5f5',
  'surface-hover': '#eeeeee',
  'surface-secondary': '#e5e5e5',
  'text-secondary': '#6b6b6b',
};

function copyAndLoadTheme(source: Theme): {
  copied: ReturnType<typeof buildCopyFromTheme>['theme'];
  loaded: Theme;
} {
  const copied = buildCopyFromTheme(source).theme;
  const payload = {
    success: true as const,
    diagnostics: [],
    themes: [{ ...copied, id: `${copied.id}-loaded` }],
  };
  vi.stubGlobal('window', {
    electronAPI: {
      localThemes: {
        listSync: () => payload,
      },
    },
  });

  bootstrapLocalThemesSync();
  return { copied, loaded: getLocalThemes()[0]! };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local theme export', () => {
  it('用可直接替换的示例路径解释 icon / logo 配置', () => {
    const source: Theme = {
      id: 'cindy-light',
      name: 'CINDY Light',
      type: 'light',
      colors: {},
    };

    expect(buildCopyFromTheme(source).theme.brand).toEqual({
      icon: '/absolute/path/to/your-image-folder/icon-square-50x50px.png',
      logo: '/absolute/path/to/your-image-folder/logo-horizontal-110x37.5px.png',
    });
  });

  it('复制产生的 Switch registry 默认别名在加载时重新派生', () => {
    const { copied, loaded } = copyAndLoadTheme({
      id: 'copy-source',
      name: 'Copy Source',
      type: 'light',
      colors: COPY_SOURCE_COLORS,
    });

    expect(copied.colors['switch-track-off']).toBe('var(--text-secondary)');
    expect(copied.colors['switch-thumb-off']).toBe('var(--surface-on-card)');
    expect(loaded.colors['switch-track-off']).toMatch(/^#[0-9a-f]{6}$/);
    expect(loaded.colors['switch-thumb-off']).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('复制后加载不覆盖显式 Switch override', () => {
    const { copied, loaded } = copyAndLoadTheme({
      id: 'explicit-source',
      name: 'Explicit Source',
      type: 'light',
      colors: {
        ...COPY_SOURCE_COLORS,
        'switch-track-off': '#765432',
        'switch-thumb-off': '#fedcba',
      },
    });

    expect(copied.colors['switch-track-off']).toBe('#765432');
    expect(copied.colors['switch-thumb-off']).toBe('#fedcba');
    expect(loaded.colors['switch-track-off']).toBe('#765432');
    expect(loaded.colors['switch-thumb-off']).toBe('#fedcba');
  });

  it('刷新同一配置时替换素材对象，并把文件版本加入图片 URL', async () => {
    const payload = {
      success: true as const,
      diagnostics: [],
      themes: [
        {
          id: 'custom-local',
          name: 'Custom',
          type: 'light' as const,
          colors: {},
          brand: { icon: '/tmp/icon.png' },
          brandRevisions: { icon: '12:34.5' },
        },
      ],
    };
    vi.stubGlobal('window', {
      electronAPI: {
        localThemes: {
          listSync: () => payload,
          list: async () => payload,
        },
      },
    });

    bootstrapLocalThemesSync();
    const firstAsset = getLocalThemes()[0]?.brand?.icon;
    expect(firstAsset?.src).toBe(
      'xdt-file://local/?path=%2Ftmp%2Ficon.png&v=12%3A34.5',
    );

    await refreshLocalThemes();
    expect(getLocalThemes()[0]?.brand?.icon).not.toBe(firstAsset);
  });
});
