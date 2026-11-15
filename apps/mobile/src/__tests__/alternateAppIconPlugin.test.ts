// @vitest-environment node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const plugin = require('../../plugins/with-ios-alternate-app-icons');

const mobileRoot = path.resolve(__dirname, '..', '..');

const iconBySuffix = (suffix) =>
  plugin.ALTERNATE_APP_ICONS.find((icon) => icon.name.endsWith(suffix));

describe('with-ios-alternate-app-icons', () => {
  it('登记桌面版的三个备选图标集，名称与运行时一致', () => {
    expect(plugin.ALTERNATE_APP_ICONS.map((icon) => icon.name)).toEqual([
      'AppIcon-Cat',
      'AppIcon-Wordmark',
      'AppIcon-Mark',
    ]);
    expect(iconBySuffix('Wordmark').files).toEqual({
      light: 'wordmark-light.png',
      dark: 'wordmark-dark.png',
    });
    expect(iconBySuffix('Cat').files).toEqual({ light: 'cat.png' });
    expect(iconBySuffix('Mark').files).toEqual({
      light: 'mark-light.png',
      dark: 'mark-dark.png',
    });
  });

  it('Contents.json 使用单张 1024 universal；有深色素材时带 dark 外观', () => {
    const wordmark = plugin.buildContentsJson(iconBySuffix('Wordmark'));
    expect(wordmark.images).toHaveLength(2);
    expect(wordmark.images[0]).toMatchObject({
      filename: 'wordmark-light.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    });
    expect(wordmark.images[1]).toMatchObject({
      appearances: [{ appearance: 'luminosity', value: 'dark' }],
      filename: 'wordmark-dark.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    });

    const cat = plugin.buildContentsJson(iconBySuffix('Cat'));
    expect(cat.images).toHaveLength(1);
    expect(cat.images[0].filename).toBe('cat.png');

    const mark = plugin.buildContentsJson(iconBySuffix('Mark'));
    expect(mark.images.map((image) => image.filename)).toEqual([
      'mark-light.png',
      'mark-dark.png',
    ]);
  });

  it('所有备选图标素材都是 1024×1024、无 alpha 的 RGB PNG', () => {
    for (const icon of plugin.ALTERNATE_APP_ICONS) {
      for (const file of Object.values(icon.files)) {
        const png = readFileSync(path.join(mobileRoot, 'assets', 'app-icons', file));
        // PNG IHDR：宽度/高度为大端 32 位，color type 2 = RGB（6 才是 RGBA）。
        expect(png.readUInt32BE(16), file).toBe(1024);
        expect(png.readUInt32BE(20), file).toBe(1024);
        expect(png[25], file).toBe(2);
      }
    }
  });
});
