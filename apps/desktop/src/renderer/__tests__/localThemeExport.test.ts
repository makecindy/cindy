import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapLocalThemesSync,
  buildCopyFromTheme,
  getLocalThemes,
  refreshLocalThemes,
} from '../themes/local-themes';
import type { Theme } from '../themes/types';

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
