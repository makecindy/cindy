// @vitest-environment node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const plugin = require('../../plugins/with-ios-alternate-app-icons');

const mobileRoot = path.resolve(__dirname, '..', '..');

describe('with-ios-alternate-app-icons', () => {
  it('只登记一个备选图标集，名称与运行时一致', () => {
    expect(plugin.ALTERNATE_APP_ICONS).toEqual([
      {
        name: 'AppIcon-Wordmark',
        files: { light: 'wordmark-light.png', dark: 'wordmark-dark.png' },
      },
    ]);
  });

  it('Contents.json 使用单张 1024 universal，并带深色外观', () => {
    const contents = plugin.buildContentsJson(plugin.ALTERNATE_APP_ICONS[0]);
    expect(contents.images).toHaveLength(2);
    expect(contents.images[0]).toMatchObject({
      filename: 'wordmark-light.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    });
    expect(contents.images[1]).toMatchObject({
      appearances: [{ appearance: 'luminosity', value: 'dark' }],
      filename: 'wordmark-dark.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    });
  });

  it('备选图标素材是 1024×1024、无 alpha 的 RGB PNG', () => {
    for (const file of ['wordmark-light.png', 'wordmark-dark.png']) {
      const png = readFileSync(path.join(mobileRoot, 'assets', 'app-icons', file));
      // PNG IHDR：宽度/高度为大端 32 位，color type 2 = RGB（6 才是 RGBA）。
      expect(png.readUInt32BE(16), file).toBe(1024);
      expect(png.readUInt32BE(20), file).toBe(1024);
      expect(png[25], file).toBe(2);
    }
  });
});
